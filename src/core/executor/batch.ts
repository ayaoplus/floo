/**
 * Batch 入口与多任务调度
 *
 * createAndRun:`floo run` 的核心入口,负责创建 batch + initial task,
 *               根据 startPhase 分流到 simple path / 飞轮 / planner 拆分。
 * runBatch:    多 task 拓扑调度(scope 冲突避免 + 依赖检查 + 并发上限)。
 * runBatchEntry: createAndRun 中的飞轮 + planner 扩展逻辑(从 createAndRun 抽出来,
 *                降低嵌套并方便后续替换为 PlanState 驱动)。
 */

import { writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Batch, FlooConfig, Phase, Task } from '../types.js';
import {
  PHASE_ORDER,
  MAX_DISCUSS_ROUNDS,
  DEFAULT_CONFIG,
} from '../types.js';
import { ensureFlooDir, detectConflicts } from '../scope.js';
import { notify } from '../notifications.js';
import {
  synthesizeInitialPlan,
  materializeTemplate,
  writePlan,
  planHasComplexCapability,
  planHasDiscussDesignerLoop,
  planHasPlanner,
  planHasPlannerExpansion,
  type PlanTemplate,
} from '../plan.js';

import { log, saveTask, saveBatch, deriveBatchToken } from './io.js';
import {
  collectArtifact,
  cleanStaleArtifact,
  cleanStaleDesignQuestions,
  collectDesignQuestions,
  hasBlockerQuestions,
  fallbackDesignFromQuestions,
} from './artifacts.js';
import { consumePlannerOutput } from './planner.js';
import { executePhase } from './execute-step.js';
import { runBatchSummaryReview } from './summary.js';
import { runTask, runTaskFromSteps, type DispatcherOptions } from './state-machine.js';
import { planStepsToRunSteps } from './state.js';

const exec = promisify(execFile);

// ============================================================
// runBatch:多 task 拓扑调度
// ============================================================

/**
 * 并行执行多个任务(scope 无冲突的同时跑,有冲突的按依赖串行)。
 * 每个子任务从 coder 阶段开始(designer/planner 已在 batch 级别完成)。
 *
 * 失败传播:依赖的任务已 failed → 当前任务也标记 failed。
 * 死锁检测:有 pending 但全部依赖被阻塞 → 标记所有 pending failed。
 */
export async function runBatch(
  tasks: Task[],
  opts: DispatcherOptions,
): Promise<Task[]> {
  const { projectRoot } = opts;
  const config = opts.config ?? DEFAULT_CONFIG;
  const flooDir = await ensureFlooDir(projectRoot);

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
    // graceful shutdown:不再 dispatch 新任务,等已 running 自然结束
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
      // 死锁:有 pending 但全被依赖卡住
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
 * 分流(Step 4d 起 plan-driven):
 *   plan 缺省:走老路径 startPhase 推断(coder/reviewer/tester→simple path,
 *              否则飞轮+planner+拆分)
 *   plan 存在:按 plan 拓扑判断
 *     - 仅 coder/reviewer/tester capability       → simple path
 *     - 含 discuss step + loop_with: designer     → 飞轮
 *     - 含 capability='planner' step              → 跑 planner
 *     - 含 defer_after='planner' step             → planner 后拆 task
 */
export async function createAndRun(
  description: string,
  startPhase: Phase,
  opts: DispatcherOptions & {
    scope?: string[];
    endPhase?: Phase;
    /**
     * 可选 plan 模板。Step 4d 起 simple path 与 complex path 均消费 plan.steps:
     *   - simple path 用 plan.steps 驱动 step 序列,不再从 PHASE_ORDER 派生
     *   - complex path 用 plan 中的 loop_with / defer_after / capability 判断分支
     * 不传 plan 时沿用老 startPhase 推断,行为与 4d 落地前一致。
     */
    plan?: PlanTemplate;
  },
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

  // 落盘 plan.yaml:
  //   - 有 opts.plan(--mode 模板路径):用 materializeTemplate 把模板物化成实际执行的 plan,
  //     plan.steps 等于真正会跑的 step 序列(codex review #2 修复——避免 plan.yaml 与
  //     实际执行序列脱节,导致 Step 6 plan-patch 在错的图上 apply)
  //   - 无 opts.plan(老路径):synthesizeInitialPlan 生成 6 阶段镜像兜底
  try {
    const initialPlan = opts.plan
      ? materializeTemplate({ template: opts.plan, batch, task: mainTask, config })
      : synthesizeInitialPlan({ batch, task: mainTask, startPhase, config });
    await writePlan(flooDir, initialPlan);
  } catch (err) {
    await log(flooDir, 'plan-mirror-write-failed', { batch: batchId, error: String(err) });
  }

  await notify(flooDir, 'task_started', { batch_id: batchId, task_id: mainTask.id, description });

  // 记录 batch 创建时的 HEAD(供 summary review diff 基线)
  const signalsDir = join(flooDir, 'signals');
  await mkdir(signalsDir, { recursive: true });
  let batchBaseHead = '';
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: projectRoot });
    batchBaseHead = stdout.trim();
  } catch { /* 新仓库无 HEAD */ }
  await writeFile(join(signalsDir, `${batchId}-batch.base-head`), batchBaseHead);

  /** 基础设施异常兜底:确保 task/batch 不停留在脏状态 */
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
// runBatchEntry:createAndRun 核心调度(飞轮 + planner 拆分)
// ============================================================

async function runBatchEntry(
  startPhase: Phase,
  opts: DispatcherOptions & { scope?: string[]; endPhase?: Phase; plan?: PlanTemplate },
  batch: Batch,
  mainTask: Task,
  batchId: string,
  config: FlooConfig,
  flooDir: string,
  projectRoot: string,
): Promise<{ batch: Batch; tasks: Task[] }> {
  const { adapters, plan } = opts;

  // ---- 分支判定 (Step 4d):plan 优先,缺省时 fallback 到 startPhase 推断 ----
  //
  // 规则:plan 中的拓扑结构是行为来源——
  //   simple path  = plan 不含 discuss/designer/planner 中任何一个 capability
  //   飞轮        = plan 含 discuss step,且与某个 designer step 互为 loop_with
  //   planner step = plan 含 capability='planner' 的 step
  //   拆分        = plan 含 defer_after='planner' 的 step
  //
  // 不传 plan 时(`floo run` 不带 --mode)沿用老 startPhase 推断,与 4d 落地前
  // 行为完全一致——避免回归。
  const startIdx = PHASE_ORDER.indexOf(startPhase);
  const coderIdx = PHASE_ORDER.indexOf('coder');
  const isSimple = plan ? !planHasComplexCapability(plan) : (startIdx >= coderIdx);
  if (isSimple) {
    return runSimplePath(startPhase, opts, batch, mainTask, batchId, config, flooDir, projectRoot);
  }

  // 复杂 path:前置 phase 链 (discuss/designer/planner)
  mainTask.status = 'running';
  await saveTask(flooDir, mainTask);

  // runCounter 跨 phase 递增,保证 runs/ 目录下每条记录的 ID 有序
  const ctx: WheelCtx = { preRunCounter: 0, batch, mainTask, batchId, config, flooDir, projectRoot, adapters, opts };

  // 飞轮:plan 中 loop_with 关系优先,fallback 到 startPhase
  const shouldWheel = plan
    ? planHasDiscussDesignerLoop(plan)
    : (startPhase === 'discuss' || startPhase === 'designer');
  if (shouldWheel) {
    const wheelResult = await runDiscussDesignerWheel(startPhase, ctx);
    if (wheelResult) return wheelResult;
  }

  // planner:plan 显式声明才跑;无 plan 时沿用老路径(必跑)
  const shouldPlanner = plan ? planHasPlanner(plan) : true;
  if (shouldPlanner) {
    const plannerResult = await runPlannerStep(ctx);
    if ('return' in plannerResult) return plannerResult.return;
  }

  // 拆分:plan 中有 defer_after: planner 的 step;无 plan 时沿用老路径(必拆分)
  const shouldExpand = plan ? planHasPlannerExpansion(plan) : true;
  if (shouldExpand) {
    return runPostPlannerExpansion(ctx);
  }

  // wheel 或 planner 已经跑过 + 没拆分需求:直接收尾(避免重复 spawn 已跑的 phase)
  if (shouldWheel || shouldPlanner) {
    return finalizeBatchSuccess(ctx);
  }

  // 三个分支都没触发(自定义 designer-only / discuss+designer 无 loop_with 等):
  // 退化为 simple path,通过 runTaskFromSteps 按 plan.steps 顺序逐个 phase 跑。
  // runStateMachine 是 phase-agnostic 的,可以处理 designer / discuss / planner 等任意 phase。
  return runSimplePath(startPhase, opts, batch, mainTask, batchId, config, flooDir, projectRoot);
}

/** 复杂 path 走完没有 planner/expansion 时的统一收尾(主任务标 completed + batch.status) */
async function finalizeBatchSuccess(ctx: WheelCtx): Promise<{ batch: Batch; tasks: Task[] }> {
  ctx.mainTask.status = 'completed';
  ctx.mainTask.current_phase = null;
  await saveTask(ctx.flooDir, ctx.mainTask);
  ctx.batch.status = 'completed';
  await saveBatch(ctx.flooDir, ctx.batch);
  await notify(ctx.flooDir, 'task_completed',
    { batch_id: ctx.batchId, task_id: ctx.mainTask.id, status: 'completed', phase: null });
  await notify(ctx.flooDir, 'batch_completed',
    { batch_id: ctx.batchId, task_id: ctx.mainTask.id, status: 'completed', total_tasks: 1, completed: 1, failed: 0 });
  return { batch: ctx.batch, tasks: [ctx.mainTask] };
}

// ============================================================
// 子流程:simple path(coder/reviewer/tester 起步)
// ============================================================

async function runSimplePath(
  startPhase: Phase,
  opts: DispatcherOptions & { scope?: string[]; endPhase?: Phase; plan?: PlanTemplate },
  batch: Batch,
  mainTask: Task,
  batchId: string,
  config: FlooConfig,
  flooDir: string,
  projectRoot: string,
): Promise<{ batch: Batch; tasks: Task[] }> {
  // 优先级:opts.plan(plan-driven) > opts.endPhase(--mode tiny/quick 旧路径) > 默认推断
  let result: Task;
  if (opts.plan) {
    // plan-driven:plan.yaml 真正决定 step 序列
    const runSteps = planStepsToRunSteps(opts.plan.steps);
    if (runSteps.length === 0) {
      throw new Error(`runSimplePath: plan "${opts.plan.name}" 没有可执行 step(deferred 占位被全部过滤)`);
    }
    result = await runTaskFromSteps(mainTask, runSteps, opts);
  } else {
    // 兼容路径:沿用 (startPhase, endPhase) 推断
    const endPhase = opts.endPhase ?? (startPhase === 'coder' ? undefined : startPhase);
    result = await runTask(mainTask, startPhase, opts, endPhase);
  }
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

// ============================================================
// 子流程:飞轮 + planner + 拆分(共享上下文)
// ============================================================

interface WheelCtx {
  preRunCounter: number;
  batch: Batch;
  mainTask: Task;
  batchId: string;
  config: FlooConfig;
  flooDir: string;
  projectRoot: string;
  adapters: Record<string, AgentAdapterRecord>;
  opts: DispatcherOptions & { scope?: string[] };
}

// 单独 alias 让 import 更清晰
type AgentAdapterRecord = Parameters<typeof executePhase>[5][string];

/** 前置 phase 失败统一兜底 */
async function failOnPhase(
  ctx: WheelCtx,
  exitCode: number | undefined,
  phase: Phase,
): Promise<{ batch: Batch; tasks: Task[] }> {
  const wasCancelled = exitCode === -1;
  ctx.mainTask.status = wasCancelled ? 'cancelled' : 'failed';
  await saveTask(ctx.flooDir, ctx.mainTask);
  ctx.batch.status = wasCancelled ? 'cancelled' : 'failed';
  await saveBatch(ctx.flooDir, ctx.batch);
  await notify(ctx.flooDir, 'task_completed', { batch_id: ctx.batchId, task_id: ctx.mainTask.id, status: ctx.mainTask.status, phase });
  await notify(ctx.flooDir, 'batch_completed', { batch_id: ctx.batchId, task_id: ctx.mainTask.id, status: ctx.batch.status, total_tasks: 1, completed: 0, failed: 1 });
  return { batch: ctx.batch, tasks: [ctx.mainTask] };
}

/** 用户 Ctrl+C 时的统一兜底 */
async function cancelAndReturn(ctx: WheelCtx, phase: Phase): Promise<{ batch: Batch; tasks: Task[] }> {
  ctx.mainTask.status = 'cancelled';
  ctx.mainTask.current_phase = null;
  await saveTask(ctx.flooDir, ctx.mainTask);
  ctx.batch.status = 'cancelled';
  await saveBatch(ctx.flooDir, ctx.batch);
  await notify(ctx.flooDir, 'task_completed', { batch_id: ctx.batchId, task_id: ctx.mainTask.id, status: 'cancelled', phase });
  await notify(ctx.flooDir, 'batch_completed', { batch_id: ctx.batchId, task_id: ctx.mainTask.id, status: 'cancelled', total_tasks: 1, completed: 0, failed: 0 });
  return { batch: ctx.batch, tasks: [ctx.mainTask] };
}

/** discuss + designer 飞轮。返回 truthy 表示中途失败/取消,直接出顶层 */
async function runDiscussDesignerWheel(
  startPhase: Phase,
  ctx: WheelCtx,
): Promise<{ batch: Batch; tasks: Task[] } | null> {
  const maxDiscussRounds = ctx.config.limits?.max_discuss_rounds ?? MAX_DISCUSS_ROUNDS;
  // discuss 起步:首轮必跑;designer 起步:用户自备 context,首轮不跑 discuss
  let discussRound = startPhase === 'discuss' ? 0 : 1;
  let designerRound = 0;

  while (true) {
    if (ctx.opts.signal?.aborted) return cancelAndReturn(ctx, designerRound > 0 ? 'designer' : 'discuss');

    const needDiscuss = (startPhase === 'discuss' && discussRound === 0) || designerRound > 0;
    if (needDiscuss) {
      if (discussRound >= maxDiscussRounds) {
        // 触达上限仍被反向质疑 → 把 design-questions 转成 design.md 兜底
        await log(ctx.flooDir, 'discuss-max-rounds-exceeded', { task: ctx.mainTask.id, rounds: discussRound });
        await fallbackDesignFromQuestions(ctx.projectRoot, ctx.flooDir, ctx.mainTask);
        await collectArtifact(ctx.projectRoot, ctx.flooDir, ctx.mainTask, 'designer');
        break;
      }
      discussRound++;
      ctx.mainTask.current_phase = 'discuss';
      await saveTask(ctx.flooDir, ctx.mainTask);
      await cleanStaleArtifact(ctx.projectRoot, 'discuss', ctx.mainTask.id);
      ctx.preRunCounter++;
      const discussResult = await executePhase(
        ctx.mainTask, 'discuss', ctx.config, ctx.flooDir, ctx.projectRoot, ctx.adapters, ctx.preRunCounter,
        { round: String(discussRound) },
      );
      if (!discussResult.success) {
        return failOnPhase(ctx, discussResult.exitArtifact?.exit_code, 'discuss');
      }
      await collectArtifact(ctx.projectRoot, ctx.flooDir, ctx.mainTask, 'discuss');
      if (ctx.opts.signal?.aborted) return cancelAndReturn(ctx, 'discuss');
    }

    // 跑 designer
    designerRound++;
    ctx.mainTask.current_phase = 'designer';
    await saveTask(ctx.flooDir, ctx.mainTask);
    await cleanStaleArtifact(ctx.projectRoot, 'designer', ctx.mainTask.id);
    await cleanStaleDesignQuestions(ctx.projectRoot, ctx.mainTask.id);
    ctx.preRunCounter++;
    const designResult = await executePhase(ctx.mainTask, 'designer', ctx.config, ctx.flooDir, ctx.projectRoot, ctx.adapters, ctx.preRunCounter);
    if (!designResult.success) {
      return failOnPhase(ctx, designResult.exitArtifact?.exit_code, 'designer');
    }

    const hadQuestions = await collectDesignQuestions(ctx.projectRoot, ctx.flooDir, ctx.mainTask);
    await collectArtifact(ctx.projectRoot, ctx.flooDir, ctx.mainTask, 'designer');

    if (ctx.opts.signal?.aborted) return cancelAndReturn(ctx, 'designer');

    // blocker 级反向质疑 → 触发回 discuss
    if (hadQuestions && await hasBlockerQuestions(ctx.flooDir, ctx.mainTask)) {
      await log(ctx.flooDir, 'discuss-rollback', {
        task: ctx.mainTask.id, designer_round: designerRound, next_discuss_round: discussRound + 1,
      });
      continue;
    }

    // 没 blocker:正常完成。若 designer 只产 non-blocker questions 没 design.md,兜底
    const taskDir = join(ctx.flooDir, 'batches', ctx.batchId, 'tasks', ctx.mainTask.id);
    const designPresent = await access(join(taskDir, 'design.md')).then(() => true).catch(() => false);
    if (!designPresent) {
      await log(ctx.flooDir, 'designer-missing-design-md', { task: ctx.mainTask.id });
      await fallbackDesignFromQuestions(ctx.projectRoot, ctx.flooDir, ctx.mainTask);
      await collectArtifact(ctx.projectRoot, ctx.flooDir, ctx.mainTask, 'designer');
    }
    break;
  }
  return null;
}

/** planner 单 phase 执行 */
async function runPlannerStep(
  ctx: WheelCtx,
): Promise<{ ok: true } | { return: { batch: Batch; tasks: Task[] } }> {
  ctx.mainTask.current_phase = 'planner';
  await saveTask(ctx.flooDir, ctx.mainTask);
  await cleanStaleArtifact(ctx.projectRoot, 'planner', ctx.mainTask.id);
  ctx.preRunCounter++;
  const planResult = await executePhase(ctx.mainTask, 'planner', ctx.config, ctx.flooDir, ctx.projectRoot, ctx.adapters, ctx.preRunCounter);
  if (!planResult.success) {
    const wasCancelled = planResult.exitArtifact?.exit_code === -1;
    ctx.mainTask.status = wasCancelled ? 'cancelled' : 'failed';
    await saveTask(ctx.flooDir, ctx.mainTask);
    ctx.batch.status = wasCancelled ? 'cancelled' : 'failed';
    await saveBatch(ctx.flooDir, ctx.batch);
    await notify(ctx.flooDir, 'task_completed', { batch_id: ctx.batchId, task_id: ctx.mainTask.id, status: ctx.mainTask.status, phase: 'planner' });
    await notify(ctx.flooDir, 'batch_completed', { batch_id: ctx.batchId, task_id: ctx.mainTask.id, status: ctx.batch.status, total_tasks: 1, completed: 0, failed: 1 });
    return { return: { batch: ctx.batch, tasks: [ctx.mainTask] } };
  }
  await collectArtifact(ctx.projectRoot, ctx.flooDir, ctx.mainTask, 'planner');
  return { ok: true };
}

/** planner 后:拆子任务 + 跑 coder/reviewer/tester */
async function runPostPlannerExpansion(ctx: WheelCtx): Promise<{ batch: Batch; tasks: Task[] }> {
  const subTasks = await consumePlannerOutput(ctx.flooDir, ctx.batch, ctx.mainTask);

  if (subTasks.length <= 1) {
    // 单任务:继续跑 coder → reviewer → tester
    const task = subTasks[0] ?? ctx.mainTask;
    const result = await runTask(task, 'coder', ctx.opts);
    ctx.batch.status = result.status === 'completed' ? 'completed'
      : result.status === 'cancelled' ? 'cancelled'
      : 'failed';
    await saveBatch(ctx.flooDir, ctx.batch);

    if (result.status === 'completed') {
      await runBatchSummaryReview(ctx.flooDir, ctx.batch, [result], ctx.config, ctx.projectRoot, ctx.adapters);
    }

    await notify(ctx.flooDir, 'batch_completed', {
      batch_id: ctx.batch.id, task_id: task.id,
      status: ctx.batch.status, total_tasks: 1,
      completed: result.status === 'completed' ? 1 : 0,
      failed: result.status === 'failed' ? 1 : 0,
    });
    return { batch: ctx.batch, tasks: [result] };
  }

  // 多任务:并行调度
  ctx.mainTask.status = 'completed';
  ctx.mainTask.current_phase = null;
  await saveTask(ctx.flooDir, ctx.mainTask);

  const results = await runBatch(subTasks, ctx.opts);

  const allCompleted = results.every(t => t.status === 'completed');
  const anyFailed = results.some(t => t.status === 'failed');
  const allCancelledOrDone = results.every(t => t.status === 'completed' || t.status === 'cancelled');
  ctx.batch.status = allCompleted ? 'completed'
    : anyFailed ? 'failed'
    : allCancelledOrDone ? 'cancelled'
    : 'active';
  await saveBatch(ctx.flooDir, ctx.batch);

  if (allCompleted) {
    await runBatchSummaryReview(ctx.flooDir, ctx.batch, results, ctx.config, ctx.projectRoot, ctx.adapters);
  }

  await notify(ctx.flooDir, 'batch_completed', {
    batch_id: ctx.batch.id, task_id: ctx.mainTask.id,
    status: ctx.batch.status, total_tasks: results.length,
    completed: results.filter(t => t.status === 'completed').length,
    failed: results.filter(t => t.status === 'failed').length,
  });

  return { batch: ctx.batch, tasks: results };
}
