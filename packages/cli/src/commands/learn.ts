/**
 * floo learn — 手动记录经验教训
 * 用法：floo learn "问题描述" --solution "解决方案" --tags "tag1,tag2"
 * 简写：floo learn "一句话描述"（problem 和 solution 用同一段文字）
 */

import { Command } from 'commander';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { addLesson, listLessons, distillRules } from '@floo/core';

export const learnCommand = new Command('learn')
  .description('记录经验教训')
  .argument('<description>', '经验描述（问题 + 解决方案）')
  .option('-s, --solution <text>', '解决方案（不指定则复用 description）')
  .option('-c, --cause <text>', '原因分析')
  .option('-t, --tags <tags>', '标签，逗号分隔', '')
  .option('--list', '列出所有经验教训')
  .option('--distill', '蒸馏规则到 project-rules.md')
  .action(async (description: string, options: {
    solution?: string;
    cause?: string;
    tags: string;
    list?: boolean;
    distill?: boolean;
  }) => {
    const flooDir = join(process.cwd(), '.floo');

    try {
      await access(flooDir);
    } catch {
      console.error('错误：当前目录没有 .floo/ 配置。请先运行 `floo init`。');
      process.exit(1);
    }

    // --list: 列出所有经验
    if (options.list) {
      const lessons = await listLessons(flooDir);
      if (lessons.length === 0) {
        console.log('暂无经验记录。');
        return;
      }
      for (const l of lessons) {
        const tags = l.tags.length > 0 ? ` [${l.tags.join(', ')}]` : '';
        console.log(`${l.date} ${l.id}${tags}`);
        console.log(`  问题: ${l.problem}`);
        console.log(`  解决: ${l.solution}`);
        console.log('');
      }
      console.log(`共 ${lessons.length} 条经验。`);
      return;
    }

    // --distill: 蒸馏规则
    if (options.distill) {
      await distillRules(flooDir);
      console.log('✓ 规则蒸馏完成 → .floo/context/project-rules.md');
      return;
    }

    // 添加经验
    const tags = options.tags
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);

    const id = await addLesson(flooDir, {
      problem: description,
      cause: options.cause,
      solution: options.solution ?? description,
      tags,
    });

    console.log(`✓ 经验已记录: ${id}`);
  });
