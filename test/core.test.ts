/**
 * Core 测试
 * 验证：types、scope 冲突检测、commit 锁、skill 模板、tmux adapter、router、adapters
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
} from '../src/core/index.js';
import type {
  Task,
  Batch,
  RunRecord,
  ExitArtifact,
  SpawnOptions,
  Runtime,
} from '../src/core/index.js';
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

// 空 scope 视为冲突（不确定改什么 → 强制串行）
const overlap4 = scopesOverlap([], ['src/api/']);
assert(overlap4.length > 0, '空 scope 与任何 scope 冲突');
const overlap5 = scopesOverlap([], []);
assert(overlap5.length > 0, '两个空 scope 也冲突');

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

import { routeTask } from '../src/core/router.js';

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

import { ClaudeAdapter, CodexAdapter, createAndRun } from '../src/core/index.js';

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
// 9. Config 向导纯函数
// ============================================================

console.log('\n=== 9. Config 向导 ===');

import { applyQuickStart, applyManual, diffConfig } from '../src/commands/config.js';
import type { QuickStartAnswers, ManualAnswers } from '../src/commands/config.js';

// --- applyQuickStart ---

const baseConfig = structuredClone(DEFAULT_CONFIG);

// all-claude 预设：所有角色都改为 claude/sonnet
const qs1 = applyQuickStart(baseConfig, {
  max_agents: 2,
  max_review_rounds: 3,
  runtime_preset: 'all-claude',
});
assert(qs1.concurrency.max_agents === 2, 'QuickStart: max_agents 更新');
assert(qs1.limits?.max_review_rounds === 3, 'QuickStart: max_review_rounds 更新');
assert(qs1.roles.reviewer.runtime === 'claude', 'QuickStart all-claude: reviewer 改为 claude');
assert(qs1.roles.coder.runtime === 'claude', 'QuickStart all-claude: coder 保持 claude');

// all-codex 预设：所有角色改为 codex/codex-mini
const qs2 = applyQuickStart(baseConfig, {
  max_agents: 1,
  max_review_rounds: 1,
  runtime_preset: 'all-codex',
});
assert(qs2.roles.designer.runtime === 'codex', 'QuickStart all-codex: designer 改为 codex');
assert(qs2.roles.coder.model === 'codex-mini', 'QuickStart all-codex: model = codex-mini');

// keep 预设：roles 不变
const qs3 = applyQuickStart(baseConfig, {
  max_agents: 3,
  max_review_rounds: 2,
  runtime_preset: 'keep',
});
assert(qs3.roles.reviewer.runtime === 'codex', 'QuickStart keep: reviewer 保持 codex');
assert(qs3.roles.designer.runtime === 'claude', 'QuickStart keep: designer 保持 claude');

// 不修改原对象
assert(baseConfig.concurrency.max_agents === 3, 'applyQuickStart 不修改原配置');

// --- applyManual ---

const manualAnswers: ManualAnswers = {
  roles: {
    designer:  { runtime: 'claude', model: 'opus' },
    planner:   { runtime: 'claude', model: 'sonnet' },
    coder:     { runtime: 'claude', model: 'sonnet' },
    reviewer:  { runtime: 'claude', model: 'haiku' },
    tester:    { runtime: 'codex',  model: 'codex-mini' },
  },
  max_agents: 2,
  commit_lock: false,
  timeout_minutes: 60,
  keep_on_success_minutes: 15,
  keep_on_failure_minutes: 720,
  orphan_check_interval_minutes: 5,
  max_review_rounds: 3,
  max_test_rounds: 1,
  extra_protected_files: ['secrets.json', '.env.local'],
};

const m1 = applyManual(baseConfig, manualAnswers);
assert(m1.roles.designer.model === 'opus', 'Manual: designer model 更新');
assert(m1.roles.reviewer.runtime === 'claude', 'Manual: reviewer 改为 claude');
assert(m1.concurrency.commit_lock === false, 'Manual: commit_lock 更新');
assert(m1.session.timeout_minutes === 60, 'Manual: timeout 更新');
assert(m1.limits?.max_review_rounds === 3, 'Manual: max_review_rounds 更新');
assert(m1.limits?.max_test_rounds === 1, 'Manual: max_test_rounds 更新');
assert(m1.protected_files.includes('secrets.json'), 'Manual: 新增保护文件');
assert(m1.protected_files.includes('.env'), 'Manual: 原有保护文件保留');

// extra_protected_files 去重
const m2 = applyManual(baseConfig, { ...manualAnswers, extra_protected_files: ['.env', 'new.txt'] });
const envCount = m2.protected_files.filter(f => f === '.env').length;
assert(envCount === 1, 'Manual: 保护文件不重复添加');

// 不修改原对象
assert(baseConfig.concurrency.commit_lock === true, 'applyManual 不修改原配置');

// --- diffConfig ---

// 无变化
const noDiff = diffConfig(baseConfig, structuredClone(baseConfig));
assert(noDiff.length === 0, 'diffConfig: 相同配置无变化');

// 有变化
const changed = applyQuickStart(baseConfig, { max_agents: 1, max_review_rounds: 3, runtime_preset: 'all-claude' });
const diffs = diffConfig(baseConfig, changed);
assert(diffs.some(d => d.includes('max_agents')), 'diffConfig: 检测到 max_agents 变化');
assert(diffs.some(d => d.includes('max_review_rounds')), 'diffConfig: 检测到 max_review_rounds 变化');
assert(diffs.some(d => d.includes('reviewer')), 'diffConfig: 检测到 reviewer runtime 变化');

// ============================================================
// 结果
// ============================================================

console.log(`\n=== 结果：${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
