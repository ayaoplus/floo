#!/usr/bin/env node
/**
 * Floo CLI 入口
 * 所有命令都是胶水层，调用 @floo/core 的 API
 */

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { cancelCommand } from './commands/cancel.js';
import { monitorCommand } from './commands/monitor.js';
import { learnCommand } from './commands/learn.js';
import { syncCommand } from './commands/sync.js';
import { configCommand } from './commands/config.js';

const program = new Command();

program
  .name('floo')
  .description('Multi-Agent Vibe Coding Harness')
  .version('0.1.0');

program.addCommand(initCommand);
program.addCommand(runCommand);
program.addCommand(statusCommand);
program.addCommand(cancelCommand);
program.addCommand(monitorCommand);
program.addCommand(learnCommand);
program.addCommand(syncCommand);
program.addCommand(configCommand);

program.parse();
