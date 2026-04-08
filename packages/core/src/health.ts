/**
 * Health — 系统健康检查
 * 清理孤儿 tmux session、检测卡死任务、日志轮转
 */

import { readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listBatches, listTasks } from './monitor.js';

const exec = promisify(execFile);

// ============================================================
// 类型定义
// ============================================================

/** 健康检查报告 */
export interface HealthReport {
  orphansCleaned: string[];
  staleTasks: Array<{ batchId: string; taskId: string; phase: string; staleSinceMinutes: number }>;
  logsRotated: boolean;
  checkedAt: string; // ISO 8601
}

// ============================================================
// 孤儿 session 清理
// ============================================================

/**
 * 查找并清理没有对应运行中任务的 floo- tmux session
 * tmux 服务未启动时静默返回空数组
 */
export async function cleanOrphanSessions(flooDir: string): Promise<string[]> {
  // 获取所有 floo- 开头的 tmux session
  let sessionNames: string[];
  try {
    const { stdout } = await exec('tmux', ['list-sessions', '-F', '#{session_name}']);
    sessionNames = stdout
      .trim()
      .split('\n')
      .filter(name => name.startsWith('floo-'));
  } catch {
    // tmux 服务未运行或其他错误，直接返回
    return [];
  }

  if (sessionNames.length === 0) return [];

  // 收集所有 running 状态的任务 ID，构建 session name 集合
  const runningSessionNames = new Set<string>();
  const batches = await listBatches(flooDir);
  for (const batch of batches) {
    if (batch.status !== 'active') continue;
    const tasks = await listTasks(flooDir, batch.id);
    for (const task of tasks) {
      if (task.status === 'running' && task.current_phase) {
        runningSessionNames.add(`floo-${task.id}-${task.current_phase}`);
      }
    }
  }

  // 清理没有对应运行任务的 session
  const cleaned: string[] = [];
  for (const name of sessionNames) {
    if (runningSessionNames.has(name)) continue;

    try {
      await exec('tmux', ['kill-session', '-t', name]);
      cleaned.push(name);
    } catch {
      // session 可能已经自己退出了，忽略
    }
  }

  return cleaned;
}

// ============================================================
// 卡死任务检测
// ============================================================

/**
 * 检测状态为 running 但实际已停滞的任务
 * 与 monitor.checkTimeouts 不同：此函数额外检查 tmux session 是否还活着
 */
export async function detectStaleTasks(
  flooDir: string,
  timeoutMinutes: number,
): Promise<Array<{ batchId: string; taskId: string; phase: string; staleSinceMinutes: number }>> {
  const stale: Array<{ batchId: string; taskId: string; phase: string; staleSinceMinutes: number }> = [];

  // 获取当前存活的 tmux session 列表
  const aliveSessions = new Set<string>();
  try {
    const { stdout } = await exec('tmux', ['list-sessions', '-F', '#{session_name}']);
    for (const name of stdout.trim().split('\n')) {
      if (name) aliveSessions.add(name);
    }
  } catch {
    // tmux 服务未运行，所有 running 任务都视为可能卡死
  }

  const batches = await listBatches(flooDir);
  for (const batch of batches) {
    if (batch.status !== 'active') continue;

    const tasks = await listTasks(flooDir, batch.id);
    for (const task of tasks) {
      if (task.status !== 'running' || !task.current_phase) continue;

      const sessionName = `floo-${task.id}-${task.current_phase}`;
      const updatedAt = new Date(task.updated_at).getTime();
      const minutesSinceUpdate = (Date.now() - updatedAt) / 60_000;

      // 两种情况标记为 stale：
      // 1. tmux session 已经不在了（任务状态没有正确更新）
      // 2. 超过 timeoutMinutes 没有更新
      const sessionDead = !aliveSessions.has(sessionName);
      const timedOut = minutesSinceUpdate > timeoutMinutes;

      if (sessionDead || timedOut) {
        stale.push({
          batchId: batch.id,
          taskId: task.id,
          phase: task.current_phase,
          staleSinceMinutes: Math.round(minutesSinceUpdate),
        });
      }
    }
  }

  return stale;
}

// ============================================================
// 日志轮转
// ============================================================

/** 默认最大日志大小：5MB */
const DEFAULT_MAX_SIZE_BYTES = 5 * 1024 * 1024;

/** 默认保留日志文件数量 */
const DEFAULT_MAX_FILES = 3;

/**
 * 轮转 system.log
 * 当文件超过 maxSizeBytes 时，执行 .1 → .2 → .3 的滚动重命名
 */
export async function rotateLogs(
  flooDir: string,
  maxSizeBytes: number = DEFAULT_MAX_SIZE_BYTES,
  maxFiles: number = DEFAULT_MAX_FILES,
): Promise<boolean> {
  const logPath = join(flooDir, 'logs', 'system.log');

  // 检查日志文件是否存在以及大小
  let fileSize: number;
  try {
    const fileStat = await stat(logPath);
    fileSize = fileStat.size;
  } catch {
    // 日志文件不存在，无需轮转
    return false;
  }

  if (fileSize <= maxSizeBytes) return false;

  // 删除超出保留数量的旧日志
  for (let i = maxFiles; i >= 1; i--) {
    const oldPath = i === 1 ? logPath : `${logPath}.${i - 1}`;
    const newPath = `${logPath}.${i}`;

    if (i === maxFiles) {
      // 最老的那个直接删除
      try {
        await unlink(newPath);
      } catch { /* 不存在就算了 */ }
    }

    // 依次往后挪：.2 → .3，.1 → .2，system.log → .1
    try {
      await rename(oldPath, newPath);
    } catch { /* 源文件不存在，跳过 */ }
  }

  // 创建新的空日志文件
  await writeFile(logPath, '');

  return true;
}

// ============================================================
// 综合健康检查
// ============================================================

/** 健康检查配置（可选，使用 FlooConfig.session 的子集） */
interface HealthCheckConfig {
  timeoutMinutes?: number;
  maxLogSizeBytes?: number;
  maxLogFiles?: number;
}

/**
 * 一次性运行所有健康检查，返回综合报告
 */
export async function runHealthCheck(
  flooDir: string,
  config?: HealthCheckConfig,
): Promise<HealthReport> {
  const timeoutMinutes = config?.timeoutMinutes ?? 30;

  const [orphansCleaned, staleTasks, logsRotated] = await Promise.all([
    cleanOrphanSessions(flooDir),
    detectStaleTasks(flooDir, timeoutMinutes),
    rotateLogs(flooDir, config?.maxLogSizeBytes, config?.maxLogFiles),
  ]);

  return {
    orphansCleaned,
    staleTasks,
    logsRotated,
    checkedAt: new Date().toISOString(),
  };
}
