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
export { loadSkill, renderTemplate, extractVariables } from './skills/loader.js';
