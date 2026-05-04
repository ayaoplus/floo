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
  runTaskFromSteps,
  createAndRun,
  loadTemplate,
  synthesizeInitialPlan,
  writePlan,
  ensureFlooDir,
  DEFAULT_CONFIG,
  type ExecutorOptions,
  type PlanYaml,
  type RunStep,
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
// 5. runTaskFromSteps: 直接接受 RunStep[] 跑 (Step 4c)
// ============================================================

console.log('\n=== 5. runTaskFromSteps: 外部 step 列表驱动 ===');

{
  const dir = await setupTestProject();
  try {
    const reviewer = new ReviewerPassAdapter();
    const opts = {
      projectRoot: dir,
      config: TEST_CONFIG,
      adapters: { codex: reviewer, claude: reviewer },
    };

    const fakeBatch: Batch = {
      id: '2026-05-04-runtaskfromsteps-test',
      description: 'plan-driven runTask',
      status: 'active',
      tasks: ['rtfs-001'],
      created_at: '2026-05-04T10:00:00Z',
      updated_at: '2026-05-04T10:00:00Z',
    };
    const fakeTask: Task = {
      id: 'rtfs-001',
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

    // 用户自定义的 step 列表(模拟来自 plan.yaml)
    const customSteps: RunStep[] = [
      { id: 'review-only', phase: 'reviewer', status: 'pending' },
    ];

    // 需要先把 batch + task 落盘(runTaskFromSteps 不做这事)
    const { mkdir, writeFile } = await import('node:fs/promises');
    const flooDir = join(dir, '.floo');
    await mkdir(join(flooDir, 'batches', fakeBatch.id), { recursive: true });
    await writeFile(join(flooDir, 'batches', fakeBatch.id, 'batch.json'), JSON.stringify(fakeBatch, null, 2));
    await mkdir(join(flooDir, 'batches', fakeBatch.id, 'tasks', fakeTask.id), { recursive: true });
    await writeFile(join(flooDir, 'batches', fakeBatch.id, 'tasks', fakeTask.id, 'task.json'), JSON.stringify(fakeTask, null, 2));

    const result = await runTaskFromSteps(fakeTask, customSteps, opts);
    assert(result.status === 'completed', 'runTaskFromSteps 完成');
    assert(reviewer.spawned.length === 1, 'reviewer 被调用 1 次');
    assert(reviewer.spawned[0].phase === 'reviewer', 'spawn 的 phase = reviewer');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log('\n=== 5b. runTaskFromSteps: 空 steps 抛错 ===');

{
  try {
    await runTaskFromSteps(
      {} as Task,
      [],
      { projectRoot: '/tmp/fake', adapters: {} },
    );
    assert(false, '空 steps 应抛错');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes('steps 数组为空'), '错误信息含"steps 数组为空"');
  }
}

// ============================================================
// 6. createAndRun(opts.plan): plan-driven simple path (Step 4c)
// ============================================================

console.log('\n=== 6. createAndRun(opts.plan): plan 驱动 simple path ===');

{
  const dir = await setupTestProject();
  try {
    const reviewer = new ReviewerPassAdapter();
    const opts = {
      projectRoot: dir,
      config: TEST_CONFIG,
      adapters: { codex: reviewer, claude: reviewer },
    };

    // 加载 quick.yaml,但只用其 reviewer step 部分
    // 这里我们伪造一个含单 reviewer 的 plan,模拟用户编辑 plan 加自定义 step 序列
    const customPlan = {
      schema_version: 1 as const,
      name: 'custom-reviewer-only',
      steps: [
        { id: 'review-only', capability: 'reviewer' as const },
      ],
    };

    const result = await createAndRun('plan-driven test', 'reviewer', {
      ...opts,
      plan: customPlan,
    });

    assert(result.tasks.length === 1, 'createAndRun(plan) 返回单 task');
    assert(result.batch.status === 'completed', 'batch 完成');
    assert(reviewer.spawned[0].phase === 'reviewer', '只跑了 reviewer step');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log('\n=== 6b. createAndRun(opts.plan): plan 仅含 deferred 占位时抛错 ===');

{
  const dir = await setupTestProject();
  try {
    const reviewer = new ReviewerPassAdapter();
    const opts = {
      projectRoot: dir,
      config: TEST_CONFIG,
      adapters: { codex: reviewer, claude: reviewer },
    };
    const allDeferred = {
      schema_version: 1 as const,
      name: 'all-deferred',
      steps: [
        { id: 'a', capability: 'coder' as const, status: 'deferred' as const },
        { id: 'b', capability: 'reviewer' as const, status: 'deferred' as const },
      ],
    };
    // createAndRun 顶层 try/catch 会把 error 转成 batch.status='failed' (crash protection)
    const result = await createAndRun('all deferred', 'coder', { ...opts, plan: allDeferred });
    assert(result.batch.status === 'failed', '全 deferred plan 触发 batch 失败');
    assert(result.tasks[0].status === 'failed', 'task 也标记 failed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ============================================================
// 7. loadTemplate('quick') + createAndRun: 真消费 plan.yaml
// ============================================================

console.log('\n=== 7. quick.yaml 模板 + createAndRun → 消费 plan.steps ===');

{
  const dir = await setupTestProject();
  try {
    const reviewer = new ReviewerPassAdapter();
    const opts = {
      projectRoot: dir,
      config: TEST_CONFIG,
      adapters: { codex: reviewer, claude: reviewer },
    };

    const quickPlan = await loadTemplate('quick');
    // quick = coder + reviewer,但 mock coder 不会写文件;改成 reviewer 起步走单步
    // 这里只验证"plan.steps 被消费"——通过 reviewer 起步 + 单 reviewer step 验证
    const reviewerOnlyPlan = {
      ...quickPlan,
      steps: quickPlan.steps.filter(s => s.capability === 'reviewer'),
    };

    const result = await createAndRun('quick template test', 'reviewer', {
      ...opts,
      plan: reviewerOnlyPlan,
    });

    assert(result.batch.status === 'completed', 'batch 完成');
    assert(reviewer.spawned.length === 1, 'plan 里只有 1 个 reviewer step → 跑 1 次');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ============================================================
// 8. createAndRun(opts.plan): designer-only complex plan(Step 4d 修复)
// ============================================================
// 回归 codex review #1 finding:designer-only / no-loop 的 complex plan
// 应当真跑 designer,而不是 finalizeBatchSuccess 直接标 completed。

console.log('\n=== 8. createAndRun: designer-only plan 真跑 designer phase ===');

{
  const dir = await setupTestProject();
  try {
    const adapter = new ReviewerPassAdapter();
    const opts = {
      projectRoot: dir,
      config: TEST_CONFIG,
      adapters: { codex: adapter, claude: adapter },
    };

    // 自定义 plan:只含 designer,没 discuss/planner/loop_with(complex 但无飞轮无拆分)
    const designerOnly = {
      schema_version: 1 as const,
      name: 'designer-only',
      steps: [
        { id: 'design-1', capability: 'designer' as const },
      ],
    };

    const result = await createAndRun('designer-only test', 'designer', {
      ...opts,
      plan: designerOnly,
    });

    assert(result.batch.status === 'completed', 'designer-only batch 完成');
    assert(adapter.spawned.length === 1, 'designer phase 被 spawn 1 次');
    assert(adapter.spawned[0].phase === 'designer', 'spawn 的 phase = designer(不是直接 finalize)');
    assert(result.tasks[0].status === 'completed', 'task 完成');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log('\n=== 8b. createAndRun: discuss+designer 无 loop_with → 也按 plan 顺序跑 ===');

{
  const dir = await setupTestProject();
  try {
    const adapter = new ReviewerPassAdapter();
    const opts = {
      projectRoot: dir,
      config: TEST_CONFIG,
      adapters: { codex: adapter, claude: adapter },
    };

    // 含 discuss + designer 但无 loop_with → planHasDiscussDesignerLoop=false
    // 不应该跳过两个 phase
    const noLoopPlan = {
      schema_version: 1 as const,
      name: 'no-loop',
      steps: [
        { id: 'd1', capability: 'discuss' as const },
        { id: 'd2', capability: 'designer' as const, depends_on: ['d1'] },
      ],
    };

    const result = await createAndRun('no-loop test', 'discuss', {
      ...opts,
      plan: noLoopPlan,
    });

    assert(result.batch.status === 'completed', 'no-loop batch 完成');
    assert(adapter.spawned.length === 2, 'discuss + designer 各 spawn 1 次');
    const phases = adapter.spawned.map(s => s.phase);
    assert(phases.includes('discuss'), 'discuss phase 被 spawn');
    assert(phases.includes('designer'), 'designer phase 被 spawn');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ============================================================
// 结果
// ============================================================

console.log(`\n=== 结果：${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
