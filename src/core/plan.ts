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

import { join, dirname } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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

// ============================================================
// Plan Template (Step 2)
// ============================================================

/**
 * 模板 step 的 scope 声明:
 *   - 'task' (字符串字面量):透传 task.scope
 *   - string[]:字面 scope 列表
 *   - undefined:空 scope
 */
export type PlanTemplateScope = 'task' | string[] | undefined;

/** 模板内的单个 step,只描述拓扑骨架,运行时字段由 synthesize 阶段填 */
export interface PlanTemplateStep {
  id: string;
  capability: Phase;
  depends_on?: string[];
  scope?: PlanTemplateScope;
  /** Step 4 飞轮过渡:标记本 step 与哪个 step 形成循环(reviewer ↔ implement / discuss ↔ designer) */
  loop_with?: string;
  /** 当某 step 完成后,本节点的具体形态才能确定。Step 1 镜像里把这类标记的节点状态置为 deferred */
  defer_after?: string;
  /** 显式指定 status,覆盖 defer_after 推断;模板里通常不写,留默认 pending 由 synthesize 推断 */
  status?: PlanStepStatus;
  /** 模板里很少强制 runtime/model;留空时 synthesize 阶段从 config.roles 取 */
  runtime?: Runtime;
  model?: string;
}

/** 顶层 plan template 结构 */
export interface PlanTemplate {
  schema_version: 1;
  name: string;
  description?: string;
  steps: PlanTemplateStep[];
}

/**
 * 默认模板根目录:
 *   优先级 = 显式参数 > FLOO_TEMPLATES_DIR 环境变量 > package 内置 templates/plans/
 *
 * 内置目录基于 src/core/plan.ts 自身位置反推,既支持源码 tsx 运行,也支持 dist/ 安装态。
 */
function defaultTemplatesDir(): string {
  if (process.env.FLOO_TEMPLATES_DIR) return process.env.FLOO_TEMPLATES_DIR;
  const here = fileURLToPath(import.meta.url);
  // 源码态:src/core/plan.ts → 包根 = ../../  → templates/plans/
  // 编译态:dist/core/plan.js → 包根 = ../../  → templates/plans/
  const packageRoot = join(dirname(here), '..', '..');
  return join(packageRoot, 'templates', 'plans');
}

/** 模板路径计算 */
export function planTemplatePath(name: string, baseDir?: string): string {
  return join(baseDir ?? defaultTemplatesDir(), `${name}.yaml`);
}

/**
 * 加载模板 + schema 校验。同步 IO 不暴露异步签名,因为这是模块级一次性加载需求,
 * 但 fs 操作仍走 promises API(避免引入 sync IO 的代码风格)。
 *
 * @throws 如果文件不存在 / yaml 格式错误 / schema 不通过
 */
export async function loadTemplate(name: string, baseDir?: string): Promise<PlanTemplate> {
  const path = planTemplatePath(name, baseDir);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`plan template 不存在:${name} (查找路径 ${path})`);
    }
    throw err;
  }
  const parsed = parseYaml(raw) as unknown;
  return validateTemplate(parsed, name);
}

/**
 * 把模板转换成 (startPhase, endPhase) 元组,供 createAndRun 消费。
 *
 * 规则:
 *   - startPhase = 第一个 step 的 capability(必须存在,validateTemplate 已保证)
 *   - endPhase   = 最后一个 step 的 capability;若等于 PHASE_ORDER 的最后一阶段则返回 undefined
 *                  (sentinel 值表示"跑到流程结尾")
 *
 * 这是 Step 4b 阶段的简化映射:模板的拓扑结构暂时只用首尾 phase 表示,
 * 完整的 step DAG 留给 PlanState 驱动后(Step 4c+)消费。
 */
export function templateToPhases(template: PlanTemplate): { startPhase: Phase; endPhase?: Phase } {
  const firstStep = template.steps[0];
  const lastStep = template.steps[template.steps.length - 1];
  const startPhase = firstStep.capability;
  const lastCap = lastStep.capability;
  const isFullPipeline = lastCap === PHASE_ORDER[PHASE_ORDER.length - 1];
  return {
    startPhase,
    ...(isFullPipeline ? {} : { endPhase: lastCap }),
  };
}

/** schema 校验:返回结构化对象,失败抛 Error 含定位信息 */
export function validateTemplate(parsed: unknown, name: string): PlanTemplate {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`plan template ${name}: 顶层不是 object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schema_version !== 1) {
    throw new Error(`plan template ${name}: schema_version 必须为 1,实际 ${obj.schema_version}`);
  }
  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    throw new Error(`plan template ${name}: name 字段缺失或非字符串`);
  }
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    throw new Error(`plan template ${name}: steps 必须是非空数组`);
  }

  const validCaps = new Set<Phase>(PHASE_ORDER);
  const seenIds = new Set<string>();
  const steps: PlanTemplateStep[] = obj.steps.map((s, idx) => {
    if (!s || typeof s !== 'object') {
      throw new Error(`plan template ${name}: steps[${idx}] 不是 object`);
    }
    const step = s as Record<string, unknown>;
    if (typeof step.id !== 'string' || step.id.length === 0) {
      throw new Error(`plan template ${name}: steps[${idx}].id 缺失或非字符串`);
    }
    if (seenIds.has(step.id)) {
      throw new Error(`plan template ${name}: steps[${idx}].id "${step.id}" 重复`);
    }
    seenIds.add(step.id);
    if (typeof step.capability !== 'string' || !validCaps.has(step.capability as Phase)) {
      throw new Error(
        `plan template ${name}: steps[${idx}].capability "${step.capability}" 非法 (允许:${[...validCaps].join('/')})`,
      );
    }
    const dependsOn = step.depends_on;
    if (dependsOn !== undefined) {
      if (!Array.isArray(dependsOn) || !dependsOn.every(d => typeof d === 'string')) {
        throw new Error(`plan template ${name}: steps[${idx}].depends_on 必须是 string[]`);
      }
      // 校验依赖 id 必须在前面已声明
      for (const dep of dependsOn) {
        if (!seenIds.has(dep) && dep !== step.id) {
          throw new Error(`plan template ${name}: steps[${idx}] 引用未声明的依赖 "${dep}"`);
        }
      }
    }
    return {
      id: step.id,
      capability: step.capability as Phase,
      ...(dependsOn ? { depends_on: dependsOn as string[] } : {}),
      ...(step.scope !== undefined ? { scope: step.scope as PlanTemplateScope } : {}),
      ...(typeof step.loop_with === 'string' ? { loop_with: step.loop_with } : {}),
      ...(typeof step.defer_after === 'string' ? { defer_after: step.defer_after } : {}),
      ...(typeof step.status === 'string' ? { status: step.status as PlanStepStatus } : {}),
      ...(typeof step.runtime === 'string' ? { runtime: step.runtime as Runtime } : {}),
      ...(typeof step.model === 'string' ? { model: step.model } : {}),
    };
  });

  return {
    schema_version: 1,
    name: obj.name,
    ...(typeof obj.description === 'string' ? { description: obj.description } : {}),
    steps,
  };
}
