/**
 * Dispatcher — 核心调度状态机
 *
 * 职责:驱动任务在 phase 之间流转(designer → planner → coder → reviewer → tester),
 * 处理重试、review/test 循环、discuss-designer 飞轮、planner 拆任务、批次并行调度。
 *
 * Step 4b refactor:
 *   - 所有 IO/artifact/prompt/单 phase 执行/verdict 检查 helper 已搬到 src/core/executor/
 *   - 本文件只剩状态机本身:runTask / runBatch / createAndRun
 *   - 后续 commit 会把状态机也搬到 executor 子模块,dispatcher 退化为 thin shim
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  Task,
  Batch,
  Phase,
  FlooConfig,
  AgentAdapter,
} from './types.js';
import {
  PHASE_ORDER,
  MAX_REVIEW_ROUNDS,
  MAX_TEST_ROUNDS,
  MAX_DISCUSS_ROUNDS,
  DEFAULT_CONFIG,
} from './types.js';
import { readExitArtifact } from './adapters/base.js';
import { findOutOfScope, ensureFlooDir, detectConflicts } from './scope.js';
import { notify } from './notifications.js';
import { synthesizeInitialPlan, writePlan } from './plan.js';

import { log, saveTask, saveBatch, deriveBatchToken } from './executor/io.js';
import {
  collectArtifact,
  cleanStaleArtifact,
  cleanStaleDesignQuestions,
  collectDesignQuestions,
  hasBlockerQuestions,
  fallbackDesignFromQuestions,
} from './executor/artifacts.js';
import { consumePlannerOutput } from './executor/planner.js';
import { executePhase } from './executor/execute-step.js';
import { checkReviewVerdict, checkTestResult } from './executor/verdict.js';
import { runBatchSummaryReview } from './executor/summary.js';

const exec = promisify(execFile);

// ============================================================
// Dispatcher 公共接口
// ============================================================

export interface DispatcherOptions {
  projectRoot: string;
  config?: FlooConfig;
  adapters: Record<string, AgentAdapter>;  // runtime name → adapter
  /** 传入 AbortSignal 支持 graceful shutdown(Ctrl+C 时停止调度新任务) */
  signal?: AbortSignal;
}

// ============================================================
// runTask:单 task 多 phase 状态机
// ============================================================

/**
 * 运行单个任务的完整生命周期。
 * 从 startPhase 开始,驱动状态机流转到 endPhase(含)或失败。
 * endPhase 默认 = PHASE_ORDER 最后一个阶段。
 *
 * 内部副作用:
 *   - reviewer fail → 回 coder 重跑(最多 maxReviewRounds 轮)
 *   - tester fail  → 回 coder 重跑 + 重置 reviewRounds
 *   - planner 完成 → consumePlannerOutput 拆 task(单任务情况合并到当前 task)
 *   - coder 完成 → 检查 protected files / scope violation / 过滤 exit artifact
 */
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
  if (startIdx === -1) {
    throw new Error(`Invalid start phase: ${startPhase}`);
  }
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

    // review_level 短路:scan 仅检查 coder exit + scope, skip 直接跳过
    if (phase === 'reviewer' && task.review_level === 'scan') {
      const coderArtifact = await readExitArtifact(flooDir, task.id, 'coder');
      if (coderArtifact.exit_code !== 0) {
        task.status = 'failed';
        await saveTask(flooDir, task);
        await log(flooDir, 'scan-failed', { task: task.id, reason: 'coder_exit_nonzero', exit_code: coderArtifact.exit_code });
        return task;
      }
      const outOfScope = findOutOfScope(coderArtifact.files_changed, task.scope);
      if (outOfScope.length > 0) {
        await log(flooDir, 'scan-scope-violation', { task: task.id, files: outOfScope });
      }
      await log(flooDir, 'scan-passed', { task: task.id });
      phaseIdx++;
      continue;
    }
    if (phase === 'reviewer' && task.review_level === 'skip') {
      await log(flooDir, 'skip-reviewer', { task: task.id });
      phaseIdx++;
      continue;
    }

    task.current_phase = phase;
    await saveTask(flooDir, task);

    // 清掉项目根目录残留 artifact,防止 collectArtifact 吃到上一轮
    await cleanStaleArtifact(projectRoot, phase, task.id);

    // 跑当前 phase(内部含 retry)
    runCounter++;
    const result = await executePhase(task, phase, config, flooDir, projectRoot, adapters, runCounter);

    if (!result.success) {
      // 区分 cancelled / failed
      const wasCancelled = result.exitArtifact?.exit_code === -1;
      task.status = wasCancelled ? 'cancelled' : 'failed';
      task.current_phase = phase;
      await saveTask(flooDir, task);
      const reason = wasCancelled ? 'cancelled_externally' : 'max_retries_exceeded';
      await log(flooDir, reason, { task: task.id, phase });
      await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: task.status, phase, reason });
      return task;
    }

    // 收 agent 产出到任务目录
    await collectArtifact(projectRoot, flooDir, task, phase);

    // ——— phase-specific 后处理 ———

    if (phase === 'planner') {
      // 读已持久化的 batch(避免手动构造空壳)
      const batchPath = join(flooDir, 'batches', task.batch_id, 'batch.json');
      const batch: Batch = JSON.parse(await readFile(batchPath, 'utf-8'));
      const subTasks = await consumePlannerOutput(flooDir, batch, task);
      // 单子任务时合并到当前 task,继续往下跑;多任务由 runBatch 处理
      if (subTasks.length === 1) {
        Object.assign(task, subTasks[0]);
      }
    }

    if (phase === 'reviewer') {
      const verdict = await checkReviewVerdict(flooDir, task);
      if (verdict === 'fail') {
        // 单 phase 模式 (--from reviewer):coder 不在范围内,无法回退修复
        const coderInRange = PHASE_ORDER.indexOf('coder') >= startIdx && PHASE_ORDER.indexOf('coder') <= endIdx;
        if (!coderInRange) {
          task.status = 'failed';
          await saveTask(flooDir, task);
          await log(flooDir, 'failed', { task: task.id, reason: 'review_fail_no_coder', verdict: 'fail' });
          await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: 'failed', reason: 'review_fail_no_coder' });
          return task;
        }
        reviewRounds++;
        if (reviewRounds >= maxReviewRounds) {
          task.status = 'failed';
          await saveTask(flooDir, task);
          await log(flooDir, 'failed', { task: task.id, reason: 'max_review_rounds', rounds: reviewRounds });
          await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: 'failed', reason: 'max_review_rounds' });
          return task;
        }
        await log(flooDir, 'review-fail', { task: task.id, round: reviewRounds });
        await notify(flooDir, 'review_concluded', { batch_id: task.batch_id, task_id: task.id, phase, verdict: 'fail', round: reviewRounds });
        phaseIdx = PHASE_ORDER.indexOf('coder');
        continue;
      }
      await log(flooDir, 'review-pass', { task: task.id });
      await notify(flooDir, 'review_concluded', { batch_id: task.batch_id, task_id: task.id, phase, verdict: 'pass' });
    }

    if (phase === 'tester') {
      const testResult = await checkTestResult(flooDir, task);
      if (testResult === 'fail') {
        const coderInRange = PHASE_ORDER.indexOf('coder') >= startIdx && PHASE_ORDER.indexOf('coder') <= endIdx;
        if (!coderInRange) {
          task.status = 'failed';
          await saveTask(flooDir, task);
          await log(flooDir, 'failed', { task: task.id, reason: 'test_fail_no_coder', verdict: 'fail' });
          await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: 'failed', reason: 'test_fail_no_coder' });
          return task;
        }
        testRounds++;
        if (testRounds >= maxTestRounds) {
          task.status = 'failed';
          await saveTask(flooDir, task);
          await log(flooDir, 'failed', { task: task.id, reason: 'max_test_rounds', rounds: testRounds });
          await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: 'failed', reason: 'max_test_rounds' });
          return task;
        }
        await log(flooDir, 'test-fail', { task: task.id, round: testRounds });
        await notify(flooDir, 'review_concluded', { batch_id: task.batch_id, task_id: task.id, phase, verdict: 'fail', round: testRounds });
        // tester fail → 回 coder,coder 会读 test-report.md 当反馈
        reviewRounds = 0;  // 重置 review 轮数,新一轮 coder→reviewer→tester
        phaseIdx = PHASE_ORDER.indexOf('coder');
        continue;
      }
      await log(flooDir, 'test-pass', { task: task.id });
      await notify(flooDir, 'review_concluded', { batch_id: task.batch_id, task_id: task.id, phase, verdict: 'pass' });
    }

    if (phase === 'coder') {
      const exitArtifact = await readExitArtifact(flooDir, task.id, phase);

      // 1. Protected files:无论 scope 如何,改受保护文件一律 fail
      const protectedHits = exitArtifact.files_changed.filter(
        f => config.protected_files.some(p => f === p || f.endsWith('/' + p)),
      );
      if (protectedHits.length > 0) {
        await log(flooDir, 'protected-file-violation', { task: task.id, files: protectedHits });
        task.status = 'failed';
        task.current_phase = phase;
        await saveTask(flooDir, task);
        await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: 'failed', reason: 'protected_file_violation' });
        return task;
      }

      // 2. Scope violation:有 scope 时越界即 fail(scope 是约束,不是建议)
      if (task.scope.length > 0) {
        const outOfScope = findOutOfScope(exitArtifact.files_changed, task.scope);
        if (outOfScope.length > 0) {
          await log(flooDir, 'scope-violation', { task: task.id, files: outOfScope });
          task.status = 'failed';
          task.current_phase = phase;
          await saveTask(flooDir, task);
          await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: 'failed', reason: 'scope_violation', files: outOfScope });
          return task;
        }
      }

      // 3. 过滤 exit artifact:只保留本任务 scope 内的文件,排除并行任务噪声
      const rawCount = exitArtifact.files_changed.length;
      const taskFiles = exitArtifact.files_changed.filter(
        file => findOutOfScope([file], task.scope).length === 0,
      );
      if (taskFiles.length !== rawCount) {
        exitArtifact.files_changed = taskFiles;
        const exitPath = join(flooDir, 'signals', `${task.id}-${phase}.exit`);
        await writeFile(exitPath, JSON.stringify(exitArtifact, null, 2));
        await log(flooDir, 'artifact-filtered', { task: task.id, raw: rawCount, filtered: taskFiles.length });
      }
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
// runBatch:多 task 拓扑调度
// ============================================================

/**
 * 并行执行多个任务(scope 无冲突的同时跑,有冲突的按依赖串行)。
 * 每个子任务从 coder 开始(designer/planner 已在 batch 级别完成)。
 *
 * 死锁检测:有待处理任务但全部依赖被阻塞 → 标记所有 pending failed。
 */
async function runBatch(
  tasks: Task[],
  opts: DispatcherOptions,
): Promise<Task[]> {
  const { projectRoot } = opts;
  const config = opts.config ?? DEFAULT_CONFIG;
  const flooDir = await ensureFlooDir(projectRoot);

  // scope 冲突检测
  const conflicts = detectConflicts(tasks.map(t => ({ id: t.id, scope: t.scope })));
  const conflictPairs = new Set(conflicts.flatMap(c => [`${c.task_a}:${c.task_b}`, `${c.task_b}:${c.task_a}`]));

  const completed = new Set<string>();
  const failed = new Set<string>();
  const results: Task[] = [];

  function hasDependencyFailed(task: Task): boolean {
    return task.depends_on.some(dep => failed.has(dep));
  }

  function canStart(task: Task, running: Set<string>): boolean {
    if (task.depends_on.some(dep => !completed.has(dep))) return false;
    for (const rid of running) {
      if (conflictPairs.has(`${task.id}:${rid}`)) return false;
    }
    return true;
  }

  const pending = new Map(tasks.map(t => [t.id, t]));
  const running = new Map<string, Promise<Task>>();

  await log(flooDir, 'batch-start', {
    total: tasks.length,
    task_ids: tasks.map(t => t.id),
    conflicts: conflicts.length,
  });

  while (pending.size > 0 || running.size > 0) {
    // graceful shutdown:不再 dispatch 新任务,等已 running 的自然结束
    if (opts.signal?.aborted && pending.size > 0) {
      await log(flooDir, 'batch-aborting', { pending: [...pending.keys()] });
      for (const [, task] of pending) {
        task.status = 'cancelled';
        task.current_phase = null;
        await saveTask(flooDir, task);
        results.push(task);
      }
      pending.clear();
    }

    // 失败传播
    for (const [id, task] of pending) {
      if (hasDependencyFailed(task)) {
        pending.delete(id);
        task.status = 'failed';
        task.current_phase = null;
        await saveTask(flooDir, task);
        failed.add(id);
        results.push(task);
        await log(flooDir, 'dependency-failed', { task: id, failed_deps: task.depends_on.filter(d => failed.has(d)) });
      }
    }

    // dispatch 可启动任务(受 max_agents 上限约束)
    const runningIds = new Set(running.keys());
    for (const [id, task] of pending) {
      if (running.size >= config.concurrency.max_agents) break;
      if (canStart(task, runningIds)) {
        pending.delete(id);
        runningIds.add(id);
        await log(flooDir, 'parallel-dispatch', { task: id });

        const promise = runTask(task, 'coder', opts).then(result => {
          if (result.status === 'completed') completed.add(id);
          else failed.add(id);
          return result;
        }).catch(async (err) => {
          await log(flooDir, 'parallel-crash', { task: id, error: String(err) });
          task.status = 'failed';
          task.current_phase = null;
          await saveTask(flooDir, task);
          failed.add(id);
          return task;
        });
        running.set(id, promise);
      }
    }

    if (running.size === 0 && pending.size > 0) {
      // 死锁:有 pending 任务但全被依赖卡住
      await log(flooDir, 'deadlock', { pending: [...pending.keys()] });
      for (const [id, task] of pending) {
        task.status = 'failed';
        task.current_phase = null;
        await saveTask(flooDir, task);
        failed.add(id);
        results.push(task);
      }
      pending.clear();
      await log(flooDir, 'deadlock-resolved', { action: 'all_pending_failed' });
    }

    // 等任意一个 running 完成
    if (running.size > 0) {
      const settled = await Promise.race(
        [...running.entries()].map(([id, p]) => p.then(r => ({ id, result: r }))),
      );
      running.delete(settled.id);
      results.push(settled.result);
      await log(flooDir, 'parallel-done', {
        task: settled.id,
        status: settled.result.status,
        remaining: pending.size + running.size,
      });
    }
  }

  return results;
}

// ============================================================
// createAndRun:批次入口
// ============================================================

/**
 * 创建批次和任务,启动执行。这是 `floo run` 的核心入口。
 *
 * 流程:
 *   1. coder/reviewer/tester 起步:跳过 planner,直接 runTask
 *   2. discuss/designer 起步:走飞轮(designer 反馈 blocker → 回 discuss round 2)
 *   3. planner 完成:consumePlannerOutput 拆子任务 → runBatch 并行调度
 */
export async function createAndRun(
  description: string,
  startPhase: Phase,
  opts: DispatcherOptions & { scope?: string[] },
): Promise<{ batch: Batch; tasks: Task[] }> {
  const { projectRoot } = opts;
  const config = opts.config ?? DEFAULT_CONFIG;
  const flooDir = await ensureFlooDir(projectRoot);

  // batch 与 task ID 生成
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const timeSlug = now.toISOString().slice(11, 19).replace(/:/g, '');
  const descSlug = description.slice(0, 30).replace(/[^a-zA-Z0-9一-鿿]/g, '-').replace(/-+/g, '-');
  const randomSuffix = Math.random().toString(36).slice(2, 6);
  const batchId = `${date}-${timeSlug}-${randomSuffix}-${descSlug}`;
  const batchToken = deriveBatchToken(batchId);
  const mainTaskId = `${batchToken}-001`;

  const batch: Batch = {
    id: batchId,
    description,
    status: 'active',
    tasks: [mainTaskId],
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  await saveBatch(flooDir, batch);

  const mainTask: Task = {
    id: mainTaskId,
    batch_id: batchId,
    description,
    status: 'pending',
    current_phase: null,
    scope: opts.scope ?? [],
    acceptance_criteria: [],
    review_level: 'full',
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    depends_on: [],
  };
  await saveTask(flooDir, mainTask);

  // Step 1 镜像 plan:落盘开局快照,dispatcher 不消费,仅作 ledger 锚点
  try {
    const initialPlan = synthesizeInitialPlan({ batch, task: mainTask, startPhase, config });
    await writePlan(flooDir, initialPlan);
  } catch (err) {
    await log(flooDir, 'plan-mirror-write-failed', { batch: batchId, error: String(err) });
  }

  await notify(flooDir, 'task_started', { batch_id: batchId, task_id: mainTask.id, description });

  // 记录 batch 创建时的 HEAD,用于 summary review 的 diff 基线
  const signalsDir = join(flooDir, 'signals');
  await mkdir(signalsDir, { recursive: true });
  let batchBaseHead = '';
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: projectRoot });
    batchBaseHead = stdout.trim();
  } catch { /* 新仓库无 HEAD */ }
  await writeFile(join(signalsDir, `${batchId}-batch.base-head`), batchBaseHead);

  /** 基础设施异常兜底:确保 task/batch 不会停留在 running/active 脏状态 */
  async function failBatch(error: unknown): Promise<{ batch: Batch; tasks: Task[] }> {
    await log(flooDir, 'createAndRun-crash', { batch: batchId, error: String(error) });
    mainTask.status = 'failed';
    mainTask.current_phase = null;
    await saveTask(flooDir, mainTask);
    batch.status = 'failed';
    await saveBatch(flooDir, batch);
    return { batch, tasks: [mainTask] };
  }

  try {
    return await runBatchEntry(startPhase, opts, batch, mainTask, batchId, config, flooDir, projectRoot);
  } catch (err) {
    return failBatch(err);
  }
}

// ============================================================
// 批次入口的核心调度(从 createAndRun 抽出,降低单函数嵌套)
// ============================================================

/**
 * createAndRun 的核心调度部分。
 * 拆出来为了:
 *   1. 让 createAndRun 顶层 try/catch 保持薄
 *   2. 后续把飞轮 / planner 拆分搬到 executor 子模块时,这里是切换点
 */
async function runBatchEntry(
  startPhase: Phase,
  opts: DispatcherOptions & { scope?: string[] },
  batch: Batch,
  mainTask: Task,
  batchId: string,
  config: FlooConfig,
  flooDir: string,
  projectRoot: string,
): Promise<{ batch: Batch; tasks: Task[] }> {
  const { adapters } = opts;

  // coder 或更后的 phase 起步:跳过 planner,直接 runTask
  const startIdx = PHASE_ORDER.indexOf(startPhase);
  const coderIdx = PHASE_ORDER.indexOf('coder');
  if (startIdx >= coderIdx) {
    // reviewer/tester 是单 phase 任务;coder 跑完整 coder→reviewer→tester
    const endPhase = startPhase === 'coder' ? undefined : startPhase;
    const result = await runTask(mainTask, startPhase, opts, endPhase);
    batch.status = result.status === 'completed' ? 'completed'
      : result.status === 'cancelled' ? 'cancelled'
      : 'failed';
    await saveBatch(flooDir, batch);

    if (result.status === 'completed' && startPhase === 'coder') {
      await runBatchSummaryReview(flooDir, batch, [result], config, projectRoot, opts.adapters);
    }

    await notify(flooDir, 'batch_completed', {
      batch_id: batchId, task_id: mainTask.id,
      status: batch.status, total_tasks: 1,
      completed: result.status === 'completed' ? 1 : 0,
      failed: result.status === 'failed' ? 1 : 0,
    });
    return { batch, tasks: [result] };
  }

  // ——— 前置 phase 链 (discuss/designer/planner) ———
  mainTask.status = 'running';
  await saveTask(flooDir, mainTask);

  // runCounter 跨 phase 递增,保证 runs/ 目录下每条记录的 ID 有序
  let preRunCounter = 0;

  /** 前置 phase 失败统一兜底 */
  const failOnPhase = async (
    exitCode: number | undefined,
    phase: Phase,
  ): Promise<{ batch: Batch; tasks: Task[] }> => {
    const wasCancelled = exitCode === -1;
    mainTask.status = wasCancelled ? 'cancelled' : 'failed';
    await saveTask(flooDir, mainTask);
    batch.status = wasCancelled ? 'cancelled' : 'failed';
    await saveBatch(flooDir, batch);
    await notify(flooDir, 'task_completed', { batch_id: batchId, task_id: mainTask.id, status: mainTask.status, phase });
    await notify(flooDir, 'batch_completed', { batch_id: batchId, task_id: mainTask.id, status: batch.status, total_tasks: 1, completed: 0, failed: 1 });
    return { batch, tasks: [mainTask] };
  };

  /** 用户 Ctrl+C 时的统一兜底 */
  const cancelAndReturn = async (phase: Phase): Promise<{ batch: Batch; tasks: Task[] }> => {
    mainTask.status = 'cancelled';
    mainTask.current_phase = null;
    await saveTask(flooDir, mainTask);
    batch.status = 'cancelled';
    await saveBatch(flooDir, batch);
    await notify(flooDir, 'task_completed', { batch_id: batchId, task_id: mainTask.id, status: 'cancelled', phase });
    await notify(flooDir, 'batch_completed', { batch_id: batchId, task_id: mainTask.id, status: 'cancelled', total_tasks: 1, completed: 0, failed: 0 });
    return { batch, tasks: [mainTask] };
  };

  // ——— discuss + designer 飞轮 (startPhase 落 discuss/designer 时) ———
  if (startPhase === 'discuss' || startPhase === 'designer') {
    const maxDiscussRounds = config.limits?.max_discuss_rounds ?? MAX_DISCUSS_ROUNDS;
    // 从 discuss 开始:首轮必跑;从 designer 开始:用户自备 context,首轮不跑 discuss
    let discussRound = startPhase === 'discuss' ? 0 : 1;
    let designerRound = 0;

    while (true) {
      if (opts.signal?.aborted) return cancelAndReturn(designerRound > 0 ? 'designer' : 'discuss');

      const needDiscuss = (startPhase === 'discuss' && discussRound === 0) || designerRound > 0;
      if (needDiscuss) {
        if (discussRound >= maxDiscussRounds) {
          // 触达上限仍被反向质疑 → 把 design-questions 转成 design.md 兜底
          await log(flooDir, 'discuss-max-rounds-exceeded', { task: mainTask.id, rounds: discussRound });
          await fallbackDesignFromQuestions(projectRoot, flooDir, mainTask);
          await collectArtifact(projectRoot, flooDir, mainTask, 'designer');
          break;
        }
        discussRound++;
        mainTask.current_phase = 'discuss';
        await saveTask(flooDir, mainTask);
        await cleanStaleArtifact(projectRoot, 'discuss', mainTask.id);
        preRunCounter++;
        const discussResult = await executePhase(
          mainTask, 'discuss', config, flooDir, projectRoot, adapters, preRunCounter,
          { round: String(discussRound) },
        );
        if (!discussResult.success) {
          return failOnPhase(discussResult.exitArtifact?.exit_code, 'discuss');
        }
        await collectArtifact(projectRoot, flooDir, mainTask, 'discuss');
        if (opts.signal?.aborted) return cancelAndReturn('discuss');
      }

      // 跑 designer
      designerRound++;
      mainTask.current_phase = 'designer';
      await saveTask(flooDir, mainTask);
      await cleanStaleArtifact(projectRoot, 'designer', mainTask.id);
      await cleanStaleDesignQuestions(projectRoot, mainTask.id);
      preRunCounter++;
      const designResult = await executePhase(mainTask, 'designer', config, flooDir, projectRoot, adapters, preRunCounter);
      if (!designResult.success) {
        return failOnPhase(designResult.exitArtifact?.exit_code, 'designer');
      }

      const hadQuestions = await collectDesignQuestions(projectRoot, flooDir, mainTask);
      await collectArtifact(projectRoot, flooDir, mainTask, 'designer');

      if (opts.signal?.aborted) return cancelAndReturn('designer');

      // blocker 级反向质疑 → 触发回 discuss
      if (hadQuestions && await hasBlockerQuestions(flooDir, mainTask)) {
        await log(flooDir, 'discuss-rollback', {
          task: mainTask.id, designer_round: designerRound, next_discuss_round: discussRound + 1,
        });
        continue;
      }

      // 没 blocker:正常完成。若 designer 只产出 non-blocker questions 没 design.md,兜底
      const taskDir = join(flooDir, 'batches', batchId, 'tasks', mainTask.id);
      const designPresent = await access(join(taskDir, 'design.md')).then(() => true).catch(() => false);
      if (!designPresent) {
        await log(flooDir, 'designer-missing-design-md', { task: mainTask.id });
        await fallbackDesignFromQuestions(projectRoot, flooDir, mainTask);
        await collectArtifact(projectRoot, flooDir, mainTask, 'designer');
      }
      break;
    }
  }

  // ——— 跑 planner ———
  mainTask.current_phase = 'planner';
  await saveTask(flooDir, mainTask);
  await cleanStaleArtifact(projectRoot, 'planner', mainTask.id);
  preRunCounter++;
  const planResult = await executePhase(mainTask, 'planner', config, flooDir, projectRoot, adapters, preRunCounter);
  if (!planResult.success) {
    const wasCancelled = planResult.exitArtifact?.exit_code === -1;
    mainTask.status = wasCancelled ? 'cancelled' : 'failed';
    await saveTask(flooDir, mainTask);
    batch.status = wasCancelled ? 'cancelled' : 'failed';
    await saveBatch(flooDir, batch);
    await notify(flooDir, 'task_completed', { batch_id: batchId, task_id: mainTask.id, status: mainTask.status, phase: 'planner' });
    await notify(flooDir, 'batch_completed', { batch_id: batchId, task_id: mainTask.id, status: batch.status, total_tasks: 1, completed: 0, failed: 1 });
    return { batch, tasks: [mainTask] };
  }
  await collectArtifact(projectRoot, flooDir, mainTask, 'planner');

  // ——— 拆子任务 ———
  const subTasks = await consumePlannerOutput(flooDir, batch, mainTask);

  if (subTasks.length <= 1) {
    // 单任务:继续跑 coder → reviewer → tester
    const task = subTasks[0] ?? mainTask;
    const result = await runTask(task, 'coder', opts);
    batch.status = result.status === 'completed' ? 'completed'
      : result.status === 'cancelled' ? 'cancelled'
      : 'failed';
    await saveBatch(flooDir, batch);

    if (result.status === 'completed') {
      await runBatchSummaryReview(flooDir, batch, [result], config, projectRoot, adapters);
    }

    await notify(flooDir, 'batch_completed', {
      batch_id: batch.id, task_id: task.id,
      status: batch.status, total_tasks: 1,
      completed: result.status === 'completed' ? 1 : 0,
      failed: result.status === 'failed' ? 1 : 0,
    });
    return { batch, tasks: [result] };
  }

  // 多任务:并行调度。父任务标 completed,清 phase 防 status 残留
  mainTask.status = 'completed';
  mainTask.current_phase = null;
  await saveTask(flooDir, mainTask);

  const results = await runBatch(subTasks, opts);

  const allCompleted = results.every(t => t.status === 'completed');
  const anyFailed = results.some(t => t.status === 'failed');
  const allCancelledOrDone = results.every(t => t.status === 'completed' || t.status === 'cancelled');
  batch.status = allCompleted ? 'completed'
    : anyFailed ? 'failed'
    : allCancelledOrDone ? 'cancelled'
    : 'active';
  await saveBatch(flooDir, batch);

  // 全部完成才触发整体 review(避免失败任务的 commit 混进 summary diff)
  if (allCompleted) {
    await runBatchSummaryReview(flooDir, batch, results, config, projectRoot, adapters);
  }

  await notify(flooDir, 'batch_completed', {
    batch_id: batch.id, task_id: mainTask.id,
    status: batch.status, total_tasks: results.length,
    completed: results.filter(t => t.status === 'completed').length,
    failed: results.filter(t => t.status === 'failed').length,
  });

  return { batch, tasks: results };
}
