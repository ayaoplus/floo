/**
 * 单 phase 执行(含重试)
 *
 * spawn agent → wait completion → 读 exit artifact → 写 run.json + 通知。
 * MAX_RETRIES 次数内,失败重试时把上轮 stderr 注入下一轮 prompt。
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  AgentAdapter,
  ExitArtifact,
  FlooConfig,
  Phase,
  RunRecord,
  SpawnOptions,
  Task,
} from '../types.js';
import { MAX_RETRIES } from '../types.js';
import { readExitArtifact, waitForCompletion } from '../adapters/base.js';
import type { TemplateVars } from '../skills/loader.js';
import { notify } from '../notifications.js';
import { extractLesson } from '../lessons.js';

import { log, saveRun, saveTask } from './io.js';
import { buildPrompt } from './prompt.js';

const exec = promisify(execFile);

/** 把 tmux session 完整输出写入 .floo/batches/.../logs/<runId>.log,供 Web UI 回放 */
export async function persistSessionOutput(
  flooDir: string,
  batchId: string,
  taskId: string,
  runId: string,
  adapter: AgentAdapter,
  sessionName: string,
): Promise<void> {
  try {
    const fullOutput = await adapter.getOutput(sessionName, 100000);
    const logsDir = join(flooDir, 'batches', batchId, 'tasks', taskId, 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(join(logsDir, `${runId}.log`), fullOutput);
  } catch (err) {
    await log(flooDir, 'session-output-capture-failed', { task: taskId, run: runId, error: String(err) });
  }
}

/**
 * 执行单个 phase(内部含 retry):
 *   1. 构建 prompt(失败时把上轮错误注入)
 *   2. spawn adapter
 *   3. 心跳更新 task.updated_at(供 health-check 判断)
 *   4. waitForCompletion(tmux wait-for)
 *   5. 持久化 session 输出 + run.json
 *   6. 解析 exit artifact:0=成功,-1=被外部 kill 立即停止,其他=进入下一次重试
 */
export async function executePhase(
  task: Task,
  phase: Phase,
  config: FlooConfig,
  flooDir: string,
  projectRoot: string,
  adapters: Record<string, AgentAdapter>,
  runCounter: number,
  callerExtraVars?: TemplateVars,
): Promise<{ success: boolean; exitArtifact?: ExitArtifact }> {
  const binding = task.role_overrides?.[phase] ?? config.roles[phase];
  const adapter = adapters[binding.runtime];
  if (!adapter) {
    throw new Error(`No adapter for runtime: ${binding.runtime}`);
  }

  let lastError = '';

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const runId = `${String(runCounter).padStart(3, '0')}-${phase}-${attempt}`;

    const extraVars: TemplateVars = { ...callerExtraVars };
    if (attempt > 1 && lastError) {
      extraVars.previous_error = lastError;
    }
    const prompt = await buildPrompt(projectRoot, flooDir, task, phase, extraVars);

    const run: RunRecord = {
      id: runId,
      task_id: task.id,
      phase,
      runtime: binding.runtime,
      model: binding.model,
      session_name: '',
      attempt,
      started_at: new Date().toISOString(),
      finished_at: null,
      exit_code: null,
      duration_seconds: null,
    };

    await log(flooDir, 'dispatch', {
      task: task.id, phase, runtime: binding.runtime, attempt,
    });

    const spawnOpts: SpawnOptions = {
      taskId: task.id,
      phase,
      prompt,
      cwd: projectRoot,
      runtime: binding.runtime,
      model: binding.model,
      // coder phase:runner 注入 git wrapper 串行化 git 写
      commitLock: phase === 'coder' && config.concurrency.commit_lock,
      // coder phase 传递 scope,用于 force-commit 兜底
      scope: phase === 'coder' ? task.scope : undefined,
    };

    const sessionName = await adapter.spawn(spawnOpts);
    run.session_name = sessionName;

    await notify(flooDir, 'phase_started', {
      batch_id: task.batch_id, task_id: task.id, phase,
      runtime: binding.runtime, model: binding.model, session: sessionName,
    });

    // 心跳:每 5 分钟刷新 updated_at,供 health-check 判断任务还活着
    const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
    const heartbeat = setInterval(async () => {
      try {
        task.updated_at = new Date().toISOString();
        await saveTask(flooDir, task);
        await log(flooDir, 'heartbeat', { task: task.id, phase });
      } catch { /* 心跳失败不影响主流程 */ }
    }, HEARTBEAT_INTERVAL_MS);

    try {
      const timeoutMs = config.session.timeout_minutes * 60 * 1000;
      await waitForCompletion(sessionName, flooDir, task.id, phase, timeoutMs);
    } finally {
      clearInterval(heartbeat);
    }

    await persistSessionOutput(flooDir, task.batch_id, task.id, runId, adapter, sessionName);

    const exitArtifact = await readExitArtifact(flooDir, task.id, phase);
    run.finished_at = exitArtifact.finished_at;
    run.exit_code = exitArtifact.exit_code;
    run.duration_seconds = exitArtifact.duration_seconds;
    await saveRun(flooDir, task.batch_id, task.id, run);

    await log(flooDir, 'callback', {
      task: task.id, phase, exit_code: exitArtifact.exit_code,
      duration: `${exitArtifact.duration_seconds}s`,
    });
    await notify(flooDir, 'phase_completed', {
      batch_id: task.batch_id, task_id: task.id, phase,
      exit_code: exitArtifact.exit_code, duration_seconds: exitArtifact.duration_seconds,
    });

    if (exitArtifact.exit_code === 0) {
      // 重试成功:自动提取经验教训(attempt > 1 说明前面有失败)
      if (attempt > 1 && lastError) {
        try {
          await extractLesson(flooDir, task.id, task.batch_id, phase, lastError, `Retry #${attempt} succeeded`);
          await log(flooDir, 'lesson-extracted', { task: task.id, phase, attempt });
        } catch { /* lesson 提取失败不影响主流程 */ }
      }
      return { success: true, exitArtifact };
    }

    if (exitArtifact.exit_code === -1) {
      // 被 floo cancel 终止 → 立即停止,不重试
      await log(flooDir, 'terminated', { task: task.id, phase, attempt });
      return { success: false, exitArtifact };
    }

    try {
      lastError = await adapter.getOutput(sessionName, 30);
    } catch {
      lastError = `Agent exited with code ${exitArtifact.exit_code}`;
    }
    await log(flooDir, 'retry', {
      task: task.id, phase, attempt: `${attempt}/${MAX_RETRIES}`,
    });
    await notify(flooDir, 'retry', {
      batch_id: task.batch_id, task_id: task.id, phase,
      attempt, max_retries: MAX_RETRIES, error: lastError.slice(0, 200),
    });
  }

  return { success: false };
}

// 工具:暴露给 dispatcher / runStateMachine 用的 git diff(目前未使用,留给后续 write_policy 校验)
export const _gitExec = exec;
export const _readFile = readFile;
