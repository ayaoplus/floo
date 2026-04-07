/**
 * floo init — 初始化项目
 * 创建 .floo/ 目录结构 + 默认 floo.config.yaml
 */

import { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureFlooDir, DEFAULT_CONFIG } from '@floo/core';

export const initCommand = new Command('init')
  .description('初始化当前项目的 floo 配置')
  .action(async () => {
    const cwd = process.cwd();

    // 创建 .floo/ 目录结构
    const flooDir = await ensureFlooDir(cwd);
    console.log(`✓ 创建 ${flooDir}`);

    // 生成默认 floo.config.yaml（JSON 格式，后续可改 YAML）
    const configPath = join(cwd, 'floo.config.json');
    try {
      await writeFile(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), { flag: 'wx' });
      console.log(`✓ 生成 ${configPath}`);
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST') {
        console.log(`  floo.config.json 已存在，跳过`);
      } else {
        throw err;
      }
    }

    console.log('\nfloo 初始化完成。运行 `floo run "任务描述"` 开始。');
  });
