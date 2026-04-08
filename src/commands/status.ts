/**
 * floo status — 查看当前项目的任务状态概览
 * 读取 .floo/ 目录，调用 getStatusSummary 输出格式化状态
 */

import { Command } from 'commander';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { getStatusSummary } from '../core/index.js';

export const statusCommand = new Command('status')
  .description('查看当前项目的任务状态')
  .action(async () => {
    const flooDir = join(process.cwd(), '.floo');

    // 检查 .floo 目录是否存在
    try {
      await access(flooDir);
    } catch {
      console.error('错误：当前目录没有 .floo/ 配置。请先运行 `floo init`。');
      process.exit(1);
    }

    try {
      const summary = await getStatusSummary(flooDir);
      console.log(summary);
    } catch (err) {
      console.error('读取状态失败:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });
