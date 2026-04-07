/**
 * Monitor — 任务监控
 * 提供任务状态查询、超时检测、任务取消等功能
 * 与 dispatcher 紧耦合，共享 .floo/ 数据结构
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task, Batch, RunRecord } from './types.js';
import type { AgentAdapter } from './types.js';

// ============================================================
// 状态查询
// ============================================================

/** 读取指定批次信息 */
export async function getBatch(flooDir: string, batchId: string): Promise<Batch> {
  const filePath = join(flooDir, 'batches', batchId, 'batch.json');
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as Batch;
}

/** 读取指定任务信息 */
export async function getTask(flooDir: string, batchId: string, taskId: string): Promise<Task> {
  const filePath = join(flooDir, 'batches', batchId, 'tasks', taskId, 'task.json');
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as Task;
}

/** 列出所有批次 */
export async function listBatches(flooDir: string): Promise<Batch[]> {
  const batchesDir = join(flooDir, 'batches');
  try {
    const entries = await readdir(batchesDir, { withFileTypes: true });
    const batches: Batch[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        try {
          const batch = await getBatch(flooDir, entry.name);
          batches.push(batch);
        } catch { /* 跳过损坏的批次 */ }
      }
    }
    // 按创建时间倒序
    return batches.sort((a, b) => b.created_at.localeCompare(a.created_at));
  } catch {
    return [];
  }
}

/** 列出批次下所有任务 */
export async function listTasks(flooDir: string, batchId: string): Promise<Task[]> {
  const tasksDir = join(flooDir, 'batches', batchId, 'tasks');
  try {
    const entries = await readdir(tasksDir, { withFileTypes: true });
    const tasks: Task[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        try {
          const task = await getTask(flooDir, batchId, entry.name);
          tasks.push(task);
        } catch { /* 跳过损坏的任务 */ }
      }
    }
    return tasks;
  } catch {
    return [];
  }
}

/** 列出任务的所有 run 记录 */
export async function listRuns(flooDir: string, batchId: string, taskId: string): Promise<RunRecord[]> {
  const runsDir = join(flooDir, 'batches', batchId, 'tasks', taskId, 'runs');
  try {
    const entries = await readdir(runsDir);
    const runs: RunRecord[] = [];
    for (const entry of entries) {
      if (entry.endsWith('.json')) {
        const content = await readFile(join(runsDir, entry), 'utf-8');
        runs.push(JSON.parse(content) as RunRecord);
      }
    }
    // 按 id 排序（001-designer, 002-coder, ...）
    return runs.sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

// ============================================================
// 任务取消
// ============================================================

/**
 * 取消正在运行的任务
 * kill tmux session → 回滚 scope 内 unstaged changes → 更新状态
 */
export async function cancelTask(
  flooDir: string,
  batchId: string,
  taskId: string,
  adapter: AgentAdapter,
  projectRoot: string,
): Promise<Task> {
  const task = await getTask(flooDir, batchId, taskId);

  if (task.status !== 'running') {
    throw new Error(`Task ${taskId} is not running (status: ${task.status})`);
  }

  if (!task.current_phase) {
    throw new Error(`Task ${taskId} has no current phase`);
  }

  const sessionName = `floo-${taskId}-${task.current_phase}`;

  // kill session（会自动写 exit artifact，exit_code = -1）
  await adapter.kill(sessionName, projectRoot, taskId, task.current_phase);

  // 回滚 scope 内的 unstaged changes
  if (task.scope.length > 0) {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const exec = promisify(execFile);
      await exec('git', ['checkout', '--', ...task.scope], { cwd: projectRoot });
    } catch { /* 可能没有需要回滚的变更 */ }
  }

  // 更新 task 状态
  task.status = 'cancelled';
  task.updated_at = new Date().toISOString();
  const taskDir = join(flooDir, 'batches', batchId, 'tasks', taskId);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(taskDir, 'task.json'), JSON.stringify(task, null, 2));

  // 检查是否所有任务都已结束，更新 batch 状态
  const tasks = await listTasks(flooDir, batchId);
  const allDone = tasks.every(t => t.status === 'completed' || t.status === 'cancelled' || t.status === 'failed');
  if (allDone) {
    const batch = await getBatch(flooDir, batchId);
    batch.status = 'cancelled';
    batch.updated_at = new Date().toISOString();
    await writeFile(join(flooDir, 'batches', batchId, 'batch.json'), JSON.stringify(batch, null, 2));
  }

  return task;
}

// ============================================================
// 超时检测
// ============================================================

/**
 * 检查是否有超时的任务
 * 返回超时的 session 列表
 */
export async function checkTimeouts(
  flooDir: string,
  timeoutMinutes: number,
): Promise<Array<{ batchId: string; taskId: string; phase: string; runningMinutes: number }>> {
  const timedOut: Array<{ batchId: string; taskId: string; phase: string; runningMinutes: number }> = [];
  const batches = await listBatches(flooDir);

  for (const batch of batches) {
    if (batch.status !== 'active') continue;

    const tasks = await listTasks(flooDir, batch.id);
    for (const task of tasks) {
      if (task.status !== 'running' || !task.current_phase) continue;

      // 计算运行时间
      const updatedAt = new Date(task.updated_at).getTime();
      const now = Date.now();
      const runningMinutes = (now - updatedAt) / 60_000;

      if (runningMinutes > timeoutMinutes) {
        timedOut.push({
          batchId: batch.id,
          taskId: task.id,
          phase: task.current_phase,
          runningMinutes: Math.round(runningMinutes),
        });
      }
    }
  }

  return timedOut;
}

// ============================================================
// 状态概览
// ============================================================

/** 格式化的状态概览，给 `floo status` 用 */
export async function getStatusSummary(flooDir: string): Promise<string> {
  const batches = await listBatches(flooDir);
  if (batches.length === 0) {
    return '没有活跃的批次。';
  }

  const lines: string[] = [];

  for (const batch of batches) {
    lines.push(`批次: ${batch.id} [${batch.status}]`);
    lines.push(`  描述: ${batch.description}`);

    const tasks = await listTasks(flooDir, batch.id);
    for (const task of tasks) {
      const phase = task.current_phase ? ` @ ${task.current_phase}` : '';
      lines.push(`  任务: ${task.id} [${task.status}${phase}]`);
      lines.push(`    ${task.description}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
