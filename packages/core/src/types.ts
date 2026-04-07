/**
 * Floo 核心类型定义
 * 所有模块共享的类型，修改需谨慎——其他模块全部依赖这个文件
 */

// ============================================================
// 基础枚举
// ============================================================

/** 任务执行阶段 */
export type Phase = 'designer' | 'planner' | 'coder' | 'reviewer' | 'tester';

/** Agent 运行时 */
export type Runtime = 'claude' | 'codex';

/** 任务状态 */
export type TaskStatus =
  | 'pending'    // 等待调度
  | 'running'    // 某个 phase 正在执行
  | 'completed'  // 全流程通过
  | 'failed'     // 到达重试上限，暂停等人
  | 'cancelled'; // 用户取消

/** 批次状态 */
export type BatchStatus = 'active' | 'completed' | 'cancelled';

/** Review 结论 */
export type Verdict = 'pass' | 'fail';

/** Review 反馈置信度 */
export type Severity = 'critical' | 'important' | 'suggestion';

// ============================================================
// 配置
// ============================================================

/** 单个角色的运行时绑定 */
export interface RoleBinding {
  runtime: Runtime;
  model: string;
}

/** floo.config.yaml 的完整结构 */
export interface FlooConfig {
  roles: Record<Phase, RoleBinding>;
  concurrency: {
    max_agents: number;
    commit_lock: boolean;
  };
  session: {
    timeout_minutes: number;
    keep_on_success_minutes: number;
    keep_on_failure_minutes: number;
    orphan_check_interval_minutes: number;
  };
  protected_files: string[];
}

// ============================================================
// 任务与批次
// ============================================================

/** 单个任务 */
export interface Task {
  id: string;               // 如 "task-001"
  batch_id: string;          // 所属批次 ID
  description: string;       // 用户原始描述
  status: TaskStatus;
  current_phase: Phase | null;
  scope: string[];           // 允许修改的文件/目录列表
  acceptance_criteria: string[];
  /** full=派 review agent, scan=自动检查 scope+exit, skip=仅验证 scope */
  review_level: 'full' | 'scan' | 'skip';
  created_at: string;        // ISO 8601
  updated_at: string;
  /** 角色绑定覆盖（任务级 > 项目级 > 系统默认） */
  role_overrides?: Partial<Record<Phase, RoleBinding>>;
}

/** 批次 */
export interface Batch {
  id: string;               // 如 "2026-04-07-auth-refactor"
  description: string;
  status: BatchStatus;
  tasks: string[];           // task ID 列表
  created_at: string;
  updated_at: string;
}

// ============================================================
// 执行记录
// ============================================================

/** 单次 agent 执行记录（存 runs/001-designer.yaml） */
export interface RunRecord {
  id: string;               // 如 "001-designer"
  task_id: string;
  phase: Phase;
  runtime: Runtime;
  model: string;
  session_name: string;      // tmux session 名
  attempt: number;           // 第几次尝试（1-based）
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  duration_seconds: number | null;
}

/** floo-runner 写入的 exit artifact（.floo/signals/{taskId}-{phase}.exit） */
export interface ExitArtifact {
  task_id: string;
  phase: Phase;
  session_name: string;
  exit_code: number;
  finished_at: string;        // ISO 8601
  duration_seconds: number;
  files_changed: string[];    // git diff --name-only 的结果
}

// ============================================================
// Scope 与锁
// ============================================================

/** Scope 冲突检测结果 */
export interface ScopeConflict {
  task_a: string;
  task_b: string;
  overlapping_files: string[];
}

/** Commit 锁信息 */
export interface CommitLock {
  task_id: string;
  session_name: string;
  acquired_at: string;
  pid: number;
}

// ============================================================
// Agent Adapter
// ============================================================

/** adapter.spawn() 的参数 */
export interface SpawnOptions {
  taskId: string;
  phase: Phase;
  prompt: string;
  cwd: string;
  runtime: Runtime;
  model: string;
}

/** adapter 接口——所有 runtime adapter 都要实现 */
export interface AgentAdapter {
  runtime: Runtime;

  /** 启动 agent（通过 floo-runner 包装），只启动不等待 */
  spawn(opts: SpawnOptions): Promise<string>;  // 返回 session name

  /** 检查 session 是否还活着 */
  isAlive(sessionName: string): Promise<boolean>;

  /** 获取 session 输出（最后 N 行） */
  getOutput(sessionName: string, lines?: number): Promise<string>;

  /** 向运行中的 session 发送消息 */
  sendMessage(sessionName: string, msg: string): Promise<void>;

  /** 强制终止 session 并写入 exit artifact（exit_code = -1 表示被终止） */
  kill(sessionName: string, cwd: string, taskId: string, phase: string): Promise<void>;
}

// ============================================================
// Dispatcher
// ============================================================

/** 状态机的阶段流转顺序（Milestone 1 不含 tester） */
export const PHASE_ORDER: Phase[] = ['designer', 'planner', 'coder', 'reviewer'];

/** 最大重试次数 */
export const MAX_RETRIES = 3;

/** 最大 review 轮数（reviewer fail → coder → reviewer） */
export const MAX_REVIEW_ROUNDS = 2;

// ============================================================
// 默认配置
// ============================================================

export const DEFAULT_CONFIG: FlooConfig = {
  roles: {
    designer:  { runtime: 'claude', model: 'sonnet' },
    planner:   { runtime: 'claude', model: 'sonnet' },
    coder:     { runtime: 'claude', model: 'sonnet' },
    reviewer:  { runtime: 'codex',  model: 'codex-mini' },
    tester:    { runtime: 'claude', model: 'sonnet' },
  },
  concurrency: {
    max_agents: 3,
    commit_lock: true,
  },
  session: {
    timeout_minutes: 30,
    keep_on_success_minutes: 30,
    keep_on_failure_minutes: 1440, // 24h
    orphan_check_interval_minutes: 10,
  },
  protected_files: ['.env', 'floo.config.yaml', 'CLAUDE.md', 'AGENTS.md'],
};
