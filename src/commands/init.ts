/**
 * floo init — 初始化项目
 * 创建 .floo/ 目录结构 + 默认配置 + 复制 skill 模板 + 更新 .gitignore
 */

import { Command } from 'commander';
import { writeFile, readFile, readdir, copyFile, mkdir, access, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { symlink } from 'node:fs/promises';
import { ensureFlooDir, DEFAULT_CONFIG } from '../core/index.js';

/**
 * 找到 floo 项目根目录（包含 skills/ 和 templates/ 的目录）
 * 从当前文件位置向上遍历，兼容 dist/src/npx 等不同安装方式
 */
function getFlooRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  // 最多向上查找 10 层
  for (let i = 0; i < 10; i++) {
    // floo 根目录的标志：同时包含 skills/ 和 packages/ 目录
    if (existsSync(join(dir, 'skills')) && existsSync(join(dir, 'packages'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // 到达文件系统根目录
    dir = parent;
  }
  // fallback：用旧的相对路径推算
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return join(__dirname, '..', '..', '..', '..');
}

export const initCommand = new Command('init')
  .description('初始化当前项目的 floo 配置')
  .option('--with-playwright', '安装 Playwright 并配置 E2E 测试支持')
  .action(async (options: { withPlaywright?: boolean }) => {
    const cwd = process.cwd();
    const flooRoot = getFlooRoot();

    // 1. 创建 .floo/ 目录结构
    const flooDir = await ensureFlooDir(cwd);
    console.log(`✓ 创建 ${flooDir}`);

    // 2. 生成默认 floo.config.json
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

    // 3. 复制 skill 模板到项目 skills/ 目录
    const srcSkillsDir = join(flooRoot, 'skills');
    const destSkillsDir = join(cwd, 'skills');
    try {
      await access(srcSkillsDir);
      await mkdir(destSkillsDir, { recursive: true });
      const files = await readdir(srcSkillsDir);
      let copied = 0;
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const dest = join(destSkillsDir, file);
        try {
          await access(dest);
          // 已存在，不覆盖
        } catch {
          await copyFile(join(srcSkillsDir, file), dest);
          copied++;
        }
      }
      console.log(`✓ 复制 ${copied} 个 skill 模板到 skills/`);
    } catch {
      console.log('  警告：找不到 skill 模板源目录，跳过复制');
    }

    // 4. 确保 .gitignore 包含 .floo/
    const gitignorePath = join(cwd, '.gitignore');
    try {
      let content = '';
      try {
        content = await readFile(gitignorePath, 'utf-8');
      } catch { /* 文件不存在 */ }

      const lines = content.split('\n');
      const hasFlooEntry = lines.some(line => line.trim() === '.floo/' || line.trim() === '.floo');
      if (!hasFlooEntry) {
        const newContent = content.length > 0 && !content.endsWith('\n')
          ? content + '\n.floo/\n'
          : content + '.floo/\n';
        await writeFile(gitignorePath, newContent);
        console.log(`✓ 添加 .floo/ 到 .gitignore`);
      } else {
        console.log(`  .gitignore 已包含 .floo/，跳过`);
      }
    } catch (err) {
      console.log('  警告：无法更新 .gitignore:', err instanceof Error ? err.message : err);
    }

    // 5. 安装 post-commit git hook（编译门禁）
    const FLOO_HOOK_MARKER = 'FLOO_POST_COMMIT_HOOK';
    try {
      const gitHooksDir = join(cwd, '.git', 'hooks');
      const hookDest = join(gitHooksDir, 'post-commit');
      const hookSrc = join(flooRoot, 'templates', 'post-commit.sh');

      let shouldInstall = false;
      try {
        const existing = await readFile(hookDest, 'utf-8');
        if (existing.includes(FLOO_HOOK_MARKER)) {
          // 是 floo 的 hook，覆盖更新
          shouldInstall = true;
        } else {
          console.log('  .git/hooks/post-commit 已存在（非 floo），跳过');
        }
      } catch {
        // 文件不存在，安装
        shouldInstall = true;
      }

      if (shouldInstall) {
        try {
          await access(hookSrc);
          await copyFile(hookSrc, hookDest);
          await chmod(hookDest, 0o755);
          console.log('✓ 安装 post-commit hook（编译门禁）');
        } catch {
          console.log('  警告：找不到 hook 模板，跳过安装');
        }
      }
    } catch {
      console.log('  警告：无法安装 git hook（可能不是 git 仓库）');
    }

    // 6. 安装 floo SKILL.md 到 agent 发现目录
    // 让 Claude Code、Codex、OpenClaw 等 agent 自动感知 floo 的存在
    const skillSrc = join(flooRoot, 'SKILL.md');
    try {
      await access(skillSrc);

      // 安装到各 agent 的 skill 发现目录
      const skillTargets = [
        join(cwd, '.agents', 'skills', 'floo'),   // Codex / OpenClaw
        join(cwd, '.claude', 'skills', 'floo'),   // Claude Code
      ];

      let installed = 0;
      for (const targetDir of skillTargets) {
        await mkdir(targetDir, { recursive: true });
        const destSkillMd = join(targetDir, 'SKILL.md');
        try {
          await access(destSkillMd);
          // 已存在，跳过（用户可能已定制）
        } catch {
          // 尝试创建符号链接，失败时 fallback 到复制
          try {
            await symlink(skillSrc, destSkillMd);
          } catch {
            await copyFile(skillSrc, destSkillMd);
          }
          installed++;
        }
      }
      if (installed > 0) {
        console.log(`✓ 安装 floo SKILL.md 到 .agents/skills/floo/ 和 .claude/skills/floo/`);
      } else {
        console.log(`  floo SKILL.md 已存在，跳过`);
      }
    } catch {
      console.log('  警告：找不到 SKILL.md，跳过 skill 安装');
    }

    // 7. 可选：安装 Playwright 并配置 E2E 测试
    if (options.withPlaywright) {
      console.log('\n安装 Playwright...');
      const { execSync } = await import('node:child_process');
      try {
        execSync('npm install -D @playwright/test', { cwd, stdio: 'inherit' });
        execSync('npx playwright install', { cwd, stdio: 'inherit' });
        console.log('✓ Playwright 安装完成');
        console.log('  提示：tester 角色将使用 Playwright 进行 E2E 测试');
        console.log('  配置文件：playwright.config.ts（如需自定义请手动创建）');
      } catch (err) {
        console.log('  警告：Playwright 安装失败:', err instanceof Error ? err.message : err);
        console.log('  你可以稍后手动运行：npm install -D @playwright/test && npx playwright install');
      }
    }

    console.log('\nfloo 初始化完成。运行 `floo run "任务描述"` 开始。');
  });
