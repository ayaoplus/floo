/**
 * Claude CLI Adapter
 *
 * Step 5 起退化为 GenericRuntimeAdapter 的 preset:实际 buildAgentCommand
 * 逻辑来自 RuntimeConfig (DEFAULT_CONFIG.runtimes.claude),命令模板
 * 与重构前完全等价。这个类继续 export 是为了:
 *   - 保留外部 import 路径(如自定义 floo SDK 消费者)
 *   - 给 commands/run.ts 等老代码提供"无配置 new"的便捷构造
 *
 * 想自定义 claude 调用方式,改 floo.config.json#runtimes.claude 即可,
 * 不需要修改本文件。
 */

import { GenericRuntimeAdapter } from './generic.js';
import { DEFAULT_CONFIG } from '../types.js';

export class ClaudeAdapter extends GenericRuntimeAdapter {
  constructor() {
    // DEFAULT_CONFIG.runtimes 在 types.ts 是必填字段,types 上是 optional
    // 因为 FlooConfig 整体可缺 runtimes 段;这里走默认配置故必定存在。
    const cfg = DEFAULT_CONFIG.runtimes!.claude;
    super('claude', cfg);
  }
}
