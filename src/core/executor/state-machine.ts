/**
 * 单 task 多 phase 状态机
 *
 * 从 startPhase 开始,驱动状态机流转到 endPhase(含)或失败。
 * 内部副作用:
 *   - reviewer fail → 回 coder 重跑(maxReviewRounds 内)
 *   - tester fail  → 回 coder 重跑 + 重置 reviewRounds
 *   - planner 完成 → consumePlannerOutput 拆 task(单任务时合并到当前 task)
 *   - coder 完成 → 检查 protected files / scope violation / 过滤 exit artifact
 *
 * 这个文件就是原 dispatcher.runTask 搬过来的 + 替换 import 路径。
 * 后续会进一步改造为消费 PlanState 而不是 (task, startPhase) 元组。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentAdapter, Batch, FlooConfig, Phase, Task } from '../types.js';
import {
  PHASE_ORDER,
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

// ============================================================
// 公共选项类型
// ============================================================

/**
 * runTask / createAndRun 共享的运行选项。
 *
 * 历史上叫 DispatcherOptions,从 dispatcher.ts 搬到这里后名称保留——
 * 外部消费者(包括 dispatcher.test)都还从 './dispatcher.js' 拿这个类型,
 * dispatcher.ts 现在 re-export。
 */
export interface DispatcherOptions {
  projectRoot: string;
  config?: FlooConfig;
  adapters: Record<string, AgentAdapter>;  // runtime name → adapter
  /** AbortSignal 支持 graceful shutdown(Ctrl+C 时停止 dispatch 新任务) */
  signal?: AbortSignal;
}

// ============================================================
// runTask
// ============================================================

/** 任务起步后跑到结束的状态机主循环 */
export async function runTask(
  task: Task,
  startPhase: Phase,
  opts: DispatcherOptions,
  endPhase?: Phase,
): Promise<Task> {
  const { projectRoot, adapters } = opts;
  const config = opts.config ?? DEFAULT_CONFIG;
  const flooDir = await ensureFlooDir(projectRoot);

  const startIdx = PHASE_ORDER.indexOf(startPhase);
  if (startIdx === -1) throw new Error(`Invalid start phase: ${startPhase}`);
  const endIdx = endPhase ? PHASE_ORDER.indexOf(endPhase) : PHASE_ORDER.length - 1;

  task.status = 'running';
  await saveTask(flooDir, task);
  await log(flooDir, 'dispatch', { task: task.id, start_phase: startPhase });

  const maxReviewRounds = config.limits?.max_review_rounds ?? MAX_REVIEW_ROUNDS;
  const maxTestRounds = config.limits?.max_test_rounds ?? MAX_TEST_ROUNDS;

  let reviewRounds = 0;
  let testRounds = 0;
  let runCounter = 0;

  let phaseIdx = startIdx;
  while (phaseIdx <= endIdx) {
    if (opts.signal?.aborted) {
      task.status = 'cancelled';
      task.current_phase = null;
      await saveTask(flooDir, task);
      await log(flooDir, 'aborted', { task: task.id, phase: PHASE_ORDER[phaseIdx] });
      return task;
    }

    const phase = PHASE_ORDER[phaseIdx];

    // review_level 短路:scan/skip 时不派 reviewer agent
    if (phase === 'reviewer') {
      const sc = await applyReviewShortCircuit(task, flooDir);
      if (sc === 'fail-return') return task;          // scan 检测到 coder 失败,直接 return
      if (sc === 'skip-phase') { phaseIdx++; continue; }  // scan-pass 或 skip,跳过 reviewer 继续
      // 'run-normally' → 正常派 reviewer agent
    }

    task.current_phase = phase;
    await saveTask(flooDir, task);
    await cleanStaleArtifact(projectRoot, phase, task.id);

    runCounter++;
    const result = await executePhase(task, phase, config, flooDir, projectRoot, adapters, runCounter);

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
      const next = await handleReviewerVerdict(task, flooDir, startIdx, endIdx, maxReviewRounds, reviewRounds);
      if (next.action === 'fail') return task;
      if (next.action === 'retry-coder') {
        reviewRounds = next.reviewRounds;
        phaseIdx = PHASE_ORDER.indexOf('coder');
        continue;
      }
    }

    if (phase === 'tester') {
      const next = await handleTesterVerdict(task, flooDir, startIdx, endIdx, maxTestRounds, testRounds);
      if (next.action === 'fail') return task;
      if (next.action === 'retry-coder') {
        testRounds = next.testRounds;
        reviewRounds = 0;  // 重置 review 轮数
        phaseIdx = PHASE_ORDER.indexOf('coder');
        continue;
      }
    }

    if (phase === 'coder') {
      const violationResult = await checkCoderViolations(task, flooDir, config);
      if (violationResult === 'fail') return task;
    }

    phaseIdx++;
  }

  task.status = 'completed';
  task.current_phase = null;
  await saveTask(flooDir, task);
  await log(flooDir, 'completed', { task: task.id });
  await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: 'completed' });
  return task;
}

// ============================================================
// 拆出来的小函数(每个 phase 后处理 + review_level 短路)
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
  startIdx: number,
  endIdx: number,
  maxReviewRounds: number,
  reviewRounds: number,
): Promise<ReviewerOutcome> {
  const verdict = await checkReviewVerdict(flooDir, task);
  if (verdict === 'pass') {
    await log(flooDir, 'review-pass', { task: task.id });
    await notify(flooDir, 'review_concluded', { batch_id: task.batch_id, task_id: task.id, phase: 'reviewer', verdict: 'pass' });
    return { action: 'pass' };
  }
  // fail
  // 单 phase 模式 (--from reviewer):coder 不在范围内,无法回退
  const coderInRange = PHASE_ORDER.indexOf('coder') >= startIdx && PHASE_ORDER.indexOf('coder') <= endIdx;
  if (!coderInRange) {
    task.status = 'failed';
    await saveTask(flooDir, task);
    await log(flooDir, 'failed', { task: task.id, reason: 'review_fail_no_coder', verdict: 'fail' });
    await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: 'failed', reason: 'review_fail_no_coder' });
    return { action: 'fail' };
  }
  const next = reviewRounds + 1;
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
  startIdx: number,
  endIdx: number,
  maxTestRounds: number,
  testRounds: number,
): Promise<TesterOutcome> {
  const result = await checkTestResult(flooDir, task);
  if (result === 'pass') {
    await log(flooDir, 'test-pass', { task: task.id });
    await notify(flooDir, 'review_concluded', { batch_id: task.batch_id, task_id: task.id, phase: 'tester', verdict: 'pass' });
    return { action: 'pass' };
  }
  const coderInRange = PHASE_ORDER.indexOf('coder') >= startIdx && PHASE_ORDER.indexOf('coder') <= endIdx;
  if (!coderInRange) {
    task.status = 'failed';
    await saveTask(flooDir, task);
    await log(flooDir, 'failed', { task: task.id, reason: 'test_fail_no_coder', verdict: 'fail' });
    await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: 'failed', reason: 'test_fail_no_coder' });
    return { action: 'fail' };
  }
  const next = testRounds + 1;
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
