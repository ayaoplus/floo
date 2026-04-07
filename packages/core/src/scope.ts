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
// Commit 锁（文件锁实现）
// ============================================================

const LOCK_FILE = 'commit.lock';

/**
 * 获取 commit 锁
 * 使用 wx flag（exclusive create）保证原子性：文件已存在则抛错
 */
export async function acquireCommitLock(
  flooDir: string,
  taskId: string,
  sessionName: string,
): Promise<void> {
  const lockPath = join(flooDir, LOCK_FILE);

  const lock: CommitLock = {
    task_id: taskId,
    session_name: sessionName,
    acquired_at: new Date().toISOString(),
    pid: process.pid,
  };

  try {
    // wx = write + exclusive：文件存在则报 EEXIST
    await writeFile(lockPath, JSON.stringify(lock, null, 2), { flag: 'wx' });
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST') {
      // 锁已被占用，检查是否是死锁（持有者进程已经不在了）
      const stale = await isLockStale(lockPath);
      if (stale) {
        // 死锁清理：删除旧锁，重新获取
        await unlink(lockPath);
        await writeFile(lockPath, JSON.stringify(lock, null, 2), { flag: 'wx' });
        return;
      }
      throw new Error(`Commit lock held by task ${await getLockHolder(lockPath)}`);
    }
    throw err;
  }
}

/** 释放 commit 锁 */
export async function releaseCommitLock(flooDir: string): Promise<void> {
  const lockPath = join(flooDir, LOCK_FILE);
  try {
    await unlink(lockPath);
  } catch (err: unknown) {
    // 锁文件不存在也没关系（可能已被清理）
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
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
