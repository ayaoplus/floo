/**
 * Claude CLI Adapter
 * 通过 claude CLI 启动 agent session，继承 BaseAdapter 处理 tmux 和 runner 逻辑
 */

import { BaseAdapter } from './base.js';
import type { Runtime, SpawnOptions } from '../types.js';

/** 转义 shell 单引号：' → '\'' */
function escapeShellSingleQuote(str: string): string {
  return str.replace(/'/g, "'\\''");
}

export class ClaudeAdapter extends BaseAdapter {
  runtime: Runtime = 'claude';

  /** 构建 claude CLI 命令 */
  protected buildAgentCommand(opts: SpawnOptions): string {
    const escaped = escapeShellSingleQuote(opts.prompt);
    return `claude --model ${opts.model} --dangerously-skip-permissions -p '${escaped}'`;
  }
}
