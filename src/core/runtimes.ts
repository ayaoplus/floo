/**
 * Runtime 注册表加载 (Step 5)
 *
 * 从 FlooConfig.runtimes 实例化 adapter map,供 commands/run.ts 与
 * commands/cancel.ts 使用。原本的 `{ claude: new ClaudeAdapter(), codex: new CodexAdapter() }`
 * 静态写法被这里替换。
 *
 * 合并策略(deep merge):
 *   - 用户 config 没有 runtimes 段 → 全用 DEFAULT_CONFIG.runtimes
 *   - 用户配了某个 runtime 名(如 claude) → 用户 entry 整体覆盖默认 entry
 *     (不混合 default.args + user.args,避免数组拼接的二义性)
 *   - 用户加了新 runtime 名(如 gemini) → 直接注册
 */

import type { AgentAdapter, FlooConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import { GenericRuntimeAdapter } from './adapters/generic.js';

/**
 * 把 user.runtimes 与 DEFAULT_CONFIG.runtimes 合并,user entry 整体覆盖。
 * config 不带 runtimes 段时用全部默认值。
 */
export function mergeRuntimes(
  config: Pick<FlooConfig, 'runtimes'>,
): NonNullable<FlooConfig['runtimes']> {
  const defaults = DEFAULT_CONFIG.runtimes ?? {};
  return { ...defaults, ...(config.runtimes ?? {}) };
}

/**
 * 为 config 中的每个 runtime 实例化 GenericRuntimeAdapter,返回 name → adapter map。
 *
 * 调用方典型:
 *   const adapters = loadAdapters(config);
 *   await runTask(task, phase, { adapters, config, ... });
 */
export function loadAdapters(
  config: Pick<FlooConfig, 'runtimes'>,
): Record<string, AgentAdapter> {
  const merged = mergeRuntimes(config);
  const map: Record<string, AgentAdapter> = {};
  for (const [name, rcfg] of Object.entries(merged)) {
    map[name] = new GenericRuntimeAdapter(name, rcfg);
  }
  return map;
}
