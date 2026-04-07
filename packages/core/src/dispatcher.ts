/**
 * Dispatcher — 核心调度器
 * 状态机驱动任务在 phase 之间流转：designer → planner → coder → reviewer
 * 处理正常流转、失败重试、review 循环、超时取消
 */

import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadSkill, type TemplateVars } from './skills/loader.js';
import { readExitArtifact, waitForCompletion } from './adapters/base.js';
import { findOutOfScope, ensureFlooDir, detectConflicts } from './scope.js';
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

const exec = promisify(execFile);

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
  const { appendFile } = await import('node:fs/promises');
  await appendFile(join(logDir, 'system.log'), line);
}

// ============================================================
// 任务/批次持久化
// ============================================================

/** 持久化任务状态 */
async function saveTask(flooDir: string, task: Task): Promise<void> {
  const taskDir = join(flooDir, 'batches', task.batch_id, 'tasks', task.id);
  await mkdir(taskDir, { recursive: true });
  task.updated_at = new Date().toISOString();
  await writeFile(join(taskDir, 'task.json'), JSON.stringify(task, null, 2));
}

/** 持久化批次状态 */
async function saveBatch(flooDir: string, batch: Batch): Promise<void> {
  const batchDir = join(flooDir, 'batches', batch.id);
  await mkdir(batchDir, { recursive: true });
  batch.updated_at = new Date().toISOString();
  await writeFile(join(batchDir, 'batch.json'), JSON.stringify(batch, null, 2));
}

/** 保存 run 记录（runId 包含 attempt 防覆盖） */
async function saveRun(flooDir: string, batchId: string, taskId: string, run: RunRecord): Promise<void> {
  const runsDir = join(flooDir, 'batches', batchId, 'tasks', taskId, 'runs');
  await mkdir(runsDir, { recursive: true });
  await writeFile(join(runsDir, `${run.id}.json`), JSON.stringify(run, null, 2));
}

// ============================================================
// 工具函数
// ============================================================

/** 去掉 YAML 值的引号：`"foo"` → `foo`，`'bar'` → `bar` */
function stripYamlQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

// ============================================================
// Artifact 收集
// ============================================================

/** phase 对应的 artifact 文件名 */
const PHASE_ARTIFACTS: Partial<Record<Phase, string>> = {
  designer: 'design.md',
  planner: 'plan.md',
  reviewer: 'review.md',
};

/**
 * phase 完成后，将 agent 写在项目根目录的 artifact 复制到任务目录
 * agent 在 projectRoot 下运行，产出写在 projectRoot；dispatcher 从任务目录读取
 */
async function collectArtifact(
  projectRoot: string,
  flooDir: string,
  task: Task,
  phase: Phase,
): Promise<void> {
  const filename = PHASE_ARTIFACTS[phase];
  if (!filename) return;

  const src = join(projectRoot, filename);
  const taskDir = join(flooDir, 'batches', task.batch_id, 'tasks', task.id);
  const dest = join(taskDir, filename);

  try {
    await access(src);
    await mkdir(taskDir, { recursive: true });
    await copyFile(src, dest);
    await log(flooDir, 'artifact-collected', { task: task.id, phase, file: filename });
  } catch {
    // artifact 可能不存在（如 agent 失败了没产出）
    await log(flooDir, 'artifact-missing', { task: task.id, phase, file: filename });
  }
}

/**
 * 在 phase 执行前删除项目根目录的旧 artifact
 * 防止 agent 失败时 collectArtifact 复制到上一轮的陈旧文件
 */
async function cleanStaleArtifact(projectRoot: string, phase: Phase): Promise<void> {
  const filename = PHASE_ARTIFACTS[phase];
  if (!filename) return;

  const filePath = join(projectRoot, filename);
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(filePath);
  } catch { /* 文件不存在，忽略 */ }
}

/** 从 YAML 列表块提取列表项 */
function extractYamlList(block: string): string[] {
  const items: string[] = [];
  const matches = block.matchAll(/^\s+-\s+(.+)/gm);
  for (const m of matches) {
    items.push(stripYamlQuotes(m[1].trim()));
  }
  return items;
}

/** 解析后的子任务定义 */
interface ParsedTask {
  id: string;
  description: string;
  scope: string[];
  acceptance_criteria: string[];
  review_level: 'full' | 'scan' | 'skip';
  depends_on: string[];
}

/**
 * 解析 plan.md 拆出多个子任务
 * 支持两种格式：
 * 1. 多任务 YAML（每个 task 有 id、description、scope 等）
 * 2. 单任务简单格式（只有 scope 和 acceptance_criteria，兼容 M1）
 */
function parsePlanTasks(content: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];

  // 尝试匹配多任务块：以 `- id:` 开头的 YAML 列表（支持缩进，如 `  - id:`）
  const taskBlocks = content.split(/(?=^\s*-\s+id:\s*)/m).filter(b => b.trim().length > 0);

  for (const block of taskBlocks) {
    const idMatch = block.match(/id:\s*["']?([^\s"']+)["']?/);
    if (!idMatch) continue; // 不是任务块

    const descMatch = block.match(/description:\s*["']?(.+?)["']?\s*$/m);
    const scopeMatch = block.match(/scope:\s*\n((?:\s+-\s+.+\n?)+)/);
    const criteriaMatch = block.match(/acceptance_criteria:\s*\n((?:\s+-\s+.+\n?)+)/);
    const levelMatch = block.match(/review_level:\s*["']?(full|scan|skip)["']?/i);
    const depsMatch = block.match(/depends_on:\s*\n((?:\s+-\s+.+\n?)+)/);

    tasks.push({
      id: stripYamlQuotes(idMatch[1]),
      description: descMatch ? stripYamlQuotes(descMatch[1].trim()) : '',
      scope: scopeMatch ? extractYamlList(scopeMatch[1]) : [],
      acceptance_criteria: criteriaMatch ? extractYamlList(criteriaMatch[1]) : [],
      review_level: levelMatch ? levelMatch[1].toLowerCase() as 'full' | 'scan' | 'skip' : 'full',
      depends_on: depsMatch ? extractYamlList(depsMatch[1]) : [],
    });
  }

  // 兼容 M1 单任务格式：没找到多任务块，提取全局 scope/criteria
  if (tasks.length === 0) {
    const scope: string[] = [];
    const scopeMatches = content.matchAll(/scope:\s*\n((?:\s+-\s+.+\n?)+)/g);
    for (const m of scopeMatches) {
      scope.push(...extractYamlList(m[1]));
    }
    const criteriaMatch = content.match(/acceptance_criteria:\s*\n((?:\s+-\s+.+\n?)+)/);
    const levelMatch = content.match(/review_level:\s*["']?(full|scan|skip)["']?/i);

    tasks.push({
      id: 'task-001',
      description: '',
      scope,
      acceptance_criteria: criteriaMatch ? extractYamlList(criteriaMatch[1]) : [],
      review_level: levelMatch ? levelMatch[1].toLowerCase() as 'full' | 'scan' | 'skip' : 'full',
      depends_on: [],
    });
  }

  return tasks;
}

/**
 * Planner 完成后，解析 plan.md 创建/更新子任务
 * 返回所有子任务（用于后续并行调度）
 */
async function consumePlannerOutput(
  flooDir: string,
  batch: Batch,
  parentTask: Task,
): Promise<Task[]> {
  const taskDir = join(flooDir, 'batches', batch.id, 'tasks', parentTask.id);
  let content: string;
  try {
    content = await readFile(join(taskDir, 'plan.md'), 'utf-8');
  } catch {
    return [parentTask]; // plan.md 不存在，用原 task 继续
  }

  const parsed = parsePlanTasks(content);

  if (parsed.length <= 1) {
    // 单任务：更新原 task 的 scope/criteria/review_level
    const p = parsed[0];
    if (p) {
      if (p.scope.length > 0) parentTask.scope = [...new Set([...parentTask.scope, ...p.scope])];
      if (p.acceptance_criteria.length > 0) parentTask.acceptance_criteria = p.acceptance_criteria;
      parentTask.review_level = p.review_level;
      await saveTask(flooDir, parentTask);
    }
    await log(flooDir, 'plan-consumed', { task: parentTask.id, sub_tasks: 1 });
    return [parentTask];
  }

  // 多任务：为每个子任务创建 Task 对象
  const now = new Date().toISOString();
  const tasks: Task[] = [];

  // 父任务的 artifact 目录（design.md / plan.md 存放位置）
  const parentTaskDir = join(flooDir, 'batches', batch.id, 'tasks', parentTask.id);

  for (const p of parsed) {
    const task: Task = {
      id: p.id,
      batch_id: batch.id,
      description: p.description || parentTask.description,
      status: 'pending',
      current_phase: null,
      scope: p.scope,
      acceptance_criteria: p.acceptance_criteria,
      review_level: p.review_level,
      created_at: now,
      updated_at: now,
      depends_on: p.depends_on,
    };
    await saveTask(flooDir, task);

    // 将父任务的 design.md / plan.md 复制到子任务目录，确保 coder 能拿到上下文
    const subTaskDir = join(flooDir, 'batches', batch.id, 'tasks', task.id);
    for (const artifact of ['design.md', 'plan.md']) {
      try {
        await copyFile(join(parentTaskDir, artifact), join(subTaskDir, artifact));
      } catch { /* artifact 可能不存在（如跳过了 designer） */ }
    }

    tasks.push(task);
  }

  // 更新 batch 的 task 列表
  batch.tasks = tasks.map(t => t.id);
  await saveBatch(flooDir, batch);

  await log(flooDir, 'plan-consumed', {
    task: parentTask.id,
    sub_tasks: tasks.length,
    task_ids: tasks.map(t => t.id),
  });

  return tasks;
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
    try {
      vars.review_feedback = await readFile(join(taskDir, 'review.md'), 'utf-8');
    } catch { /* 首次执行没有 review */ }
  }

  if (phase === 'planner') {
    try {
      const { stdout } = await exec('find', [
        '.', '-type', 'f',
        '-not', '-path', './.git/*',
        '-not', '-path', './node_modules/*',
        '-not', '-path', './.floo/*',
      ], { cwd: projectRoot });
      vars.project_structure = stdout.trim();
    } catch {
      vars.project_structure = '(无法获取项目结构)';
    }
  }

  if (phase === 'reviewer') {
    // Fix #6: 用 base-head 文件获取完整 diff，而不是只看 HEAD~1
    try {
      const signalsDir = join(flooDir, 'signals');
      const baseHead = (await readFile(join(signalsDir, `${task.id}-coder.base-head`), 'utf-8')).trim();
      if (baseHead) {
        const { stdout } = await exec('git', ['diff', baseHead, 'HEAD'], { cwd: projectRoot });
        vars.diff = stdout.trim();
      } else {
        // 新仓库，用 diff-tree 列出所有文件
        const { stdout } = await exec('git', ['diff-tree', '--no-commit-id', '-p', '--root', '-r', 'HEAD'], { cwd: projectRoot });
        vars.diff = stdout.trim();
      }
    } catch {
      // fallback: 至少看最近一个 commit
      try {
        const { stdout } = await exec('git', ['diff', 'HEAD~1'], { cwd: projectRoot });
        vars.diff = stdout.trim();
      } catch {
        vars.diff = '(无法获取 diff)';
      }
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

  const startIdx = PHASE_ORDER.indexOf(startPhase);
  if (startIdx === -1) {
    throw new Error(`Invalid start phase: ${startPhase}`);
  }

  task.status = 'running';
  await saveTask(flooDir, task);
  await log(flooDir, 'dispatch', { task: task.id, start_phase: startPhase });

  let reviewRounds = 0;
  let runCounter = 0;

  let phaseIdx = startIdx;
  while (phaseIdx < PHASE_ORDER.length) {
    const phase = PHASE_ORDER[phaseIdx];

    // Fix #3: scan/skip 级别跳过 reviewer phase
    if (phase === 'reviewer' && task.review_level !== 'full') {
      await log(flooDir, 'skip-reviewer', { task: task.id, review_level: task.review_level });
      phaseIdx++;
      continue;
    }

    task.current_phase = phase;
    await saveTask(flooDir, task);

    // 清理项目根目录的旧 artifact，防止 collectArtifact 吃到上一轮的陈旧产物
    await cleanStaleArtifact(projectRoot, phase);

    // 执行当前 phase（含重试）
    runCounter++;
    const result = await executePhase(task, phase, config, flooDir, projectRoot, adapters, runCounter);

    if (!result.success) {
      task.status = 'failed';
      task.current_phase = phase;
      await saveTask(flooDir, task);
      await log(flooDir, 'failed', { task: task.id, phase, reason: 'max_retries_exceeded' });
      return task;
    }

    // Fix #1: 收集 agent 产出的 artifact 到任务目录
    await collectArtifact(projectRoot, flooDir, task, phase);

    // phase 完成后的特殊处理
    if (phase === 'planner') {
      // 单任务模式：解析 plan.md 更新当前 task（不拆子任务）
      const dummyBatch: Batch = { id: task.batch_id, description: '', status: 'active', tasks: [task.id], created_at: '', updated_at: '' };
      const subTasks = await consumePlannerOutput(flooDir, dummyBatch, task);
      // 如果只有一个子任务，直接用更新后的 task 继续
      if (subTasks.length === 1) {
        Object.assign(task, subTasks[0]);
      }
      // 多任务情况由 runBatch 处理，runTask 不处理
    }

    if (phase === 'reviewer') {
      const verdict = await checkReviewVerdict(flooDir, task);
      if (verdict === 'fail') {
        reviewRounds++;
        if (reviewRounds >= MAX_REVIEW_ROUNDS) {
          task.status = 'failed';
          await saveTask(flooDir, task);
          await log(flooDir, 'failed', { task: task.id, reason: 'max_review_rounds', rounds: reviewRounds });
          return task;
        }
        await log(flooDir, 'review-fail', { task: task.id, round: reviewRounds });
        phaseIdx = PHASE_ORDER.indexOf('coder');
        continue;
      }
      await log(flooDir, 'review-pass', { task: task.id });
    }

    if (phase === 'coder') {
      const exitArtifact = await readExitArtifact(flooDir, task.id, phase);

      // 1. Scope violation 检测：agent 是否修改了 scope 外的文件
      const outOfScope = findOutOfScope(exitArtifact.files_changed, task.scope);
      if (outOfScope.length > 0) {
        // 只记日志，不自动扩展 scope——并行场景下 outOfScope 含其他任务的文件，扩展会污染
        await log(flooDir, 'scope-violation', { task: task.id, files: outOfScope });
      }

      // 2. 过滤 exit artifact：只保留本任务 scope 内的文件，排除并行任务的噪声
      //    写回 .exit 文件，确保下游消费者（reviewer diff 等）看到干净数据
      const rawCount = exitArtifact.files_changed.length;
      const taskFiles = exitArtifact.files_changed.filter(
        file => findOutOfScope([file], task.scope).length === 0,
      );
      if (taskFiles.length !== rawCount) {
        exitArtifact.files_changed = taskFiles;
        const exitPath = join(flooDir, 'signals', `${task.id}-${phase}.exit`);
        await writeFile(exitPath, JSON.stringify(exitArtifact, null, 2));
        await log(flooDir, 'artifact-filtered', {
          task: task.id, raw: rawCount, filtered: taskFiles.length,
        });
      }
    }

    phaseIdx++;
  }

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
  const binding = task.role_overrides?.[phase] ?? config.roles[phase];
  const adapter = adapters[binding.runtime];
  if (!adapter) {
    throw new Error(`No adapter for runtime: ${binding.runtime}`);
  }

  let lastError = '';

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // Fix #4: runId 包含 attempt，避免重试覆盖
    const runId = `${String(runCounter).padStart(3, '0')}-${phase}-${attempt}`;

    const extraVars: TemplateVars = {};
    if (attempt > 1 && lastError) {
      extraVars.previous_error = lastError;
    }
    const prompt = await buildPrompt(projectRoot, flooDir, task, phase, extraVars);

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

    const spawnOpts: SpawnOptions = {
      taskId: task.id,
      phase,
      prompt,
      cwd: projectRoot,
      runtime: binding.runtime,
      model: binding.model,
      // coder phase 通过 runner 脚本注入 git wrapper 序列化 git 写操作
      commitLock: phase === 'coder' && config.concurrency.commit_lock,
    };

    const sessionName = await adapter.spawn(spawnOpts);
    run.session_name = sessionName;

    await waitForCompletion(sessionName, flooDir, task.id, phase);

    const exitArtifact = await readExitArtifact(flooDir, task.id, phase);

    run.finished_at = exitArtifact.finished_at;
    run.exit_code = exitArtifact.exit_code;
    run.duration_seconds = exitArtifact.duration_seconds;
    await saveRun(flooDir, task.batch_id, task.id, run);

    await log(flooDir, 'callback', {
      task: task.id, phase, exit_code: exitArtifact.exit_code,
      duration: `${exitArtifact.duration_seconds}s`,
    });

    if (exitArtifact.exit_code === 0) {
      return { success: true, exitArtifact };
    }

    if (exitArtifact.exit_code === -1) {
      lastError = 'Agent was terminated externally';
      await log(flooDir, 'terminated', { task: task.id, phase, attempt });
    } else {
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

    const match = reviewContent.match(/verdict:\s*(pass|fail)/i);
    if (match) {
      return match[1].toLowerCase() as 'pass' | 'fail';
    }

    return 'fail'; // 找不到 verdict，保守策略
  } catch {
    return 'fail'; // review.md 不存在
  }
}

// ============================================================
// 批次调度入口
// ============================================================

/**
 * 并行执行多个任务（scope 无冲突的同时跑，有冲突的按依赖串行）
 * 每个子任务从 coder 阶段开始（designer/planner 已在 batch 级别完成）
 */
async function runBatch(
  tasks: Task[],
  opts: DispatcherOptions,
): Promise<Task[]> {
  const { projectRoot } = opts;
  const config = opts.config ?? DEFAULT_CONFIG;
  const flooDir = await ensureFlooDir(projectRoot);

  // 用 scope 冲突检测判断并行/串行
  const conflicts = detectConflicts(tasks.map(t => ({ id: t.id, scope: t.scope })));
  const conflictPairs = new Set(conflicts.flatMap(c => [`${c.task_a}:${c.task_b}`, `${c.task_b}:${c.task_a}`]));

  const completed = new Set<string>();  // 成功完成的任务
  const failed = new Set<string>();     // 失败的任务（区分于 completed）
  const results: Task[] = [];

  /** 检查任务的依赖是否有失败的（失败传播） */
  function hasDependencyFailed(task: Task): boolean {
    return task.depends_on.some(dep => failed.has(dep));
  }

  /** 检查任务是否可以开始（依赖全部成功完成 + 无 scope 冲突的 running 任务） */
  function canStart(task: Task, running: Set<string>): boolean {
    // 依赖检查：所有依赖必须在 completed（成功）集合中
    if (task.depends_on.some(dep => !completed.has(dep))) return false;
    // scope 冲突检查：不和任何 running 任务有冲突
    for (const rid of running) {
      if (conflictPairs.has(`${task.id}:${rid}`)) return false;
    }
    return true;
  }

  const pending = new Map(tasks.map(t => [t.id, t]));
  const running = new Map<string, Promise<Task>>();

  await log(flooDir, 'batch-start', {
    total: tasks.length,
    task_ids: tasks.map(t => t.id),
    conflicts: conflicts.length,
  });

  // 调度循环：持续 dispatch 可启动的任务，等待完成的任务
  while (pending.size > 0 || running.size > 0) {
    // 失败传播：依赖的任务已 failed，则当前任务也标记为 failed
    for (const [id, task] of pending) {
      if (hasDependencyFailed(task)) {
        pending.delete(id);
        task.status = 'failed';
        task.current_phase = null;
        await saveTask(flooDir, task);
        failed.add(id);
        results.push(task);
        await log(flooDir, 'dependency-failed', { task: id, failed_deps: task.depends_on.filter(d => failed.has(d)) });
      }
    }

    // dispatch 可启动的任务（受 max_agents 并发上限约束）
    const runningIds = new Set(running.keys());
    for (const [id, task] of pending) {
      if (running.size >= config.concurrency.max_agents) break;
      if (canStart(task, runningIds)) {
        pending.delete(id);
        runningIds.add(id);

        await log(flooDir, 'parallel-dispatch', { task: id });

        // 从 coder 开始跑（designer/planner 已在 batch 级别完成）
        // 并行安全由 scope 冲突检测保证；commit lock 留给 floo-runner 层精确锁 git 操作
        const promise = runTask(task, 'coder', opts).then(result => {
          if (result.status === 'completed') {
            completed.add(id);
          } else {
            failed.add(id);
          }
          return result;
        });
        running.set(id, promise);
      }
    }

    if (running.size === 0 && pending.size > 0) {
      // 死锁检测：有待处理任务但全部被依赖阻塞（循环依赖）
      // 不强制启动，标记所有 pending 任务为 failed
      await log(flooDir, 'deadlock', { pending: [...pending.keys()] });
      for (const [id, task] of pending) {
        task.status = 'failed';
        task.current_phase = null;
        await saveTask(flooDir, task);
        failed.add(id);
        results.push(task);
      }
      pending.clear();
      await log(flooDir, 'deadlock-resolved', { action: 'all_pending_failed' });
    }

    // 等待任意一个 running 任务完成
    if (running.size > 0) {
      const settled = await Promise.race(
        [...running.entries()].map(([id, p]) => p.then(r => ({ id, result: r }))),
      );
      running.delete(settled.id);
      results.push(settled.result);

      await log(flooDir, 'parallel-done', {
        task: settled.id,
        status: settled.result.status,
        remaining: pending.size + running.size,
      });
    }
  }

  return results;
}

/**
 * 创建批次和任务，启动执行
 * 这是 `floo run` 的核心入口
 *
 * 流程：
 * 1. 如果从 designer 开始 → designer phase → planner phase → 拆子任务
 * 2. 如果从 planner 开始 → planner phase → 拆子任务
 * 3. 拆出多子任务 → runBatch 并行调度（每个从 coder 开始）
 * 4. 单任务 → 直接 runTask
 * 5. 如果从 coder/reviewer 开始 → 直接 runTask（跳过 planner）
 */
export async function createAndRun(
  description: string,
  startPhase: Phase,
  opts: DispatcherOptions & { scope?: string[] },
): Promise<{ batch: Batch; tasks: Task[] }> {
  const { projectRoot } = opts;
  const config = opts.config ?? DEFAULT_CONFIG;
  const flooDir = await ensureFlooDir(projectRoot);

  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const timeSlug = now.toISOString().slice(11, 19).replace(/:/g, '');
  const descSlug = description.slice(0, 30).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '-').replace(/-+/g, '-');
  const batchId = `${date}-${timeSlug}-${descSlug}`;

  const batch: Batch = {
    id: batchId,
    description,
    status: 'active',
    tasks: ['task-001'],
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  await saveBatch(flooDir, batch);

  const mainTask: Task = {
    id: 'task-001',
    batch_id: batchId,
    description,
    status: 'pending',
    current_phase: null,
    scope: opts.scope ?? [],
    acceptance_criteria: [],
    review_level: 'full',
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    depends_on: [],
  };
  await saveTask(flooDir, mainTask);

  // 如果从 coder 或 reviewer 开始，跳过 planner，直接单任务执行
  const startIdx = PHASE_ORDER.indexOf(startPhase);
  const coderIdx = PHASE_ORDER.indexOf('coder');
  if (startIdx >= coderIdx) {
    const result = await runTask(mainTask, startPhase, opts);
    batch.status = result.status === 'completed' ? 'completed' : 'active';
    await saveBatch(flooDir, batch);
    return { batch, tasks: [result] };
  }

  // 从 designer 或 planner 开始：先跑前置 phase 到 planner 完成
  const adapters = opts.adapters;
  mainTask.status = 'running';
  await saveTask(flooDir, mainTask);

  // 执行 designer（如果需要）
  if (startPhase === 'designer') {
    mainTask.current_phase = 'designer';
    await saveTask(flooDir, mainTask);
    await cleanStaleArtifact(projectRoot, 'designer');
    const designResult = await executePhase(mainTask, 'designer', config, flooDir, projectRoot, adapters, 1);
    if (!designResult.success) {
      mainTask.status = 'failed';
      await saveTask(flooDir, mainTask);
      return { batch, tasks: [mainTask] };
    }
    await collectArtifact(projectRoot, flooDir, mainTask, 'designer');
  }

  // 执行 planner
  mainTask.current_phase = 'planner';
  await saveTask(flooDir, mainTask);
  await cleanStaleArtifact(projectRoot, 'planner');
  const planResult = await executePhase(mainTask, 'planner', config, flooDir, projectRoot, adapters, 2);
  if (!planResult.success) {
    mainTask.status = 'failed';
    await saveTask(flooDir, mainTask);
    return { batch, tasks: [mainTask] };
  }
  await collectArtifact(projectRoot, flooDir, mainTask, 'planner');

  // 解析 plan.md 拆子任务
  const subTasks = await consumePlannerOutput(flooDir, batch, mainTask);

  if (subTasks.length <= 1) {
    // 单任务：继续跑 coder → reviewer
    const task = subTasks[0] ?? mainTask;
    const result = await runTask(task, 'coder', opts);
    batch.status = result.status === 'completed' ? 'completed' : 'active';
    await saveBatch(flooDir, batch);
    return { batch, tasks: [result] };
  }

  // 多任务：并行调度（父任务标记完成，清理 phase 避免 status 残留）
  mainTask.status = 'completed';
  mainTask.current_phase = null;
  await saveTask(flooDir, mainTask);

  const results = await runBatch(subTasks, opts);

  // 更新 batch 状态
  const allCompleted = results.every(t => t.status === 'completed');
  batch.status = allCompleted ? 'completed' : 'active';
  await saveBatch(flooDir, batch);

  return { batch, tasks: results };
}
