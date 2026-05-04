/**
 * Executor 测试 (Step 4a)
 *
 * 范围:
 *   - runPlan + legacy-dispatcher mode → 等价于 createAndRun
 *   - runPlan + executor mode → unsupported 错误
 *   - runPlan + 未知 mode → 抛错
 *   - runPlanFromDisk → 读盘后调用 runPlan
 *   - runPlanFromDisk + 不存在的 batch → 抛错
 *
 * 端到端验证用最短路径 (start_phase=reviewer 单 step),避免重复 dispatcher.test 的完整 setup
 */

import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  runPlan,
  runPlanFromDisk,
  synthesizeInitialPlan,
  writePlan,
  ensureFlooDir,
  DEFAULT_CONFIG,
  type ExecutorOptions,
  type PlanYaml,
} from '../src/core/index.js';
import type { Task, Batch, AgentAdapter, SpawnOptions, ExitArtifact, Phase, Runtime, FlooConfig } from '../src/core/index.js';

const exec = promisify(execFile);

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

/** 最小化测试项目:git + .floo + skills/ 模板 */
async function setupTestProject(): Promise<string> {
  const dir = join(tmpdir(), `floo-executor-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  await mkdir(dir, { recursive: true });
  await exec('git', ['init'], { cwd: dir });
  await exec('git', ['config', 'user.email', 'test@floo.dev'], { cwd: dir });
  await exec('git', ['config', 'user.name', 'Floo Test'], { cwd: dir });
  await writeFile(join(dir, '.gitkeep'), '');
  await exec('git', ['add', '.'], { cwd: dir });
  await exec('git', ['commit', '-m', 'init'], { cwd: dir });
  await ensureFlooDir(dir);
  // 最小 skill 模板
  const skillsDir = join(dir, 'skills');
  await mkdir(skillsDir, { recursive: true });
  for (const skill of ['discuss', 'designer', 'planner', 'coder', 'reviewer', 'tester']) {
    await writeFile(join(skillsDir, `${skill}.md`), `You are ${skill}. {{description}}`);
  }
  return dir;
}

/** 极简 mock adapter:写 verdict pass review.md + exit artifact */
class ReviewerPassAdapter implements AgentAdapter {
  runtime: Runtime = 'codex';
  spawned: SpawnOptions[] = [];

  async spawn(opts: SpawnOptions): Promise<string> {
    this.spawned.push(opts);
    const sessionName = `floo-${opts.taskId}-${opts.phase}`;
    const signalsDir = join(opts.cwd, '.floo', 'signals');
    await mkdir(signalsDir, { recursive: true });

    // reviewer 写 review.md verdict: pass(项目根目录,task-prefixed 文件名)
    if (opts.phase === 'reviewer') {
      await writeFile(
        join(opts.cwd, `${opts.taskId}-review.md`),
        'verdict: pass\n\nReviewer pass via executor.test mock.',
      );
    }

    let headAfter = '';
    try {
      const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: opts.cwd });
      headAfter = stdout.trim();
    } catch { /* ignore */ }

    const artifact: ExitArtifact = {
      task_id: opts.taskId,
      phase: opts.phase as Phase,
      session_name: sessionName,
      exit_code: 0,
      finished_at: new Date().toISOString(),
      duration_seconds: 1,
      files_changed: [],
      head_after: headAfter,
    };
    await writeFile(
      join(signalsDir, `${opts.taskId}-${opts.phase}.exit`),
      JSON.stringify(artifact, null, 2),
    );
    await writeFile(join(signalsDir, `${opts.taskId}-${opts.phase}.base-head`), headAfter);
    return sessionName;
  }

  async isAlive() { return false; }
  async getOutput() { return 'mock'; }
  async sendMessage() { /* noop */ }
  async kill(sessionName: string, cwd: string, taskId: string, phase: string) {
    const signalsDir = join(cwd, '.floo', 'signals');
    await mkdir(signalsDir, { recursive: true });
    const artifact: ExitArtifact = {
      task_id: taskId,
      phase: phase as Phase,
      session_name: sessionName,
      exit_code: -1,
      finished_at: new Date().toISOString(),
      duration_seconds: -1,
      files_changed: [],
    };
    await writeFile(
      join(signalsDir, `${taskId}-${phase}.exit`),
      JSON.stringify(artifact, null, 2),
    );
  }
}

const TEST_CONFIG: FlooConfig = {
  ...DEFAULT_CONFIG,
  session: { ...DEFAULT_CONFIG.session, timeout_minutes: 1 },
};

// ============================================================
// 1. runPlan + legacy-dispatcher mode → 等价 createAndRun
// ============================================================

console.log('\n=== 1. runPlan: legacy-dispatcher mode 等价 createAndRun ===');

{
  const dir = await setupTestProject();
  try {
    const reviewer = new ReviewerPassAdapter();
    const opts: ExecutorOptions = {
      projectRoot: dir,
      config: TEST_CONFIG,
      adapters: { codex: reviewer, claude: reviewer },
    };

    // 手工合成 plan(模拟 OpenClaw 等外部消费者从 plan.yaml 调用 floo)
    const fakeBatch: Batch = {
      id: '2026-05-04-exec-test-001',
      description: 'executor test - reviewer only',
      status: 'active',
      tasks: ['exectest-001'],
      created_at: '2026-05-04T10:00:00Z',
      updated_at: '2026-05-04T10:00:00Z',
    };
    const fakeTask: Task = {
      id: 'exectest-001',
      batch_id: fakeBatch.id,
      description: fakeBatch.description,
      status: 'pending',
      current_phase: null,
      scope: ['src/'],
      acceptance_criteria: [],
      review_level: 'full',
      created_at: fakeBatch.created_at,
      updated_at: fakeBatch.updated_at,
      depends_on: [],
    };
    const plan = synthesizeInitialPlan({
      batch: fakeBatch,
      task: fakeTask,
      startPhase: 'reviewer',
      config: TEST_CONFIG,
    });

    const result = await runPlan(plan, opts);

    assert(result.tasks.length === 1, 'runPlan 返回单 task(reviewer 起步)');
    assert(result.batch.status === 'completed', 'batch 完成');
    assert(reviewer.spawned.length === 1, 'reviewer 被调用 1 次');
    assert(reviewer.spawned[0].phase === 'reviewer', 'spawn 的 phase = reviewer');
    // batch.id 是 createAndRun 内部生成的,不会等于我们 plan 里的 id(因为 createAndRun 重新生成)
    // 这里只验证 description 透传
    assert(result.batch.description === 'executor test - reviewer only', 'description 透传到 createAndRun');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ============================================================
// 2. runPlan + executor mode → unsupported 错误
// ============================================================

console.log('\n=== 2. runPlan: executor mode 当前不支持 ===');

{
  const plan: PlanYaml = {
    schema_version: 1,
    batch_id: 'fake',
    created_at: '2026-05-04T10:00:00Z',
    description: 'fake',
    mode: 'executor',
    start_phase: 'coder',
    initial_task: { id: 'fake-001', scope: [], acceptance_criteria: [], review_level: 'full', depends_on: [] },
    steps: [],
    notes: [],
  };
  try {
    await runPlan(plan, { projectRoot: '/tmp/fake', adapters: {} });
    assert(false, 'executor mode 应抛错');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes('Step 4b'), '错误信息提到 Step 4b 落地后启用');
  }
}

// ============================================================
// 3. runPlan + 未知 mode → 抛错
// ============================================================

console.log('\n=== 3. runPlan: 未知 mode 抛错 ===');

{
  // 故意构造非法 mode
  const plan = {
    schema_version: 1,
    batch_id: 'fake',
    created_at: '2026-05-04T10:00:00Z',
    description: 'fake',
    mode: 'frobnicate',  // 非法
    start_phase: 'coder',
    initial_task: { id: 'fake-001', scope: [], acceptance_criteria: [], review_level: 'full', depends_on: [] },
    steps: [],
    notes: [],
  } as unknown as PlanYaml;
  try {
    await runPlan(plan, { projectRoot: '/tmp/fake', adapters: {} });
    assert(false, '未知 mode 应抛错');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes('frobnicate'), '错误信息含未知 mode 名字');
  }
}

// ============================================================
// 4. runPlanFromDisk → 读盘后调用 runPlan
// ============================================================

console.log('\n=== 4. runPlanFromDisk: 读盘后委托 runPlan ===');

{
  const dir = await setupTestProject();
  try {
    const flooDir = join(dir, '.floo');
    const reviewer = new ReviewerPassAdapter();

    // 先把一份 plan 落盘
    const fakeBatch: Batch = {
      id: '2026-05-04-fromdisk-test-001',
      description: 'from disk test',
      status: 'active',
      tasks: ['fromdisk-001'],
      created_at: '2026-05-04T10:00:00Z',
      updated_at: '2026-05-04T10:00:00Z',
    };
    const fakeTask: Task = {
      id: 'fromdisk-001',
      batch_id: fakeBatch.id,
      description: fakeBatch.description,
      status: 'pending',
      current_phase: null,
      scope: [],
      acceptance_criteria: [],
      review_level: 'full',
      created_at: fakeBatch.created_at,
      updated_at: fakeBatch.updated_at,
      depends_on: [],
    };
    const plan = synthesizeInitialPlan({ batch: fakeBatch, task: fakeTask, startPhase: 'reviewer', config: TEST_CONFIG });
    await writePlan(flooDir, plan);

    const result = await runPlanFromDisk(flooDir, fakeBatch.id, {
      projectRoot: dir,
      config: TEST_CONFIG,
      adapters: { codex: reviewer, claude: reviewer },
    });

    assert(result.tasks.length === 1, 'runPlanFromDisk 走通 reviewer');
    assert(result.batch.status === 'completed', 'batch completed');
    assert(reviewer.spawned[0].phase === 'reviewer', 'spawn 的 phase = reviewer');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log('\n=== 4b. runPlanFromDisk: 不存在的 batchId 抛错 ===');

{
  const dir = await setupTestProject();
  try {
    const flooDir = join(dir, '.floo');
    try {
      await runPlanFromDisk(flooDir, 'no-such-batch-id', {
        projectRoot: dir,
        config: TEST_CONFIG,
        adapters: {},
      });
      assert(false, '应抛错');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      assert(msg.includes('未找到 plan.yaml'), '错误信息提示 plan.yaml 不存在');
      assert(msg.includes('no-such-batch-id'), '错误信息含 batchId');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ============================================================
// 结果
// ============================================================

console.log(`\n=== 结果：${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
