/**
 * Generic Runtime Adapter (Step 5)
 *
 * 把 ClaudeAdapter / CodexAdapter 中"只有 buildAgentCommand 不同"的部分
 * 配置化:从 floo.config.json#runtimes 读 RuntimeConfig (command + args 模板),
 * 在 spawn 时把模板里的 ${model} / ${prompt} 等占位符替换成 SpawnOptions 字段
 * 后,shell-quote 拼接成 agent 命令字符串。
 *
 * 注入到 BaseAdapter.spawn 的 buildRunnerScript 流程,tmux + git 锁 + exit
 * artifact 全部沿用,不重写。
 *
 * 设计取舍:
 *   - args 是字符串数组而不是单个 template 字符串,因为每个 arg 独立 shell-quote
 *     可以彻底避免命令注入,且不需要 shell parser。代价是 yaml 写起来略冗长。
 *   - 占位符列表是封闭集合(model/prompt/task_id/phase/cwd/session_name),未声明
 *     的 ${foo} 会被原样保留(不抛错,便于 agent 自身的 ${VAR} 写法不被误吞)。
 */

import { BaseAdapter } from './base.js';
import type { Runtime, RuntimeConfig, SpawnOptions } from '../types.js';

/**
 * Shell 单引号包裹 + 内部单引号转义,与 base.ts 中 buildRunnerScript 内联
 * 的 escapeShellSingleQuote 风格一致。
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 解析单个 arg 中的 ${var} 占位符。未声明的 var 原样保留,避免吞掉 agent
 * 自己的 ${VAR}。
 */
function renderArg(arg: string, vars: Record<string, string>): string {
  return arg.replace(/\$\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : whole);
}

/**
 * 配置驱动的 adapter。每个 runtime 一个实例,内部仅持有 RuntimeConfig 引用。
 *
 * `runtime` 字段类型是 string 而非具体联合,因为 Step 5 之后 runtime 名是
 * 配置层定义,不是编译期枚举。
 */
export class GenericRuntimeAdapter extends BaseAdapter {
  runtime: Runtime;
  private readonly cfg: RuntimeConfig;

  constructor(name: string, cfg: RuntimeConfig) {
    super();
    this.runtime = name;
    this.cfg = cfg;
  }

  /** 把 RuntimeConfig.args 模板渲染并 shell-quote 后,与 command 拼成一行 */
  protected buildAgentCommand(opts: SpawnOptions): string {
    return this.renderCommand(opts);
  }

  /**
   * 公共版的 buildAgentCommand,纯函数语义(只读 cfg + 入参,无副作用),
   * 给测试用例使用。运行时仍走 protected 入口。
   */
  public renderCommand(opts: SpawnOptions): string {
    const sessionName = `floo-${opts.taskId}-${opts.phase}`;
    const vars: Record<string, string> = {
      model: opts.model,
      prompt: opts.prompt,
      task_id: opts.taskId,
      phase: opts.phase,
      cwd: opts.cwd,
      session_name: sessionName,
    };
    const renderedArgs = this.cfg.args.map(arg => shellQuote(renderArg(arg, vars)));
    return [this.cfg.command, ...renderedArgs].join(' ');
  }
}

/**
 * 内部 helper export,便于测试 + claude.ts/codex.ts 兼容包装时复用。
 * 不是公开 API(签名可能变),走 src/core/adapters/generic.ts 直 import。
 */
export const _internal = { shellQuote, renderArg };
