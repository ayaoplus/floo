/**
 * 任务取消 - web 侧轻量实现
 *
 * 设计选择:不依赖 src/core/monitor.cancelTask(那个需要传入 AgentAdapter 实例),
 * 而是直接 spawn `tmux kill-session` + 改 task.json + 回滚 scope 内 unstaged 变更。
 * 与 src/core/monitor.cancelTask 行为对齐,复制了关键的 6 步:
 *   1. 读 task.json 校验状态
 *   2. tmux kill-session(忽略不存在错误)
 *   3. 写 exit artifact (exit_code=-1)
 *   4. git checkout 回滚 scope 内变更
 *   5. 更新 task.status=cancelled + updated_at
 *   6. 检查 batch 是否全部终态,更新 batch.status
 *
 * 这是有意识的"代码重复"——保持 web/lib/* 不 import src/* 的边界,部署灵活。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Task, Batch } from './types';

const exec = promisify(execFile);

/** Cancel 操作结果 */
export interface CancelResult {
  ok: boolean;
  /** 失败原因(ok=false 时) */
  reason?: string;
  /** 取消后的 task 快照(ok=true 时) */
  task?: Task;
}

/** 推断项目根目录:.floo 的父目录 */
function inferProjectRoot(flooDir: string): string {
  return resolve(flooDir, '..');
}

/**
 * 取消正在运行的任务。
 *
 * @param flooDir   .floo 目录绝对路径
 * @param batchId   批次 ID
 * @param taskId    任务 ID
 */
export async function cancelTask(
  flooDir: string,
  batchId: string,
  taskId: string,
): Promise<CancelResult> {
  const taskDir = join(flooDir, 'batches', batchId, 'tasks', taskId);
  const taskPath = join(taskDir, 'task.json');

  // 1. 读 task.json + 校验状态
  let task: Task;
  try {
    task = JSON.parse(await readFile(taskPath, 'utf-8')) as Task;
  } catch {
    return { ok: false, reason: `Task ${taskId} not found` };
  }

  if (task.status !== 'running') {
    return { ok: false, reason: `Task ${taskId} is not running (status: ${task.status})` };
  }
  if (!task.current_phase) {
    return { ok: false, reason: `Task ${taskId} has no current phase` };
  }

  const projectRoot = inferProjectRoot(flooDir);
  const sessionName = `floo-${taskId}-${task.current_phase}`;

  // 2. tmux kill-session(忽略不存在错误)
  try {
    await exec('tmux', ['kill-session', '-t', sessionName]);
  } catch { /* session 可能已经退出,继续往下 */ }

  // 3. 写 exit artifact
  const signalsDir = join(flooDir, 'signals');
  await mkdir(signalsDir, { recursive: true });
  const exitArtifact = {
    task_id: taskId,
    phase: task.current_phase,
    session_name: sessionName,
    exit_code: -1,
    finished_at: new Date().toISOString(),
    duration_seconds: -1,
    files_changed: [],
  };
  await writeFile(
    join(signalsDir, `${taskId}-${task.current_phase}.exit`),
    JSON.stringify(exitArtifact, null, 2),
  );

  // 4. 回滚 scope 内 unstaged 变更
  if (task.scope.length > 0) {
    try {
      await exec('git', ['checkout', '--', ...task.scope], { cwd: projectRoot });
    } catch { /* 可能没有需要回滚的变更 */ }
  }

  // 5. 更新 task 状态
  task.status = 'cancelled';
  task.updated_at = new Date().toISOString();
  await writeFile(taskPath, JSON.stringify(task, null, 2));

  // 6. 若 batch 内所有 task 都终态,更新 batch 状态
  const batchDir = join(flooDir, 'batches', batchId);
  try {
    const batch: Batch = JSON.parse(await readFile(join(batchDir, 'batch.json'), 'utf-8'));
    const allTaskFiles = batch.tasks ?? [taskId];
    let allDone = true;
    for (const tid of allTaskFiles) {
      try {
        const t: Task = JSON.parse(await readFile(join(batchDir, 'tasks', tid, 'task.json'), 'utf-8'));
        if (t.status !== 'completed' && t.status !== 'cancelled' && t.status !== 'failed') {
          allDone = false;
          break;
        }
      } catch {
        allDone = false;
        break;
      }
    }
    if (allDone) {
      batch.status = 'cancelled';
      batch.updated_at = new Date().toISOString();
      await writeFile(join(batchDir, 'batch.json'), JSON.stringify(batch, null, 2));
    }
  } catch { /* batch 文件读不到也不阻塞 cancel */ }

  return { ok: true, task };
}
