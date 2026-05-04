/**
 * Batch 整体 review
 *
 * 所有任务完成后,汇总 review/test 结论 + batch 整体 diff,派 reviewer agent
 * 写一份 summary.md 到 .floo/batches/<id>/。只读不改代码。
 */

import { readFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { AgentAdapter, Batch, FlooConfig, SpawnOptions, Task } from '../types.js';
import { waitForCompletion } from '../adapters/base.js';
import { log } from './io.js';

const exec = promisify(execFile);

/**
 * 跑批次整体 review。
 *
 * 1. 收集每个任务的 review/test verdict 摘要
 * 2. 用 batch base-head 算整体 diff
 * 3. 给 reviewer adapter 喂一份合成 prompt
 * 4. 收集 summary artifact 到 batch 目录
 *
 * 任何一步失败都只 log 不抛错,因为这是 batch 完成后的额外步骤,不应阻塞主流程。
 */
export async function runBatchSummaryReview(
  flooDir: string,
  batch: Batch,
  completedTasks: Task[],
  config: FlooConfig,
  projectRoot: string,
  adapters: Record<string, AgentAdapter>,
): Promise<void> {
  await log(flooDir, 'summary-review-start', { batch: batch.id, tasks: completedTasks.length });

  // 1. 各任务 verdict 摘要
  const taskSummaries: string[] = [];
  for (const task of completedTasks) {
    const taskDir = join(flooDir, 'batches', batch.id, 'tasks', task.id);
    let summary = `### ${task.id}: ${task.description}\n`;
    summary += `- Scope: ${task.scope.join(', ') || '(未指定)'}\n`;

    try {
      const review = await readFile(join(taskDir, 'review.md'), 'utf-8');
      summary += `- Review: ${review.match(/verdict:\s*(pass|fail)/i)?.[0] ?? '(无 verdict)'}\n`;
    } catch { /* 无 review */ }

    try {
      const testReport = await readFile(join(taskDir, 'test-report.md'), 'utf-8');
      summary += `- Test: ${testReport.match(/result:\s*(pass|fail)/i)?.[0] ?? '(无 result)'}\n`;
    } catch { /* 无 test-report */ }

    taskSummaries.push(summary);
  }

  // 2. 整体 diff (用 batch 创建时落盘的 base-head)
  let batchDiff = '';
  try {
    const signalsDir = join(flooDir, 'signals');
    const baseHead = (await readFile(join(signalsDir, `${batch.id}-batch.base-head`), 'utf-8')).trim();
    if (baseHead) {
      const { stdout } = await exec('git', ['diff', baseHead, 'HEAD'], { cwd: projectRoot });
      batchDiff = stdout.trim();
    } else {
      // 新仓库:用空树 diff 获取从零开始的累计变更
      const { stdout: emptyTree } = await exec('git', ['hash-object', '-t', 'tree', '/dev/null'], { cwd: projectRoot });
      const { stdout } = await exec('git', ['diff', emptyTree.trim(), 'HEAD'], { cwd: projectRoot });
      batchDiff = stdout.trim();
    }
  } catch {
    batchDiff = '(无法获取 diff)';
  }

  // 3. 合成 prompt
  const summaryOutputFile = 'summary.md';
  const prompt = `# 整体 Review — 批次总结报告

你是 Reviewer 角色，负责对本批次的所有变更进行整体审查。**这是只读报告，不修改代码。**

## 批次信息

- **批次 ID**：${batch.id}
- **描述**：${batch.description}
- **完成任务数**：${completedTasks.length}

## 各任务概况

${taskSummaries.join('\n')}

## 整体代码变更

\`\`\`diff
${batchDiff.slice(0, 50000)}
\`\`\`

## 输出要求

将以下内容写入当前目录的 \`${batch.id}-summary.md\` 文件。

### 格式

\`\`\`markdown
# 批次整体 Review

## 概述
（1-3 句话总结本批次的整体质量）

## 各任务评估
（逐个任务简要评价）

## 跨任务问题
（不同任务之间的一致性、接口兼容性、重复代码等）

## 风险点
（潜在的技术债务、性能风险、安全隐患）

## 建议
（后续改进方向，供用户决定是否开新批次）
\`\`\`

## 约束

- **只读不改代码**，只输出报告
- 报告要简洁有用，不做开放式评判
- 聚焦跨任务的整体质量，不重复各任务 review 已覆盖的内容
`;

  // 4. 用 reviewer 配置启动
  const binding = config.roles.reviewer;
  const adapter = adapters[binding.runtime];
  if (!adapter) {
    await log(flooDir, 'summary-review-skip', { reason: `no adapter for ${binding.runtime}` });
    return;
  }

  const summaryTaskId = `summary-${batch.id}`;
  const summaryTask: Task = {
    id: summaryTaskId,
    batch_id: batch.id,
    description: `整体 Review: ${batch.description}`,
    status: 'running',
    current_phase: 'reviewer',
    scope: [],
    acceptance_criteria: [],
    review_level: 'full',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    depends_on: [],
  };

  const spawnOpts: SpawnOptions = {
    taskId: summaryTask.id,
    phase: 'reviewer',
    prompt,
    cwd: projectRoot,
    runtime: binding.runtime,
    model: binding.model,
  };

  try {
    const sessionName = await adapter.spawn(spawnOpts);
    const timeoutMs = config.session.timeout_minutes * 60 * 1000;
    await waitForCompletion(sessionName, flooDir, summaryTask.id, 'reviewer', timeoutMs);

    const artifactSrc = join(projectRoot, `${batch.id}-summary.md`);
    const artifactDest = join(flooDir, 'batches', batch.id, summaryOutputFile);
    try {
      await copyFile(artifactSrc, artifactDest);
      await log(flooDir, 'summary-review-done', { batch: batch.id, file: summaryOutputFile });
    } catch {
      await log(flooDir, 'summary-review-artifact-missing', { batch: batch.id });
    }
  } catch (err) {
    await log(flooDir, 'summary-review-failed', { batch: batch.id, error: String(err) });
  }
}
