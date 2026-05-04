/**
 * Reviewer / Tester 结论检查
 *
 * 从 task 目录的 review.md / test-report.md 中提取 verdict,默认保守 fail。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Task } from '../types.js';

/** 从 review.md 中提取 verdict: pass/fail。找不到默认 fail(保守) */
export async function checkReviewVerdict(
  flooDir: string,
  task: Task,
): Promise<'pass' | 'fail'> {
  try {
    const taskDir = join(flooDir, 'batches', task.batch_id, 'tasks', task.id);
    const reviewContent = await readFile(join(taskDir, 'review.md'), 'utf-8');
    const match = reviewContent.match(/verdict:\s*(pass|fail)/i);
    if (match) return match[1].toLowerCase() as 'pass' | 'fail';
    return 'fail';
  } catch {
    return 'fail';
  }
}

/** 从 test-report.md 中提取 result: pass/fail。找不到默认 fail(保守) */
export async function checkTestResult(
  flooDir: string,
  task: Task,
): Promise<'pass' | 'fail'> {
  try {
    const taskDir = join(flooDir, 'batches', task.batch_id, 'tasks', task.id);
    const reportContent = await readFile(join(taskDir, 'test-report.md'), 'utf-8');
    const match = reportContent.match(/result:\s*(pass|fail)/i);
    if (match) return match[1].toLowerCase() as 'pass' | 'fail';
    return 'fail';
  } catch {
    return 'fail';
  }
}
