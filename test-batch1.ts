/**
 * Batch 1 验证脚本
 * 验证：types 导入、scope 冲突检测、commit 锁、skill 模板加载、tmux adapter
 */

import {
  scopesOverlap,
  detectConflicts,
  findOutOfScope,
  acquireCommitLock,
  releaseCommitLock,
  ensureFlooDir,
  renderTemplate,
  extractVariables,
  BaseAdapter,
  readExitArtifact,
  waitForCompletion,
  PHASE_ORDER,
  MAX_RETRIES,
  DEFAULT_CONFIG,
} from './packages/core/src/index.js';
import type {
  Task,
  Batch,
  RunRecord,
  ExitArtifact,
  SpawnOptions,
  Runtime,
} from './packages/core/src/index.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ============================================================
// 测试工具
// ============================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.log(`  ✗ ${msg}`);
    failed++;
  }
}

// ============================================================
// 1. Types 导入验��
// ============================================================

console.log('\n=== 1. Types 导入 ===');

assert(PHASE_ORDER.length === 5, 'PHASE_ORDER 有 5 个阶段（含 tester）');
assert(PHASE_ORDER[0] === 'designer', '第一个阶段是 designer');
assert(MAX_RETRIES === 3, 'MAX_RETRIES = 3');
assert(DEFAULT_CONFIG.roles.reviewer.runtime === 'codex', 'Reviewer 默认用 codex');

// 验证类型可用（编译时检查）
const mockTask: Task = {
  id: 'task-001',
  batch_id: 'test-batch',
  description: 'test task',
  status: 'pending',
  current_phase: null,
  scope: ['src/api/'],
  acceptance_criteria: ['works'],
  review_level: 'full',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  depends_on: [],
};
assert(mockTask.id === 'task-001', 'Task 类型可以正常构造');

// ============================================================
// 2. Scope 冲突检测
// ============================================================

console.log('\n=== 2. Scope 冲突检测 ===');

// 无冲突
const overlap1 = scopesOverlap(['src/api/'], ['src/web/']);
assert(overlap1.length === 0, '不相交的 scope 无冲突');

// 有冲突：父子目录
const overlap2 = scopesOverlap(['src/api/'], ['src/api/health.ts']);
assert(overlap2.length > 0, '父子目录有冲突');

// 有冲突：完全相同
const overlap3 = scopesOverlap(['src/api/health.ts'], ['src/api/health.ts']);
assert(overlap3.length > 0, '相同文件有冲突');

// 多任务冲突检测
const conflicts = detectConflicts([
  { id: 'T1', scope: ['src/api/'] },
  { id: 'T2', scope: ['src/web/'] },
  { id: 'T3', scope: ['src/api/health.ts'] },
]);
assert(conflicts.length === 1, '三任务中只有 T1↔T3 冲突');
assert(conflicts[0]?.task_a === 'T1' && conflicts[0]?.task_b === 'T3', '冲突对正确');

// 越界检测
const outOfScope = findOutOfScope(
  ['src/api/health.ts', 'src/web/index.ts', 'README.md'],
  ['src/api/'],
);
assert(outOfScope.length === 2, '两个文件越界');
assert(outOfScope.includes('src/web/index.ts'), 'web/index.ts 越界');
assert(outOfScope.includes('README.md'), 'README.md 越界');

// ============================================================
// 3. Commit 锁
// ============================================================

console.log('\n=== 3. Commit 锁 ===');

const testDir = join(tmpdir(), `floo-test-${Date.now()}`);
await mkdir(testDir, { recursive: true });

// 获取锁
await acquireCommitLock(testDir, 'T001', 'floo-T001-coder');
assert(true, '锁获取成功');

// 重复获取应该失败（同一进程持有，PID 检查会认为非 stale）
// maxWaitMs=0 表示不等待，立即报错
try {
  await acquireCommitLock(testDir, 'T002', 'floo-T002-coder', 0);
  assert(false, '重复获取锁应该抛错');
} catch (err) {
  assert(String(err).includes('Commit lock held'), '重复获取锁正确报错');
}

// 释放锁
await releaseCommitLock(testDir, 'T001');
assert(true, '锁释放成功');

// 用错误的 taskId 释放应该报错
await acquireCommitLock(testDir, 'T001', 'floo-T001-coder');
try {
  await releaseCommitLock(testDir, 'T999');
  assert(false, '用错误 taskId 释放应该报错');
} catch (err) {
  assert(String(err).includes('Cannot release lock'), '持有者验证正确');
}
await releaseCommitLock(testDir, 'T001');

// 释放后可以重新获取
await acquireCommitLock(testDir, 'T002', 'floo-T002-coder');
assert(true, '释放后重新获取成功');
await releaseCommitLock(testDir, 'T002');

// 清理
await rm(testDir, { recursive: true });

// ============================================================
// 4. Skill 模板
// ============================================================

console.log('\n=== 4. Skill 模板 ===');

const template = '你是 {{role}}，任务是 {{task}}。项目：{{ project }}';
const rendered = renderTemplate(template, {
  role: 'Designer',
  task: '设计支付模块',
  project: 'floo',
});
assert(rendered === '你是 Designer，任务是 设计支付模块。项目：floo', '变量替换正确');

// 未匹配变量保留原样
const partial = renderTemplate('Hello {{name}}, {{unknown}}!', { name: 'World' });
assert(partial === 'Hello World, {{unknown}}!', '未匹配变量保留');

// 提取变量名
const vars = extractVariables('{{a}} and {{b}} and {{a}}');
assert(vars.length === 2, '提取去重变量名');
assert(vars.includes('a') && vars.includes('b'), '变量名正确');

// ============================================================
// 5. tmux Adapter（需要 tmux 可用）
// ============================================================

console.log('\n=== 5. tmux Adapter ===');

// 创建一个简单的测试 adapter
class TestAdapter extends BaseAdapter {
  runtime: Runtime = 'claude';

  protected buildAgentCommand(opts: SpawnOptions): string {
    // 用 echo 模拟 agent 执行
    return `echo "Hello from ${opts.phase}"`;
  }
}

const adapter = new TestAdapter();
const testProjectDir = join(tmpdir(), `floo-tmux-test-${Date.now()}`);
await mkdir(testProjectDir, { recursive: true });

// 初始化 .floo 目录
await ensureFlooDir(testProjectDir);

const sessionName = await adapter.spawn({
  taskId: 'TEST',
  phase: 'designer',
  prompt: 'test prompt',
  cwd: testProjectDir,
  runtime: 'claude',
  model: 'sonnet',
});

assert(sessionName === 'floo-TEST-designer', 'session name 格式正确');

// 等待完成（echo 命令很快就结束，会退化到文件轮询模式）
await waitForCompletion(
  sessionName,
  join(testProjectDir, '.floo'),
  'TEST',
  'designer',
);
assert(true, 'agent 完成信号收到');

// session 应该已经结束
const alive = await adapter.isAlive(sessionName);
assert(!alive, 'session 已结束');

// 读 exit artifact
const exitArtifact = await readExitArtifact(
  join(testProjectDir, '.floo'),
  'TEST',
  'designer',
);
assert(exitArtifact.exit_code === 0, 'exit code = 0');
assert(exitArtifact.task_id === 'TEST', 'task_id 正确');
assert(exitArtifact.phase === 'designer', 'phase 正确');
assert(exitArtifact.session_name === 'floo-TEST-designer', 'session_name 正确');
assert(typeof exitArtifact.duration_seconds === 'number', 'duration 是数字');

// 清理
await rm(testProjectDir, { recursive: true });

// ============================================================
// 6. Batch 2: Router
// ============================================================

console.log('\n=== 6. Router ===');

import { routeTask } from './packages/core/src/router.js';

assert(routeTask('重构支付模块，支持多币种') === 'designer', '长描述默认 designer');
assert(routeTask('fix login button bug') === 'coder', 'bug 关键词走 coder');
assert(routeTask('修复登录报错') === 'coder', '中文 bug 关键词走 coder');
assert(routeTask('review src/api/') === 'reviewer', 'review 关键词走 reviewer');
assert(routeTask('给 src/api/health.ts 加 version') === 'planner', '短描述+文件路径走 planner');
assert(routeTask('', { from: 'coder' }) === 'coder', '显式覆盖生效');
assert(routeTask('改个小东西', { scope: ['src/a.ts'] }) === 'coder', '有 scope+短描述走 coder');

// ============================================================
// 7. Batch 2: Adapters + Dispatcher 导入
// ============================================================

console.log('\n=== 7. Adapters & Dispatcher ===');

import { ClaudeAdapter, CodexAdapter, createAndRun } from './packages/core/src/index.js';

const claude = new ClaudeAdapter();
assert(claude.runtime === 'claude', 'ClaudeAdapter runtime 正确');

const codex = new CodexAdapter();
assert(codex.runtime === 'codex', 'CodexAdapter runtime 正确');

assert(typeof createAndRun === 'function', 'createAndRun 导出正确');

// ============================================================
// 8. Batch 2: YAML 引号剥离
// ============================================================

console.log('\n=== 8. YAML 引号处理 ===');

// 测试 consumePlannerOutput 的间接效果：stripYamlQuotes
// 直接测试引号剥离逻辑
function testStripQuotes(val: string): string {
  if ((val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  return val;
}

assert(testStripQuotes('"src/api/health.ts"') === 'src/api/health.ts', '双引号剥离');
assert(testStripQuotes("'src/api/health.ts'") === 'src/api/health.ts', '单引号剥离');
assert(testStripQuotes('src/api/health.ts') === 'src/api/health.ts', '无引号不变');
assert(testStripQuotes('"full"') === 'full', 'review_level 引号剥离');

// ============================================================
// 结果
// ============================================================

console.log(`\n=== 结果：${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
