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

// Dispatcher
export { runTask, createAndRun, type DispatcherOptions } from './dispatcher.js';

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

// Plan (Step 1: 镜像快照,dispatcher 不消费,Step 4 后 executor 才会真正驱动)
// Plan template (Step 2: loadTemplate 提供模板加载,模板尚未被消费)
export {
  synthesizeInitialPlan,
  writePlan,
  readPlan,
  planYamlPath,
  loadTemplate,
  validateTemplate,
  planTemplatePath,
  type PlanYaml,
  type PlanStep,
  type PlanStepStatus,
  type PlanTemplate,
  type PlanTemplateStep,
  type PlanTemplateScope,
} from './plan.js';
