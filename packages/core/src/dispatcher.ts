/**
 * Dispatcher — 核心调度器
 * 状态机驱动任务在 phase 之间流转：designer → planner → coder → reviewer
 * 处理正常流转、失败重试、review 循环、超时取消
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSkill, type TemplateVars } from './skills/loader.js';
import { readExitArtifact, waitForCompletion } from './adapters/base.js';
import { findOutOfScope, ensureFlooDir } from './scope.js';
import type {
  Task,
  Batch,
  Phase,
  RunRecord,
  ExitArtifact,
  FlooConfig,
  AgentAdapter,
  SpawnOptions,
} from './types.js';
import {
  PHASE_ORDER,
  MAX_RETRIES,
  MAX_REVIEW_ROUNDS,
  DEFAULT_CONFIG,
} from './types.js';

// ============================================================
// 日志
// ============================================================

/** 系统日志：单行纯文本，给 AI 排障用 */
async function log(flooDir: string, module: string, fields: Record<string, unknown>): Promise<void> {
  const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
  const line = `[${ts}] [${module}] ${parts}\n`;

  const logDir = join(flooDir, 'logs');
  await mkdir(logDir, { recursive: true });
  const logFile = join(logDir, 'system.log');

  // 追加写入
  const { appendFile } = await import('node:fs/promises');
  await appendFile(logFile, line);
}

// ============================================================
// 任务/批次持久化
// ============================================================

/** 持久化任务状态到 .floo/batches/{batchId}/tasks/{taskId}/task.yaml */
async function saveTask(flooDir: string, task: Task): Promise<void> {
  const taskDir = join(flooDir, 'batches', task.batch_id, 'tasks', task.id);
  await mkdir(taskDir, { recursive: true });
  task.updated_at = new Date().toISOString();
  await writeFile(join(taskDir, 'task.json'), JSON.stringify(task, null, 2));
}

/** 读取任务状态 */
async function loadTask(flooDir: string, batchId: string, taskId: string): Promise<Task> {
  const filePath = join(flooDir, 'batches', batchId, 'tasks', taskId, 'task.json');
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as Task;
}

/** 持久化批次状态 */
async function saveBatch(flooDir: string, batch: Batch): Promise<void> {
  const batchDir = join(flooDir, 'batches', batch.id);
  await mkdir(batchDir, { recursive: true });
  batch.updated_at = new Date().toISOString();
  await writeFile(join(batchDir, 'batch.json'), JSON.stringify(batch, null, 2));
}

/** 保存 run 记录 */
async function saveRun(flooDir: string, batchId: string, taskId: string, run: RunRecord): Promise<void> {
  const runsDir = join(flooDir, 'batches', batchId, 'tasks', taskId, 'runs');
  await mkdir(runsDir, { recursive: true });
  await writeFile(join(runsDir, `${run.id}.json`), JSON.stringify(run, null, 2));
}

/** 保存 artifact 文件（design.md, plan.md, review.md 等） */
async function saveArtifact(flooDir: string, batchId: string, taskId: string, filename: string, content: string): Promise<void> {
  const taskDir = join(flooDir, 'batches', batchId, 'tasks', taskId);
  await mkdir(taskDir, { recursive: true });
  await writeFile(join(taskDir, filename), content);
}

// ============================================================
// Prompt 组装
// ============================================================

/**
 * 为指定 phase 组装完整 prompt
 * 从 skill 模板加载 + 填充任务上下文变量
 */
async function buildPrompt(
  projectRoot: string,
  flooDir: string,
  task: Task,
  phase: Phase,
  extraVars?: TemplateVars,
): Promise<string> {
  const skillsDir = join(projectRoot, 'skills');
  const taskDir = join(flooDir, 'batches', task.batch_id, 'tasks', task.id);

  // 基础变量
  const vars: TemplateVars = {
    description: task.description,
    task_scope: task.scope.join(', '),
    acceptance_criteria: task.acceptance_criteria.join('\n- '),
    ...extraVars,
  };

  // 按 phase 补充上下文
  if (phase === 'planner' || phase === 'coder' || phase === 'reviewer') {
    try {
      vars.design_doc = await readFile(join(taskDir, 'design.md'), 'utf-8');
    } catch { /* designer 可能被跳过 */ }
  }

  if (phase === 'coder') {
    try {
      vars.plan_doc = await readFile(join(taskDir, 'plan.md'), 'utf-8');
    } catch { /* planner 可能被跳过 */ }
    // 如果有前次 review 反馈
    try {
      vars.review_feedback = await readFile(join(taskDir, 'review.md'), 'utf-8');
    } catch { /* 首次执行没有 review */ }
  }

  if (phase === 'planner') {
    // 注入项目目录结构
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const exec = promisify(execFile);
      const { stdout } = await exec('find', ['.', '-type', 'f', '-not', '-path', './.git/*', '-not', '-path', './node_modules/*', '-not', '-path', './.floo/*'], { cwd: projectRoot });
      vars.project_structure = stdout.trim();
    } catch {
      vars.project_structure = '(无法获取项目结构)';
    }
  }

  if (phase === 'reviewer') {
    // 注入最近的 git diff
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const exec = promisify(execFile);
      const { stdout } = await exec('git', ['diff', 'HEAD~1'], { cwd: projectRoot });
      vars.diff = stdout.trim();
    } catch {
      vars.diff = '(无法获取 diff)';
    }
  }

  return loadSkill(skillsDir, phase, vars);
}

// ============================================================
// Dispatcher 核心
// ============================================================

export interface DispatcherOptions {
  projectRoot: string;
  config?: FlooConfig;
  adapters: Record<string, AgentAdapter>;  // runtime name → adapter
}

/**
 * 运行单个任务的完整生命周期
 * 从指定 phase 开始，驱动状态机流转直到完成或失败
 */
export async function runTask(
  task: Task,
  startPhase: Phase,
  opts: DispatcherOptions,
): Promise<Task> {
  const { projectRoot, adapters } = opts;
  const config = opts.config ?? DEFAULT_CONFIG;
  const flooDir = await ensureFlooDir(projectRoot);

  // 确定从 startPhase 开始的 phase 序列
  const startIdx = PHASE_ORDER.indexOf(startPhase);
  if (startIdx === -1) {
    throw new Error(`Invalid start phase: ${startPhase}`);
  }

  task.status = 'running';
  await saveTask(flooDir, task);
  await log(flooDir, 'dispatch', { task: task.id, start_phase: startPhase });

  let reviewRounds = 0;  // coder → reviewer 循环计数
  let runCounter = 0;    // 全局 run 计数

  // 从 startPhase 开始遍历 phase
  let phaseIdx = startIdx;
  while (phaseIdx < PHASE_ORDER.length) {
    const phase = PHASE_ORDER[phaseIdx];
    task.current_phase = phase;
    await saveTask(flooDir, task);

    // 执行当前 phase（含重试）
    const result = await executePhase(task, phase, config, flooDir, projectRoot, adapters, ++runCounter);

    if (!result.success) {
      // 到达重试上限，任务失败
      task.status = 'failed';
      task.current_phase = phase;
      await saveTask(flooDir, task);
      await log(flooDir, 'failed', { task: task.id, phase, reason: 'max_retries_exceeded' });
      return task;
    }

    // phase 完成后的特殊处理
    if (phase === 'designer') {
      // designer 产出的内容保存为 design.md
      // （agent 应该已经在 cwd 写了 design.md，这里只做记录）
      await log(flooDir, 'phase-done', { task: task.id, phase: 'designer' });
    }

    if (phase === 'reviewer') {
      // 检查 review 结论
      const verdict = await checkReviewVerdict(flooDir, task);
      if (verdict === 'fail') {
        reviewRounds++;
        if (reviewRounds >= MAX_REVIEW_ROUNDS) {
          // review 循环到达上限
          task.status = 'failed';
          await saveTask(flooDir, task);
          await log(flooDir, 'failed', { task: task.id, reason: 'max_review_rounds', rounds: reviewRounds });
          return task;
        }
        // 回退到 coder 重新修改
        await log(flooDir, 'review-fail', { task: task.id, round: reviewRounds });
        phaseIdx = PHASE_ORDER.indexOf('coder');
        continue;
      }
      // review pass，继续下一个 phase
      await log(flooDir, 'review-pass', { task: task.id });
    }

    if (phase === 'coder') {
      // scope 越界检查
      const exitArtifact = await readExitArtifact(flooDir, task.id, phase);
      const outOfScope = findOutOfScope(exitArtifact.files_changed, task.scope);
      if (outOfScope.length > 0) {
        await log(flooDir, 'scope-violation', { task: task.id, files: outOfScope });
        // Milestone 1：越界但无并发冲突，接受并更新 scope
        task.scope = [...new Set([...task.scope, ...exitArtifact.files_changed])];
        await saveTask(flooDir, task);
      }
    }

    phaseIdx++;
  }

  // 所有 phase 完成
  task.status = 'completed';
  task.current_phase = null;
  await saveTask(flooDir, task);
  await log(flooDir, 'completed', { task: task.id });

  return task;
}

/**
 * 执行单个 phase（含重试逻辑）
 * 最多重试 MAX_RETRIES 次，每次带上前次错误信息
 */
async function executePhase(
  task: Task,
  phase: Phase,
  config: FlooConfig,
  flooDir: string,
  projectRoot: string,
  adapters: Record<string, AgentAdapter>,
  runCounter: number,
): Promise<{ success: boolean; exitArtifact?: ExitArtifact }> {
  // 解析角色绑定：任务级覆盖 > 项目级配置
  const binding = task.role_overrides?.[phase] ?? config.roles[phase];
  const adapter = adapters[binding.runtime];
  if (!adapter) {
    throw new Error(`No adapter for runtime: ${binding.runtime}`);
  }

  let lastError = '';

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const runId = `${String(runCounter).padStart(3, '0')}-${phase}`;

    // 组装 prompt
    const extraVars: TemplateVars = {};
    if (attempt > 1 && lastError) {
      extraVars.previous_error = lastError;
    }
    const prompt = await buildPrompt(projectRoot, flooDir, task, phase, extraVars);

    // 创建 run 记录
    const run: RunRecord = {
      id: runId,
      task_id: task.id,
      phase,
      runtime: binding.runtime,
      model: binding.model,
      session_name: '',
      attempt,
      started_at: new Date().toISOString(),
      finished_at: null,
      exit_code: null,
      duration_seconds: null,
    };

    await log(flooDir, 'dispatch', {
      task: task.id, phase, runtime: binding.runtime, attempt,
    });

    // 启动 agent
    const spawnOpts: SpawnOptions = {
      taskId: task.id,
      phase,
      prompt,
      cwd: projectRoot,
      runtime: binding.runtime,
      model: binding.model,
    };

    const sessionName = await adapter.spawn(spawnOpts);
    run.session_name = sessionName;

    // 等待完成
    await waitForCompletion(sessionName, flooDir, task.id, phase);

    // 读取结果
    const exitArtifact = await readExitArtifact(flooDir, task.id, phase);

    // 更新 run 记录
    run.finished_at = exitArtifact.finished_at;
    run.exit_code = exitArtifact.exit_code;
    run.duration_seconds = exitArtifact.duration_seconds;
    await saveRun(flooDir, task.batch_id, task.id, run);

    await log(flooDir, 'callback', {
      task: task.id, phase, exit_code: exitArtifact.exit_code,
      duration: `${exitArtifact.duration_seconds}s`,
    });

    // 判断成功/失败
    if (exitArtifact.exit_code === 0) {
      return { success: true, exitArtifact };
    }

    // 失败，收集错误信息用于下次重试
    if (exitArtifact.exit_code === -1) {
      // 被外部终止（cancel/timeout）
      lastError = 'Agent was terminated externally';
      await log(flooDir, 'terminated', { task: task.id, phase, attempt });
    } else {
      // 非零退出码，尝试获取 agent 输出作为错误上下文
      try {
        lastError = await adapter.getOutput(sessionName, 30);
      } catch {
        lastError = `Agent exited with code ${exitArtifact.exit_code}`;
      }
      await log(flooDir, 'retry', {
        task: task.id, phase, attempt: `${attempt}/${MAX_RETRIES}`,
      });
    }
  }

  // 所有重试耗尽
  return { success: false };
}

/**
 * 检查 review 结论
 * 从 review.md 中提取 verdict: pass/fail
 */
async function checkReviewVerdict(
  flooDir: string,
  task: Task,
): Promise<'pass' | 'fail'> {
  try {
    const taskDir = join(flooDir, 'batches', task.batch_id, 'tasks', task.id);
    const reviewContent = await readFile(join(taskDir, 'review.md'), 'utf-8');

    // 查找 verdict: pass 或 verdict: fail（不区分大小写）
    const match = reviewContent.match(/verdict:\s*(pass|fail)/i);
    if (match) {
      return match[1].toLowerCase() as 'pass' | 'fail';
    }

    // review_level 为 scan 或 skip 时，没有 review agent，直接 pass
    if (task.review_level !== 'full') {
      return 'pass';
    }

    // 找不到 verdict，默认 fail（保守策略）
    return 'fail';
  } catch {
    // review.md 不存在
    if (task.review_level !== 'full') {
      return 'pass';
    }
    return 'fail';
  }
}

// ============================================================
// 批次调度入口
// ============================================================

/**
 * 创建批次和任务，启动执行
 * 这是 `floo run` 的核心入口
 */
export async function createAndRun(
  description: string,
  startPhase: Phase,
  opts: DispatcherOptions & { scope?: string[] },
): Promise<{ batch: Batch; task: Task }> {
  const { projectRoot } = opts;
  const flooDir = await ensureFlooDir(projectRoot);

  // 生成 batch ID
  const date = new Date().toISOString().slice(0, 10);
  const slug = description.slice(0, 30).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '-').replace(/-+/g, '-');
  const batchId = `${date}-${slug}`;

  // 创建批次
  const batch: Batch = {
    id: batchId,
    description,
    status: 'active',
    tasks: ['task-001'],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await saveBatch(flooDir, batch);

  // 创建任务
  const task: Task = {
    id: 'task-001',
    batch_id: batchId,
    description,
    status: 'pending',
    current_phase: null,
    scope: opts.scope ?? [],
    acceptance_criteria: [],
    review_level: 'full',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await saveTask(flooDir, task);

  // 执行任务
  const result = await runTask(task, startPhase, opts);

  // 更新批次状态
  batch.status = result.status === 'completed' ? 'completed' : 'active';
  await saveBatch(flooDir, batch);

  return { batch, task: result };
}
