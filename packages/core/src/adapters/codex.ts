/**
 * Codex CLI Adapter
 * 通过 codex CLI 启动 agent session，继承 BaseAdapter 处理 tmux 和 runner 逻辑
 */

import { BaseAdapter } from './base.js';
import type { Runtime, SpawnOptions } from '../types.js';

/** 转义 shell 单引号：' → '\'' */
function escapeShellSingleQuote(str: string): string {
  return str.replace(/'/g, "'\\''");
}

export class CodexAdapter extends BaseAdapter {
  runtime: Runtime = 'codex';

  /** 构建 codex CLI 命令 */
  protected buildAgentCommand(opts: SpawnOptions): string {
    const escaped = escapeShellSingleQuote(opts.prompt);
    return `codex --model ${opts.model} --dangerously-bypass-approvals-and-sandbox '${escaped}'`;
  }
}
