/**
 * Planner 输出解析与子任务生成
 *
 * Planner 在项目根目录写 plan.md(YAML in Markdown);
 * 这里负责把它解析成 Task[] 落到 .floo/batches/<id>/tasks/。
 */

import { readFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { Batch, Task } from '../types.js';
import { log, saveBatch, saveTask, toStringArray } from './io.js';

/** 解析后的子任务定义 */
export interface ParsedTask {
  id: string;
  description: string;
  scope: string[];
  acceptance_criteria: string[];
  review_level: 'full' | 'scan' | 'skip';
  depends_on: string[];
}

/**
 * 解析 plan.md 中的 YAML 拆出多个子任务。
 * 支持两种结构:
 *   1. 多任务: { tasks: [...] } 或顶层数组
 *   2. 单任务: { scope: [...], acceptance_criteria: [...] }
 */
export function parsePlanTasks(content: string): ParsedTask[] {
  // 优先吃 ```yaml ... ``` 代码块
  const codeBlockMatch = content.match(/```ya?ml\s*\n([\s\S]*?)```/);
  const yamlContent = codeBlockMatch ? codeBlockMatch[1] : content;

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlContent);
  } catch {
    return [{
      id: 'fallback', description: '', scope: [], acceptance_criteria: [],
      review_level: 'full', depends_on: [],
    }];
  }

  // 支持 { tasks: [...] } 或直接 [...]
  let rawTasks: unknown[];
  if (parsed && typeof parsed === 'object' && 'tasks' in parsed && Array.isArray((parsed as Record<string, unknown>).tasks)) {
    rawTasks = (parsed as Record<string, unknown>).tasks as unknown[];
  } else if (Array.isArray(parsed)) {
    rawTasks = parsed;
  } else if (parsed && typeof parsed === 'object') {
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
 * Planner 完成后,解析 plan.md 创建/更新子任务。
 * 单任务:更新原 task 的 scope/criteria/review_level
 * 多任务:为每个子任务创建 Task 对象 + 复制 design/plan.md 到子目录
 */
export async function consumePlannerOutput(
  flooDir: string,
  batch: Batch,
  parentTask: Task,
): Promise<Task[]> {
  const taskDir = join(flooDir, 'batches', batch.id, 'tasks', parentTask.id);
  let content: string;
  try {
    content = await readFile(join(taskDir, 'plan.md'), 'utf-8');
  } catch {
    return [parentTask];
  }

  const parsed = parsePlanTasks(content);

  if (parsed.length <= 1) {
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

  // 多任务:为每个子任务创建独立 Task
  const now = new Date().toISOString();
  const tasks: Task[] = [];
  // 父任务 ID 形如 "{batchToken}-001",保留 batchToken 给子任务用
  const batchToken = parentTask.id.replace(/-\d+$/, '');

  // planner 原 ID → 新 ID 映射,用于重写 depends_on
  const idMap = new Map<string, string>();
  for (let i = 0; i < parsed.length; i++) {
    const newId = `${batchToken}-${String(i + 1).padStart(3, '0')}`;
    idMap.set(parsed[i].id, newId);
  }

  const parentTaskDir = join(flooDir, 'batches', batch.id, 'tasks', parentTask.id);

  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    const subTaskId = idMap.get(p.id)!;
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

    // 父任务的 design/plan.md 复制给子任务,确保 coder 拿到上下文
    const subTaskDir = join(flooDir, 'batches', batch.id, 'tasks', task.id);
    for (const artifact of ['design.md', 'plan.md']) {
      try {
        await copyFile(join(parentTaskDir, artifact), join(subTaskDir, artifact));
      } catch { /* artifact 可能不存在 */ }
    }
    tasks.push(task);
  }

  batch.tasks = tasks.map(t => t.id);
  await saveBatch(flooDir, batch);

  await log(flooDir, 'plan-consumed', {
    task: parentTask.id,
    sub_tasks: tasks.length,
    task_ids: tasks.map(t => t.id),
  });
  return tasks;
}
