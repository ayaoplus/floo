/**
 * Executor IO 基础设施
 *
 * 从原 dispatcher.ts 抽出的持久化 + 日志辅助。dispatcher 和 executor 共用。
 */

import { writeFile, mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Batch, RunRecord, Task } from '../types.js';

/** 系统日志:单行纯文本,给 AI 排障用 */
export async function log(
  flooDir: string,
  module: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
  const line = `[${ts}] [${module}] ${parts}\n`;
  const logDir = join(flooDir, 'logs');
  await mkdir(logDir, { recursive: true });
  await appendFile(join(logDir, 'system.log'), line);
}

/** 持久化任务状态 */
export async function saveTask(flooDir: string, task: Task): Promise<void> {
  const taskDir = join(flooDir, 'batches', task.batch_id, 'tasks', task.id);
  await mkdir(taskDir, { recursive: true });
  task.updated_at = new Date().toISOString();
  await writeFile(join(taskDir, 'task.json'), JSON.stringify(task, null, 2));
}

/** 持久化批次状态 */
export async function saveBatch(flooDir: string, batch: Batch): Promise<void> {
  const batchDir = join(flooDir, 'batches', batch.id);
  await mkdir(batchDir, { recursive: true });
  batch.updated_at = new Date().toISOString();
  await writeFile(join(batchDir, 'batch.json'), JSON.stringify(batch, null, 2));
}

/** 保存 run 记录(runId 包含 attempt 防覆盖) */
export async function saveRun(
  flooDir: string,
  batchId: string,
  taskId: string,
  run: RunRecord,
): Promise<void> {
  const runsDir = join(flooDir, 'batches', batchId, 'tasks', taskId, 'runs');
  await mkdir(runsDir, { recursive: true });
  await writeFile(join(runsDir, `${run.id}.json`), JSON.stringify(run, null, 2));
}

/** 确保值是字符串数组(YAML 解析结果可能是各种类型) */
export function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  return [];
}

/**
 * 从 batchId 生成 batch token(时间部分 + 随机后缀)
 * 用于 task ID 前缀,确保并发 batch 的资源不碰撞
 *   batchId 格式 "yyyy-MM-dd-HHmmss-xxxx-descSlug"
 */
export function deriveBatchToken(batchId: string): string {
  const parts = batchId.split('-');
  const timePart = parts[3] ?? '000000';
  const randomPart = parts[4] ?? Math.random().toString(36).slice(2, 6);
  return `${timePart}${randomPart}`;
}
