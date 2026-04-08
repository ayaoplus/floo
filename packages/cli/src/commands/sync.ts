/**
 * floo sync — 同步项目规则到 CLAUDE.md / AGENTS.md
 * 读取 .floo/context/project-rules.md，适配格式后生成配置文件
 */

import { Command } from 'commander';
import { join } from 'node:path';
import { readFile, writeFile, access } from 'node:fs/promises';
import { distillRules } from '@floo/core';

/** 生成 CLAUDE.md 内容（project-rules 嵌入到 Claude 格式） */
function generateClaudeMd(rules: string, projectName: string): string {
  const lines: string[] = [];
  lines.push(`# ${projectName} — AI 编码规范`);
  lines.push('');
  lines.push('> 由 `floo sync` 自动生成，基于 `.floo/context/project-rules.md`。');
  lines.push('> 如需修改规则，请编辑 project-rules.md 后重新运行 `floo sync`。');
  lines.push('');
  lines.push(rules);
  return lines.join('\n');
}

/** 生成 AGENTS.md 内容（project-rules 嵌入到 Codex 格式） */
function generateAgentsMd(rules: string, projectName: string): string {
  const lines: string[] = [];
  lines.push(`# ${projectName} — Agent 工作规范`);
  lines.push('');
  lines.push('> 由 `floo sync` 自动生成，基于 `.floo/context/project-rules.md`。');
  lines.push('');
  lines.push(rules);
  return lines.join('\n');
}

export const syncCommand = new Command('sync')
  .description('同步项目规则到 CLAUDE.md / AGENTS.md')
  .option('--distill', '同步前先蒸馏 lessons 为规则')
  .option('--dry-run', '只预览，不实际写文件')
  .action(async (options: { distill?: boolean; dryRun?: boolean }) => {
    const cwd = process.cwd();
    const flooDir = join(cwd, '.floo');

    try {
      await access(flooDir);
    } catch {
      console.error('错误：当前目录没有 .floo/ 配置。请先运行 `floo init`。');
      process.exit(1);
    }

    // 可选：先蒸馏
    if (options.distill) {
      await distillRules(flooDir);
      console.log('✓ 规则蒸馏完成');
    }

    // 读取 project-rules.md
    const rulesPath = join(flooDir, 'context', 'project-rules.md');
    let rules: string;
    try {
      rules = await readFile(rulesPath, 'utf-8');
    } catch {
      console.error('错误：.floo/context/project-rules.md 不存在。');
      console.error('  先运行 `floo learn` 记录经验，再运行 `floo sync --distill` 蒸馏规则。');
      process.exit(1);
    }

    // 读取项目名称
    let projectName = 'Project';
    try {
      const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf-8'));
      if (pkg.name) projectName = pkg.name;
    } catch { /* 没有 package.json */ }

    const claudeMd = generateClaudeMd(rules, projectName);
    const agentsMd = generateAgentsMd(rules, projectName);

    if (options.dryRun) {
      console.log('=== CLAUDE.md ===');
      console.log(claudeMd);
      console.log('\n=== AGENTS.md ===');
      console.log(agentsMd);
      return;
    }

    await writeFile(join(cwd, 'CLAUDE.md'), claudeMd);
    await writeFile(join(cwd, 'AGENTS.md'), agentsMd);
    console.log('✓ CLAUDE.md 已生成');
    console.log('✓ AGENTS.md 已生成');
  });
