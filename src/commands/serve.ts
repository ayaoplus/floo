/**
 * floo serve — 启动 Web 监控面板
 * 在 web/ 目录下运行 next dev 或 next start
 */

import { Command } from 'commander';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';

export const serveCommand = new Command('serve')
  .description('启动 Web 监控面板')
  .option('-p, --port <port>', '端口号', '3000')
  .option('--prod', '以生产模式运行（需要先 build）')
  .action(async (opts) => {
    const webDir = join(import.meta.dirname, '..', '..', 'web');
    const flooDir = join(process.cwd(), '.floo');

    // 检查 web 目录
    try {
      await access(webDir);
    } catch {
      console.error('错误：找不到 web/ 目录。请确认在 floo 项目根目录下运行。');
      process.exit(1);
    }

    // 设置环境变量，让 Next.js 知道 .floo 目录在哪里
    const env = {
      ...process.env,
      FLOO_DIR: flooDir,
      PORT: opts.port,
    };

    const command = opts.prod ? 'start' : 'dev';
    console.log(`启动 Web 监控面板 (${command} mode) → http://localhost:${opts.port}`);
    console.log(`数据目录: ${flooDir}`);

    // 用 npx next dev/start 启动
    const child = spawn('npx', ['next', command, '--port', opts.port], {
      cwd: webDir,
      env,
      stdio: 'inherit',
    });

    child.on('error', (err) => {
      console.error('启动失败:', err.message);
      process.exit(1);
    });

    child.on('exit', (code) => {
      process.exit(code ?? 0);
    });
  });
