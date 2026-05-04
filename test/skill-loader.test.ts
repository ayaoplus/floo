/**
 * Skill loader 测试 (Step 3)
 *
 * 覆盖:
 *   - parseSkillFile / validateCapabilityMetadata schema 校验
 *   - 6 个内置 skills/*.md 的 frontmatter 全部合法
 *   - loadSkill 老 API 向后兼容(返回去 frontmatter + 变量渲染后的 body)
 */

import {
  parseSkillFile,
  validateCapabilityMetadata,
  loadSkill,
  loadSkillWithMetadata,
} from '../src/core/index.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const here = fileURLToPath(import.meta.url);
const skillsDir = join(dirname(here), '..', 'skills');

// ============================================================
// 1. parseSkillFile: 有 frontmatter 的文件
// ============================================================

console.log('\n=== 1. parseSkillFile: 含 frontmatter ===');

{
  const raw = [
    '---',
    'name: coder',
    'write_policy: scope',
    'outputs:',
    '  - commits',
    'default_runtime: claude',
    'default_model: sonnet',
    '---',
    '',
    '# Body',
    'hello',
  ].join('\n');
  const parsed = parseSkillFile(raw, 'test');
  assert(parsed.metadata !== null, 'metadata 非 null');
  assert(parsed.metadata!.name === 'coder', 'name = coder');
  assert(parsed.metadata!.write_policy === 'scope', 'write_policy = scope');
  assert(parsed.metadata!.outputs[0] === 'commits', 'outputs[0] = commits');
  assert(parsed.metadata!.default_runtime === 'claude', 'default_runtime = claude');
  assert(parsed.body.startsWith('# Body'), 'body 从 frontmatter 后开始');
  assert(!parsed.body.includes('write_policy'), 'body 不含 frontmatter');
}

// ============================================================
// 2. parseSkillFile: 无 frontmatter 的文件向后兼容
// ============================================================

console.log('\n=== 2. parseSkillFile: 无 frontmatter ===');

{
  const raw = '# Old style skill\nNo frontmatter here.';
  const parsed = parseSkillFile(raw, 'test');
  assert(parsed.metadata === null, 'metadata = null(无 frontmatter)');
  assert(parsed.body === raw, 'body 等于原 raw');
}

console.log('\n=== 2b. parseSkillFile: 第一行不是 --- 时不触发 frontmatter 解析 ===');

{
  const raw = '\n---\nname: x\n---\n\nbody';  // 第一行是空行,不算 frontmatter
  const parsed = parseSkillFile(raw, 'test');
  assert(parsed.metadata === null, '前导空行不触发 frontmatter');
  assert(parsed.body === raw, 'body 完整保留');
}

console.log('\n=== 2c. parseSkillFile: 不闭合的 --- 容错 ===');

{
  const raw = '---\nname: coder\nwrite_policy: scope\n# 没有闭合 ---';
  const parsed = parseSkillFile(raw, 'test');
  assert(parsed.metadata === null, '不闭合的 frontmatter 视为无 metadata(容错)');
  assert(parsed.body === raw, 'body 完整保留');
}

// ============================================================
// 3. validateCapabilityMetadata: schema 错误形态
// ============================================================

console.log('\n=== 3. validateCapabilityMetadata: schema 错误 ===');

function expectThrow(parse: unknown, name: string, contains: string, msg: string) {
  try {
    validateCapabilityMetadata(parse, name);
    assert(false, `${msg}:应该抛错 (含 "${contains}")`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    assert(errMsg.includes(contains), `${msg}:错误含 "${contains}"`);
  }
}

expectThrow(null, 'x', '顶层不是 object', '顶层 null');
expectThrow({}, 'x', 'name', '缺 name');
expectThrow({ name: 'unknown' }, 'x', '非法', 'name 非合法 Phase');
expectThrow({ name: 'coder' }, 'x', 'write_policy', '缺 write_policy');
expectThrow(
  { name: 'coder', write_policy: 'free-for-all' },
  'x',
  'write_policy',
  'write_policy 非法',
);
expectThrow(
  { name: 'coder', write_policy: 'scope' },
  'x',
  'outputs',
  '缺 outputs',
);
expectThrow(
  { name: 'coder', write_policy: 'scope', outputs: [] },
  'x',
  'outputs',
  'outputs 空',
);
expectThrow(
  { name: 'coder', write_policy: 'scope', outputs: ['commits'] },
  'x',
  'default_runtime',
  '缺 default_runtime',
);
// Step 5 起 Runtime 是开放联合,自定义 runtime(如 gemini)在 frontmatter 里被接受。
// 运行时由 commands 层 loadAdapters 兜:若该 runtime 未在 floo.config.json 注册,spawn 时报错。
{
  const meta = validateCapabilityMetadata(
    { name: 'coder', write_policy: 'scope', outputs: ['commits'], default_runtime: 'gemini', default_model: 'pro' },
    'x',
  );
  assert(meta.default_runtime === 'gemini', 'frontmatter 接受自定义 runtime "gemini"(Step 5 修复)');
}
expectThrow(
  { name: 'coder', write_policy: 'scope', outputs: ['commits'], default_runtime: 'claude' },
  'x',
  'default_model',
  '缺 default_model',
);
expectThrow(
  { name: 'coder', write_policy: 'scope', outputs: ['commits'], default_runtime: 'claude', default_model: 'sonnet', inputs: 'should-be-array' },
  'x',
  'inputs',
  'inputs 非数组',
);

// 合法情况
{
  const meta = validateCapabilityMetadata(
    { name: 'coder', write_policy: 'scope', outputs: ['commits'], default_runtime: 'claude', default_model: 'sonnet' },
    'x',
  );
  assert(meta.name === 'coder', '合法 metadata 正常返回');
  assert(meta.inputs === undefined, 'inputs 缺省 = undefined');
}

// ============================================================
// 4. 6 个内置 skills/*.md 的 frontmatter 全部合法
// ============================================================

console.log('\n=== 4. 内置 skills/*.md frontmatter 全部合法 ===');

const expected = [
  { name: 'discuss', write_policy: 'artifacts_only', runtime: 'claude', model: 'opus' },
  { name: 'designer', write_policy: 'artifacts_only', runtime: 'claude', model: 'opus' },
  { name: 'planner', write_policy: 'artifacts_only', runtime: 'claude', model: 'sonnet' },
  { name: 'coder', write_policy: 'scope', runtime: 'claude', model: 'sonnet' },
  { name: 'reviewer', write_policy: 'readonly', runtime: 'codex', model: 'codex-mini' },
  { name: 'tester', write_policy: 'readonly', runtime: 'claude', model: 'sonnet' },
];

for (const exp of expected) {
  const file = await loadSkillWithMetadata(skillsDir, exp.name);
  assert(file.metadata !== null, `${exp.name}: metadata 非 null`);
  if (!file.metadata) continue;
  assert(file.metadata.name === exp.name, `${exp.name}: metadata.name 一致`);
  assert(file.metadata.write_policy === exp.write_policy, `${exp.name}: write_policy = ${exp.write_policy}`);
  assert(file.metadata.default_runtime === exp.runtime, `${exp.name}: default_runtime = ${exp.runtime}`);
  assert(file.metadata.default_model === exp.model, `${exp.name}: default_model = ${exp.model}`);
  assert(file.metadata.outputs.length > 0, `${exp.name}: outputs 非空`);
  // body 是渲染前模板,应该含原 prompt 标题
  assert(file.body.length > 0, `${exp.name}: body 非空`);
  assert(file.body.startsWith('#') || file.body.startsWith('\n#'), `${exp.name}: body 以标题开头(frontmatter 已剥离)`);
}

// ============================================================
// 5. loadSkill 老 API 向后兼容
// ============================================================

console.log('\n=== 5. loadSkill 老 API 向后兼容 ===');

{
  // coder skill 含 {{description}} 等变量,loadSkill 应渲染掉
  const rendered = await loadSkill(skillsDir, 'coder', {
    description: '加 priority 字段',
    task_scope: 'src/api/health.ts',
    acceptance_criteria: 'GET /health 返回 priority',
    design_doc: 'design.md 内容',
  });
  assert(rendered.length > 0, '渲染结果非空');
  assert(!rendered.includes('---\nname: coder'), '渲染结果不含 frontmatter');
  assert(rendered.includes('加 priority 字段'), '{{description}} 被替换');
  assert(rendered.includes('src/api/health.ts'), '{{task_scope}} 被替换');
  // 未传变量保留原样(向后兼容)
  // (具体哪些 var 取决于 coder.md 内容,这里只验证 frontmatter 剥离 + 至少一个变量替换)
}

// ============================================================
// 结果
// ============================================================

console.log(`\n=== 结果：${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
