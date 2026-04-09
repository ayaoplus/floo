/**
 * Floo 数据访问层
 * 直接读取 .floo/ 目录的 JSON 文件，供 Server Components 和 API Routes 使用
 */

import { readFile, readdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Batch, Task, RunRecord, SessionInfo, Notification } from './types';

/** 获取 .floo 目录路径（优先用环境变量，默认 ../..floo） */
function getFlooDir(): string {
  return process.env.FLOO_DIR || resolve(process.cwd(), '..', '.floo');
}

/** 检查路径是否存在 */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 安全读取 JSON 文件，失败返回 null */
async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/** 读取指定批次 */
export async function getBatch(batchId: string): Promise<Batch | null> {
  const filePath = join(getFlooDir(), 'batches', batchId, 'batch.json');
  return readJson<Batch>(filePath);
}

/** 列出所有批次，按创建时间倒序 */
export async function listBatches(): Promise<Batch[]> {
  const batchesDir = join(getFlooDir(), 'batches');
  if (!(await exists(batchesDir))) return [];

  try {
    const entries = await readdir(batchesDir, { withFileTypes: true });
    const batches: Batch[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const batch = await readJson<Batch>(join(batchesDir, entry.name, 'batch.json'));
        if (batch) batches.push(batch);
      }
    }
    return batches.sort((a, b) => b.created_at.localeCompare(a.created_at));
  } catch {
    return [];
  }
}

/** 列出批次下所有任务 */
export async function listTasks(batchId: string): Promise<Task[]> {
  const tasksDir = join(getFlooDir(), 'batches', batchId, 'tasks');
  if (!(await exists(tasksDir))) return [];

  try {
    const entries = await readdir(tasksDir, { withFileTypes: true });
    const tasks: Task[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const task = await readJson<Task>(join(tasksDir, entry.name, 'task.json'));
        if (task) tasks.push(task);
      }
    }
    return tasks;
  } catch {
    return [];
  }
}

/** 列出所有批次的所有任务 */
export async function listAllTasks(): Promise<Task[]> {
  const batches = await listBatches();
  const allTasks: Task[] = [];
  for (const batch of batches) {
    const tasks = await listTasks(batch.id);
    allTasks.push(...tasks);
  }
  return allTasks;
}

/** 读取指定任务 */
export async function getTask(batchId: string, taskId: string): Promise<Task | null> {
  const filePath = join(getFlooDir(), 'batches', batchId, 'tasks', taskId, 'task.json');
  return readJson<Task>(filePath);
}

/** 列出任务的 run 记录 */
export async function listRuns(batchId: string, taskId: string): Promise<RunRecord[]> {
  const runsDir = join(getFlooDir(), 'batches', batchId, 'tasks', taskId, 'runs');
  if (!(await exists(runsDir))) return [];

  try {
    const entries = await readdir(runsDir);
    const runs: RunRecord[] = [];
    for (const entry of entries) {
      if (entry.endsWith('.json')) {
        const run = await readJson<RunRecord>(join(runsDir, entry));
        if (run) runs.push(run);
      }
    }
    return runs.sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

/** 读取任务的 artifact 文件内容（design.md, plan.md, review.md, test-report.md） */
export async function readArtifact(batchId: string, taskId: string, filename: string): Promise<string | null> {
  const filePath = join(getFlooDir(), 'batches', batchId, 'tasks', taskId, filename);
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** 列出所有 tmux session 信息 */
export async function listSessions(): Promise<SessionInfo[]> {
  const sessionsDir = join(getFlooDir(), 'sessions');
  if (!(await exists(sessionsDir))) return [];

  try {
    const entries = await readdir(sessionsDir);
    const sessions: SessionInfo[] = [];
    for (const entry of entries) {
      if (entry.endsWith('.json')) {
        const session = await readJson<SessionInfo>(join(sessionsDir, entry));
        if (session) sessions.push(session);
      }
    }
    return sessions;
  } catch {
    return [];
  }
}

/** 列出任务的通知事件（按时间正序） */
export async function listTaskNotifications(taskId: string): Promise<Notification[]> {
  const notifDir = join(getFlooDir(), 'notifications');
  if (!(await exists(notifDir))) return [];

  try {
    const entries = await readdir(notifDir);
    const jsonFiles = entries.filter(f => f.endsWith('.json')).sort();
    const notifications: Notification[] = [];

    for (const file of jsonFiles) {
      const notif = await readJson<Notification>(join(notifDir, file));
      if (notif && notif.task_id === taskId) {
        notifications.push(notif);
      }
    }
    return notifications;
  } catch {
    return [];
  }
}

/** 读取某个 run 的 session 输出日志 */
export async function readRunLog(batchId: string, taskId: string, runId: string): Promise<string | null> {
  const filePath = join(getFlooDir(), 'batches', batchId, 'tasks', taskId, 'logs', `${runId}.log`);
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** 列出任务下所有可用的 run log 文件名 */
export async function listRunLogs(batchId: string, taskId: string): Promise<string[]> {
  const logsDir = join(getFlooDir(), 'batches', batchId, 'tasks', taskId, 'logs');
  if (!(await exists(logsDir))) return [];

  try {
    const entries = await readdir(logsDir);
    return entries.filter(f => f.endsWith('.log')).sort();
  } catch {
    return [];
  }
}

/** 获取系统级统计数据 */
export async function getStats(): Promise<{
  totalBatches: number;
  activeBatches: number;
  totalTasks: number;
  runningTasks: number;
  completedTasks: number;
  failedTasks: number;
  activeSessions: number;
}> {
  const batches = await listBatches();
  const allTasks = await listAllTasks();
  const sessions = await listSessions();

  return {
    totalBatches: batches.length,
    activeBatches: batches.filter(b => b.status === 'active').length,
    totalTasks: allTasks.length,
    runningTasks: allTasks.filter(t => t.status === 'running').length,
    completedTasks: allTasks.filter(t => t.status === 'completed').length,
    failedTasks: allTasks.filter(t => t.status === 'failed').length,
    activeSessions: sessions.filter(s => s.alive).length,
  };
}
