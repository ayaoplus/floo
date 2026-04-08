/**
 * floo cancel — 取消正在运行的任务
 * 根据 taskId 找到任务，选择对应的 adapter，执行取消操作
 */

import { Command } from 'commander';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  ClaudeAdapter,
  CodexAdapter,
  getTask,
  listBatches,
  cancelTask,
  DEFAULT_CONFIG,
  type FlooConfig,
} from '../core/index.js';

export const cancelCommand = new Command('cancel')
  .description('取消正在运行的任务')
  .argument('<taskId>', '要取消的任务 ID')
  .option('--batch <batchId>', '指定批次 ID（默认取最新的 active 批次）')
  .action(async (taskId: string, options: { batch?: string }) => {
    const cwd = process.cwd();
    const flooDir = join(cwd, '.floo');

    // 确定 batchId：优先用 --batch 参数，否则找最新的 active 批次
    let batchId = options.batch;
    if (!batchId) {
      const batches = await listBatches(flooDir);
      const activeBatch = batches.find(b => b.status === 'active');
      if (!activeBatch) {
        console.error('错误：没有找到活跃的批次。请用 --batch 指定批次 ID。');
        process.exit(1);
      }
      batchId = activeBatch.id;
    }

    // 读取任务信息，确定 current_phase 对应的 runtime
    let task;
    try {
      task = await getTask(flooDir, batchId, taskId);
    } catch {
      console.error(`错误：找不到任务 ${taskId}（批次: ${batchId}）`);
      process.exit(1);
    }

    if (!task.current_phase) {
      console.error(`错误：任务 ${taskId} 没有正在执行的阶段。`);
      process.exit(1);
    }

    // 加载配置（深度合并）
    let config: FlooConfig = DEFAULT_CONFIG;
    try {
      const configContent = await readFile(join(cwd, 'floo.config.json'), 'utf-8');
      const userConfig = JSON.parse(configContent);
      config = {
        roles: { ...DEFAULT_CONFIG.roles, ...userConfig.roles },
        concurrency: { ...DEFAULT_CONFIG.concurrency, ...userConfig.concurrency },
        session: { ...DEFAULT_CONFIG.session, ...userConfig.session },
        protected_files: userConfig.protected_files ?? DEFAULT_CONFIG.protected_files,
      };
    } catch { /* 使用默认配置 */ }

    const roleBinding = task.role_overrides?.[task.current_phase] ?? config.roles[task.current_phase];
    const adapter = roleBinding.runtime === 'codex'
      ? new CodexAdapter()
      : new ClaudeAdapter();

    console.log(`取消任务: ${taskId} @ ${task.current_phase}（批次: ${batchId}）`);
    console.log(`使用 adapter: ${roleBinding.runtime}`);

    try {
      const cancelled = await cancelTask(flooDir, batchId, taskId, adapter, cwd);
      console.log(`✓ 任务已取消 (${cancelled.status})`);
    } catch (err) {
      console.error('取消失败:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });
