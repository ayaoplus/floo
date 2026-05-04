/**
 * PHASE_ORDER 派生 (Step 4e)
 *
 * 把"phase 顺序"这件事从 types.ts 硬编码常量挪到 templates/plans/feature.yaml,
 * 让 yaml 成为单一事实源。用户编辑 feature.yaml 调整 phase 顺序时,所有依赖
 * PHASE_ORDER 的代码(simple path step 派生 / synthesizeSteps 镜像 / valid
 * capability 校验)自动跟随。
 *
 * 同步加载策略:
 *   - 模块首次 import 时同步读 yaml(fs.readFileSync + parseYaml),计算结果缓存
 *   - 用同步 API 是因为 PHASE_ORDER 是模块级 export,异步初始化会让所有调用者
 *     都得 await,改造面太大,不值得
 *   - feature.yaml 缺失/解析失败 → 用硬编码 FALLBACK 兜底 + console.warn,
 *     避免启动期 crash 阻塞所有测试
 *
 * 算法:steps[].capability 按数组顺序去重(loop_with 是回边,不影响线性顺序;
 *      defer_after 标记的 deferred step 同样按出现顺序贡献 capability)。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import type { Phase } from './types.js';

/** feature.yaml 缺失/坏掉时的硬编码兜底,与原 types.ts 老版本保持一致 */
const FALLBACK_PHASE_ORDER: readonly Phase[] = [
  'discuss', 'designer', 'planner', 'coder', 'reviewer', 'tester',
];

/** 计算 feature.yaml 文件的默认绝对路径(与 plan.ts:defaultTemplatesDir 同源) */
function defaultFeatureYamlPath(): string {
  if (process.env.FLOO_TEMPLATES_DIR) {
    return join(process.env.FLOO_TEMPLATES_DIR, 'feature.yaml');
  }
  // 源码: src/core/phase-order.ts → ../../templates/plans/feature.yaml
  // 编译: dist/core/phase-order.js → ../../templates/plans/feature.yaml
  const here = fileURLToPath(import.meta.url);
  const packageRoot = join(dirname(here), '..', '..');
  return join(packageRoot, 'templates', 'plans', 'feature.yaml');
}

/**
 * 从模板对象派生 phase 顺序。纯函数,不接触文件系统,便于测试。
 *
 * @param template 任意带 steps[].capability 的对象;不强校验 schema(已由 plan.ts:validateTemplate 兜)
 * @returns capability 按出现顺序去重的 Phase 列表
 */
export function derivePhaseOrder(template: { steps: Array<{ capability: string }> }): Phase[] {
  const seen = new Set<string>();
  const order: Phase[] = [];
  for (const step of template.steps) {
    if (seen.has(step.capability)) continue;
    seen.add(step.capability);
    order.push(step.capability as Phase);
  }
  return order;
}

/**
 * 同步加载 feature.yaml + 派生 PHASE_ORDER。
 *
 * 失败路径(文件不存在/解析失败/没 steps):console.warn 一行 + 返回 FALLBACK,
 * 不抛异常。这样测试 fixture 可以缺这个文件,运行行为仍可预期。
 */
export function loadFeaturePhaseOrder(yamlPath?: string): Phase[] {
  const path = yamlPath ?? defaultFeatureYamlPath();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn(`[floo] feature.yaml 不存在 (${path}),PHASE_ORDER 用硬编码 fallback`);
    } else {
      console.warn(`[floo] feature.yaml 读取失败: ${err instanceof Error ? err.message : err},用 fallback`);
    }
    return [...FALLBACK_PHASE_ORDER];
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    console.warn(`[floo] feature.yaml 解析失败: ${err instanceof Error ? err.message : err},用 fallback`);
    return [...FALLBACK_PHASE_ORDER];
  }
  if (!parsed || typeof parsed !== 'object') {
    console.warn('[floo] feature.yaml 顶层不是 object,用 fallback');
    return [...FALLBACK_PHASE_ORDER];
  }
  const steps = (parsed as { steps?: unknown }).steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    console.warn('[floo] feature.yaml 缺 steps[] 或为空,用 fallback');
    return [...FALLBACK_PHASE_ORDER];
  }
  // 走纯函数派生
  return derivePhaseOrder({ steps: steps as Array<{ capability: string }> });
}

/**
 * 模块级 PHASE_ORDER:首次 import 该模块时一次性派生,后续所有 import 共享同一份。
 *
 * 注:这是 Step 4e 的核心 export,types.ts 通过 re-export 维持向后兼容。
 */
export const PHASE_ORDER: Phase[] = loadFeaturePhaseOrder();
