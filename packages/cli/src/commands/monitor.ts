/**
 * floo monitor — 实时监控任务状态
 * 定时轮询 .floo/ 目录，清屏输出状态概览，同时检测超时任务
 * Ctrl+C 退出
 */

import { Command } from 'commander';
import { join } from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { getStatusSummary, checkTimeouts, listNotifications, DEFAULT_CONFIG } from '@floo/core';

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

    // 记录上次 poll 时间，用于只显示新通知
    let lastPollTime = new Date();

    /** 格式化通知事件为可读文本 */
    function formatEvent(event: string, data: Record<string, unknown>): string {
      switch (event) {
        case 'task_started': return `任务启动: ${data.description ?? ''}`;
        case 'phase_started': return `${data.phase} 开始 (${data.runtime}/${data.model})`;
        case 'phase_completed': return `${data.phase} 完成 (exit=${data.exit_code}, ${data.duration_seconds}s)`;
        case 'review_concluded': return `review: ${data.verdict}`;
        case 'task_completed': return `任务${data.status === 'completed' ? '完成' : '失败'}${data.reason ? ` (${data.reason})` : ''}`;
        case 'batch_completed': return `批次${data.status === 'completed' ? '完成' : '部分失败'} (${data.completed}/${data.total_tasks})`;
        case 'retry': return `重试 ${data.phase} (${data.attempt}/${data.max_retries})`;
        default: return event;
      }
    }

    /** 单次轮询：输出状态 + 通知 + 检测超时 */
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

      // 读取新通知
      try {
        const notifications = await listNotifications(flooDir, { since: lastPollTime });
        if (notifications.length > 0) {
          console.log('\n--- 最新通知 ---');
          for (const n of notifications) {
            const time = new Date(n.timestamp).toLocaleTimeString();
            const desc = formatEvent(n.event, n.data);
            console.log(`  [${time}] ${n.task_id} — ${desc}`);
          }
        }
      } catch { /* 通知读取失败不影响主流程 */ }

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

      lastPollTime = new Date();
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
