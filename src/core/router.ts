/**
 * 任务路由器
 * 根据用户输入的任务描述，自动判断应该从哪个阶段开始执行
 */

import type { Phase } from './types.js';

/** bug/修复类关键词 */
const BUG_KEYWORDS = /\b(bug|fix|hotfix)\b|修复|报错|崩溃|异常/i;

/** review/审查类关键词 */
const REVIEW_KEYWORDS = /\b(review|audit)\b|审查|检查|审阅|code\s*review/i;

/** 粗略匹配文件路径：含 / 或 . 后缀的 token */
const FILE_PATH_PATTERN = /(?:^|\s)([\w\-./]+\/[\w\-./]+|[\w\-]+\.\w{1,10})(?:\s|$)/;

/**
 * 根据任务描述和可选参数，决定任务应从哪个 Phase 开始执行
 *
 * 路由优先级：
 * 1. 用户显式指定 opts.from → 直接返回
 * 2. 有具体 scope 且描述很短 → coder（小改动，跳过讨论）
 * 3. 描述含 bug/fix 等关键词 → coder（修复类明确短路）
 * 4. 描述含 review/审查 等关键词 → reviewer
 * 5. 描述简短且含文件路径 → planner（已明确到文件，跳过讨论）
 * 6. 默认 → discuss（深度挖掘需求再做设计）
 */
export function routeTask(
  description: string,
  opts?: { from?: Phase; scope?: string[] },
): Phase {
  // 1. 用户显式覆盖，直接返回
  if (opts?.from) {
    return opts.from;
  }

  const trimmed = description.trim();

  // 2. 有具体文件列表 + 描述很短 → 小改动，直接 coder
  if (opts?.scope && opts.scope.length > 0 && trimmed.length < 50) {
    return 'coder';
  }

  // 3. bug/fix/修复/报错 → 从 coder 开始
  if (BUG_KEYWORDS.test(trimmed)) {
    return 'coder';
  }

  // 4. review/审查/检查 → 从 reviewer 开始
  if (REVIEW_KEYWORDS.test(trimmed)) {
    return 'reviewer';
  }

  // 5. 描述简短且包含具体文件路径 → 从 planner 开始（跳过 discuss + designer）
  if (trimmed.length < 100 && FILE_PATH_PATTERN.test(trimmed)) {
    return 'planner';
  }

  // 6. 默认从 discuss 开始——挖透需求再设计，避免 designer 盲猜
  return 'discuss';
}
