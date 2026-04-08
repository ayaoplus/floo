/**
 * Health — 系统健康检查
 * 清理孤儿 tmux session、检测卡死任务、日志轮转
 */

import { writeFile, readdir, rename, unlink, stat } from 'node:fs/promises';
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
 * 查找并清理当前项目中已结束但 tmux session 仍存活的孤儿 session
 *
 * 判断依据完全基于本地 .floo/signals/ 文件，不做全局 tmux session name 匹配：
 * - 有 .exit 文件 = 当前项目的 agent 已结束 → session 是残留的，可清理
 * - 无 .exit 文件 = 不确定是否属于当前项目 → 不碰
 * 这样即使另一个项目有同名 session（如 floo-task-001-coder），也不会被误杀
 */
export async function cleanOrphanSessions(flooDir: string): Promise<string[]> {
  // 从 .floo/signals/ 提取已结束的 {taskId}-{phase} 对
  const signalsDir = join(flooDir, 'signals');
  let exitFiles: string[];
  try {
    const entries = await readdir(signalsDir);
    exitFiles = entries.filter(f => f.endsWith('.exit'));
  } catch {
    return []; // signals 目录不存在
  }

  // 排除仍在 running 的任务（有 exit 文件但任务可能在重试中）
  const runningSessions = new Set<string>();
  const batches = await listBatches(flooDir);
  for (const batch of batches) {
    const tasks = await listTasks(flooDir, batch.id);
    for (const task of tasks) {
      if (task.status === 'running' && task.current_phase) {
        runningSessions.add(`floo-${task.id}-${task.current_phase}`);
      }
    }
  }

  // 候选：有 exit 文件（确认属于当前项目）且不在 running 中
  const candidates: string[] = [];
  for (const file of exitFiles) {
    // exit 文件名格式：{taskId}-{phase}.exit → session 名：floo-{taskId}-{phase}
    const base = file.replace(/\.exit$/, '');
    const sessionName = `floo-${base}`;
    if (!runningSessions.has(sessionName)) {
      candidates.push(sessionName);
    }
  }

  if (candidates.length === 0) return [];

  // 逐个检查并清理（只碰有 exit 证据的 session）
  const cleaned: string[] = [];
  for (const name of candidates) {
    try {
      await exec('tmux', ['has-session', '-t', name]);
      // session 存在，清理它
      await exec('tmux', ['kill-session', '-t', name]);
      cleaned.push(name);
    } catch { /* session 不存在，无需处理 */ }
  }

  return cleaned;
}

// ============================================================
// 卡死任务检测
// ============================================================

/**
 * 检测状态为 running 但实际已停滞的任务
 *
 * 判断依据：
 * 1. 有 .exit 信号文件 → agent 已结束但状态未更新 → 确定 stale
 * 2. 超过 timeoutMinutes 没有 heartbeat 更新 → 可能 stale
 *
 * 不使用全局 tmux session 列表判断存活（避免跨项目同名 session 误判）
 */
export async function detectStaleTasks(
  flooDir: string,
  timeoutMinutes: number,
): Promise<Array<{ batchId: string; taskId: string; phase: string; staleSinceMinutes: number }>> {
  const stale: Array<{ batchId: string; taskId: string; phase: string; staleSinceMinutes: number }> = [];
  const signalsDir = join(flooDir, 'signals');

  const batches = await listBatches(flooDir);
  for (const batch of batches) {
    if (batch.status !== 'active') continue;

    const tasks = await listTasks(flooDir, batch.id);
    for (const task of tasks) {
      if (task.status !== 'running' || !task.current_phase) continue;

      const updatedAt = new Date(task.updated_at).getTime();
      const minutesSinceUpdate = (Date.now() - updatedAt) / 60_000;

      // 检查 .exit 信号文件是否存在（本地文件，不会跨项目碰撞）
      let hasExitFile = false;
      try {
        await stat(join(signalsDir, `${task.id}-${task.current_phase}.exit`));
        hasExitFile = true;
      } catch { /* 文件不存在 */ }

      // 有 exit 文件说明 agent 确实结束了；超时说明可能卡死
      if (hasExitFile || minutesSinceUpdate > timeoutMinutes) {
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
