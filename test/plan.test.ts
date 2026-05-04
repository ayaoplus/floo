/**
 * Plan 模块测试 (Step 1)
 *
 * 覆盖:
 *   - synthesizeInitialPlan 在各 startPhase 下生成的 step 草图
 *   - writePlan / readPlan 的 round-trip
 *   - plan.yaml 路径与 batch 目录结构对齐
 *   - dispatcher 不消费 plan.yaml(行为不变,这部分由 dispatcher.test.ts 兜底)
 */

import {
  synthesizeInitialPlan,
  writePlan,
  readPlan,
  planYamlPath,
  loadTemplate,
  validateTemplate,
  planTemplatePath,
  DEFAULT_CONFIG,
} from '../src/core/index.js';
import type { Batch, Task, Phase } from '../src/core/index.js';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

/** 构造测试用 Batch + Task */
function makeFixture(opts: { startPhase: Phase; scope?: string[] }): { batch: Batch; task: Task } {
  const batch: Batch = {
    id: '2026-05-04-test-batch',
    description: 'plan.yaml 镜像测试',
    status: 'active',
    tasks: ['testbatch-001'],
    created_at: '2026-05-04T10:00:00.000Z',
    updated_at: '2026-05-04T10:00:00.000Z',
  };
  const task: Task = {
    id: 'testbatch-001',
    batch_id: batch.id,
    description: batch.description,
    status: 'pending',
    current_phase: null,
    scope: opts.scope ?? [],
    acceptance_criteria: [],
    review_level: 'full',
    created_at: batch.created_at,
    updated_at: batch.updated_at,
    depends_on: [],
  };
  return { batch, task };
}

// ============================================================
// 1. synthesizeInitialPlan: reviewer 单步
// ============================================================

console.log('\n=== 1. synthesizeInitialPlan: reviewer/tester 起步 → 单步 ===');

{
  const { batch, task } = makeFixture({ startPhase: 'reviewer' });
  const plan = synthesizeInitialPlan({ batch, task, startPhase: 'reviewer', config: DEFAULT_CONFIG });
  assert(plan.steps.length === 1, 'reviewer 起步只有 1 个 step');
  assert(plan.steps[0].capability === 'reviewer', 'step 0 capability = reviewer');
  assert(plan.steps[0].status === 'pending', 'reviewer step 状态 pending');
  assert(plan.steps[0].depends_on.length === 0, 'reviewer step 无依赖');
  // 角色绑定应来自 DEFAULT_CONFIG
  assert(plan.steps[0].runtime === 'codex', 'reviewer 默认 runtime = codex (来自 DEFAULT_CONFIG)');
}

{
  const { batch, task } = makeFixture({ startPhase: 'tester' });
  const plan = synthesizeInitialPlan({ batch, task, startPhase: 'tester', config: DEFAULT_CONFIG });
  assert(plan.steps.length === 1, 'tester 起步只有 1 个 step');
  assert(plan.steps[0].capability === 'tester', 'step 0 capability = tester');
}

// ============================================================
// 2. synthesizeInitialPlan: coder 起步 → 三步
// ============================================================

console.log('\n=== 2. synthesizeInitialPlan: coder 起步 → coder→reviewer→tester ===');

{
  const { batch, task } = makeFixture({ startPhase: 'coder', scope: ['src/api/health.ts'] });
  const plan = synthesizeInitialPlan({ batch, task, startPhase: 'coder', config: DEFAULT_CONFIG });
  assert(plan.steps.length === 3, 'coder 起步生成 3 个 step');
  assert(plan.steps.map(s => s.capability).join(',') === 'coder,reviewer,tester', 'step 顺序: coder→reviewer→tester');
  assert(plan.steps[0].depends_on.length === 0, 'coder 无依赖');
  assert(plan.steps[1].depends_on.includes('coder'), 'reviewer 依赖 coder');
  assert(plan.steps[2].depends_on.includes('coder') && plan.steps[2].depends_on.includes('reviewer'), 'tester 依赖 coder + reviewer');
  assert(plan.steps[0].scope.includes('src/api/health.ts'), 'coder step scope 沿用 task scope');
  assert(plan.steps.every(s => s.status === 'pending'), 'coder 起步全部 pending(无 deferred)');
}

// ============================================================
// 3. synthesizeInitialPlan: discuss/designer/planner 起步 → 前置 + deferred
// ============================================================

console.log('\n=== 3. synthesizeInitialPlan: discuss 起步 → 前置 phase + deferred 占位 ===');

{
  const { batch, task } = makeFixture({ startPhase: 'discuss' });
  const plan = synthesizeInitialPlan({ batch, task, startPhase: 'discuss', config: DEFAULT_CONFIG });
  // discuss → designer → planner → implement-deferred → review-deferred → test-deferred
  assert(plan.steps.length === 6, 'discuss 起步生成 6 个 step');
  const ids = plan.steps.map(s => s.id);
  assert(ids[0] === 'discuss' && ids[1] === 'designer' && ids[2] === 'planner', '前置三步顺序正确');
  assert(ids[3] === 'implement-deferred', '第 4 步是 implement-deferred 占位');
  assert(ids[5] === 'test-deferred', '第 6 步是 test-deferred 占位');
  assert(plan.steps[3].status === 'deferred', 'deferred 步状态 = deferred');
  assert(typeof plan.steps[3].notes === 'string' && plan.steps[3].notes!.includes('planner'), 'deferred 步带 planner 拆 task 说明');
  assert(plan.steps[1].depends_on[0] === 'discuss', 'designer 依赖 discuss');
  assert(plan.steps[2].depends_on[0] === 'designer', 'planner 依赖 designer');
  assert(plan.steps[3].depends_on[0] === 'planner', 'implement-deferred 依赖 planner');
}

console.log('\n=== 3b. synthesizeInitialPlan: designer 起步 → 跳过 discuss ===');

{
  const { batch, task } = makeFixture({ startPhase: 'designer' });
  const plan = synthesizeInitialPlan({ batch, task, startPhase: 'designer', config: DEFAULT_CONFIG });
  assert(plan.steps.length === 5, 'designer 起步生成 5 个 step (无 discuss)');
  assert(plan.steps[0].id === 'designer', '第一步是 designer');
  assert(plan.steps[0].depends_on.length === 0, 'designer 起步时 designer 无依赖');
}

console.log('\n=== 3c. synthesizeInitialPlan: planner 起步 → 仅 planner + deferred ===');

{
  const { batch, task } = makeFixture({ startPhase: 'planner' });
  const plan = synthesizeInitialPlan({ batch, task, startPhase: 'planner', config: DEFAULT_CONFIG });
  assert(plan.steps.length === 4, 'planner 起步生成 4 个 step (planner + 3 deferred)');
  assert(plan.steps[0].id === 'planner', '第一步是 planner');
  assert(plan.steps.slice(1).every(s => s.status === 'deferred'), '后三步全部 deferred');
}

// ============================================================
// 4. plan.yaml 顶层字段
// ============================================================

console.log('\n=== 4. plan.yaml 顶层元数据字段 ===');

{
  const { batch, task } = makeFixture({ startPhase: 'coder', scope: ['src/foo.ts'] });
  const plan = synthesizeInitialPlan({ batch, task, startPhase: 'coder', config: DEFAULT_CONFIG });
  assert(plan.schema_version === 1, 'schema_version = 1');
  assert(plan.batch_id === batch.id, 'batch_id 透传');
  assert(plan.created_at === batch.created_at, 'created_at 透传 batch.created_at');
  assert(plan.mode === 'legacy-dispatcher', 'mode = legacy-dispatcher (Step 1 镜像)');
  assert(plan.start_phase === 'coder', 'start_phase 透传');
  assert(plan.initial_task.id === task.id, 'initial_task.id 透传');
  assert(plan.initial_task.scope[0] === 'src/foo.ts', 'initial_task.scope 透传');
  assert(plan.notes.length > 0, 'notes 非空(给读者的镜像说明)');
}

// ============================================================
// 5. writePlan / readPlan round-trip
// ============================================================

console.log('\n=== 5. writePlan / readPlan round-trip ===');

const tmpDir = join(tmpdir(), `floo-plan-test-${Date.now()}`);
const flooDir = join(tmpDir, '.floo');

try {
  await mkdir(flooDir, { recursive: true });
  const { batch, task } = makeFixture({ startPhase: 'discuss' });
  const original = synthesizeInitialPlan({ batch, task, startPhase: 'discuss', config: DEFAULT_CONFIG });

  await writePlan(flooDir, original);
  const expectedPath = join(flooDir, 'batches', batch.id, 'plan.yaml');
  assert(planYamlPath(flooDir, batch.id) === expectedPath, 'planYamlPath 与 batch.json 同级目录');

  // 文件确实存在
  const raw = await readFile(expectedPath, 'utf8');
  assert(raw.length > 0, '写盘后文件非空');
  assert(raw.includes('schema_version:'), 'yaml 含 schema_version 字段');
  assert(raw.includes('mode: legacy-dispatcher'), 'yaml 含 mode 字段');

  // round-trip
  const loaded = await readPlan(flooDir, batch.id);
  assert(loaded !== null, 'readPlan 返回非 null');
  assert(loaded!.batch_id === original.batch_id, 'round-trip: batch_id 一致');
  assert(loaded!.steps.length === original.steps.length, 'round-trip: steps 长度一致');
  assert(loaded!.steps[0].capability === original.steps[0].capability, 'round-trip: 第一步 capability 一致');
  assert(loaded!.steps[3].status === 'deferred', 'round-trip: deferred 标记保留');

  // 不存在的 batch
  const missing = await readPlan(flooDir, 'no-such-batch');
  assert(missing === null, '不存在的 batch readPlan 返回 null');
} finally {
  await rm(tmpDir, { recursive: true, force: true });
}

// ============================================================
// 6. role_overrides 不影响 Step 1 镜像(镜像反映项目级默认绑定)
// ============================================================

console.log('\n=== 6. Step 1 镜像反映 config.roles,不读 task.role_overrides ===');

{
  const { batch, task } = makeFixture({ startPhase: 'coder' });
  // 给 task 加一个 override(模拟用户在 task 级别强制 reviewer 用 claude)
  task.role_overrides = { reviewer: { runtime: 'claude', model: 'opus' } };
  const plan = synthesizeInitialPlan({ batch, task, startPhase: 'coder', config: DEFAULT_CONFIG });
  // Step 1 镜像不读 role_overrides,反映的是默认绑定
  const reviewerStep = plan.steps.find(s => s.capability === 'reviewer')!;
  assert(reviewerStep.runtime === 'codex', 'Step 1 镜像 reviewer.runtime = codex (默认绑定,忽略 task.role_overrides)');
  // 这是有意为之的简化,Step 4 executor 落地后才会消费 role_overrides
}

// ============================================================
// 7. loadTemplate: 内置 feature.yaml(Step 2)
// ============================================================

console.log('\n=== 7. loadTemplate: 内置 feature.yaml ===');

{
  const tpl = await loadTemplate('feature');
  assert(tpl.schema_version === 1, 'feature.yaml schema_version = 1');
  assert(tpl.name === 'feature', 'feature.yaml name = feature');
  assert(typeof tpl.description === 'string' && tpl.description.length > 0, 'feature.yaml 含 description');
  // step 顺序应当对齐 PHASE_ORDER 的 6 阶段语义,前 3 步是 discuss/designer/planner
  assert(tpl.steps.length === 6, 'feature.yaml 含 6 个 step');
  assert(tpl.steps[0].capability === 'discuss', 'step 0 = discuss');
  assert(tpl.steps[1].capability === 'designer', 'step 1 = designer');
  assert(tpl.steps[2].capability === 'planner', 'step 2 = planner');
  assert(tpl.steps[3].capability === 'coder', 'step 3 = coder');
  assert(tpl.steps[4].capability === 'reviewer', 'step 4 = reviewer');
  assert(tpl.steps[5].capability === 'tester', 'step 5 = tester');
  // 飞轮标记
  assert(tpl.steps[0].loop_with === 'designer', 'discuss 标 loop_with: designer');
  assert(tpl.steps[4].loop_with === 'implement', 'reviewer 标 loop_with: implement');
  // defer_after 标记
  assert(tpl.steps[3].defer_after === 'planner', 'implement 标 defer_after: planner');
  // 依赖
  assert(tpl.steps[1].depends_on?.[0] === 'discuss', 'designer depends_on discuss');
  const testerDeps = tpl.steps[5].depends_on ?? [];
  assert(testerDeps.includes('implement') && testerDeps.includes('review'), 'tester 依赖 implement + review');
  // scope
  assert(tpl.steps[3].scope === 'task', 'implement scope = task (透传 task.scope)');
}

console.log('\n=== 7b. loadTemplate: 不存在的模板抛错 ===');

try {
  await loadTemplate('no-such-template');
  assert(false, '应该抛错');
} catch (err) {
  assert(err instanceof Error && err.message.includes('不存在'), '不存在的模板抛 Error 含定位信息');
}

console.log('\n=== 7c. loadTemplate: FLOO_TEMPLATES_DIR 环境变量覆盖 ===');

{
  const envTmpDir = join(tmpdir(), `floo-template-test-${Date.now()}`);
  await mkdir(envTmpDir, { recursive: true });
  await writeFile(
    join(envTmpDir, 'minimal.yaml'),
    [
      'schema_version: 1',
      'name: minimal',
      'steps:',
      '  - id: only',
      '    capability: coder',
    ].join('\n'),
  );
  const oldEnv = process.env.FLOO_TEMPLATES_DIR;
  process.env.FLOO_TEMPLATES_DIR = envTmpDir;
  try {
    const tpl = await loadTemplate('minimal');
    assert(tpl.name === 'minimal', '环境变量目录加载成功');
    assert(tpl.steps.length === 1, '环境变量目录的模板 step 数正确');
    // planTemplatePath 也应跟随环境变量
    assert(planTemplatePath('minimal') === join(envTmpDir, 'minimal.yaml'), 'planTemplatePath 跟随 FLOO_TEMPLATES_DIR');
  } finally {
    if (oldEnv === undefined) delete process.env.FLOO_TEMPLATES_DIR;
    else process.env.FLOO_TEMPLATES_DIR = oldEnv;
    await rm(envTmpDir, { recursive: true, force: true });
  }
}

// ============================================================
// 8. validateTemplate: schema 校验各种错误形态
// ============================================================

console.log('\n=== 8. validateTemplate: schema 错误形态 ===');

function expectThrow(parse: unknown, name: string, contains: string, msg: string) {
  try {
    validateTemplate(parse, name);
    assert(false, `${msg}:应该抛错 (含 "${contains}")`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    assert(errMsg.includes(contains), `${msg}:错误信息含 "${contains}" (实际:${errMsg})`);
  }
}

expectThrow(null, 'x', '顶层不是 object', '顶层非 object');
expectThrow({ schema_version: 2, name: 'x', steps: [{ id: 'a', capability: 'coder' }] }, 'x', 'schema_version', 'schema_version 错误');
expectThrow({ schema_version: 1, steps: [] }, 'x', 'name', '缺 name');
expectThrow({ schema_version: 1, name: 'x', steps: [] }, 'x', 'steps', 'steps 空');
expectThrow(
  { schema_version: 1, name: 'x', steps: [{ id: 'a', capability: 'unknown' }] },
  'x',
  '非法',
  'capability 非法',
);
expectThrow(
  { schema_version: 1, name: 'x', steps: [{ id: 'a', capability: 'coder' }, { id: 'a', capability: 'reviewer' }] },
  'x',
  '重复',
  'id 重复',
);
expectThrow(
  { schema_version: 1, name: 'x', steps: [{ id: 'a', capability: 'coder', depends_on: ['nonexistent'] }] },
  'x',
  '未声明',
  '依赖未声明 step',
);

// 合法情况:不抛错
{
  const tpl = validateTemplate(
    { schema_version: 1, name: 'x', steps: [{ id: 'a', capability: 'coder' }] },
    'x',
  );
  assert(tpl.steps[0].id === 'a', '合法模板正常返回');
}

// ============================================================
// 9. Step 2 不影响 dispatcher 行为(放在这里只做提示性 assert)
// ============================================================

console.log('\n=== 9. Step 2 不消费模板:PHASE_ORDER 仍是硬编码 ===');

{
  // PHASE_ORDER 来源在 types.ts,Step 2 没改
  const { PHASE_ORDER } = await import('../src/core/index.js');
  assert(PHASE_ORDER.length === 6, 'PHASE_ORDER 仍是硬编码 6 阶段');
  assert(PHASE_ORDER[0] === 'discuss', 'PHASE_ORDER[0] 不受 feature.yaml 影响');
}

// ============================================================
// 结果
// ============================================================

console.log(`\n=== 结果：${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
