/**
 * Scope 冲突检测 + Commit 锁
 * 确保并行任务不会修改同一文件，序列化 git commit 操作
 */

import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScopeConflict, CommitLock } from './types.js';

// ============================================================
// Scope 冲突检测
// ============================================================

/**
 * 判断两个 scope 是否有交集
 * scope 项可以是文件路径或目录路径（以 / 结尾表示目录前缀匹配）
 */
export function scopesOverlap(scopeA: string[], scopeB: string[]): string[] {
  // 空 scope = 未指定约束，可能改任何文件 → 和任何任务都视为冲突（强制串行）
  if (scopeA.length === 0 || scopeB.length === 0) {
    return ['(empty scope)'];
  }

  const overlapping: string[] = [];

  for (const a of scopeA) {
    for (const b of scopeB) {
      if (pathsConflict(a, b)) {
        overlapping.push(`${a} ↔ ${b}`);
      }
    }
  }

  return overlapping;
}

/**
 * 两个路径是否冲突
 * - 完全相同 → 冲突
 * - 一个是另一个的父目录 → 冲突（如 src/api/ 和 src/api/health.ts）
 */
function pathsConflict(a: string, b: string): boolean {
  // 归一化：去掉尾部斜杠再比较
  const na = a.replace(/\/+$/, '');
  const nb = b.replace(/\/+$/, '');

  if (na === nb) return true;
  // a 是 b 的父目录，或反过来
  if (nb.startsWith(na + '/')) return true;
  if (na.startsWith(nb + '/')) return true;

  return false;
}

/**
 * 检查一组任务的 scope 冲突
 * 返回所有冲突对
 */
export function detectConflicts(
  tasks: Array<{ id: string; scope: string[] }>,
): ScopeConflict[] {
  const conflicts: ScopeConflict[] = [];

  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const overlap = scopesOverlap(tasks[i].scope, tasks[j].scope);
      if (overlap.length > 0) {
        conflicts.push({
          task_a: tasks[i].id,
          task_b: tasks[j].id,
          overlapping_files: overlap,
        });
      }
    }
  }

  return conflicts;
}

/**
 * 检查文件列表是否越界（超出允许的 scope）
 * 返回越界的文件列表
 */
export function findOutOfScope(filesChanged: string[], allowedScope: string[]): string[] {
  return filesChanged.filter(file => {
    // 文件必须被至少一个 scope 项覆盖
    return !allowedScope.some(s => pathsConflict(file, s));
  });
}

// ============================================================
// Commit 锁（Node.js 文件锁实现）
// 注意：dispatcher 当前不使用此锁，实际的 git 写操作序列化由
// runner 脚本中的 mkdir 目录锁（.floo/.git-lock）完成。
// 此 API 保留供外部消费者和测试使用。
// ============================================================

const LOCK_FILE = 'commit.lock';

/** 等待重试的默认配置 */
const LOCK_RETRY_INTERVAL_MS = 1000;  // 每次重试间隔 1 秒
const LOCK_MAX_WAIT_MS = 300_000;     // 最多等待 5 分钟

/**
 * 获取 commit 锁（带等待重试）
 * 使用 wx flag（exclusive create）保证原子性
 * 锁被占用时会等待重试，而不是直接抛错
 * @param maxWaitMs 最大等待时间，0 表示不等待（立刻抛错），默认 5 分钟
 */
export async function acquireCommitLock(
  flooDir: string,
  taskId: string,
  sessionName: string,
  maxWaitMs: number = LOCK_MAX_WAIT_MS,
): Promise<void> {
  const lockPath = join(flooDir, LOCK_FILE);
  const deadline = Date.now() + maxWaitMs;

  while (true) {
    const lock: CommitLock = {
      task_id: taskId,
      session_name: sessionName,
      acquired_at: new Date().toISOString(),
      pid: process.pid,
    };

    try {
      // wx = write + exclusive：文件存在则报 EEXIST
      await writeFile(lockPath, JSON.stringify(lock, null, 2), { flag: 'wx' });
      return; // 获取成功
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST') {
        // 锁已被占用，检查是否过期（持有者进程已不在）
        const stale = await isLockStale(lockPath);
        if (stale) {
          await unlink(lockPath);
          continue; // 清理后立即重试
        }

        // 锁有效，检查是否超时
        if (Date.now() >= deadline) {
          throw new Error(`Commit lock held by task ${await getLockHolder(lockPath)}${maxWaitMs > 0 ? ` (waited ${maxWaitMs / 1000}s)` : ''}`);
        }

        // 等待后重试
        await new Promise(r => setTimeout(r, LOCK_RETRY_INTERVAL_MS));
        continue;
      }
      throw err;
    }
  }
}

/** 释放 commit 锁（必须验证持有者身份，防止误删其他任务的锁） */
export async function releaseCommitLock(flooDir: string, taskId: string): Promise<void> {
  const lockPath = join(flooDir, LOCK_FILE);
  try {
    // 验证锁的持有者是否是当前任务
    const content = await readFile(lockPath, 'utf-8');
    const lock = JSON.parse(content) as CommitLock;
    if (lock.task_id !== taskId) {
      throw new Error(`Cannot release lock: held by task ${lock.task_id}, not ${taskId}`);
    }
    await unlink(lockPath);
  } catch (err: unknown) {
    // 锁文件不存在也没关系（可能已被清理）
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw err;
  }
}

/** 检查锁文件是否过期（持有者进程已退出） */
async function isLockStale(lockPath: string): Promise<boolean> {
  try {
    const content = await readFile(lockPath, 'utf-8');
    const lock = JSON.parse(content) as CommitLock;

    // 检查 PID 是否还活着
    try {
      process.kill(lock.pid, 0); // signal 0 不杀进程，只检查是否存在
      return false; // 进程还在，锁有效
    } catch {
      return true; // 进程不在了，锁过期
    }
  } catch {
    // 锁文件读取失败，认为过期
    return true;
  }
}

/** 读取锁持有者的 task_id */
async function getLockHolder(lockPath: string): Promise<string> {
  try {
    const content = await readFile(lockPath, 'utf-8');
    const lock = JSON.parse(content) as CommitLock;
    return lock.task_id;
  } catch {
    return 'unknown';
  }
}

/**
 * 确保 .floo 目录结构存在
 * init 命令和各模块启动时调用
 */
export async function ensureFlooDir(projectRoot: string): Promise<string> {
  const flooDir = join(projectRoot, '.floo');
  const dirs = [
    flooDir,
    join(flooDir, 'batches'),
    join(flooDir, 'sessions'),
    join(flooDir, 'signals'),
    join(flooDir, 'notifications'),
    join(flooDir, 'lessons'),
    join(flooDir, 'context'),
    join(flooDir, 'logs'),
  ];

  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }

  return flooDir;
}
