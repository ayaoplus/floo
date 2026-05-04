/**
 * Prompt 组装
 *
 * 从 skill 模板加载 + 填充任务上下文变量。每个 phase 自己声明需要哪些变量,
 * buildPrompt 根据 phase 收集对应文件并渲染。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Phase, Task } from '../types.js';
import { loadSkill, type TemplateVars } from '../skills/loader.js';
import { readExitArtifact } from '../adapters/base.js';
import { artifactFilename, DESIGNER_QUESTIONS_BASE } from './artifacts.js';

const exec = promisify(execFile);

/**
 * 为指定 phase 组装完整 prompt。
 *
 * 每个 phase 的变量收集:
 *   - 通用:description / task_scope / output_file / acceptance_criteria
 *   - planner+:design_doc(读上游 design.md)
 *   - discuss:design_questions(第二轮 discuss 用 designer 反馈)
 *   - designer:context_doc + questions_output_file
 *   - coder:plan_doc / review_feedback / test_feedback
 *   - planner:project_structure(find 列出文件树)
 *   - reviewer/tester:diff(精确锁 base-head → head_after 范围)
 */
export async function buildPrompt(
  projectRoot: string,
  flooDir: string,
  task: Task,
  phase: Phase,
  extraVars?: TemplateVars,
): Promise<string> {
  const skillsDir = join(projectRoot, 'skills');
  const taskDir = join(flooDir, 'batches', task.batch_id, 'tasks', task.id);

  const vars: TemplateVars = {
    description: task.description,
    task_scope: task.scope.join(', '),
    output_file: artifactFilename(phase, task.id) ?? '',
    acceptance_criteria: task.acceptance_criteria.join('\n- '),
    ...extraVars,
  };

  if (phase === 'planner' || phase === 'coder' || phase === 'reviewer' || phase === 'tester') {
    try {
      vars.design_doc = await readFile(join(taskDir, 'design.md'), 'utf-8');
    } catch { /* designer 可能被跳过 */ }
  }

  if (phase === 'discuss') {
    try {
      vars.design_questions = await readFile(join(taskDir, `${DESIGNER_QUESTIONS_BASE}.md`), 'utf-8');
    } catch {
      vars.design_questions = '（首轮 discuss，无 designer 反馈）';
    }
    if (!vars.project_context) vars.project_context = '（未提供项目背景，可读仓库 README / CLAUDE.md 自行了解）';
    if (!vars.round) vars.round = '1';
  }

  if (phase === 'designer') {
    try {
      vars.context_doc = await readFile(join(taskDir, 'context.md'), 'utf-8');
    } catch {
      vars.context_doc = '（discuss 阶段被跳过，无 context 文档，你需要基于 description 自行判断 scope 和验收标准）';
    }
    vars.questions_output_file = `${task.id}-${DESIGNER_QUESTIONS_BASE}.md`;
  }

  if (phase === 'coder') {
    try {
      vars.plan_doc = await readFile(join(taskDir, 'plan.md'), 'utf-8');
    } catch { /* planner 可能被跳过 */ }
    try {
      vars.review_feedback = await readFile(join(taskDir, 'review.md'), 'utf-8');
    } catch { /* 首次执行没有 review */ }
    try {
      vars.test_feedback = await readFile(join(taskDir, 'test-report.md'), 'utf-8');
    } catch { /* 首次执行没有 test-report */ }
  }

  if (phase === 'planner') {
    try {
      const { stdout } = await exec('find', [
        '.', '-type', 'f',
        '-not', '-path', './.git/*',
        '-not', '-path', './node_modules/*',
        '-not', '-path', './.floo/*',
      ], { cwd: projectRoot });
      vars.project_structure = stdout.trim();
    } catch {
      vars.project_structure = '(无法获取项目结构)';
    }
  }

  if (phase === 'reviewer' || phase === 'tester') {
    // 用 base-head 和 head_after 精确锁定 coder diff 范围,
    // 并行场景下避免读到其他任务的 commit
    const scopePaths = task.scope.length > 0 ? ['--', ...task.scope] : [];
    try {
      const signalsDir = join(flooDir, 'signals');
      const baseHead = (await readFile(join(signalsDir, `${task.id}-coder.base-head`), 'utf-8')).trim();
      let endRef = 'HEAD';
      try {
        const coderArtifact = await readExitArtifact(flooDir, task.id, 'coder');
        if (coderArtifact.head_after) endRef = coderArtifact.head_after;
      } catch { /* coder artifact 可能不存在 */ }

      if (baseHead) {
        const { stdout } = await exec('git', ['diff', baseHead, endRef, ...scopePaths], { cwd: projectRoot });
        vars.diff = stdout.trim();
      } else {
        const { stdout } = await exec(
          'git',
          ['diff-tree', '--no-commit-id', '-p', '--root', '-r', endRef, ...scopePaths],
          { cwd: projectRoot },
        );
        vars.diff = stdout.trim();
      }
    } catch {
      try {
        const { stdout } = await exec('git', ['diff', 'HEAD~1', ...scopePaths], { cwd: projectRoot });
        vars.diff = stdout.trim();
      } catch {
        vars.diff = '(无法获取 diff)';
      }
    }
  }

  if (phase === 'tester') {
    try {
      vars.review_feedback = await readFile(join(taskDir, 'review.md'), 'utf-8');
    } catch { /* 可能没有 review */ }
  }

  return loadSkill(skillsDir, phase, vars);
}
