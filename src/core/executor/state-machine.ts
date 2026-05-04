/**
 * 单 task 多 phase 状态机
 *
 * Step 4c 改造:
 *   - 主循环操作 RunState(step 数组 + currentIdx + 计数器),不再用 phaseIdx + PHASE_ORDER 索引
 *   - runTask 兼容入口:接受 (task, startPhase, opts, endPhase?),内部 makeStepsForPhaseRange 合成
 *   - runTaskFromSteps 新入口:接受外部 RunStep[],适合从 plan.yaml 派生的 step 列表
 *
 * 内部副作用:
 *   - reviewer fail → rollbackToPhase(state, 'coder')(maxReviewRounds 内)
 *   - tester fail  → rollbackToPhase(state, 'coder') + 重置 reviewRounds
 *   - planner 完成 → consumePlannerOutput 拆 task(单任务时合并到当前 task)
 *   - coder 完成 → 检查 protected files / scope violation / 过滤 exit artifact
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentAdapter, Batch, FlooConfig, Phase, Task } from '../types.js';
import {
  MAX_REVIEW_ROUNDS,
  MAX_TEST_ROUNDS,
  DEFAULT_CONFIG,
} from '../types.js';
import { readExitArtifact } from '../adapters/base.js';
import { findOutOfScope, ensureFlooDir } from '../scope.js';
import { notify } from '../notifications.js';

import { log, saveTask } from './io.js';
import { collectArtifact, cleanStaleArtifact } from './artifacts.js';
import { consumePlannerOutput } from './planner.js';
import { executePhase } from './execute-step.js';
import { checkReviewVerdict, checkTestResult } from './verdict.js';
import {
  type RunState,
  type RunStep,
  advance,
  currentStep,
  makeRunState,
  makeStepsForPhaseRange,
  rollbackToPhase,
} from './state.js';

// ============================================================
// 公共选项类型
// ============================================================

/**
 * runTask / createAndRun 共享的运行选项。
 * 历史上叫 DispatcherOptions,从 dispatcher.ts 搬过来后保留同名兼容外部消费者。
 */
export interface DispatcherOptions {
  projectRoot: string;
  config?: FlooConfig;
  adapters: Record<string, AgentAdapter>;  // runtime name → adapter
  /** AbortSignal 支持 graceful shutdown(Ctrl+C 时停止 dispatch 新任务) */
  signal?: AbortSignal;
}

// ============================================================
// runTask 公共入口(兼容 + 新)
// ============================================================

/**
 * 兼容入口:任务从 startPhase 起步跑到 endPhase(含)或失败。
 * 内部 makeStepsForPhaseRange 合成 step 列表后调用 runTaskFromSteps。
 */
export async function runTask(
  task: Task,
  startPhase: Phase,
  opts: DispatcherOptions,
  endPhase?: Phase,
): Promise<Task> {
  const steps = makeStepsForPhaseRange(startPhase, endPhase);
  return runTaskFromSteps(task, steps, opts);
}

/**
 * 新入口:接受外部 RunStep[](通常来自 plan.yaml 的 PlanStep[] 转换)。
 * 让 plan.yaml 真正驱动执行序列——而不是 PHASE_ORDER。
 *
 * 用法示例(executor.runPlan / commands/run --mode 走这条):
 *   const planSteps = planStepsToRunSteps(plan.steps);
 *   await runTaskFromSteps(task, planSteps, opts);
 */
export async function runTaskFromSteps(
  task: Task,
  steps: RunStep[],
  opts: DispatcherOptions,
): Promise<Task> {
  if (steps.length === 0) {
    throw new Error('runTaskFromSteps: steps 数组为空');
  }
  const state = makeRunState(steps);
  return runStateMachine(task, state, opts);
}

// ============================================================
// runStateMachine:主循环(消费 RunState)
// ============================================================

/**
 * 真正的状态机循环:
 *   1. 取 currentStep,abort 检查
 *   2. review_level 短路(scan/skip)
 *   3. executePhase + collectArtifact
 *   4. capability-specific 后处理(planner/reviewer/tester/coder)
 *   5. 后处理可能 rollbackToPhase('coder') 实现 retry,或 advance() 推进
 */
async function runStateMachine(
  task: Task,
  state: RunState,
  opts: DispatcherOptions,
): Promise<Task> {
  const { projectRoot, adapters } = opts;
  const config = opts.config ?? DEFAULT_CONFIG;
  const flooDir = await ensureFlooDir(projectRoot);

  task.status = 'running';
  await saveTask(flooDir, task);
  await log(flooDir, 'dispatch', { task: task.id, start_phase: state.steps[0].phase });

  const maxReviewRounds = config.limits?.max_review_rounds ?? MAX_REVIEW_ROUNDS;
  const maxTestRounds = config.limits?.max_test_rounds ?? MAX_TEST_ROUNDS;

  while (state.currentIdx < state.steps.length) {
    if (opts.signal?.aborted) {
      task.status = 'cancelled';
      task.current_phase = null;
      await saveTask(flooDir, task);
      await log(flooDir, 'aborted', { task: task.id, phase: currentStep(state)?.phase });
      return task;
    }

    const step = currentStep(state)!;  // currentIdx 边界已被 while 守护
    const phase = step.phase;

    // review_level=scan/skip 短路
    if (phase === 'reviewer') {
      const sc = await applyReviewShortCircuit(task, flooDir);
      if (sc === 'fail-return') return task;
      if (sc === 'skip-phase') { advance(state); continue; }
    }

    task.current_phase = phase;
    await saveTask(flooDir, task);
    await cleanStaleArtifact(projectRoot, phase, task.id);

    state.runCounter++;
    const result = await executePhase(task, phase, config, flooDir, projectRoot, adapters, state.runCounter);

    if (!result.success) {
      const wasCancelled = result.exitArtifact?.exit_code === -1;
      task.status = wasCancelled ? 'cancelled' : 'failed';
      task.current_phase = phase;
      await saveTask(flooDir, task);
      const reason = wasCancelled ? 'cancelled_externally' : 'max_retries_exceeded';
      await log(flooDir, reason, { task: task.id, phase });
      await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: task.status, phase, reason });
      return task;
    }

    await collectArtifact(projectRoot, flooDir, task, phase);

    // ——— phase-specific 后处理 ———
    if (phase === 'planner') {
      await handlePlannerOutput(flooDir, task);
    }

    if (phase === 'reviewer') {
      const next = await handleReviewerVerdict(task, flooDir, state, maxReviewRounds);
      if (next.action === 'fail') return task;
      if (next.action === 'retry-coder') {
        state.reviewRounds = next.reviewRounds;
        if (!rollbackToPhase(state, 'coder')) {
          // coder 不在 step 列表里(--from reviewer),其实已被 handleReviewerVerdict 标 fail 走前面
          // 这里只是兜底:若意外进入,直接退出避免死循环
          task.status = 'failed';
          await saveTask(flooDir, task);
          return task;
        }
        continue;
      }
    }

    if (phase === 'tester') {
      const next = await handleTesterVerdict(task, flooDir, state, maxTestRounds);
      if (next.action === 'fail') return task;
      if (next.action === 'retry-coder') {
        state.testRounds = next.testRounds;
        state.reviewRounds = 0;  // 重置 review 轮数,新一轮 coder→reviewer→tester
        if (!rollbackToPhase(state, 'coder')) {
          task.status = 'failed';
          await saveTask(flooDir, task);
          return task;
        }
        continue;
      }
    }

    if (phase === 'coder') {
      const violationResult = await checkCoderViolations(task, flooDir, config);
      if (violationResult === 'fail') return task;
    }

    advance(state);
  }

  task.status = 'completed';
  task.current_phase = null;
  await saveTask(flooDir, task);
  await log(flooDir, 'completed', { task: task.id });
  await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: 'completed' });
  return task;
}

// ============================================================
// 子流程 handlers
// ============================================================

/**
 * review_level=scan/skip 时的短路处理。
 * 返回:
 *   'run-normally': review_level=full,正常派 reviewer agent
 *   'skip-phase':   scan-pass 或 skip,跳过 reviewer 继续走下一步
 *   'fail-return':  scan 检测到 coder 失败,task 已标记 failed,主循环应 return task
 */
async function applyReviewShortCircuit(
  task: Task,
  flooDir: string,
): Promise<'run-normally' | 'skip-phase' | 'fail-return'> {
  if (task.review_level === 'scan') {
    const coderArtifact = await readExitArtifact(flooDir, task.id, 'coder');
    if (coderArtifact.exit_code !== 0) {
      task.status = 'failed';
      await saveTask(flooDir, task);
      await log(flooDir, 'scan-failed', { task: task.id, reason: 'coder_exit_nonzero', exit_code: coderArtifact.exit_code });
      return 'fail-return';
    }
    const outOfScope = findOutOfScope(coderArtifact.files_changed, task.scope);
    if (outOfScope.length > 0) {
      await log(flooDir, 'scan-scope-violation', { task: task.id, files: outOfScope });
    }
    await log(flooDir, 'scan-passed', { task: task.id });
    return 'skip-phase';
  }
  if (task.review_level === 'skip') {
    await log(flooDir, 'skip-reviewer', { task: task.id });
    return 'skip-phase';
  }
  return 'run-normally';
}

/** planner 完成后:解析 plan.md → 拆子任务(单任务合并到当前 task) */
async function handlePlannerOutput(flooDir: string, task: Task): Promise<void> {
  const batchPath = join(flooDir, 'batches', task.batch_id, 'batch.json');
  const batch: Batch = JSON.parse(await readFile(batchPath, 'utf-8'));
  const subTasks = await consumePlannerOutput(flooDir, batch, task);
  if (subTasks.length === 1) {
    Object.assign(task, subTasks[0]);
  }
}

/** reviewer 后处理结果 */
type ReviewerOutcome =
  | { action: 'pass' }
  | { action: 'fail' }
  | { action: 'retry-coder'; reviewRounds: number };

async function handleReviewerVerdict(
  task: Task,
  flooDir: string,
  state: RunState,
  maxReviewRounds: number,
): Promise<ReviewerOutcome> {
  const verdict = await checkReviewVerdict(flooDir, task);
  if (verdict === 'pass') {
    await log(flooDir, 'review-pass', { task: task.id });
    await notify(flooDir, 'review_concluded', { batch_id: task.batch_id, task_id: task.id, phase: 'reviewer', verdict: 'pass' });
    return { action: 'pass' };
  }
  // fail
  // 单 phase 模式 (--from reviewer):coder 不在 step 列表里,无法回退
  const hasCoder = state.steps.some(s => s.phase === 'coder');
  if (!hasCoder) {
    task.status = 'failed';
    await saveTask(flooDir, task);
    await log(flooDir, 'failed', { task: task.id, reason: 'review_fail_no_coder', verdict: 'fail' });
    await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: 'failed', reason: 'review_fail_no_coder' });
    return { action: 'fail' };
  }
  const next = state.reviewRounds + 1;
  if (next >= maxReviewRounds) {
    task.status = 'failed';
    await saveTask(flooDir, task);
    await log(flooDir, 'failed', { task: task.id, reason: 'max_review_rounds', rounds: next });
    await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: 'failed', reason: 'max_review_rounds' });
    return { action: 'fail' };
  }
  await log(flooDir, 'review-fail', { task: task.id, round: next });
  await notify(flooDir, 'review_concluded', { batch_id: task.batch_id, task_id: task.id, phase: 'reviewer', verdict: 'fail', round: next });
  return { action: 'retry-coder', reviewRounds: next };
}

/** tester 后处理结果 */
type TesterOutcome =
  | { action: 'pass' }
  | { action: 'fail' }
  | { action: 'retry-coder'; testRounds: number };

async function handleTesterVerdict(
  task: Task,
  flooDir: string,
  state: RunState,
  maxTestRounds: number,
): Promise<TesterOutcome> {
  const result = await checkTestResult(flooDir, task);
  if (result === 'pass') {
    await log(flooDir, 'test-pass', { task: task.id });
    await notify(flooDir, 'review_concluded', { batch_id: task.batch_id, task_id: task.id, phase: 'tester', verdict: 'pass' });
    return { action: 'pass' };
  }
  const hasCoder = state.steps.some(s => s.phase === 'coder');
  if (!hasCoder) {
    task.status = 'failed';
    await saveTask(flooDir, task);
    await log(flooDir, 'failed', { task: task.id, reason: 'test_fail_no_coder', verdict: 'fail' });
    await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: 'failed', reason: 'test_fail_no_coder' });
    return { action: 'fail' };
  }
  const next = state.testRounds + 1;
  if (next >= maxTestRounds) {
    task.status = 'failed';
    await saveTask(flooDir, task);
    await log(flooDir, 'failed', { task: task.id, reason: 'max_test_rounds', rounds: next });
    await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: 'failed', reason: 'max_test_rounds' });
    return { action: 'fail' };
  }
  await log(flooDir, 'test-fail', { task: task.id, round: next });
  await notify(flooDir, 'review_concluded', { batch_id: task.batch_id, task_id: task.id, phase: 'tester', verdict: 'fail', round: next });
  return { action: 'retry-coder', testRounds: next };
}

/** coder 完成后:protected files / scope violation / 过滤 exit artifact */
async function checkCoderViolations(
  task: Task,
  flooDir: string,
  config: FlooConfig,
): Promise<'pass' | 'fail'> {
  const exitArtifact = await readExitArtifact(flooDir, task.id, 'coder');

  // 1. Protected files
  const protectedHits = exitArtifact.files_changed.filter(
    f => config.protected_files.some(p => f === p || f.endsWith('/' + p)),
  );
  if (protectedHits.length > 0) {
    await log(flooDir, 'protected-file-violation', { task: task.id, files: protectedHits });
    task.status = 'failed';
    task.current_phase = 'coder';
    await saveTask(flooDir, task);
    await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: 'failed', reason: 'protected_file_violation' });
    return 'fail';
  }

  // 2. Scope violation
  if (task.scope.length > 0) {
    const outOfScope = findOutOfScope(exitArtifact.files_changed, task.scope);
    if (outOfScope.length > 0) {
      await log(flooDir, 'scope-violation', { task: task.id, files: outOfScope });
      task.status = 'failed';
      task.current_phase = 'coder';
      await saveTask(flooDir, task);
      await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: 'failed', reason: 'scope_violation', files: outOfScope });
      return 'fail';
    }
  }

  // 3. 过滤 exit artifact:只保留本任务 scope 内的文件
  const rawCount = exitArtifact.files_changed.length;
  const taskFiles = exitArtifact.files_changed.filter(
    file => findOutOfScope([file], task.scope).length === 0,
  );
  if (taskFiles.length !== rawCount) {
    exitArtifact.files_changed = taskFiles;
    const exitPath = join(flooDir, 'signals', `${task.id}-coder.exit`);
    await writeFile(exitPath, JSON.stringify(exitArtifact, null, 2));
    await log(flooDir, 'artifact-filtered', { task: task.id, raw: rawCount, filtered: taskFiles.length });
  }
  return 'pass';
}
