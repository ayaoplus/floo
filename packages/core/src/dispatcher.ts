/**
 * Dispatcher — 核心调度器
 * 状态机驱动任务在 phase 之间流转：designer → planner → coder → reviewer
 * 处理正常流转、失败重试、review 循环、超时取消
 */

import { readFile, writeFile, mkdir, copyFile, access, appendFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { loadSkill, type TemplateVars } from './skills/loader.js';
import { readExitArtifact, waitForCompletion } from './adapters/base.js';
import { findOutOfScope, ensureFlooDir, detectConflicts } from './scope.js';
import { notify } from './notifications.js';
import { extractLesson } from './lessons.js';
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
  MAX_TEST_ROUNDS,
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

/** 确保值是字符串数组（YAML 解析结果可能是各种类型） */
function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  return [];
}

/**
 * 从 batchId 生成 8 字符的 batch token（HHmmss + 2位随机）
 * 用于 task ID 前缀，确保并发 batch 的资源不碰撞
 * 例：batchId = "2026-04-08-080748-auth" → token = "08074832"
 */
function deriveBatchToken(batchId: string): string {
  // 提取时间部分：batchId 格式 "yyyy-MM-dd-HHmmss-..."
  const timePart = batchId.split('-')[3] ?? '000000';
  const random = Math.random().toString(36).slice(2, 4); // 2 字符随机
  return `${timePart}${random}`;
}

// ============================================================
// Artifact 收集
// ============================================================

/** phase 对应的 artifact 基础名（不含 taskId 前缀） */
const PHASE_ARTIFACT_BASES: Partial<Record<Phase, string>> = {
  designer: 'design',
  planner: 'plan',
  reviewer: 'review',
  tester: 'test-report',
};

/**
 * 获取 projectRoot 中的 artifact 文件名（带 taskId 前缀，防止并行覆盖）
 * 项目根目录用 `{taskId}-{base}.md`，任务目录中统一用 `{base}.md`
 */
function artifactFilename(phase: Phase, taskId: string): string | null {
  const base = PHASE_ARTIFACT_BASES[phase];
  return base ? `${taskId}-${base}.md` : null;
}

/** 任务目录中的 artifact 文件名（无前缀，始终固定） */
function taskArtifactFilename(phase: Phase): string | null {
  const base = PHASE_ARTIFACT_BASES[phase];
  return base ? `${base}.md` : null;
}

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
  const srcFilename = artifactFilename(phase, task.id);
  const destFilename = taskArtifactFilename(phase);
  if (!srcFilename || !destFilename) return;

  const src = join(projectRoot, srcFilename);
  const taskDir = join(flooDir, 'batches', task.batch_id, 'tasks', task.id);
  const dest = join(taskDir, destFilename);

  try {
    await access(src);
    await mkdir(taskDir, { recursive: true });
    await copyFile(src, dest);
    // 复制后清理项目根目录的临时 artifact，避免垃圾积累
    try { await unlink(src); } catch { /* 删除失败不影响主流程 */ }
    await log(flooDir, 'artifact-collected', { task: task.id, phase, file: srcFilename });
  } catch {
    // artifact 可能不存在（如 agent 失败了没产出）
    await log(flooDir, 'artifact-missing', { task: task.id, phase, file: srcFilename });
  }
}

/**
 * 在 phase 执行前删除项目根目录的旧 artifact
 * 防止 agent 失败时 collectArtifact 复制到上一轮的陈旧文件
 */
async function cleanStaleArtifact(projectRoot: string, phase: Phase, taskId: string): Promise<void> {
  const filename = artifactFilename(phase, taskId);
  if (!filename) return;

  const filePath = join(projectRoot, filename);
  try {
    await unlink(filePath);
  } catch { /* 文件不存在，忽略 */ }
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
 * 解析 plan.md 拆出多个子任务（使用 yaml 包解析）
 * plan.md 中的 YAML 可能在 ```yaml 代码块内，也可能直接是纯 YAML
 * 支持两种结构：
 * 1. 多任务：{ tasks: [...] } 或顶层数组
 * 2. 单任务：{ scope: [...], acceptance_criteria: [...] }
 */
function parsePlanTasks(content: string): ParsedTask[] {
  // 提取 ```yaml ... ``` 代码块，如果有的话
  const codeBlockMatch = content.match(/```ya?ml\s*\n([\s\S]*?)```/);
  const yamlContent = codeBlockMatch ? codeBlockMatch[1] : content;

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlContent);
  } catch {
    // YAML 解析失败，返回空任务列表（兼容非 YAML 内容）
    return [{
      id: 'fallback', description: '', scope: [], acceptance_criteria: [],
      review_level: 'full', depends_on: [],
    }];
  }

  // 提取任务数组：支持 { tasks: [...] } 或直接 [...]
  let rawTasks: unknown[];
  if (parsed && typeof parsed === 'object' && 'tasks' in parsed && Array.isArray((parsed as Record<string, unknown>).tasks)) {
    rawTasks = (parsed as Record<string, unknown>).tasks as unknown[];
  } else if (Array.isArray(parsed)) {
    rawTasks = parsed;
  } else if (parsed && typeof parsed === 'object') {
    // 单任务格式：直接用整个对象作为一个任务
    rawTasks = [parsed];
  } else {
    return [{
      id: 'fallback', description: '', scope: [], acceptance_criteria: [],
      review_level: 'full', depends_on: [],
    }];
  }

  const tasks: ParsedTask[] = [];
  for (const raw of rawTasks) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as Record<string, unknown>;

    // 没有 id 的对象不是有效任务（可能是注释或其他结构）
    if (!t.id && rawTasks.length > 1) continue;

    const reviewLevel = String(t.review_level ?? 'full').toLowerCase();
    tasks.push({
      id: String(t.id ?? 'fallback'),
      description: String(t.description ?? ''),
      scope: toStringArray(t.scope),
      acceptance_criteria: toStringArray(t.acceptance_criteria),
      review_level: ['full', 'scan', 'skip'].includes(reviewLevel) ? reviewLevel as 'full' | 'scan' | 'skip' : 'full',
      depends_on: toStringArray(t.depends_on),
    });
  }

  // 没有解析出任何任务，回退为单任务
  if (tasks.length === 0) {
    const obj = (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {};
    tasks.push({
      id: 'fallback',
      description: '',
      scope: toStringArray(obj.scope),
      acceptance_criteria: toStringArray(obj.acceptance_criteria),
      review_level: 'full',
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

  // 从父任务 ID 提取 batchToken（格式 "{batchToken}-001"），加到子任务 ID 前缀
  // 确保并发 batch 的子任务 ID 不碰撞
  const batchToken = parentTask.id.replace(/-\d+$/, '');

  // 建立 planner 原始 ID → 新 ID 的映射表（用于重写 depends_on）
  const idMap = new Map<string, string>();
  for (let i = 0; i < parsed.length; i++) {
    const newId = `${batchToken}-${String(i + 1).padStart(3, '0')}`;
    idMap.set(parsed[i].id, newId);
  }

  // 父任务的 artifact 目录（design.md / plan.md 存放位置）
  const parentTaskDir = join(flooDir, 'batches', batch.id, 'tasks', parentTask.id);

  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    const subTaskId = idMap.get(p.id)!;
    // depends_on 里的原始 ID 映射到新 ID
    const mappedDeps = p.depends_on.map(dep => idMap.get(dep) ?? dep);
    const task: Task = {
      id: subTaskId,
      batch_id: batch.id,
      description: p.description || parentTask.description,
      status: 'pending',
      current_phase: null,
      scope: p.scope,
      acceptance_criteria: p.acceptance_criteria,
      review_level: p.review_level,
      created_at: now,
      updated_at: now,
      depends_on: mappedDeps,
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
    // artifact 输出文件名（带 taskId 前缀，防止并行覆盖）
    output_file: artifactFilename(phase, task.id) ?? '',
    acceptance_criteria: task.acceptance_criteria.join('\n- '),
    ...extraVars,
  };

  // 按 phase 补充上下文
  if (phase === 'planner' || phase === 'coder' || phase === 'reviewer' || phase === 'tester') {
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
    // tester fail 后回到 coder，需要读取测试报告作为反馈
    try {
      vars.test_feedback = await readFile(join(taskDir, 'test-report.md'), 'utf-8');
    } catch { /* 首次执行没有 test-report */ }
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

  if (phase === 'reviewer' || phase === 'tester') {
    // 用 base-head 和 head_after 精确锁定 coder 阶段的 diff 范围
    // 并行场景下避免读到其他任务的 commit（HEAD 是移动目标）
    const scopePaths = task.scope.length > 0 ? ['--', ...task.scope] : [];
    try {
      const signalsDir = join(flooDir, 'signals');
      const baseHead = (await readFile(join(signalsDir, `${task.id}-coder.base-head`), 'utf-8')).trim();

      // 优先用 coder exit artifact 的 head_after（精确快照），fallback 到 HEAD
      let endRef = 'HEAD';
      try {
        const coderArtifact = await readExitArtifact(flooDir, task.id, 'coder');
        if (coderArtifact.head_after) endRef = coderArtifact.head_after;
      } catch { /* coder artifact 可能不存在（如 --from reviewer） */ }

      if (baseHead) {
        const { stdout } = await exec('git', ['diff', baseHead, endRef, ...scopePaths], { cwd: projectRoot });
        vars.diff = stdout.trim();
      } else {
        // 新仓库，用 diff-tree 列出所有文件
        const { stdout } = await exec('git', ['diff-tree', '--no-commit-id', '-p', '--root', '-r', endRef, ...scopePaths], { cwd: projectRoot });
        vars.diff = stdout.trim();
      }
    } catch {
      // fallback: 至少看最近一个 commit
      try {
        const { stdout } = await exec('git', ['diff', 'HEAD~1', ...scopePaths], { cwd: projectRoot });
        vars.diff = stdout.trim();
      } catch {
        vars.diff = '(无法获取 diff)';
      }
    }
  }

  if (phase === 'tester') {
    // tester 需要 review 反馈作为额外上下文（如果有的话）
    try {
      vars.review_feedback = await readFile(join(taskDir, 'review.md'), 'utf-8');
    } catch { /* 可能没有 review */ }
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
  /** 传入 AbortSignal 支持 graceful shutdown（Ctrl+C 时停止调度新任务） */
  signal?: AbortSignal;
}

/**
 * 运行单个任务的完整生命周期
 * 从 startPhase 开始，驱动状态机流转到 endPhase（含）或失败
 * endPhase 默认等于 PHASE_ORDER 最后一个阶段
 */
export async function runTask(
  task: Task,
  startPhase: Phase,
  opts: DispatcherOptions,
  endPhase?: Phase,
): Promise<Task> {
  const { projectRoot, adapters } = opts;
  const config = opts.config ?? DEFAULT_CONFIG;
  const flooDir = await ensureFlooDir(projectRoot);

  const startIdx = PHASE_ORDER.indexOf(startPhase);
  if (startIdx === -1) {
    throw new Error(`Invalid start phase: ${startPhase}`);
  }
  const endIdx = endPhase ? PHASE_ORDER.indexOf(endPhase) : PHASE_ORDER.length - 1;

  task.status = 'running';
  await saveTask(flooDir, task);
  await log(flooDir, 'dispatch', { task: task.id, start_phase: startPhase });

  let reviewRounds = 0;
  let testRounds = 0;
  let runCounter = 0;

  let phaseIdx = startIdx;
  while (phaseIdx <= endIdx) {
    // graceful shutdown：收到 abort 信号后不再启动新 phase
    if (opts.signal?.aborted) {
      task.status = 'cancelled';
      task.current_phase = null;
      await saveTask(flooDir, task);
      await log(flooDir, 'aborted', { task: task.id, phase: PHASE_ORDER[phaseIdx] });
      return task;
    }

    const phase = PHASE_ORDER[phaseIdx];

    // scan: 自动检查 exit code + scope 合规，不派 review agent
    // skip: 仅跳过 reviewer，不做额外检查
    if (phase === 'reviewer' && task.review_level === 'scan') {
      // scan 级别：检查上一个 coder phase 的结果
      const coderArtifact = await readExitArtifact(flooDir, task.id, 'coder');
      if (coderArtifact.exit_code !== 0) {
        task.status = 'failed';
        await saveTask(flooDir, task);
        await log(flooDir, 'scan-failed', { task: task.id, reason: 'coder_exit_nonzero', exit_code: coderArtifact.exit_code });
        return task;
      }
      const outOfScope = findOutOfScope(coderArtifact.files_changed, task.scope);
      if (outOfScope.length > 0) {
        await log(flooDir, 'scan-scope-violation', { task: task.id, files: outOfScope });
      }
      await log(flooDir, 'scan-passed', { task: task.id });
      phaseIdx++;
      continue;
    }
    if (phase === 'reviewer' && task.review_level === 'skip') {
      await log(flooDir, 'skip-reviewer', { task: task.id });
      phaseIdx++;
      continue;
    }

    task.current_phase = phase;
    await saveTask(flooDir, task);

    // 清理项目根目录的旧 artifact，防止 collectArtifact 吃到上一轮的陈旧产物
    await cleanStaleArtifact(projectRoot, phase, task.id);

    // 执行当前 phase（含重试）
    runCounter++;
    const result = await executePhase(task, phase, config, flooDir, projectRoot, adapters, runCounter);

    if (!result.success) {
      task.status = 'failed';
      task.current_phase = phase;
      await saveTask(flooDir, task);
      await log(flooDir, 'failed', { task: task.id, phase, reason: 'max_retries_exceeded' });
      await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: 'failed', phase, reason: 'max_retries_exceeded' });
      return task;
    }

    // Fix #1: 收集 agent 产出的 artifact 到任务目录
    await collectArtifact(projectRoot, flooDir, task, phase);

    // phase 完成后的特殊处理
    if (phase === 'planner') {
      // 读取已持久化的 batch（而非手动构造空壳，避免状态不一致）
      const batchPath = join(flooDir, 'batches', task.batch_id, 'batch.json');
      const batch: Batch = JSON.parse(await readFile(batchPath, 'utf-8'));
      const subTasks = await consumePlannerOutput(flooDir, batch, task);
      // 如果只有一个子任务，直接用更新后的 task 继续
      if (subTasks.length === 1) {
        Object.assign(task, subTasks[0]);
      }
      // 多任务情况由 runBatch 处理，runTask 不处理
    }

    if (phase === 'reviewer') {
      const verdict = await checkReviewVerdict(flooDir, task);
      if (verdict === 'fail') {
        // 单 phase 模式（--from reviewer）：coder 不在执行范围内，不能回退修复
        const coderInRange = PHASE_ORDER.indexOf('coder') >= startIdx && PHASE_ORDER.indexOf('coder') <= endIdx;
        if (!coderInRange) {
          task.status = 'failed';
          await saveTask(flooDir, task);
          await log(flooDir, 'failed', { task: task.id, reason: 'review_fail_no_coder', verdict: 'fail' });
          await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: 'failed', reason: 'review_fail_no_coder' });
          return task;
        }
        reviewRounds++;
        if (reviewRounds >= MAX_REVIEW_ROUNDS) {
          task.status = 'failed';
          await saveTask(flooDir, task);
          await log(flooDir, 'failed', { task: task.id, reason: 'max_review_rounds', rounds: reviewRounds });
          await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: 'failed', reason: 'max_review_rounds' });
          return task;
        }
        await log(flooDir, 'review-fail', { task: task.id, round: reviewRounds });
        await notify(flooDir, 'review_concluded', { batch_id: task.batch_id, task_id: task.id, phase, verdict: 'fail', round: reviewRounds });
        phaseIdx = PHASE_ORDER.indexOf('coder');
        continue;
      }
      await log(flooDir, 'review-pass', { task: task.id });
      await notify(flooDir, 'review_concluded', { batch_id: task.batch_id, task_id: task.id, phase, verdict: 'pass' });
    }

    if (phase === 'tester') {
      const testResult = await checkTestResult(flooDir, task);
      if (testResult === 'fail') {
        // 单 phase 模式（--from tester）：coder 不在执行范围内，不能回退修复
        const coderInRange = PHASE_ORDER.indexOf('coder') >= startIdx && PHASE_ORDER.indexOf('coder') <= endIdx;
        if (!coderInRange) {
          task.status = 'failed';
          await saveTask(flooDir, task);
          await log(flooDir, 'failed', { task: task.id, reason: 'test_fail_no_coder', verdict: 'fail' });
          await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: 'failed', reason: 'test_fail_no_coder' });
          return task;
        }
        testRounds++;
        if (testRounds >= MAX_TEST_ROUNDS) {
          task.status = 'failed';
          await saveTask(flooDir, task);
          await log(flooDir, 'failed', { task: task.id, reason: 'max_test_rounds', rounds: testRounds });
          await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: 'failed', reason: 'max_test_rounds' });
          return task;
        }
        await log(flooDir, 'test-fail', { task: task.id, round: testRounds });
        await notify(flooDir, 'review_concluded', { batch_id: task.batch_id, task_id: task.id, phase, verdict: 'fail', round: testRounds });
        // tester fail → 回 coder 重新修复（coder 会读取 test-report.md 作为反馈）
        reviewRounds = 0; // 重置 review 轮数，新一轮 coder→reviewer→tester
        phaseIdx = PHASE_ORDER.indexOf('coder');
        continue;
      }
      await log(flooDir, 'test-pass', { task: task.id });
      await notify(flooDir, 'review_concluded', { batch_id: task.batch_id, task_id: task.id, phase, verdict: 'pass' });
    }

    if (phase === 'coder') {
      const exitArtifact = await readExitArtifact(flooDir, task.id, phase);

      // 1. Protected files 检测：无论 scope 如何，修改受保护文件一律 fail
      const protectedHits = exitArtifact.files_changed.filter(
        f => config.protected_files.some(p => f === p || f.endsWith('/' + p)),
      );
      if (protectedHits.length > 0) {
        await log(flooDir, 'protected-file-violation', { task: task.id, files: protectedHits });
        task.status = 'failed';
        task.current_phase = phase;
        await saveTask(flooDir, task);
        await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: 'failed', reason: 'protected_file_violation' });
        return task;
      }

      // 2. Scope violation 检测：有明确 scope 时越界即 fail（scope 是约束，不是建议）
      //    空 scope = 用户未指定约束，跳过检测
      if (task.scope.length > 0) {
        const outOfScope = findOutOfScope(exitArtifact.files_changed, task.scope);
        if (outOfScope.length > 0) {
          await log(flooDir, 'scope-violation', { task: task.id, files: outOfScope });
          task.status = 'failed';
          task.current_phase = phase;
          await saveTask(flooDir, task);
          await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: 'failed', reason: 'scope_violation', files: outOfScope });
          return task;
        }
      }

      // 3. 过滤 exit artifact：只保留本任务 scope 内的文件，排除并行任务的噪声
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
  await notify(flooDir, 'task_completed', { batch_id: task.batch_id, task_id: task.id, status: 'completed' });

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
      // coder phase 传递 scope，用于 force-commit 兜底
      scope: phase === 'coder' ? task.scope : undefined,
    };

    const sessionName = await adapter.spawn(spawnOpts);
    run.session_name = sessionName;

    await notify(flooDir, 'phase_started', {
      batch_id: task.batch_id, task_id: task.id, phase,
      runtime: binding.runtime, model: binding.model, session: sessionName,
    });

    // Heartbeat：每 5 分钟刷新 updated_at，供 health-check 判断任务是否仍在活动
    const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
    const heartbeat = setInterval(async () => {
      try {
        task.updated_at = new Date().toISOString();
        await saveTask(flooDir, task);
        await log(flooDir, 'heartbeat', { task: task.id, phase });
      } catch { /* heartbeat 失败不影响主流程 */ }
    }, HEARTBEAT_INTERVAL_MS);

    try {
      const timeoutMs = config.session.timeout_minutes * 60 * 1000;
      await waitForCompletion(sessionName, flooDir, task.id, phase, timeoutMs);
    } finally {
      clearInterval(heartbeat);
    }

    const exitArtifact = await readExitArtifact(flooDir, task.id, phase);

    run.finished_at = exitArtifact.finished_at;
    run.exit_code = exitArtifact.exit_code;
    run.duration_seconds = exitArtifact.duration_seconds;
    await saveRun(flooDir, task.batch_id, task.id, run);

    await log(flooDir, 'callback', {
      task: task.id, phase, exit_code: exitArtifact.exit_code,
      duration: `${exitArtifact.duration_seconds}s`,
    });

    await notify(flooDir, 'phase_completed', {
      batch_id: task.batch_id, task_id: task.id, phase,
      exit_code: exitArtifact.exit_code, duration_seconds: exitArtifact.duration_seconds,
    });

    if (exitArtifact.exit_code === 0) {
      // 重试成功：自动提取经验教训（attempt > 1 说明前面有失败）
      if (attempt > 1 && lastError) {
        try {
          await extractLesson(flooDir, task.id, task.batch_id, phase, lastError, `Retry #${attempt} succeeded`);
          await log(flooDir, 'lesson-extracted', { task: task.id, phase, attempt });
        } catch { /* lesson 提取失败不影响主流程 */ }
      }
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
      await notify(flooDir, 'retry', {
        batch_id: task.batch_id, task_id: task.id, phase,
        attempt, max_retries: MAX_RETRIES, error: lastError.slice(0, 200),
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

/**
 * 检查测试结果
 * 从 test-report.md 中提取 result: pass/fail
 */
async function checkTestResult(
  flooDir: string,
  task: Task,
): Promise<'pass' | 'fail'> {
  try {
    const taskDir = join(flooDir, 'batches', task.batch_id, 'tasks', task.id);
    const testContent = await readFile(join(taskDir, 'test-report.md'), 'utf-8');

    const match = testContent.match(/result:\s*(pass|fail)/i);
    if (match) {
      return match[1].toLowerCase() as 'pass' | 'fail';
    }

    return 'fail'; // 找不到 result，保守策略
  } catch {
    return 'fail'; // test-report.md 不存在
  }
}

// ============================================================
// 整体 Review（批次完成后只读报告）
// ============================================================

/**
 * 批次完成后的整体 review
 * 汇总所有已完成任务的变更，派 reviewer agent 生成 summary.md
 * 只读报告，不修改代码——用户看完决定是否开新批次
 */
async function runBatchSummaryReview(
  flooDir: string,
  batch: Batch,
  completedTasks: Task[],
  config: FlooConfig,
  projectRoot: string,
  adapters: Record<string, AgentAdapter>,
): Promise<void> {
  await log(flooDir, 'summary-review-start', { batch: batch.id, tasks: completedTasks.length });

  // 汇总所有任务的 review 和 test-report
  const taskSummaries: string[] = [];
  for (const task of completedTasks) {
    const taskDir = join(flooDir, 'batches', batch.id, 'tasks', task.id);
    let summary = `### ${task.id}: ${task.description}\n`;
    summary += `- Scope: ${task.scope.join(', ') || '(未指定)'}\n`;

    try {
      const review = await readFile(join(taskDir, 'review.md'), 'utf-8');
      summary += `- Review: ${review.match(/verdict:\s*(pass|fail)/i)?.[0] ?? '(无 verdict)'}\n`;
    } catch { /* 无 review */ }

    try {
      const testReport = await readFile(join(taskDir, 'test-report.md'), 'utf-8');
      summary += `- Test: ${testReport.match(/result:\s*(pass|fail)/i)?.[0] ?? '(无 result)'}\n`;
    } catch { /* 无 test-report */ }

    taskSummaries.push(summary);
  }

  // 获取整体 diff（用批次创建时的 base-head，不受 coder 重跑覆盖影响）
  let batchDiff = '';
  try {
    const signalsDir = join(flooDir, 'signals');
    const baseHead = (await readFile(join(signalsDir, `${batch.id}-batch.base-head`), 'utf-8')).trim();
    if (baseHead) {
      // 正常情况：batch 开始时有 HEAD，diff 到当前 HEAD
      const { stdout } = await exec('git', ['diff', baseHead, 'HEAD'], { cwd: projectRoot });
      batchDiff = stdout.trim();
    } else {
      // 新仓库：batch 开始时无 commit，用空树 diff 获取从零开始的累计变更
      const { stdout: emptyTree } = await exec('git', ['hash-object', '-t', 'tree', '/dev/null'], { cwd: projectRoot });
      const { stdout } = await exec('git', ['diff', emptyTree.trim(), 'HEAD'], { cwd: projectRoot });
      batchDiff = stdout.trim();
    }
  } catch {
    batchDiff = '(无法获取 diff)';
  }

  // 组装 summary review prompt
  const summaryOutputFile = 'summary.md';
  const prompt = `# 整体 Review — 批次总结报告

你是 Reviewer 角色，负责对本批次的所有变更进行整体审查。**这是只读报告，不修改代码。**

## 批次信息

- **批次 ID**：${batch.id}
- **描述**：${batch.description}
- **完成任务数**：${completedTasks.length}

## 各任务概况

${taskSummaries.join('\n')}

## 整体代码变更

\`\`\`diff
${batchDiff.slice(0, 50000)}
\`\`\`

## 输出要求

将以下内容写入当前目录的 \`${batch.id}-summary.md\` 文件。

### 格式

\`\`\`markdown
# 批次整体 Review

## 概述
（1-3 句话总结本批次的整体质量）

## 各任务评估
（逐个任务简要评价）

## 跨任务问题
（不同任务之间的一致性、接口兼容性、重复代码等）

## 风险点
（潜在的技术债务、性能风险、安全隐患）

## 建议
（后续改进方向，供用户决定是否开新批次）
\`\`\`

## 约束

- **只读不改代码**，只输出报告
- 报告要简洁有用，不做开放式评判
- 聚焦跨任务的整体质量，不重复各任务 review 已覆盖的内容
`;

  // 用 reviewer 的 runtime 配置
  const binding = config.roles.reviewer;
  const adapter = adapters[binding.runtime];
  if (!adapter) {
    await log(flooDir, 'summary-review-skip', { reason: `no adapter for ${binding.runtime}` });
    return;
  }

  // 创建一个虚拟任务用于 summary review（ID 含 batchId 避免并发 batch 冲突）
  const summaryTaskId = `summary-${batch.id}`;
  const summaryTask: Task = {
    id: summaryTaskId,
    batch_id: batch.id,
    description: `整体 Review: ${batch.description}`,
    status: 'running',
    current_phase: 'reviewer',
    scope: [],
    acceptance_criteria: [],
    review_level: 'full',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    depends_on: [],
  };

  const spawnOpts: SpawnOptions = {
    taskId: summaryTask.id,
    phase: 'reviewer',
    prompt,
    cwd: projectRoot,
    runtime: binding.runtime,
    model: binding.model,
  };

  try {
    const sessionName = await adapter.spawn(spawnOpts);
    const timeoutMs = config.session.timeout_minutes * 60 * 1000;
    await waitForCompletion(sessionName, flooDir, summaryTask.id, 'reviewer', timeoutMs);

    // 收集 summary artifact 到 batch 目录
    const artifactSrc = join(projectRoot, `${batch.id}-summary.md`);
    const artifactDest = join(flooDir, 'batches', batch.id, summaryOutputFile);
    try {
      await copyFile(artifactSrc, artifactDest);
      await log(flooDir, 'summary-review-done', { batch: batch.id, file: summaryOutputFile });
    } catch {
      await log(flooDir, 'summary-review-artifact-missing', { batch: batch.id });
    }
  } catch (err) {
    await log(flooDir, 'summary-review-failed', { batch: batch.id, error: String(err) });
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
    // graceful shutdown：不再 dispatch 新任务，等待已 running 的完成
    if (opts.signal?.aborted && pending.size > 0) {
      await log(flooDir, 'batch-aborting', { pending: [...pending.keys()] });
      for (const [, task] of pending) {
        task.status = 'cancelled';
        task.current_phase = null;
        await saveTask(flooDir, task);
        results.push(task);
      }
      pending.clear();
      // 不 break：仍然等待 running 任务自然结束（runTask 内部会检查 signal）
    }

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
        // catch 兜底：runTask 内部异常不应让整个 batch 调度崩溃
        const promise = runTask(task, 'coder', opts).then(result => {
          if (result.status === 'completed') {
            completed.add(id);
          } else {
            failed.add(id);
          }
          return result;
        }).catch(async (err) => {
          await log(flooDir, 'parallel-crash', { task: id, error: String(err) });
          task.status = 'failed';
          task.current_phase = null;
          await saveTask(flooDir, task);
          failed.add(id);
          return task;
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
  const batchToken = deriveBatchToken(batchId);
  const mainTaskId = `${batchToken}-001`;

  const batch: Batch = {
    id: batchId,
    description,
    status: 'active',
    tasks: [mainTaskId],
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  await saveBatch(flooDir, batch);

  const mainTask: Task = {
    id: mainTaskId,
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

  await notify(flooDir, 'task_started', { batch_id: batchId, task_id: mainTask.id, description });

  // 记录批次创建时的 HEAD，用于 summary review 的 diff 基线（不受 coder 重跑覆盖影响）
  // 新仓库无 HEAD 时写空字符串，summary review 会用 diff-tree --root 兜底
  const signalsDir = join(flooDir, 'signals');
  await mkdir(signalsDir, { recursive: true });
  let batchBaseHead = '';
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: projectRoot });
    batchBaseHead = stdout.trim();
  } catch { /* 新仓库无 HEAD */ }
  await writeFile(join(signalsDir, `${batchId}-batch.base-head`), batchBaseHead);

  // 如果从 coder 或更后的 phase 开始，跳过 planner，直接单任务执行
  // coder 开始 → 跑完整后续流程（coder→reviewer→tester）
  // reviewer/tester 开始 → 只跑该单个 phase（不继续到后续 phase）
  const startIdx = PHASE_ORDER.indexOf(startPhase);
  const coderIdx = PHASE_ORDER.indexOf('coder');
  if (startIdx >= coderIdx) {
    // reviewer/tester 是单 phase 任务，不跑后续；coder 跑完整后续
    const endPhase = startPhase === 'coder' ? undefined : startPhase;
    const result = await runTask(mainTask, startPhase, opts, endPhase);
    batch.status = result.status === 'completed' ? 'completed' : 'failed';
    await saveBatch(flooDir, batch);

    // 从 coder 走完整流程的任务也触发 summary review
    if (result.status === 'completed' && startPhase === 'coder') {
      await runBatchSummaryReview(flooDir, batch, [result], config, projectRoot, opts.adapters);
    }

    await notify(flooDir, 'batch_completed', {
      batch_id: batchId, task_id: mainTask.id,
      status: batch.status, total_tasks: 1,
      completed: result.status === 'completed' ? 1 : 0, failed: result.status === 'failed' ? 1 : 0,
    });
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
    await cleanStaleArtifact(projectRoot, 'designer', mainTask.id);
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
  await cleanStaleArtifact(projectRoot, 'planner', mainTask.id);
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
    // 单任务：继续跑 coder → reviewer → tester
    const task = subTasks[0] ?? mainTask;
    const result = await runTask(task, 'coder', opts);
    batch.status = result.status === 'completed' ? 'completed' : 'failed';
    await saveBatch(flooDir, batch);

    // 单任务完成后触发整体 review（只读报告）
    if (result.status === 'completed') {
      await runBatchSummaryReview(flooDir, batch, [result], config, projectRoot, adapters);
    }

    await notify(flooDir, 'batch_completed', {
      batch_id: batch.id, task_id: task.id,
      status: batch.status, total_tasks: 1, completed: result.status === 'completed' ? 1 : 0, failed: result.status === 'failed' ? 1 : 0,
    });
    return { batch, tasks: [result] };
  }

  // 多任务：并行调度（父任务标记完成，清理 phase 避免 status 残留）
  mainTask.status = 'completed';
  mainTask.current_phase = null;
  await saveTask(flooDir, mainTask);

  const results = await runBatch(subTasks, opts);

  // 更新 batch 状态
  const allCompleted = results.every(t => t.status === 'completed');
  const anyFailed = results.some(t => t.status === 'failed');
  batch.status = allCompleted ? 'completed' : anyFailed ? 'failed' : 'active';
  await saveBatch(flooDir, batch);

  // 所有任务完成后才触发整体 review（避免失败任务的 commit 混进 summary diff）
  if (allCompleted) {
    await runBatchSummaryReview(flooDir, batch, results, config, projectRoot, adapters);
  }

  await notify(flooDir, 'batch_completed', {
    batch_id: batch.id, task_id: mainTask.id,
    status: batch.status, total_tasks: results.length,
    completed: results.filter(t => t.status === 'completed').length,
    failed: results.filter(t => t.status === 'failed').length,
  });

  return { batch, tasks: results };
}
