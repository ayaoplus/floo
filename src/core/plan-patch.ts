/**
 * Plan-Patch 机制 (Step 6)
 *
 * 让 plan.yaml 从"开局快照"演化为"动态 ledger":每次 verdict 触发循环
 * (reviewer fail / tester fail / discuss blocker)时,生成一份 patch 文件
 * 落到 .floo/batches/<batchId>/patches/<patchId>.yaml,记录"这一轮在 plan
 * 末尾追加了哪些新 step"。executor 调用 applyPatch 把新 step 接到 plan.steps,
 * UI 据此可视化执行图的实际演化。
 *
 * 设计取舍:
 *   - patch 只允许 append-steps(不允许修改/删除已有 step)。理由:
 *       1) ledger 语义,append-only 才能稳定回放;
 *       2) 执行机制简单——RunState.steps 只增不减,与 rollbackToPhase 解耦;
 *       3) 从 worker 角度也容易表达——"我希望接下来再跑这些 step"
 *   - patch_id 是文件名(去掉 .yaml),executor 据此判幂等(已 apply 的 patch
 *     再次 apply 会校验失败 / 跳过,避免重复追加)
 *   - validatePatch 失败的 patch 文件跳过 + console.warn,不阻塞(损坏的单个
 *     patch 不应让整个 batch 崩溃)
 *
 * 当前阶段(Step 6 落地范围):
 *   - 数据 + IO + applyPatch 完整就位
 *   - executor 在 reviewer/tester verdict 触发 retry 时调 writePatch + 把
 *     patch apply 到内存中的 plan(plan.yaml 同步落盘),作为"plan 演化记录"
 *   - 但执行机制(rollbackToPhase)保持不变。RunState 与 plan 双轨道:plan 是
 *     ledger,RunState 是执行游标。Step 8 orchestrator 落地后再切换 RunState
 *     到 patch-driven。
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { PlanStep, PlanYaml, PlanTemplateStep, PlanStepStatus } from './plan.js';
import type { Phase, Runtime } from './types.js';

// ============================================================
// 类型
// ============================================================

/** patch 类别。当前只支持 append-steps;以后扩展 add-edges / mark-skipped 等再 bump kind 联合 */
export type PlanPatchKind = 'append-steps';

/** 单个 plan-patch 文件结构 */
export interface PlanPatch {
  schema_version: 1;
  /** 文件名标识(不含 .yaml 后缀),如 `review-1-fail-1`。executor 据此判幂等 */
  patch_id: string;
  generated_at: string;        // ISO 8601
  /** 谁生成的,如 'executor:reviewer-verdict' / 'agent:reviewer' / 'orchestrator',便于追踪 */
  generated_by: string;
  /** 这个 patch 是哪个 step 完成后产生的(必须存在于 plan.steps) */
  parent_step: string;
  /** 可读的触发原因,如 'reviewer_fail_round_1' */
  reason: string;
  kind: PlanPatchKind;
  /**
   * append-only 新增 step 列表。每个 step 的 id 不能与 plan 中已有 step 冲突,
   * depends_on 必须指向 plan 已有 step 或本 patch 内的 step。
   */
  append_steps: PlanTemplateStep[];
}

/** applyPatch 返回:更新后的 plan + 实际追加的 step(便于上层做 ledger / 通知) */
export interface ApplyPatchResult {
  plan: PlanYaml;
  appended: PlanStep[];
}

// ============================================================
// applyPatch (纯函数)
// ============================================================

/**
 * 把一份 patch 应用到 plan,返回新 plan + 实际追加的 step。
 *
 * 校验失败时抛错,patch 不被应用。校验项:
 *   1. patch.kind === 'append-steps'(其他类型暂不支持)
 *   2. parent_step 必须存在于 plan.steps
 *   3. append_steps[].id 不能与 plan 已有 step.id 冲突,也不能在 patch 内部重复
 *   4. append_steps[].depends_on 必须指向 plan 已有 step.id 或本 patch 内更早的 step.id
 *   5. append_steps[].capability 必须是合法 Phase(由调用方上层 schema 校验已兜)
 *
 * 不修改原 plan,返回新对象(浅复制 + steps 数组重建)。
 */
export function applyPatch(plan: PlanYaml, patch: PlanPatch): ApplyPatchResult {
  if (patch.kind !== 'append-steps') {
    throw new Error(`applyPatch: kind "${patch.kind}" 暂不支持(目前只支持 append-steps)`);
  }

  const existingIds = new Set(plan.steps.map(s => s.id));
  if (!existingIds.has(patch.parent_step)) {
    throw new Error(
      `applyPatch: patch "${patch.patch_id}" 的 parent_step "${patch.parent_step}" 不在 plan.steps 中`,
    );
  }

  // 把 PlanTemplateStep 转成 PlanStep(填充运行时字段),并逐个校验。
  // 先 check patch 内重复(更具体的错误),再 check 与 plan 冲突。
  const appended: PlanStep[] = [];
  const seenAppendIds = new Set<string>();
  for (const [i, ts] of patch.append_steps.entries()) {
    if (seenAppendIds.has(ts.id)) {
      throw new Error(`applyPatch: append_steps[${i}].id "${ts.id}" 在 patch 内重复`);
    }
    if (existingIds.has(ts.id)) {
      throw new Error(`applyPatch: append_steps[${i}].id "${ts.id}" 与 plan 已有 step 冲突`);
    }
    seenAppendIds.add(ts.id);

    for (const dep of ts.depends_on ?? []) {
      // 依赖必须是 plan 已有 step,或本 patch 内更早出现的 step
      if (!existingIds.has(dep) && !seenAppendIds.has(dep)) {
        throw new Error(
          `applyPatch: append_steps[${i}] (id=${ts.id}) 的依赖 "${dep}" 既不在 plan 也不在 patch 已声明的前序 step 中`,
        );
      }
    }

    // 把 template step 物化成 PlanStep(用占位的 runtime/model,留给上层调用方按 capability 重新填)
    // 这里不接触 RoleBinding,因为 patch 模块是纯数据,不依赖 config
    const ps: PlanStep = {
      id: ts.id,
      capability: ts.capability,
      runtime: (ts.runtime ?? plan.steps[0]?.runtime ?? 'claude') as Runtime,
      model: ts.model ?? plan.steps[0]?.model ?? 'sonnet',
      depends_on: ts.depends_on ?? [],
      // scope 字段:'task' 透传需要 task.scope,plan 模块不知道,这里仅保留字面 scope。
      // 调用方(executor)需要在 apply 之前自己把 'task' 替换成实际 scope。
      scope: Array.isArray(ts.scope) ? ts.scope : [],
      status: ts.status ?? 'pending',
      ...(ts.runtime || ts.model ? {} : { notes: 'plan-patch:appended (runtime/model 继承默认)' }),
    };
    appended.push(ps);
    existingIds.add(ts.id); // 后续 patch 内引用本 step 的依赖也算合法
  }

  const newPlan: PlanYaml = {
    ...plan,
    steps: [...plan.steps, ...appended],
    notes: [...plan.notes, `applied patch ${patch.patch_id} (${patch.reason})`],
  };
  return { plan: newPlan, appended };
}

// ============================================================
// 文件 IO
// ============================================================

/** patches 目录的绝对路径 */
export function patchesDir(flooDir: string, batchId: string): string {
  return join(flooDir, 'batches', batchId, 'patches');
}

/** 单个 patch 的绝对路径 */
export function patchPath(flooDir: string, batchId: string, patchId: string): string {
  return join(patchesDir(flooDir, batchId), `${patchId}.yaml`);
}

/**
 * 把 patch 写盘。返回写入的绝对路径。
 *
 * 调用方负责保证 patch_id 唯一(典型:`${parent_step}-${reason}` 或带 timestamp 后缀)。
 * 如果文件已存在会被覆盖——通常 patch_id 唯一性已经保证不重写。
 */
export async function writePatch(
  flooDir: string,
  batchId: string,
  patch: PlanPatch,
): Promise<string> {
  const dir = patchesDir(flooDir, batchId);
  await mkdir(dir, { recursive: true });
  const path = patchPath(flooDir, batchId, patch.patch_id);
  const yaml = stringifyYaml(patch, { lineWidth: 0 });
  await writeFile(path, yaml);
  return path;
}

/**
 * 扫描 patches/ 目录,读取并校验所有 patch 文件,按 generated_at 升序返回。
 *
 * 单个 patch 校验失败 → console.warn + 跳过(不抛错,避免一份坏 patch 阻塞整个 batch)。
 * 目录不存在 → 返回空数组(没产生过 patch 是合法状态)。
 */
export async function readPatches(flooDir: string, batchId: string): Promise<PlanPatch[]> {
  const dir = patchesDir(flooDir, batchId);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const patches: PlanPatch[] = [];
  for (const name of entries) {
    if (!name.endsWith('.yaml')) continue;
    const path = join(dir, name);
    try {
      const raw = await readFile(path, 'utf-8');
      const parsed = parseYaml(raw);
      patches.push(validatePatch(parsed, name));
    } catch (err) {
      console.warn(`[floo] plan-patch ${name} 解析失败,跳过: ${err instanceof Error ? err.message : err}`);
    }
  }
  patches.sort((a, b) => a.generated_at.localeCompare(b.generated_at));
  return patches;
}

// ============================================================
// schema 校验
// ============================================================

/**
 * patch yaml schema 校验。失败抛 Error 含定位信息;成功返回结构化对象。
 *
 * 不依赖 plan 内容(只做形态校验)。"parent_step 是否真存在 / id 是否冲突"由
 * applyPatch 在已知 plan 时再校验。
 */
export function validatePatch(parsed: unknown, fileName: string): PlanPatch {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`plan-patch ${fileName}: 顶层不是 object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schema_version !== 1) {
    throw new Error(`plan-patch ${fileName}: schema_version 必须为 1,实际 ${obj.schema_version}`);
  }
  for (const field of ['patch_id', 'generated_at', 'generated_by', 'parent_step', 'reason'] as const) {
    if (typeof obj[field] !== 'string' || (obj[field] as string).length === 0) {
      throw new Error(`plan-patch ${fileName}: ${field} 缺失或非字符串`);
    }
  }
  if (obj.kind !== 'append-steps') {
    throw new Error(`plan-patch ${fileName}: kind "${String(obj.kind)}" 非法 (允许:append-steps)`);
  }
  if (!Array.isArray(obj.append_steps) || obj.append_steps.length === 0) {
    throw new Error(`plan-patch ${fileName}: append_steps 必须是非空数组`);
  }

  const VALID_PHASES: ReadonlySet<Phase> = new Set([
    'discuss', 'designer', 'planner', 'coder', 'reviewer', 'tester',
  ]);
  const append_steps: PlanTemplateStep[] = obj.append_steps.map((s, idx) => {
    if (!s || typeof s !== 'object') {
      throw new Error(`plan-patch ${fileName}: append_steps[${idx}] 不是 object`);
    }
    const step = s as Record<string, unknown>;
    if (typeof step.id !== 'string' || step.id.length === 0) {
      throw new Error(`plan-patch ${fileName}: append_steps[${idx}].id 缺失或非字符串`);
    }
    if (typeof step.capability !== 'string' || !VALID_PHASES.has(step.capability as Phase)) {
      throw new Error(
        `plan-patch ${fileName}: append_steps[${idx}].capability "${String(step.capability)}" 非法`,
      );
    }
    const dependsOn = step.depends_on;
    if (dependsOn !== undefined &&
        (!Array.isArray(dependsOn) || !dependsOn.every(d => typeof d === 'string'))) {
      throw new Error(`plan-patch ${fileName}: append_steps[${idx}].depends_on 必须是 string 数组`);
    }
    return {
      id: step.id,
      capability: step.capability as Phase,
      ...(dependsOn ? { depends_on: dependsOn as string[] } : {}),
      ...(step.scope !== undefined ? { scope: step.scope as PlanTemplateStep['scope'] } : {}),
      ...(typeof step.loop_with === 'string' ? { loop_with: step.loop_with } : {}),
      ...(typeof step.defer_after === 'string' ? { defer_after: step.defer_after } : {}),
      ...(typeof step.status === 'string' ? { status: step.status as PlanStepStatus } : {}),
      ...(typeof step.runtime === 'string' ? { runtime: step.runtime as Runtime } : {}),
      ...(typeof step.model === 'string' ? { model: step.model } : {}),
    };
  });

  return {
    schema_version: 1,
    patch_id: obj.patch_id as string,
    generated_at: obj.generated_at as string,
    generated_by: obj.generated_by as string,
    parent_step: obj.parent_step as string,
    reason: obj.reason as string,
    kind: 'append-steps',
    append_steps,
  };
}
