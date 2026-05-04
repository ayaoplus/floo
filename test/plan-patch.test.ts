/**
 * Plan-Patch 测试 (Step 6 - A)
 *
 * 范围:
 *   - applyPatch 纯函数行为(append-only / 校验 / 不修改原 plan)
 *   - validatePatch schema 校验
 *   - writePatch / readPatches IO 往返
 *   - 校验失败的 patch 文件被跳过(单点损坏不阻塞)
 */

import {
  applyPatch,
  writePatch,
  readPatches,
  validatePatch,
  patchPath,
  synthesizeInitialPlan,
  writePlan,
  readPlan,
  DEFAULT_CONFIG,
  type PlanPatch,
  type PlanYaml,
} from '../src/core/index.js';
import type { Batch, Task } from '../src/core/index.js';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

// 共用 fixture:reviewer 起步的最小 plan
function makePlan(): PlanYaml {
  const batch: Batch = {
    id: '2026-05-04-test-001',
    description: 'patch test',
    status: 'active',
    tasks: ['t-001'],
    created_at: '2026-05-04T10:00:00Z',
    updated_at: '2026-05-04T10:00:00Z',
  };
  const task: Task = {
    id: 't-001',
    batch_id: batch.id,
    description: 'patch test',
    status: 'pending',
    current_phase: null,
    scope: ['src/'],
    acceptance_criteria: [],
    review_level: 'full',
    created_at: batch.created_at,
    updated_at: batch.updated_at,
    depends_on: [],
  };
  return synthesizeInitialPlan({ batch, task, startPhase: 'coder', config: DEFAULT_CONFIG });
}

function makePatch(overrides: Partial<PlanPatch> = {}): PlanPatch {
  return {
    schema_version: 1,
    patch_id: 'review-1-fail-1',
    generated_at: '2026-05-04T10:05:00Z',
    generated_by: 'executor:reviewer-verdict',
    parent_step: 'reviewer',
    reason: 'reviewer_fail_round_1',
    kind: 'append-steps',
    append_steps: [
      { id: 'coder-2', capability: 'coder', depends_on: ['reviewer'] },
      { id: 'reviewer-2', capability: 'reviewer', depends_on: ['coder-2'] },
    ],
    ...overrides,
  };
}

// ============================================================
// 1. applyPatch happy path
// ============================================================

console.log('\n=== 1. applyPatch: append-steps 成功路径 ===');

{
  const plan = makePlan();
  const beforeStepsLen = plan.steps.length;
  const patch = makePatch();
  const result = applyPatch(plan, patch);

  assert(result.appended.length === 2, '返回 appended.length = 2');
  assert(result.plan.steps.length === beforeStepsLen + 2, '新 plan 比原 plan 多 2 个 step');
  assert(result.plan.steps[result.plan.steps.length - 2].id === 'coder-2', '末尾倒数第二是 coder-2');
  assert(result.plan.steps[result.plan.steps.length - 1].id === 'reviewer-2', '末尾是 reviewer-2');
  assert(plan.steps.length === beforeStepsLen, '原 plan 不被修改(纯函数语义)');
  assert(result.plan.notes.some(n => n.includes('review-1-fail-1')), 'plan.notes 记录 patch_id');
  assert(result.plan.notes.some(n => n.includes('reviewer_fail_round_1')), 'plan.notes 记录 reason');
}

// ============================================================
// 2. applyPatch: 校验失败路径
// ============================================================

console.log('\n=== 2. applyPatch: 校验失败 ===');

{
  const plan = makePlan();

  // 2a. parent_step 不存在
  try {
    applyPatch(plan, makePatch({ parent_step: 'no-such-step' }));
    assert(false, 'parent_step 不存在应抛错');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes('no-such-step'), '错误信息含未知 parent_step 名');
  }

  // 2b. append_steps[].id 与 plan 已有冲突
  try {
    applyPatch(plan, makePatch({
      append_steps: [{ id: 'reviewer', capability: 'reviewer' }], // reviewer 已在 plan
    }));
    assert(false, 'id 冲突应抛错');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes('冲突'), '错误信息说明 id 冲突');
  }

  // 2c. patch 内 id 重复
  try {
    applyPatch(plan, makePatch({
      append_steps: [
        { id: 'dup', capability: 'coder' },
        { id: 'dup', capability: 'reviewer' },
      ],
    }));
    assert(false, 'patch 内 id 重复应抛错');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes('重复'), '错误信息说明 patch 内重复');
  }

  // 2d. depends_on 指向不存在的 step
  try {
    applyPatch(plan, makePatch({
      append_steps: [{ id: 'a', capability: 'coder', depends_on: ['ghost'] }],
    }));
    assert(false, 'depends_on 引用不存在 step 应抛错');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes('ghost'), '错误信息含未知依赖名');
  }

  // 2e. patch 内前序 step 可作为依赖(合法)
  const okResult = applyPatch(plan, makePatch({
    append_steps: [
      { id: 'a', capability: 'coder' },
      { id: 'b', capability: 'reviewer', depends_on: ['a'] }, // 依赖 patch 内更早的 step
    ],
  }));
  assert(okResult.appended.length === 2, 'patch 内自引用依赖合法');

  // 2f. kind 非 append-steps 抛错
  try {
    applyPatch(plan, makePatch({ kind: 'unknown' as 'append-steps' }));
    assert(false, '未知 kind 应抛错');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes('append-steps'), '错误信息提示只支持 append-steps');
  }

  // 2g. (codex review #4) runtime/model 缺失且 plan 中找不到同 capability step → 抛错
  // 防止 plan-patch ledger 写入误导的 runtime/model 值
  try {
    applyPatch(plan, makePatch({
      append_steps: [{ id: 'discuss-1', capability: 'discuss' }], // plan 是 coder 起步,无 discuss step
    }));
    assert(false, '同 capability step 不存在 + 缺 runtime → 应抛错');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes('runtime/model'), '错误信息说明缺 runtime/model');
    assert(msg.includes('discuss'), '错误信息含 capability 名');
  }

  // 2h. ts.runtime/model 显式提供 → 不报错(emitRetryPatch 走的就是这条)
  const explicit = applyPatch(plan, makePatch({
    append_steps: [{ id: 'discuss-1', capability: 'discuss', runtime: 'claude', model: 'opus' }],
  }));
  assert(explicit.appended[0].runtime === 'claude', '显式 runtime 被采用');
  assert(explicit.appended[0].model === 'opus', '显式 model 被采用');
}

// ============================================================
// 3. validatePatch: schema 校验
// ============================================================

console.log('\n=== 3. validatePatch: schema 校验 ===');

{
  // happy
  const ok = validatePatch(makePatch(), 'review-1-fail-1.yaml');
  assert(ok.patch_id === 'review-1-fail-1', '合法 patch 解析成功');

  // schema_version 错
  try {
    validatePatch({ ...makePatch(), schema_version: 2 }, 'x.yaml');
    assert(false, 'schema_version 错应抛');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes('schema_version'), '错误含 schema_version');
  }

  // 缺 patch_id
  try {
    const bad = { ...makePatch() } as Record<string, unknown>;
    delete bad.patch_id;
    validatePatch(bad, 'x.yaml');
    assert(false, '缺 patch_id 应抛');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes('patch_id'), '错误含 patch_id 缺失');
  }

  // append_steps[0].capability 非法
  try {
    validatePatch(
      makePatch({ append_steps: [{ id: 'x', capability: 'foobar' as 'coder' }] }),
      'x.yaml',
    );
    assert(false, '非法 capability 应抛');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes('foobar'), '错误含非法 capability 值');
  }

  // 顶层非 object
  try {
    validatePatch('not an object', 'x.yaml');
    assert(false, '非 object 应抛');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes('顶层'), '错误说明顶层不对');
  }

  // append_steps 空数组
  try {
    validatePatch(makePatch({ append_steps: [] }), 'x.yaml');
    assert(false, '空 append_steps 应抛');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes('append_steps'), '错误信息含 append_steps 字段');
  }
}

// ============================================================
// 4. writePatch / readPatches: IO 往返
// ============================================================

console.log('\n=== 4. writePatch / readPatches: 往返 ===');

{
  const flooDir = join(tmpdir(), `floo-patch-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  await mkdir(flooDir, { recursive: true });
  try {
    const batchId = 'batch-001';
    // 写两份 patch,验证读出来按 generated_at 排序
    const p1 = makePatch({ patch_id: 'p1', generated_at: '2026-05-04T11:00:00Z' });
    const p2 = makePatch({ patch_id: 'p2', generated_at: '2026-05-04T10:00:00Z' });
    const p1Path = await writePatch(flooDir, batchId, p1);
    const p2Path = await writePatch(flooDir, batchId, p2);
    assert(p1Path === patchPath(flooDir, batchId, 'p1'), 'writePatch 返回正确路径');
    assert(p2Path !== p1Path, '两份 patch 写到不同文件');

    const all = await readPatches(flooDir, batchId);
    assert(all.length === 2, '读到 2 份 patch');
    assert(all[0].patch_id === 'p2', '按 generated_at 升序排:p2 在前');
    assert(all[1].patch_id === 'p1', 'p1 在后');
  } finally {
    await rm(flooDir, { recursive: true, force: true });
  }
}

// ============================================================
// 5. readPatches: 损坏的 patch 文件被跳过
// ============================================================

console.log('\n=== 5. readPatches: 损坏 patch 跳过 ===');

{
  const flooDir = join(tmpdir(), `floo-patch-broken-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  await mkdir(flooDir, { recursive: true });
  try {
    const batchId = 'batch-002';
    const okPatch = makePatch({ patch_id: 'good' });
    await writePatch(flooDir, batchId, okPatch);

    // 写一份坏掉的 yaml(schema_version 不对)
    const dir = join(flooDir, 'batches', batchId, 'patches');
    await writeFile(join(dir, 'broken.yaml'), 'schema_version: 99\nkind: nope\n');

    // 写一份非 yaml 文件应被忽略(扩展名过滤)
    await writeFile(join(dir, 'readme.txt'), 'not a patch');

    const all = await readPatches(flooDir, batchId);
    assert(all.length === 1, '损坏 patch 跳过,只有 1 份合法');
    assert(all[0].patch_id === 'good', 'good patch 仍被读到');
  } finally {
    await rm(flooDir, { recursive: true, force: true });
  }
}

// ============================================================
// 6. readPatches: 目录不存在返回空数组
// ============================================================

console.log('\n=== 6. readPatches: 目录不存在 = 空数组 ===');

{
  const flooDir = join(tmpdir(), `floo-patch-nodir-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  await mkdir(flooDir, { recursive: true });
  try {
    const all = await readPatches(flooDir, 'no-such-batch');
    assert(Array.isArray(all) && all.length === 0, '目录不存在时返回 []');
  } finally {
    await rm(flooDir, { recursive: true, force: true });
  }
}

// ============================================================
// 7. 端到端:plan.yaml 演化(writePlan → applyPatch → writePlan → readPlan)
// ============================================================
// 这是 Step 6 - B 的核心契约——verdict 触发 retry 时的副作用是 plan.yaml
// 真的演化了。state-machine.emitRetryPatch 内部就是这条流水线。

console.log('\n=== 7. plan.yaml 演化:落盘 → 应用 patch → 重新落盘 → 读回 ===');

{
  const flooDir = join(tmpdir(), `floo-plan-evolve-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  await mkdir(flooDir, { recursive: true });
  try {
    const plan = makePlan();
    await writePlan(flooDir, plan);

    // 模拟两轮 retry:第 1 轮 reviewer fail → patch 1
    const patch1: PlanPatch = {
      schema_version: 1,
      patch_id: 'reviewer-reviewer_fail-1',
      generated_at: '2026-05-04T10:05:00Z',
      generated_by: 'executor:verdict-retry',
      parent_step: 'reviewer',
      reason: 'reviewer_fail_round_1',
      kind: 'append-steps',
      append_steps: [
        { id: 'coder-retry-reviewer_fail-1', capability: 'coder', depends_on: ['reviewer'] },
        { id: 'reviewer-retry-reviewer_fail-1', capability: 'reviewer', depends_on: ['coder-retry-reviewer_fail-1'] },
      ],
    };
    const round1 = applyPatch(plan, patch1);
    await writePlan(flooDir, round1.plan);
    await writePatch(flooDir, plan.batch_id, patch1);

    // 第 2 轮:tester fail → patch 2(parent_step 是 round 1 追加的 reviewer)
    const patch2: PlanPatch = {
      schema_version: 1,
      patch_id: 'tester-tester_fail-1',
      generated_at: '2026-05-04T10:10:00Z',
      generated_by: 'executor:verdict-retry',
      parent_step: 'tester',
      reason: 'tester_fail_round_1',
      kind: 'append-steps',
      append_steps: [
        { id: 'coder-retry-tester_fail-1', capability: 'coder', depends_on: ['tester'] },
        { id: 'reviewer-retry-tester_fail-1', capability: 'reviewer', depends_on: ['coder-retry-tester_fail-1'] },
        { id: 'tester-retry-tester_fail-1', capability: 'tester', depends_on: ['reviewer-retry-tester_fail-1'] },
      ],
    };
    const round2 = applyPatch(round1.plan, patch2);
    await writePlan(flooDir, round2.plan);
    await writePatch(flooDir, plan.batch_id, patch2);

    // 读盘验证
    const reread = await readPlan(flooDir, plan.batch_id);
    assert(reread !== null, 'plan.yaml 演化后能读回');
    assert(reread!.steps.length === plan.steps.length + 5, '读回 plan 比初始多 5 个 step(2 + 3)');
    const ids = reread!.steps.map(s => s.id);
    assert(ids.includes('coder-retry-reviewer_fail-1'), 'round 1 coder retry 在 plan 中');
    assert(ids.includes('tester-retry-tester_fail-1'), 'round 2 tester retry 在 plan 中');
    assert(reread!.notes.some(n => n.includes('reviewer-reviewer_fail-1')), 'plan.notes 含 round 1 patch_id');
    assert(reread!.notes.some(n => n.includes('tester-tester_fail-1')), 'plan.notes 含 round 2 patch_id');

    // patch 文件目录里有两份 patch
    const allPatches = await readPatches(flooDir, plan.batch_id);
    assert(allPatches.length === 2, '两份 patch 都落盘');
    assert(allPatches[0].patch_id === 'reviewer-reviewer_fail-1', '按时间排:round 1 在前');
    assert(allPatches[1].patch_id === 'tester-tester_fail-1', 'round 2 在后');
  } finally {
    await rm(flooDir, { recursive: true, force: true });
  }
}

// ============================================================
// 结果
// ============================================================

console.log(`\n=== 结果：${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
