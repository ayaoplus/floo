/**
 * floo monitor — 实时监控任务状态
 * 定时轮询 .floo/ 目录，清屏输出状态概览，同时检测超时任务
 * Ctrl+C 退出
 */

import { Command } from 'commander';
import { join } from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { getStatusSummary, checkTimeouts, DEFAULT_CONFIG } from '@floo/core';

export const monitorCommand = new Command('monitor')
  .description('实时监控任务状态')
  .option('--interval <seconds>', '轮询间隔（秒）', '5')
  .action(async (options: { interval: string }) => {
    const flooDir = join(process.cwd(), '.floo');
    const intervalSeconds = parseInt(options.interval, 10);

    // 参数校验
    if (isNaN(intervalSeconds) || intervalSeconds < 1) {
      console.error('错误：interval 必须是大于 0 的整数。');
      process.exit(1);
    }

    // 检查 .floo 目录是否存在
    try {
      await access(flooDir);
    } catch {
      console.error('错误：当前目录没有 .floo/ 配置。请先运行 `floo init`。');
      process.exit(1);
    }

    console.log(`监控模式启动，每 ${intervalSeconds} 秒刷新一次。按 Ctrl+C 退出。\n`);

    /** 单次轮询：输出状态 + 检测超时 */
    const poll = async () => {
      // 清屏
      process.stdout.write('\x1B[2J\x1B[0f');

      console.log(`[floo monitor] ${new Date().toLocaleTimeString()} — 每 ${intervalSeconds}s 刷新\n`);

      try {
        const summary = await getStatusSummary(flooDir);
        console.log(summary);
      } catch (err) {
        console.error('读取状态失败:', err instanceof Error ? err.message : err);
      }

      // 检测超时任务（从配置读取阈值）
      try {
        let timeoutMinutes = DEFAULT_CONFIG.session.timeout_minutes;
        try {
          const cfg = JSON.parse(await readFile(join(process.cwd(), 'floo.config.json'), 'utf-8'));
          if (cfg.session?.timeout_minutes) timeoutMinutes = cfg.session.timeout_minutes;
        } catch { /* 用默认值 */ }
        const timedOut = await checkTimeouts(flooDir, timeoutMinutes);
        if (timedOut.length > 0) {
          console.log('\n⚠ 超时任务:');
          for (const t of timedOut) {
            console.log(`  ${t.taskId} @ ${t.phase} — 已运行 ${t.runningMinutes} 分钟（批次: ${t.batchId}）`);
          }
        }
      } catch { /* 超时检测失败不影响主流程 */ }
    };

    // 立即执行一次
    await poll();

    // 定时轮询
    const timer = setInterval(poll, intervalSeconds * 1000);

    // Ctrl+C 优雅退出
    process.on('SIGINT', () => {
      clearInterval(timer);
      console.log('\n监控已停止。');
      process.exit(0);
    });
  });
