/**
 * floo run — 创建任务并执行
 * clean working tree 检查 → 路由 → 创建批次 → dispatcher 驱动全流程
 */

import { Command } from 'commander';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import {
  createAndRun,
  routeTask,
  ClaudeAdapter,
  CodexAdapter,
  DEFAULT_CONFIG,
  type Phase,
  type FlooConfig,
} from '../core/index.js';

const exec = promisify(execFile);

export const runCommand = new Command('run')
  .description('创建并执行任务')
  .argument('<description>', '任务描述')
  .option('--from <phase>', '指定起始阶段 (designer/planner/coder/reviewer)')
  .option('--scope <files...>', '指定文件 scope')
  .option('--detach', '后台运行，立即返回')
  .action(async (description: string, options: { from?: string; scope?: string[]; detach?: boolean }) => {
    const cwd = process.cwd();

    // Milestone 1 强约束：working tree 必须干净（排除 floo 自身文件）
    try {
      const { stdout } = await exec('git', ['status', '--porcelain'], { cwd });
      const dirtyFiles = stdout.trim().split('\n')
        .filter(line => line.trim().length > 0)
        .filter(line => {
          const file = line.slice(3); // 去掉状态前缀如 "?? " 或 " M "
          // 排除 floo 自身产生的文件
          if (file === '.gitignore' || file === 'floo.config.json') return false;
          if (file.startsWith('.floo/') || file === '.floo/') return false;
          if (file.startsWith('skills/') || file === 'skills/') return false;
          return true;
        });
      if (dirtyFiles.length > 0) {
        console.error('错误：working tree 不干净。请先 commit 或 stash 未提交的变更。');
        console.error('运行 `git status` 查看详情。');
        process.exit(1);
      }
    } catch {
      console.error('警告：无法检查 git 状态，可能不是 git 仓库。');
    }

    // --detach: 后台模式，spawn 子进程后立即返回
    if (options.detach) {
      const logsDir = join(cwd, '.floo', 'logs');
      await mkdir(logsDir, { recursive: true });

      // 重建完整命令：保留 argv[1]（CLI 入口脚本），去掉 --detach
      const args = process.argv.slice(1).filter(a => a !== '--detach');
      const logFile = join(logsDir, `run-${Date.now()}.log`);
      const logFd = openSync(logFile, 'a');

      const child = spawn(process.argv[0], args, {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        cwd,
      });
      child.unref();

      // 关闭父进程持有的 fd，让子进程独占
      closeSync(logFd);

      console.log(`后台任务已启动 (PID: ${child.pid})`);
      console.log(`日志: ${logFile}`);
      console.log('执行 `floo monitor` 查看进度');
      process.exit(0);
    }

    // 路由：决定从哪个 phase 开始
    const startPhase = routeTask(description, {
      from: options.from as Phase | undefined,
      scope: options.scope,
    });

    console.log(`任务: ${description}`);
    console.log(`起始阶段: ${startPhase}`);
    if (options.scope) {
      console.log(`Scope: ${options.scope.join(', ')}`);
    }
    console.log('');

    // 加载配置（深度合并，用户只需覆盖想改的字段）
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

    // 初始化 adapters
    const adapters = {
      claude: new ClaudeAdapter(),
      codex: new CodexAdapter(),
    };

    console.log('开始执行...\n');

    // graceful shutdown：Ctrl+C 时通知 dispatcher 停止调度新任务
    const ac = new AbortController();
    process.once('SIGINT', () => {
      console.log('\n收到 SIGINT，正在优雅停止（等待当前 phase 完成）...');
      ac.abort();
    });

    try {
      const { batch, tasks } = await createAndRun(description, startPhase, {
        projectRoot: cwd,
        config,
        adapters,
        scope: options.scope,
        signal: ac.signal,
      });

      const allCompleted = tasks.every(t => t.status === 'completed');
      if (allCompleted) {
        console.log(`\n✓ 全部完成（${tasks.length} 个任务）`);
        console.log(`  批次: ${batch.id}`);
        for (const t of tasks) {
          console.log(`  ${t.id}: ${t.status}`);
        }
      } else {
        console.log(`\n✗ 部分任务未完成`);
        console.log(`  批次: ${batch.id}`);
        for (const t of tasks) {
          const phase = t.current_phase ? ` @ ${t.current_phase}` : '';
          console.log(`  ${t.id}: ${t.status}${phase}`);
        }
        process.exit(1);
      }
    } catch (err) {
      console.error('执行失败:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });
