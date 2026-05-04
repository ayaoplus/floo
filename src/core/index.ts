/**
 * @floo/core 公共导出
 */

// 类型和常量
export * from './types.js';

// Adapter 基类和工具函数
export { BaseAdapter, readExitArtifact, waitForCompletion } from './adapters/base.js';

// Scope 冲突检测和 commit 锁
export {
  scopesOverlap,
  detectConflicts,
  findOutOfScope,
  acquireCommitLock,
  releaseCommitLock,
  ensureFlooDir,
} from './scope.js';

// Skill 模板加载
// Step 3 新增:loadSkillWithMetadata / parseSkillFile / validateCapabilityMetadata 暴露 frontmatter
export {
  loadSkill,
  loadSkillWithMetadata,
  parseSkillFile,
  validateCapabilityMetadata,
  renderTemplate,
  extractVariables,
  type SkillFile,
  type TemplateVars,
} from './skills/loader.js';

// Adapter 实现
export { ClaudeAdapter } from './adapters/claude.js';
export { CodexAdapter } from './adapters/codex.js';

// Router
export { routeTask } from './router.js';

// Dispatcher (thin shim — 实现在 executor/state-machine.ts 与 executor/batch.ts)
export { runTask, createAndRun, type DispatcherOptions } from './dispatcher.js';

// Plan-driven 入口 (Step 4c)
// runTaskFromSteps: 接受外部 RunStep[],真 plan 驱动 step 序列
// planStepsToRunSteps: 把 plan.yaml 声明 steps 转成运行时 steps
export { runTaskFromSteps } from './executor/state-machine.js';
export {
  planStepsToRunSteps,
  makeStepsForPhaseRange,
  type RunStep,
  type RunState,
  type StepStatus,
} from './executor/state.js';

// Executor (Step 4a: plan-driven 入口,内部仍委托 dispatcher;Step 4b 后状态机搬入)
export {
  runPlan,
  runPlanFromDisk,
  type ExecutorOptions,
  type ExecutorResult,
} from './executor.js';

// Monitor
export {
  getBatch,
  getTask,
  listBatches,
  listTasks,
  listRuns,
  cancelTask,
  checkTimeouts,
  getStatusSummary,
} from './monitor.js';

// Notifications
export { notify, listNotifications, type NotificationFilter } from './notifications.js';

// Health checks
export { cleanOrphanSessions, detectStaleTasks, rotateLogs, runHealthCheck, type HealthReport } from './health.js';

// Lessons
export { addLesson, extractLesson, listLessons, distillRules, type Lesson, type LessonRecord } from './lessons.js';

// Plan (Step 1: 镜像快照)
// Plan template (Step 2: loadTemplate 提供模板加载)
// Plan 拓扑查询 (Step 4d: 让 batch.runBatchEntry 按 plan 决定分支)
export {
  synthesizeInitialPlan,
  writePlan,
  readPlan,
  planYamlPath,
  loadTemplate,
  validateTemplate,
  planTemplatePath,
  templateToPhases,
  planHasComplexCapability,
  planHasDiscussDesignerLoop,
  planHasPlanner,
  planHasPlannerExpansion,
  type PlanYaml,
  type PlanStep,
  type PlanStepStatus,
  type PlanTemplate,
  type PlanTemplateStep,
  type PlanTemplateScope,
} from './plan.js';

// Phase order (Step 4e: 从 feature.yaml 派生)
export { derivePhaseOrder, loadFeaturePhaseOrder } from './phase-order.js';
