/**
 * Agent Adapter 基础层
 * 封装 tmux 操作和 floo-runner 逻辑。具体 runtime adapter（claude.ts, codex.ts）继承此类。
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, access, chmod, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentAdapter, SpawnOptions, ExitArtifact, Runtime } from '../types.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const exec = promisify(execFile);

// ============================================================
// tmux 底层操作
// ============================================================

/** 执行 tmux 命令，返回 stdout */
async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await exec('tmux', args);
  return stdout.trim();
}

/** 检查 tmux session 是否存在 */
async function sessionExists(name: string): Promise<boolean> {
  try {
    await tmux('has-session', '-t', name);
    return true;
  } catch {
    return false;
  }
}

/** 获取 tmux session 最后 N 行输出 */
async function captureOutput(name: string, lines: number): Promise<string> {
  try {
    return await tmux('capture-pane', '-t', name, '-p', '-S', `-${lines}`);
  } catch {
    return '';
  }
}

/** 向 tmux session 发送按键序列 */
async function sendKeys(name: string, keys: string): Promise<void> {
  await tmux('send-keys', '-t', name, keys, 'Enter');
}

/**
 * 收集当前 repo 中所有变更文件（staged + unstaged + untracked）
 * kill() 调用时用，因为此时没有 BASE_HEAD 信息，只能看当前状态
 */
async function collectChangedFiles(cwd: string): Promise<string[]> {
  const files: string[] = [];

  // staged + unstaged（新仓库无 commit 时 HEAD 不存在，会失败，单独 catch）
  try {
    const { stdout } = await exec('git', ['diff', '--name-only', 'HEAD'], { cwd });
    files.push(...stdout.split('\n'));
  } catch {
    // 无 HEAD（新仓库），尝试列出 staged 文件
    try {
      const { stdout } = await exec('git', ['diff', '--name-only', '--cached'], { cwd });
      files.push(...stdout.split('\n'));
    } catch { /* ignore */ }
  }

  // untracked 文件（独立获取，不受 HEAD 影响）
  try {
    const { stdout } = await exec(
      'git', ['ls-files', '--others', '--exclude-standard'], { cwd },
    );
    files.push(...stdout.split('\n'));
  } catch { /* ignore */ }

  return [...new Set(files.map(f => f.trim()).filter(f => f.length > 0))];
}

/** 安全删除文件（不存在时不报错） */
async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // 文件不存在，忽略
  }
}

/** 强制关闭 tmux session */
async function killSession(name: string): Promise<void> {
  try {
    await tmux('kill-session', '-t', name);
  } catch {
    // session 可能已经不存在了，忽略
  }
}

// ============================================================
// floo-runner shell 脚本生成
// ============================================================

/**
 * 生成 floo-runner shell 脚本内容
 * 执行流程：运行 agent → 收集 git diff → 写 exit artifact → 发 tmux wait-for 信号
 */
function buildRunnerScript(opts: {
  agentCommand: string;
  sessionName: string;
  taskId: string;
  phase: string;
  cwd: string;
  signalsDir: string;
}): string {
  const { agentCommand, sessionName, taskId, phase, cwd, signalsDir } = opts;
  const exitFile = join(signalsDir, `${taskId}-${phase}.exit`);

  return `#!/bin/bash
set -e
cd '${cwd}'

# 记录启动前的 HEAD，用于后续 diff 比较
BASE_HEAD=$(git rev-parse HEAD 2>/dev/null || echo "")

# 运行 agent，捕获退出码（不要因为 agent 失败就中断脚本）
START_TIME=$(date -u +%s)
set +e
${agentCommand}
EXIT_CODE=$?
set -e

END_TIME=$(date -u +%s)
DURATION=$((END_TIME - START_TIME))
FINISHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# 收集所有变更文件：committed + staged + unstaged + untracked
FILES_JSON="[]"
if git rev-parse --git-dir > /dev/null 2>&1; then
  FILES_CHANGED=""
  # 1. 对比 base HEAD 到当前 HEAD 的 committed changes
  CURRENT_HEAD=$(git rev-parse HEAD 2>/dev/null || echo "")
  if [ -n "$BASE_HEAD" ] && [ -n "$CURRENT_HEAD" ] && [ "$BASE_HEAD" != "$CURRENT_HEAD" ]; then
    FILES_CHANGED=$(git diff --name-only "$BASE_HEAD" "$CURRENT_HEAD" 2>/dev/null)
  fi
  # 2. staged + unstaged changes
  WORKING_CHANGES=$(git diff --name-only HEAD 2>/dev/null)
  # 3. untracked files
  UNTRACKED=$(git ls-files --others --exclude-standard 2>/dev/null)
  # 合并去重
  FILES_CHANGED=$(printf '%s\\n%s\\n%s' "$FILES_CHANGED" "$WORKING_CHANGES" "$UNTRACKED" | sort -u | sed '/^$/d' | head -100)
  if [ -n "$FILES_CHANGED" ]; then
    FILES_JSON=$(echo "$FILES_CHANGED" | awk 'BEGIN{printf "["} NR>1{printf ","} {printf "\\"%s\\"", $0} END{printf "]"}')
  fi
fi

# 写 exit artifact
mkdir -p '${signalsDir}'
cat > '${exitFile}' << EXITEOF
{
  "task_id": "${taskId}",
  "phase": "${phase}",
  "session_name": "${sessionName}",
  "exit_code": $EXIT_CODE,
  "finished_at": "$FINISHED_AT",
  "duration_seconds": $DURATION,
  "files_changed": $FILES_JSON
}
EXITEOF

# 发 tmux wait-for 信号
tmux wait-for -S '${sessionName}-done' 2>/dev/null || true
`;
}

// ============================================================
// BaseAdapter：所有 runtime adapter 的基类
// ============================================================

export abstract class BaseAdapter implements AgentAdapter {
  abstract runtime: Runtime;

  /** 子类实现：构建具体 agent 的 CLI 命令 */
  protected abstract buildAgentCommand(opts: SpawnOptions): string;

  /**
   * 启动 agent session
   * 写一个 runner 脚本到 .floo/signals/，tmux 执行该脚本
   * 脚本结束后自动写 exit artifact + 发 wait-for 信号
   */
  async spawn(opts: SpawnOptions): Promise<string> {
    const sessionName = `floo-${opts.taskId}-${opts.phase}`;
    const signalsDir = join(opts.cwd, '.floo', 'signals');

    // 确保 signals 目录存在
    await mkdir(signalsDir, { recursive: true });

    // 清理旧的 exit artifact 和脚本，防止重试时读到 stale 数据
    const exitFile = join(signalsDir, `${opts.taskId}-${opts.phase}.exit`);
    const oldScript = join(signalsDir, `${opts.taskId}-${opts.phase}.sh`);
    await safeUnlink(exitFile);
    await safeUnlink(oldScript);

    // 如果同名 session 已存在，先清理
    if (await sessionExists(sessionName)) {
      await killSession(sessionName);
    }

    // 生成 runner 脚本并写入文件
    const agentCommand = this.buildAgentCommand(opts);
    const script = buildRunnerScript({
      agentCommand,
      sessionName,
      taskId: opts.taskId,
      phase: opts.phase,
      cwd: opts.cwd,
      signalsDir,
    });

    const scriptPath = join(signalsDir, `${opts.taskId}-${opts.phase}.sh`);
    await writeFile(scriptPath, script);
    await chmod(scriptPath, 0o755);

    // 启动 tmux session，执行 runner 脚本
    await tmux(
      'new-session', '-d',
      '-s', sessionName,
      '-c', opts.cwd,
      scriptPath,
    );

    return sessionName;
  }

  async isAlive(sessionName: string): Promise<boolean> {
    return sessionExists(sessionName);
  }

  async getOutput(sessionName: string, lines = 50): Promise<string> {
    return captureOutput(sessionName, lines);
  }

  async sendMessage(sessionName: string, msg: string): Promise<void> {
    await sendKeys(sessionName, msg);
  }

  /**
   * 强制终止 session 并写入 exit artifact
   * kill 后 floo-runner 脚本不会执行到写文件步骤，所以这里主动补写
   */
  async kill(sessionName: string, cwd: string, taskId: string, phase: string): Promise<void> {
    await killSession(sessionName);

    // 收集 agent 被终止前已经产生的文件变更
    const filesChanged = await collectChangedFiles(cwd);

    // 主动写 exit artifact，标记为被终止（exit_code = -1）
    const signalsDir = join(cwd, '.floo', 'signals');
    await mkdir(signalsDir, { recursive: true });
    const exitFile = join(signalsDir, `${taskId}-${phase}.exit`);

    const artifact: ExitArtifact = {
      task_id: taskId,
      phase: phase as ExitArtifact['phase'],
      session_name: sessionName,
      exit_code: -1,  // 特殊值：被外部终止
      finished_at: new Date().toISOString(),
      duration_seconds: -1,
      files_changed: filesChanged,
    };

    await writeFile(exitFile, JSON.stringify(artifact, null, 2));
  }
}

// ============================================================
// Exit Artifact 读取
// ============================================================

/**
 * 读取 exit artifact 文件
 * dispatcher 在收到 wait-for 信号后调用
 */
export async function readExitArtifact(
  flooDir: string,
  taskId: string,
  phase: string,
): Promise<ExitArtifact> {
  const filePath = join(flooDir, 'signals', `${taskId}-${phase}.exit`);
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as ExitArtifact;
}

/**
 * 等待 agent 完成
 * 优先用 tmux wait-for（零延迟），如果 tmux server 不可用则退化为轮询 exit artifact 文件
 */
export async function waitForCompletion(
  sessionName: string,
  flooDir: string,
  taskId: string,
  phase: string,
): Promise<void> {
  // 先尝试 tmux wait-for
  try {
    await tmux('wait-for', `${sessionName}-done`);
    return;
  } catch {
    // tmux server 可能已退出（session 结束太快），退化为文件轮询
  }

  // 轮询 exit artifact 文件是否存在
  const exitPath = join(flooDir, 'signals', `${taskId}-${phase}.exit`);
  const maxWait = 60_000; // 最多等 60 秒
  const interval = 200;   // 每 200ms 检查一次
  let waited = 0;

  while (waited < maxWait) {
    try {
      await access(exitPath);
      return; // 文件存在，agent 已完成
    } catch {
      await sleep(interval);
      waited += interval;
    }
  }

  throw new Error(`Timeout waiting for ${sessionName} to complete`);
}
