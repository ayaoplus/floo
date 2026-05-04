/**
 * Runtimes 注册表 + GenericRuntimeAdapter 测试 (Step 5)
 *
 * 范围:
 *   - shellQuote / renderArg 单元行为
 *   - GenericRuntimeAdapter.renderCommand 的 args 渲染 + shell escape
 *   - ClaudeAdapter / CodexAdapter 退化为 GenericRuntimeAdapter 后,
 *     渲染输出与原 hardcode 字符串等价(防回归)
 *   - mergeRuntimes / loadAdapters 行为
 */

import {
  GenericRuntimeAdapter,
  ClaudeAdapter,
  CodexAdapter,
  loadAdapters,
  mergeRuntimes,
  DEFAULT_CONFIG,
  type SpawnOptions,
  type RuntimeConfig,
  type FlooConfig,
} from '../src/core/index.js';

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.log(`  ✗ ${msg}`);
    failed++;
  }
}

const baseSpawnOpts: SpawnOptions = {
  taskId: 'task-001',
  phase: 'coder',
  cwd: '/tmp/proj',
  runtime: 'claude',
  model: 'sonnet',
  prompt: 'Write a hello world function.',
};

// ============================================================
// 1. GenericRuntimeAdapter.renderCommand: 占位符替换 + shell quote
// ============================================================

console.log('\n=== 1. GenericRuntimeAdapter: 占位符替换 ===');

{
  const cfg: RuntimeConfig = {
    command: 'mycli',
    args: ['--model', '${model}', '--task', '${task_id}', '${prompt}'],
  };
  const adapter = new GenericRuntimeAdapter('mycli', cfg);
  const cmd = adapter.renderCommand(baseSpawnOpts);

  assert(cmd.startsWith('mycli '), 'command 在最前');
  assert(cmd.includes("'sonnet'"), 'model 占位符替换为 sonnet 并 quote');
  assert(cmd.includes("'task-001'"), 'task_id 占位符替换并 quote');
  assert(cmd.includes("'Write a hello world function.'"), 'prompt 占位符整体 quote');
  // 未声明占位符保持原样
  const cfg2: RuntimeConfig = {
    command: 'x',
    args: ['${unknown_var}', '${model}'],
  };
  const adapter2 = new GenericRuntimeAdapter('x', cfg2);
  const cmd2 = adapter2.renderCommand(baseSpawnOpts);
  assert(cmd2.includes('${unknown_var}'), '未声明占位符原样保留');
  assert(cmd2.includes("'sonnet'"), '已声明占位符正常替换');
}

// ============================================================
// 2. shell escape: 含单引号 / 空格 / shell 元字符的 prompt 不会注入
// ============================================================

console.log('\n=== 2. Shell escape: prompt 包含特殊字符不注入 ===');

{
  const adapter = new GenericRuntimeAdapter('claude', DEFAULT_CONFIG.runtimes!.claude);
  const evil: SpawnOptions = {
    ...baseSpawnOpts,
    prompt: "'; rm -rf /; echo '",
  };
  const cmd = adapter.renderCommand(evil);
  // 单引号被 escape(shell 单引号包裹模式),整段被外层单引号包裹,bash 解析后 rm -rf 不会被执行
  assert(cmd.includes("'\\''"), 'shell 单引号转义出现在结果中');
  const lastQuoteOpen = cmd.lastIndexOf("'");
  assert(lastQuoteOpen > 0, '至少有一对引号包裹');
}

// ============================================================
// 3. ClaudeAdapter / CodexAdapter 渲染输出 = 原 hardcode 字符串(回归保证)
// ============================================================

console.log('\n=== 3. ClaudeAdapter / CodexAdapter: 命令输出与重构前等价 ===');

{
  const claude = new ClaudeAdapter();
  const codex = new CodexAdapter();

  const claudeCmd = claude.renderCommand(baseSpawnOpts);
  // 原 hardcode: claude --model sonnet --dangerously-skip-permissions -p '<prompt>'
  // GenericRuntimeAdapter 把每个 arg 都 quote,所以 --model 也带引号——shell 行为等价
  assert(claudeCmd.startsWith('claude '), 'claude 命令名正确');
  assert(claudeCmd.includes('--model'), '含 --model flag');
  assert(claudeCmd.includes("'sonnet'"), 'model 值已 quote');
  assert(claudeCmd.includes('--dangerously-skip-permissions'), '含 dangerously-skip-permissions');
  assert(claudeCmd.includes('-p'), '含 -p flag');
  assert(claude.runtime === 'claude', 'claude.runtime = "claude"');

  const codexCmd = codex.renderCommand(baseSpawnOpts);
  assert(codexCmd.startsWith('codex '), 'codex 命令名正确');
  assert(codexCmd.includes("'exec'"), 'codex 子命令 exec 存在');
  assert(codexCmd.includes('--dangerously-bypass-approvals-and-sandbox'),
    'codex 含 dangerously-bypass flag');
  assert(codex.runtime === 'codex', 'codex.runtime = "codex"');
}

// ============================================================
// 4. mergeRuntimes: 用户 entry 整体覆盖,新 entry 注册
// ============================================================

console.log('\n=== 4. mergeRuntimes: deep entry 覆盖 + 新 runtime 注册 ===');

{
  // 缺省:全用 DEFAULT
  const defaultMerged = mergeRuntimes({});
  assert('claude' in defaultMerged, '缺省合并含 claude');
  assert('codex' in defaultMerged, '缺省合并含 codex');

  // 用户覆盖 claude:整体替换(即使 user.claude.args 比 default 少也覆盖)
  const userOverride = mergeRuntimes({
    runtimes: {
      claude: { command: 'claude', args: ['-p', '${prompt}'] },  // 简化版
    },
  });
  assert(userOverride.claude.args.length === 2, 'user.claude 整体覆盖,args 只有 2 个');
  assert('codex' in userOverride, '未覆盖的 codex 仍来自 DEFAULT');

  // 用户加新 runtime
  const userAdd = mergeRuntimes({
    runtimes: {
      gemini: { command: 'gemini', args: ['chat', '${prompt}'] },
    },
  });
  assert('gemini' in userAdd, '新 runtime 已注册');
  assert('claude' in userAdd && 'codex' in userAdd, '默认 runtime 保留');
}

// ============================================================
// 5. loadAdapters: 实例化 + adapter 可调用 renderCommand
// ============================================================

console.log('\n=== 5. loadAdapters: 实例化 adapter map ===');

{
  const cfg: Pick<FlooConfig, 'runtimes'> = {
    runtimes: {
      ...DEFAULT_CONFIG.runtimes,
      gemini: { command: 'gemini', args: ['--model', '${model}', '${prompt}'] },
    },
  };
  const adapters = loadAdapters(cfg);
  assert(adapters.claude !== undefined, 'claude 已注册');
  assert(adapters.codex !== undefined, 'codex 已注册');
  assert(adapters.gemini !== undefined, '自定义 gemini 已注册');
  assert(adapters.gemini instanceof GenericRuntimeAdapter, 'gemini 是 GenericRuntimeAdapter 实例');

  const cmd = (adapters.gemini as GenericRuntimeAdapter).renderCommand(baseSpawnOpts);
  assert(cmd.startsWith('gemini '), 'gemini 命令渲染正确');
  assert(cmd.includes("'sonnet'"), 'gemini 模型占位符替换');
}

// ============================================================
// 6. config 缺 runtimes 段:loadAdapters 仍能从 DEFAULT_CONFIG 拉到 claude/codex
// ============================================================

console.log('\n=== 6. config 缺 runtimes 段时退回默认 ===');

{
  const adapters = loadAdapters({});
  assert(adapters.claude !== undefined, '缺 runtimes 段时 claude 仍在');
  assert(adapters.codex !== undefined, '缺 runtimes 段时 codex 仍在');
}

// ============================================================
// 结果
// ============================================================

console.log(`\n=== 结果：${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
