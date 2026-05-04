/**
 * Plan-driven 执行入口 (refactor Step 4a)
 *
 * 这个模块是 Floo 走向"plan as input"的入口点。它接受一份 PlanYaml(或路径),
 * 把执行图翻译为内部调度调用。
 *
 * 当前阶段(Step 4a):
 *   - PlanYaml.mode === 'legacy-dispatcher' 时,内部委托 dispatcher.createAndRun
 *     (因为 plan 里携带 start_phase + initial_task,信息齐全可还原成 dispatcher 入参)
 *   - 这是 facade,不是 reimplement;dispatcher 不动,所有现有测试一行不改
 *   - executor 的 API 形态先固化下来,后续 Step 4b 把状态机搬过来时保持外部兼容
 *
 * 未来阶段(Step 4b+):
 *   - 把 dispatcher 的 runTask / runBatch 状态机搬到这里
 *   - executor 直接消费 plan.steps[],不再走 PHASE_ORDER 硬编码
 *   - mode='executor' 路径上线
 *
 * 为什么不在 4a 直接搬代码:
 *   dispatcher.ts 1500+ 行,涉及飞轮 / 拓扑调度 / 重试 / 取消 / 通知 / lessons 等多重副作用,
 *   搬迁过程容易引入隐藏 bug 而测试覆盖不到。先把入口抽象 + 契约定下来,再分批迁移内部更稳。
 */

import type { Batch, Task } from './types.js';
import type { PlanYaml } from './plan.js';
import { readPlan } from './plan.js';
import { createAndRun, type DispatcherOptions } from './dispatcher.js';
import { join } from 'node:path';

/** runPlan 入参:沿用 DispatcherOptions,但允许通过 plan 携带的 scope 传入 */
export interface ExecutorOptions extends DispatcherOptions {
  /**
   * 是否允许 plan 里的 scope 覆盖 task.scope。
   * 默认 false:plan 镜像模式不允许越权,scope 仍以 plan.initial_task.scope 为准。
   */
  allowPlanScopeOverride?: boolean;
}

/** runPlan 返回结构,与 createAndRun 保持一致 */
export interface ExecutorResult {
  batch: Batch;
  tasks: Task[];
}

/**
 * 从 PlanYaml 执行一次 batch。
 *
 * 当 plan.mode === 'legacy-dispatcher':
 *   - 把 plan.description + plan.start_phase + plan.initial_task.scope 还原为 createAndRun 入参
 *   - dispatcher 内部的飞轮 / 状态机 / 拓扑调度全部沿用
 *   - 与直接 createAndRun(...) 完全等价(差别只是入口形态)
 *
 * 当 plan.mode === 'executor':
 *   - Step 4b 后才支持。当前抛 unsupported 错误。
 */
export async function runPlan(plan: PlanYaml, opts: ExecutorOptions): Promise<ExecutorResult> {
  if (plan.mode === 'legacy-dispatcher') {
    return createAndRun(plan.description, plan.start_phase, {
      ...opts,
      scope: plan.initial_task.scope,
    });
  }
  if (plan.mode === 'executor') {
    throw new Error(
      'executor 模式 plan 当前不被支持(Step 4b 落地后启用)。' +
        '请用 mode="legacy-dispatcher" 或直接调用 createAndRun。',
    );
  }
  throw new Error(`runPlan: 未知 plan.mode = ${(plan as { mode: string }).mode}`);
}

/**
 * 从磁盘读 plan.yaml 后执行。
 *
 * @param flooDir   .floo 目录绝对路径
 * @param batchId   batch ID,对应 .floo/batches/<batchId>/plan.yaml
 * @param opts      执行选项
 *
 * 用途:OpenClaw 等外部消费者可以"先 createAndRun 落 plan → 后续从 plan 续跑"。
 * Step 4b 后这条路径会变成主路径(executor 直接消费 plan)。
 */
export async function runPlanFromDisk(
  flooDir: string,
  batchId: string,
  opts: ExecutorOptions,
): Promise<ExecutorResult> {
  const plan = await readPlan(flooDir, batchId);
  if (!plan) {
    throw new Error(`runPlanFromDisk: 未找到 plan.yaml — 路径 ${join(flooDir, 'batches', batchId, 'plan.yaml')}`);
  }
  return runPlan(plan, opts);
}
