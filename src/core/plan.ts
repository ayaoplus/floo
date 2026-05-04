/**
 * Plan 数据模型与 IO
 *
 * Step 1 (镜像模式):
 *   每次 createAndRun 入口落一份 .floo/batches/<batchId>/plan.yaml,
 *   内容是基于 startPhase + role config 推断的开局快照,
 *   dispatcher 不消费它,仅作为 ledger 锚点 + 后续 Step 4 executor 的接入点。
 *
 *   - planner 拆 task 之后,task.json 才是真实状态,plan.yaml 不更新。
 *   - mode='legacy-dispatcher' 标记当前是镜像快照,Step 4 之后会出现 mode='executor'。
 */

import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
  PHASE_ORDER,
  type Batch,
  type FlooConfig,
  type Phase,
  type Runtime,
  type Task,
} from './types.js';

// ============================================================
// 类型
// ============================================================

/** plan step 状态:Step 1 镜像里只有 pending / deferred 两种 */
export type PlanStepStatus =
  | 'pending'    // 已知会被执行(在 startPhase 到 planner 之间的 phase)
  | 'deferred';  // 占位,planner 拆 task 完成后才能确定具体 scope/数量

/** 一个 plan step——目标态对应 capability 节点,Step 1 镜像里 capability 字段就是 Phase */
export interface PlanStep {
  /** 节点 ID(如 'discuss'、'designer'、'implement-deferred')。不与外部 taskId 冲突 */
  id: string;
  /** 当前阶段 capability 字段直接复用 Phase 名,Step 3 frontmatter 落地后语义统一 */
  capability: Phase;
  runtime: Runtime;
  model: string;
  depends_on: string[];
  scope: string[];
  status: PlanStepStatus;
  /** 可选说明,例如 'planner 拆 task 后填充' */
  notes?: string;
}

/** plan.yaml 顶层结构 */
export interface PlanYaml {
  /** schema 版本号,后续不兼容变更要 bump */
  schema_version: 1;
  batch_id: string;
  created_at: string;
  description: string;
  /**
   * 镜像模式:Step 1 ~ Step 3 都是 'legacy-dispatcher',Step 4 落 executor 后变成 'executor'。
   * 这个字段告诉 UI/外部消费者"这份 plan 是不是被实际执行驱动"。
   */
  mode: 'legacy-dispatcher' | 'executor';
  /** router 选定的起点(短路 / 飞轮 / 全流程都靠它推断 step 草图) */
  start_phase: Phase;
  /** 主任务的开局快照(planner 拆 task 后,task.json 才是真实源) */
  initial_task: {
    id: string;
    scope: string[];
    acceptance_criteria: string[];
    review_level: 'full' | 'scan' | 'skip';
    depends_on: string[];
  };
  /** 推断的 step 序列。Step 1 不动态更新 */
  steps: PlanStep[];
  /** 给读者的提醒,例如说明这份 plan 是镜像还是事实源 */
  notes: string[];
}

// ============================================================
// 草图合成
// ============================================================

/**
 * 根据 phase + 角色配置生成单个 step。
 *
 * 当前 phase 配置查找顺序:task.role_overrides > config.roles > 抛错(角色必须有)。
 * Step 1 镜像里只用 config.roles(主任务级 override 在 task.role_overrides,但 Step 1 不读它,
 * 因为镜像目的就是反映"现在的默认绑定",不是回溯 dispatcher 实际选择)。
 */
function buildStep(args: {
  id: string;
  phase: Phase;
  config: FlooConfig;
  dependsOn: string[];
  scope: string[];
  status: PlanStepStatus;
  notes?: string;
}): PlanStep {
  const role = args.config.roles[args.phase];
  if (!role) {
    throw new Error(`plan: 角色 ${args.phase} 未在配置中定义`);
  }
  return {
    id: args.id,
    capability: args.phase,
    runtime: role.runtime,
    model: role.model,
    depends_on: args.dependsOn,
    scope: args.scope,
    status: args.status,
    ...(args.notes ? { notes: args.notes } : {}),
  };
}

/**
 * 基于 startPhase 推断 step 草图,镜像 dispatcher.ts:1438-1499 的现有控制流。
 *
 *   reviewer/tester 起步 → 单步
 *   coder 起步         → coder → reviewer → tester
 *   discuss/designer/planner 起步 → 该起点 ... planner,然后 deferred 占位
 *
 * Step 1 的 step.id 用 phase 名(独立任务的 deferred 占位用 'implement-deferred' 等),
 * 这是临时命名,Step 4 之后会用真正的 task-级 id。
 */
function synthesizeSteps(args: {
  startPhase: Phase;
  taskScope: string[];
  config: FlooConfig;
}): PlanStep[] {
  const { startPhase, taskScope, config } = args;
  const steps: PlanStep[] = [];

  // case 1: reviewer / tester 单步
  if (startPhase === 'reviewer' || startPhase === 'tester') {
    steps.push(
      buildStep({
        id: startPhase,
        phase: startPhase,
        config,
        dependsOn: [],
        scope: taskScope,
        status: 'pending',
      }),
    );
    return steps;
  }

  // case 2: coder 三步(coder → reviewer → tester)
  if (startPhase === 'coder') {
    steps.push(buildStep({ id: 'coder', phase: 'coder', config, dependsOn: [], scope: taskScope, status: 'pending' }));
    steps.push(buildStep({ id: 'reviewer', phase: 'reviewer', config, dependsOn: ['coder'], scope: taskScope, status: 'pending' }));
    steps.push(buildStep({ id: 'tester', phase: 'tester', config, dependsOn: ['coder', 'reviewer'], scope: taskScope, status: 'pending' }));
    return steps;
  }

  // case 3: discuss / designer / planner 起步——前置 phase 串成线性,planner 之后用 deferred 占位
  const startIdx = PHASE_ORDER.indexOf(startPhase);
  const plannerIdx = PHASE_ORDER.indexOf('planner');
  let prevId: string | null = null;
  for (let i = startIdx; i <= plannerIdx; i++) {
    const phase = PHASE_ORDER[i];
    const id = phase;
    steps.push(
      buildStep({
        id,
        phase,
        config,
        dependsOn: prevId ? [prevId] : [],
        // 前置 phase(discuss/designer/planner)是 artifacts_only 性质,scope 留空
        scope: [],
        status: 'pending',
      }),
    );
    prevId = id;
  }

  // planner 之后:用 implement/review/test 三个 deferred 占位
  // 实际数量与具体 scope 由 planner 拆 task 后才确定,task.json 才是真实源
  const deferredNote = 'planner 拆 task 后由 task.json 反映真实 step,plan.yaml 镜像不更新';
  steps.push(
    buildStep({
      id: 'implement-deferred',
      phase: 'coder',
      config,
      dependsOn: prevId ? [prevId] : [],
      scope: taskScope,
      status: 'deferred',
      notes: deferredNote,
    }),
  );
  steps.push(
    buildStep({
      id: 'review-deferred',
      phase: 'reviewer',
      config,
      dependsOn: ['implement-deferred'],
      scope: taskScope,
      status: 'deferred',
      notes: deferredNote,
    }),
  );
  steps.push(
    buildStep({
      id: 'test-deferred',
      phase: 'tester',
      config,
      dependsOn: ['implement-deferred', 'review-deferred'],
      scope: taskScope,
      status: 'deferred',
      notes: deferredNote,
    }),
  );

  return steps;
}

/**
 * 基于 batch + initial task + startPhase 合成开局 plan.yaml 内容。
 *
 * 不副作用,纯函数,便于测试。
 */
export function synthesizeInitialPlan(args: {
  batch: Batch;
  task: Task;
  startPhase: Phase;
  config: FlooConfig;
}): PlanYaml {
  const { batch, task, startPhase, config } = args;
  return {
    schema_version: 1,
    batch_id: batch.id,
    created_at: batch.created_at,
    description: batch.description,
    mode: 'legacy-dispatcher',
    start_phase: startPhase,
    initial_task: {
      id: task.id,
      scope: task.scope,
      acceptance_criteria: task.acceptance_criteria,
      review_level: task.review_level,
      depends_on: task.depends_on,
    },
    steps: synthesizeSteps({ startPhase, taskScope: task.scope, config }),
    notes: [
      'Step 1 镜像 plan:dispatcher 不消费,仅作为 ledger/UI 锚点',
      'planner 拆 task 后,真实状态以 .floo/batches/<id>/tasks/<taskId>/task.json 为准',
      'mode 字段在 Step 4 落 executor 后会变成 "executor"',
    ],
  };
}

// ============================================================
// 落盘 / 读取
// ============================================================

/** plan.yaml 在 .floo 目录下的路径 */
export function planYamlPath(flooDir: string, batchId: string): string {
  return join(flooDir, 'batches', batchId, 'plan.yaml');
}

/** 落盘:确保 batch 目录存在,然后写 yaml */
export async function writePlan(flooDir: string, plan: PlanYaml): Promise<void> {
  const batchDir = join(flooDir, 'batches', plan.batch_id);
  await mkdir(batchDir, { recursive: true });
  // 用 yaml stringify,行宽放宽避免长字符串被折行
  const yaml = stringifyYaml(plan, { lineWidth: 0 });
  await writeFile(planYamlPath(flooDir, plan.batch_id), yaml);
}

/** 读盘:不存在返回 null;格式错误抛错 */
export async function readPlan(flooDir: string, batchId: string): Promise<PlanYaml | null> {
  let raw: string;
  try {
    raw = await readFile(planYamlPath(flooDir, batchId), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = parseYaml(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`plan.yaml 解析失败:${batchId}`);
  }
  return parsed as PlanYaml;
}
