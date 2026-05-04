/**
 * Web 数据访问层:plan.yaml + plan-patch (Step 7)
 *
 * 故意不 import src/core,保持 web 部署独立。结构与 src/core/plan.ts +
 * src/core/plan-patch.ts 同源,但 web 端只读不写,只走 yaml 解析。
 */

import { readFile, readdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { Phase } from './types';

/** plan.yaml step 状态 */
export type PlanStepStatus = 'pending' | 'deferred';

/** plan.yaml 中的单个 step(运行时投影,含 runtime/model 等) */
export interface PlanStep {
  id: string;
  capability: Phase;
  runtime: string;
  model: string;
  depends_on: string[];
  scope: string[];
  status: PlanStepStatus;
  notes?: string;
}

/** plan.yaml 顶层结构 */
export interface PlanYaml {
  schema_version: 1;
  batch_id: string;
  created_at: string;
  description: string;
  mode: 'legacy-dispatcher' | 'executor';
  start_phase: Phase;
  initial_task: {
    id: string;
    scope: string[];
    acceptance_criteria: string[];
    review_level: 'full' | 'scan' | 'skip';
    depends_on: string[];
  };
  steps: PlanStep[];
  notes: string[];
}

/** plan-patch 中的 append step 模板(没经过 applyPatch 物化前的原始字段) */
export interface PlanPatchStep {
  id: string;
  capability: Phase;
  depends_on?: string[];
  scope?: 'task' | string[];
  loop_with?: string;
  defer_after?: string;
  status?: PlanStepStatus;
  runtime?: string;
  model?: string;
}

/** plan-patch 文件结构(简化版,只取展示需要的字段) */
export interface PlanPatch {
  schema_version: 1;
  patch_id: string;
  generated_at: string;
  generated_by: string;
  parent_step: string;
  reason: string;
  kind: 'append-steps';
  append_steps: PlanPatchStep[];
}

/** 跟 web/lib/floo.ts 同款 .floo 解析 */
function getFlooDir(): string {
  return process.env.FLOO_DIR || resolve(process.cwd(), '..', '.floo');
}

/** 安全读 yaml,失败返回 null(不抛错,UI 友好) */
async function readYaml<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = parseYaml(raw);
    return parsed as T;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 读 batch 的 plan.yaml(开局快照 + plan-patch 演化后的最新版) */
export async function getBatchPlan(batchId: string): Promise<PlanYaml | null> {
  const filePath = join(getFlooDir(), 'batches', batchId, 'plan.yaml');
  return readYaml<PlanYaml>(filePath);
}

/** 读 batch 的所有 plan-patch,按 generated_at 升序 */
export async function getBatchPatches(batchId: string): Promise<PlanPatch[]> {
  const dir = join(getFlooDir(), 'batches', batchId, 'patches');
  if (!(await exists(dir))) return [];
  try {
    const entries = await readdir(dir);
    const patches: PlanPatch[] = [];
    for (const name of entries) {
      if (!name.endsWith('.yaml')) continue;
      const p = await readYaml<PlanPatch>(join(dir, name));
      if (p && p.schema_version === 1 && p.kind === 'append-steps') {
        patches.push(p);
      }
    }
    patches.sort((a, b) => a.generated_at.localeCompare(b.generated_at));
    return patches;
  } catch {
    return [];
  }
}

// ============================================================
// DAG 布局(纯函数,无 DOM 依赖,可在 server / client 都跑)
// ============================================================

/** DAG 布局后的节点位置 */
export interface DagNode {
  id: string;
  capability: Phase;
  layer: number;       // 拓扑层级(0 起步)
  column: number;      // 同层内的列号(0 起步)
  status: PlanStepStatus;
  depends_on: string[];
  /** 是否由 patch 追加(plan.yaml.notes 中找到该 patch_id 即认为是) */
  appended_by_patch: boolean;
}

/** DAG 边:from → to */
export interface DagEdge {
  from: string;
  to: string;
}

/**
 * 把 plan.steps 拓扑排序 + 分层。同一层的 step 在 UI 上水平排列。
 *
 * 算法:对每个 step,layer = max(depends_on 的 layer) + 1;无依赖的 layer = 0。
 * 简单 O(n²) 即可——floo plan 通常 < 50 个 step,够用。
 *
 * 失败容忍:如果有循环依赖(理论上 plan-patch append-only 不会出现),
 * 返回的 layer 可能不准但不抛错。
 */
export function layoutDag(plan: PlanYaml, patches: PlanPatch[]): { nodes: DagNode[]; edges: DagEdge[] } {
  const layers = new Map<string, number>();
  const stepIds = new Set(plan.steps.map(s => s.id));

  // 简单迭代解 layer:重复直到稳定
  for (let pass = 0; pass < plan.steps.length + 1; pass++) {
    let changed = false;
    for (const step of plan.steps) {
      let maxDepLayer = -1;
      for (const dep of step.depends_on) {
        const dl = layers.get(dep);
        if (dl !== undefined && dl > maxDepLayer) maxDepLayer = dl;
      }
      const newLayer = maxDepLayer + 1;
      if (layers.get(step.id) !== newLayer) {
        layers.set(step.id, newLayer);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 同层内按 plan.steps 出现顺序分配 column
  const layerCounters = new Map<number, number>();
  const patchedIds = collectPatchedStepIds(patches, stepIds);

  const nodes: DagNode[] = plan.steps.map(step => {
    const layer = layers.get(step.id) ?? 0;
    const col = layerCounters.get(layer) ?? 0;
    layerCounters.set(layer, col + 1);
    return {
      id: step.id,
      capability: step.capability,
      layer,
      column: col,
      status: step.status,
      depends_on: step.depends_on,
      appended_by_patch: patchedIds.has(step.id),
    };
  });

  const edges: DagEdge[] = [];
  for (const step of plan.steps) {
    for (const dep of step.depends_on) {
      if (stepIds.has(dep)) {
        edges.push({ from: dep, to: step.id });
      }
    }
  }

  return { nodes, edges };
}

/** 从 patches 收集所有 append_steps[].id,用于 UI 标记"这个 step 是 patch 追加的" */
function collectPatchedStepIds(patches: PlanPatch[], _stepIds: Set<string>): Set<string> {
  const ids = new Set<string>();
  for (const p of patches) {
    for (const ts of p.append_steps) {
      ids.add(ts.id);
    }
  }
  return ids;
}
