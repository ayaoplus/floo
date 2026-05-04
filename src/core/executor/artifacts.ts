/**
 * Artifact 收集与清理
 *
 * Agent 在 projectRoot 写产物 → executor 在 phase 完成后复制到 task 目录。
 * 命名:projectRoot 用 `{taskId}-{base}.md`(带前缀防止并行覆盖),task 目录统一用 `{base}.md`。
 */

import { writeFile, mkdir, copyFile, access, unlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { Phase, Task } from '../types.js';
import { MAX_DISCUSS_ROUNDS } from '../types.js';
import { log } from './io.js';

/** phase 对应的 artifact 基础名(不含 taskId 前缀) */
export const PHASE_ARTIFACT_BASES: Partial<Record<Phase, string>> = {
  discuss: 'context',
  designer: 'design',
  planner: 'plan',
  reviewer: 'review',
  tester: 'test-report',
};

/** designer 的可选反向质疑产物(不在 PHASE_ARTIFACT_BASES 里,单独处理) */
export const DESIGNER_QUESTIONS_BASE = 'design-questions';

/** projectRoot 中带 taskId 前缀的 artifact 文件名 */
export function artifactFilename(phase: Phase, taskId: string): string | null {
  const base = PHASE_ARTIFACT_BASES[phase];
  return base ? `${taskId}-${base}.md` : null;
}

/** task 目录中的 artifact 文件名(无前缀) */
export function taskArtifactFilename(phase: Phase): string | null {
  const base = PHASE_ARTIFACT_BASES[phase];
  return base ? `${base}.md` : null;
}

/** phase 完成后,把项目根目录的 artifact 复制到任务目录 */
export async function collectArtifact(
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
    try { await unlink(src); } catch { /* 删除失败不影响主流程 */ }
    await log(flooDir, 'artifact-collected', { task: task.id, phase, file: srcFilename });
  } catch {
    await log(flooDir, 'artifact-missing', { task: task.id, phase, file: srcFilename });
  }
}

/** phase 执行前删除 projectRoot 旧 artifact,防止 collectArtifact 吃到陈旧文件 */
export async function cleanStaleArtifact(
  projectRoot: string,
  phase: Phase,
  taskId: string,
): Promise<void> {
  const filename = artifactFilename(phase, taskId);
  if (!filename) return;
  try {
    await unlink(join(projectRoot, filename));
  } catch { /* 文件不存在,忽略 */ }
}

/** 清理 designer 可选的 design-questions.md(飞轮重跑 designer 前用) */
export async function cleanStaleDesignQuestions(
  projectRoot: string,
  taskId: string,
): Promise<void> {
  const filePath = join(projectRoot, `${taskId}-${DESIGNER_QUESTIONS_BASE}.md`);
  try {
    await unlink(filePath);
  } catch { /* 文件不存在,忽略 */ }
}

/** 收集 designer 可选的 design-questions.md 到任务目录 */
export async function collectDesignQuestions(
  projectRoot: string,
  flooDir: string,
  task: Task,
): Promise<boolean> {
  const src = join(projectRoot, `${task.id}-${DESIGNER_QUESTIONS_BASE}.md`);
  const taskDir = join(flooDir, 'batches', task.batch_id, 'tasks', task.id);
  const dest = join(taskDir, `${DESIGNER_QUESTIONS_BASE}.md`);

  try {
    await access(src);
    await mkdir(taskDir, { recursive: true });
    await copyFile(src, dest);
    try { await unlink(src); } catch { /* 清理失败不影响 */ }
    await log(flooDir, 'design-questions-collected', { task: task.id });
    return true;
  } catch {
    return false;
  }
}

/** 读 design-questions.md 判断是否含 blocker 级问题 */
export async function hasBlockerQuestions(flooDir: string, task: Task): Promise<boolean> {
  const taskDir = join(flooDir, 'batches', task.batch_id, 'tasks', task.id);
  const filePath = join(taskDir, `${DESIGNER_QUESTIONS_BASE}.md`);
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return false;
  }

  const codeBlockMatch = content.match(/```ya?ml\s*\n([\s\S]*?)```/);
  const yamlContent = codeBlockMatch ? codeBlockMatch[1] : content;

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlContent);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const questions = (parsed as Record<string, unknown>).questions;
  if (!Array.isArray(questions)) return false;

  return questions.some(q => {
    if (!q || typeof q !== 'object') return false;
    const sev = String((q as Record<string, unknown>).severity ?? '').toLowerCase();
    return sev === 'blocker';
  });
}

/** 触达 max_discuss_rounds 仍未收敛时的兜底:把 questions 当成假设写到 design.md */
export async function fallbackDesignFromQuestions(
  projectRoot: string,
  flooDir: string,
  task: Task,
): Promise<void> {
  const taskDir = join(flooDir, 'batches', task.batch_id, 'tasks', task.id);
  let questions = '';
  try {
    questions = await readFile(join(taskDir, `${DESIGNER_QUESTIONS_BASE}.md`), 'utf-8');
  } catch { /* 没有 questions 文件 */ }

  const fallback = `# 设计方案（降级产出）

## 说明

已达到最大 discuss 轮数（${MAX_DISCUSS_ROUNDS}），discuss ↔ designer 飞轮未收敛。
按现有 context.md 推进，以下 blocker 问题未解决，planner 需要谨慎处理或继续追问：

${questions}

## 方案

**警告：本设计是降级产出，未解决 blocker 级决策冲突。**
Planner 应将 open_questions 当成风险逐条评估，并在必要时终止任务要求用户介入。
`;

  const srcFilename = artifactFilename('designer', task.id);
  if (!srcFilename) return;
  await writeFile(join(projectRoot, srcFilename), fallback);
  await log(flooDir, 'design-fallback-written', { task: task.id });
}
