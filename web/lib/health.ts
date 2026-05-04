/**
 * Web UI 用的轻量健康检查 — 只读
 *
 * 跟 src/core/health.ts 的区别:
 *   - core/health 会 kill orphan tmux session + 轮转日志(有副作用,适合 CLI 调用)
 *   - 这里只读 task.json 计算 stale,不动任何外部资源
 *
 * 数据源:listAllTasks() 已经读过 task.json,这里复用,避免重复 IO。
 */

import type { Task } from './types';

/** 单条 stale 记录 */
export interface StaleTaskInfo {
  batchId: string;
  taskId: string;
  phase: string;
  description: string;
  staleSinceMinutes: number;
}

/** 健康摘要 */
export interface HealthSummary {
  /** 超过 timeout 仍在 running 的 task 列表(按陈旧时间倒序) */
  staleTasks: StaleTaskInfo[];
  /** running 中但 current_phase 缺失的任务(状态机异常) */
  inconsistentTasks: Array<{ batchId: string; taskId: string; description: string }>;
  /** 整体健康度:'ok' / 'warning' / 'critical' */
  level: 'ok' | 'warning' | 'critical';
  /** 检查时间 */
  checkedAt: string;
}

/**
 * 默认 stale 阈值(分钟):跟 core/health 默认值对齐
 *   - timeoutMinutes 30 = 任务半小时没心跳就视为 stale
 */
const DEFAULT_TIMEOUT_MINUTES = 30;

/**
 * 从 task 列表派生 health summary。
 *
 * level 判定:
 *   - critical:有 inconsistent 任务,或 staleSinceMinutes > 60 的任务
 *   - warning:有 stale 任务但都在 30~60 分钟之间
 *   - ok:无 stale 也无 inconsistent
 */
export function deriveHealth(allTasks: Task[], timeoutMinutes: number = DEFAULT_TIMEOUT_MINUTES): HealthSummary {
  const now = Date.now();
  const stale: StaleTaskInfo[] = [];
  const inconsistent: Array<{ batchId: string; taskId: string; description: string }> = [];

  for (const task of allTasks) {
    if (task.status !== 'running') continue;

    if (!task.current_phase) {
      // running 但没 current_phase:状态机崩了/迁移不一致
      inconsistent.push({ batchId: task.batch_id, taskId: task.id, description: task.description });
      continue;
    }

    const updatedAt = new Date(task.updated_at).getTime();
    const minutesSinceUpdate = (now - updatedAt) / 60_000;
    if (minutesSinceUpdate > timeoutMinutes) {
      stale.push({
        batchId: task.batch_id,
        taskId: task.id,
        phase: task.current_phase,
        description: task.description,
        staleSinceMinutes: Math.round(minutesSinceUpdate),
      });
    }
  }

  stale.sort((a, b) => b.staleSinceMinutes - a.staleSinceMinutes);

  const level: HealthSummary['level'] =
    inconsistent.length > 0 || stale.some(s => s.staleSinceMinutes > 60)
      ? 'critical'
      : stale.length > 0
        ? 'warning'
        : 'ok';

  return {
    staleTasks: stale,
    inconsistentTasks: inconsistent,
    level,
    checkedAt: new Date().toISOString(),
  };
}
