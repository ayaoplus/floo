/**
 * Web UI 共享类型
 * 从 src/core/types.ts 精简而来，仅包含 UI 展示需要的类型
 */

/** 任务执行阶段 */
export type Phase = 'designer' | 'planner' | 'coder' | 'reviewer' | 'tester';

/** Agent 运行时 */
export type Runtime = 'claude' | 'codex';

/** 任务状态 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** 批次状态 */
export type BatchStatus = 'active' | 'completed' | 'failed' | 'cancelled';

/** 单个任务 */
export interface Task {
  id: string;
  batch_id: string;
  description: string;
  status: TaskStatus;
  current_phase: Phase | null;
  scope: string[];
  acceptance_criteria: string[];
  review_level: 'full' | 'scan' | 'skip';
  created_at: string;
  updated_at: string;
  depends_on: string[];
}

/** 批次 */
export interface Batch {
  id: string;
  description: string;
  status: BatchStatus;
  tasks: string[];
  created_at: string;
  updated_at: string;
}

/** 单次 agent 执行记录 */
export interface RunRecord {
  id: string;
  task_id: string;
  phase: Phase;
  runtime: Runtime;
  model: string;
  session_name: string;
  attempt: number;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  duration_seconds: number | null;
}

/** tmux session 信息 */
export interface SessionInfo {
  name: string;
  task_id: string;
  phase: Phase;
  alive: boolean;
  started_at: string;
  last_activity: string | null;
}

/** 通知事件类型 */
export type NotificationEvent =
  | 'task_started'
  | 'phase_started'
  | 'phase_completed'
  | 'review_concluded'
  | 'task_completed'
  | 'batch_progress'
  | 'batch_completed'
  | 'error'
  | 'retry';

/** 通知记录 */
export interface Notification {
  id: string;
  timestamp: string;
  batch_id: string;
  task_id: string;
  event: NotificationEvent;
  phase?: Phase | null;
  data: Record<string, unknown>;
}

/** 阶段流转顺序 */
export const PHASE_ORDER: Phase[] = ['designer', 'planner', 'coder', 'reviewer', 'tester'];
