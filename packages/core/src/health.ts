/**
 * Health — 系统健康检查
 * 清理孤儿 tmux session、检测卡死任务、日志轮转
 */

import { writeFile, rename, unlink, stat } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
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
 * 安全策略：通过 tmux 查询 session 的工作目录来确认归属。
 * 只杀"工作目录是当前项目 + 任务不在 running"的 session，
 * 绝不碰其他项目碰巧同名的 session。
 */
export async function cleanOrphanSessions(flooDir: string): Promise<string[]> {
  // flooDir 应该是 {projectRoot}/.floo，用 resolve 获取绝对路径后取父目录
  const resolved = resolve(flooDir);
  if (basename(resolved) !== '.floo') {
    return []; // flooDir 格式不符合预期，安全退出
  }
  const projectRoot = resolve(resolved, '..');

  // 收集当前项目仍在 running 的 session name
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

  // 获取所有 floo- 开头的存活 tmux session
  let sessionNames: string[];
  try {
    const { stdout } = await exec('tmux', ['list-sessions', '-F', '#{session_name}']);
    sessionNames = stdout.trim().split('\n').filter(n => n.startsWith('floo-'));
  } catch {
    return []; // tmux 服务未运行
  }

  // 逐个检查：确认属于当前项目（工作目录匹配）且不在 running
  const cleaned: string[] = [];
  for (const name of sessionNames) {
    if (runningSessions.has(name)) continue; // 仍在运行，不碰

    // 用 tmux 查询 session 的工作目录，确认属于当前项目
    try {
      const { stdout: paneCwd } = await exec('tmux', [
        'display-message', '-p', '-t', name, '#{pane_current_path}',
      ]);
      const sessionCwd = paneCwd.trim();

      // 解析为绝对路径后比较（避免尾部 / 差异）
      const { resolve } = await import('node:path');
      if (resolve(sessionCwd) !== resolve(projectRoot)) continue; // 不属于当前项目

      await exec('tmux', ['kill-session', '-t', name]);
      cleaned.push(name);
    } catch { /* session 查询失败或已退出 */ }
  }

  return cleaned;
}

// ============================================================
// 卡死任务检测
// ============================================================

/**
 * 检测状态为 running 但实际已停滞的任务
 *
 * 纯粹基于 updated_at 超时判断——dispatcher 的 heartbeat 每 5 分钟刷新
 * updated_at，超过 timeoutMinutes 无更新即视为 stale。
 *
 * 不使用 tmux session 列表或 .exit 文件（两者都有跨项目/跨 batch 碰撞问题）
 */
export async function detectStaleTasks(
  flooDir: string,
  timeoutMinutes: number,
): Promise<Array<{ batchId: string; taskId: string; phase: string; staleSinceMinutes: number }>> {
  const stale: Array<{ batchId: string; taskId: string; phase: string; staleSinceMinutes: number }> = [];

  const batches = await listBatches(flooDir);
  for (const batch of batches) {
    if (batch.status !== 'active') continue;

    const tasks = await listTasks(flooDir, batch.id);
    for (const task of tasks) {
      if (task.status !== 'running' || !task.current_phase) continue;

      const updatedAt = new Date(task.updated_at).getTime();
      const minutesSinceUpdate = (Date.now() - updatedAt) / 60_000;

      if (minutesSinceUpdate > timeoutMinutes) {
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
