/**
 * floo config — 交互式配置向导
 *
 * 两种模式：
 *   Quick Start — 3个问题搞定（并发数、review轮数、runtime预设）
 *   Manual      — 逐项配置所有字段
 *
 * 读写 floo.config.json，向前兼容老配置（无 limits 字段）。
 */

import { Command } from 'commander';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { FlooConfig, Phase, Runtime } from '../core/types.js';
import { DEFAULT_CONFIG } from '../core/types.js';

// ============================================================
// 答案类型（纯数据，便于单元测试）
// ============================================================

export interface QuickStartAnswers {
  max_agents: number;
  max_review_rounds: number;
  /** 'all-claude' | 'all-codex' | 'keep' */
  runtime_preset: 'all-claude' | 'all-codex' | 'keep';
}

export interface ManualAnswers {
  roles: Record<Phase, { runtime: Runtime; model: string }>;
  max_agents: number;
  commit_lock: boolean;
  timeout_minutes: number;
  keep_on_success_minutes: number;
  keep_on_failure_minutes: number;
  orphan_check_interval_minutes: number;
  max_review_rounds: number;
  max_test_rounds: number;
  /** 追加到 protected_files 的新条目（去重由 applyManual 处理） */
  extra_protected_files: string[];
}

// ============================================================
// 纯函数：将答案应用到配置（与 I/O 解耦，便于测试）
// ============================================================

/**
 * 将 Quick Start 答案合并到现有配置，返回新配置（不修改原对象）
 */
export function applyQuickStart(config: FlooConfig, answers: QuickStartAnswers): FlooConfig {
  const next = structuredClone(config);
  next.concurrency.max_agents = answers.max_agents;

  // 确保 limits 字段存在
  next.limits ??= { max_review_rounds: 2, max_test_rounds: 2, max_discuss_rounds: 2 };
  next.limits.max_review_rounds = answers.max_review_rounds;

  if (answers.runtime_preset === 'all-claude') {
    for (const phase of Object.keys(next.roles) as Phase[]) {
      next.roles[phase] = { runtime: 'claude', model: 'sonnet' };
    }
  } else if (answers.runtime_preset === 'all-codex') {
    for (const phase of Object.keys(next.roles) as Phase[]) {
      next.roles[phase] = { runtime: 'codex', model: 'codex-mini' };
    }
  }
  // 'keep' → 不改 roles

  return next;
}

/**
 * 将 Manual 答案合并到现有配置，返回新配置（不修改原对象）
 */
export function applyManual(config: FlooConfig, answers: ManualAnswers): FlooConfig {
  const next = structuredClone(config);

  next.roles = structuredClone(answers.roles);
  next.concurrency.max_agents = answers.max_agents;
  next.concurrency.commit_lock = answers.commit_lock;
  next.session.timeout_minutes = answers.timeout_minutes;
  next.session.keep_on_success_minutes = answers.keep_on_success_minutes;
  next.session.keep_on_failure_minutes = answers.keep_on_failure_minutes;
  next.session.orphan_check_interval_minutes = answers.orphan_check_interval_minutes;

  next.limits ??= { max_review_rounds: 2, max_test_rounds: 2, max_discuss_rounds: 2 };
  next.limits.max_review_rounds = answers.max_review_rounds;
  next.limits.max_test_rounds = answers.max_test_rounds;

  // 追加保护文件（去重）
  const existing = new Set(next.protected_files);
  for (const f of answers.extra_protected_files) {
    if (f && !existing.has(f)) {
      next.protected_files.push(f);
      existing.add(f);
    }
  }

  return next;
}

/**
 * 生成配置变更摘要（前后对比）
 * 返回变更行数组，空数组表示无变化
 */
export function diffConfig(before: FlooConfig, after: FlooConfig): string[] {
  const changes: string[] = [];

  // 并发
  if (before.concurrency.max_agents !== after.concurrency.max_agents) {
    changes.push(`  max_agents: ${before.concurrency.max_agents} → ${after.concurrency.max_agents}`);
  }
  if (before.concurrency.commit_lock !== after.concurrency.commit_lock) {
    changes.push(`  commit_lock: ${before.concurrency.commit_lock} → ${after.concurrency.commit_lock}`);
  }

  // 轮数限制
  const bReview = before.limits?.max_review_rounds ?? 2;
  const aReview = after.limits?.max_review_rounds ?? 2;
  if (bReview !== aReview) {
    changes.push(`  max_review_rounds: ${bReview} → ${aReview}`);
  }
  const bTest = before.limits?.max_test_rounds ?? 2;
  const aTest = after.limits?.max_test_rounds ?? 2;
  if (bTest !== aTest) {
    changes.push(`  max_test_rounds: ${bTest} → ${aTest}`);
  }

  // 角色
  for (const phase of Object.keys(before.roles) as Phase[]) {
    const b = before.roles[phase];
    const a = after.roles[phase];
    if (b.runtime !== a.runtime || b.model !== a.model) {
      changes.push(`  ${phase}: ${b.runtime}/${b.model} → ${a.runtime}/${a.model}`);
    }
  }

  // session 超时
  const sessionKeys = [
    'timeout_minutes',
    'keep_on_success_minutes',
    'keep_on_failure_minutes',
    'orphan_check_interval_minutes',
  ] as const;
  for (const key of sessionKeys) {
    if (before.session[key] !== after.session[key]) {
      changes.push(`  session.${key}: ${before.session[key]} → ${after.session[key]}`);
    }
  }

  // 新增保护文件
  const bFiles = new Set(before.protected_files);
  const added = after.protected_files.filter(f => !bFiles.has(f));
  if (added.length > 0) {
    changes.push(`  protected_files 新增: ${added.join(', ')}`);
  }

  return changes;
}

// ============================================================
// readline 交互封装
// ============================================================

/** Promise-based readline 工具，用完必须调 close() 否则进程不退出 */
class Prompt {
  private rl: ReturnType<typeof createInterface>;

  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout });
  }

  /** 打印分节标题 */
  section(title: string): void {
    console.log(`\n── ${title} ──`);
  }

  /**
   * 文本输入。defaultVal 非空时回车采用默认值。
   */
  ask(label: string, defaultVal = ''): Promise<string> {
    const hint = defaultVal ? ` [${defaultVal}]` : '';
    return new Promise(resolve => {
      this.rl.question(`? ${label}${hint}: `, answer => {
        resolve(answer.trim() || defaultVal);
      });
    });
  }

  /**
   * 数字选单。显示编号列表，用户输入序号；非法输入 fallback 到 defaultIdx。
   * 返回 0-based 索引。
   */
  async select(label: string, options: string[], defaultIdx = 0): Promise<number> {
    console.log(`? ${label}`);
    options.forEach((opt, i) => {
      const marker = i === defaultIdx ? '❯' : ' ';
      console.log(`  ${marker} ${i + 1}) ${opt}`);
    });
    const raw = await this.ask('选择', String(defaultIdx + 1));
    const n = parseInt(raw, 10);
    if (isNaN(n) || n < 1 || n > options.length) return defaultIdx;
    return n - 1;
  }

  /** Y/n 确认 */
  async confirm(label: string, defaultYes = true): Promise<boolean> {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    const raw = await this.ask(`${label} (${hint})`, defaultYes ? 'Y' : 'N');
    return raw.toLowerCase() === 'y';
  }

  /** 关闭 readline，让进程正常退出 */
  close(): void {
    this.rl.close();
  }
}

// ============================================================
// Quick Start 向导（3个问题）
// ============================================================

async function runQuickStart(config: FlooConfig, p: Prompt): Promise<FlooConfig> {
  p.section('Quick Start');

  // 并发数：当前值映射到选项索引（clamp 到 0-2）
  const agentDefault = Math.min(Math.max(config.concurrency.max_agents - 1, 0), 2);
  const agentIdx = await p.select(
    '最多同时跑几个 agent？',
    ['1个（安全，适合小项目）', '2个（推荐）', '3个（激进）'],
    agentDefault,
  );

  // Review 轮数
  const curReview = config.limits?.max_review_rounds ?? 2;
  const reviewDefault = Math.min(Math.max(curReview - 1, 0), 2);
  const reviewIdx = await p.select(
    'Review 最多几轮？',
    ['1轮（快）', '2轮（推荐）', '3轮（严格）'],
    reviewDefault,
  );

  // Runtime 预设：根据当前配置推断默认选项
  const allClaude = Object.values(config.roles).every(r => r.runtime === 'claude');
  const allCodex = Object.values(config.roles).every(r => r.runtime === 'codex');
  const runtimeDefault = allClaude ? 0 : allCodex ? 1 : 2;
  const runtimeIdx = await p.select(
    '各角色默认用哪个 runtime？',
    ['全部 Claude（稳定）', '全部 Codex（便宜）', '保持现有混合'],
    runtimeDefault,
  );

  const presets = ['all-claude', 'all-codex', 'keep'] as const;
  return applyQuickStart(config, {
    max_agents: agentIdx + 1,
    max_review_rounds: reviewIdx + 1,
    runtime_preset: presets[runtimeIdx],
  });
}

// ============================================================
// Manual 向导（逐项配置）
// ============================================================

async function runManual(config: FlooConfig, p: Prompt): Promise<FlooConfig> {
  const phases: Phase[] = ['designer', 'planner', 'coder', 'reviewer', 'tester'];

  // 角色配置
  p.section('角色配置');
  const roles = structuredClone(config.roles);
  for (const phase of phases) {
    const cur = roles[phase];
    const runtime = (await p.ask(`${phase} runtime`, cur.runtime)) as Runtime;
    const model = await p.ask(`${phase} model`, cur.model);
    roles[phase] = { runtime, model };
  }

  // 并发
  p.section('并发');
  const agentsRaw = await p.ask('最大并发 agent 数', String(config.concurrency.max_agents));
  const max_agents = Math.max(1, parseInt(agentsRaw, 10) || config.concurrency.max_agents);
  const commit_lock = await p.confirm('开启 commit lock？', config.concurrency.commit_lock);

  // 超时
  p.section('超时（分钟）');
  const parseMin = (raw: string, fallback: number) => Math.max(1, parseInt(raw, 10) || fallback);
  const timeout_minutes = parseMin(
    await p.ask('session 超时', String(config.session.timeout_minutes)),
    config.session.timeout_minutes,
  );
  const keep_on_success_minutes = parseMin(
    await p.ask('成功后保留', String(config.session.keep_on_success_minutes)),
    config.session.keep_on_success_minutes,
  );
  const keep_on_failure_minutes = parseMin(
    await p.ask('失败后保留', String(config.session.keep_on_failure_minutes)),
    config.session.keep_on_failure_minutes,
  );
  const orphan_check_interval_minutes = parseMin(
    await p.ask('孤儿检查间隔', String(config.session.orphan_check_interval_minutes)),
    config.session.orphan_check_interval_minutes,
  );

  // 轮数限制
  p.section('轮数限制');
  const curReview = config.limits?.max_review_rounds ?? 2;
  const curTest = config.limits?.max_test_rounds ?? 2;
  const max_review_rounds = Math.max(1, parseInt(
    await p.ask('最大 review 轮数', String(curReview)), 10) || curReview,
  );
  const max_test_rounds = Math.max(1, parseInt(
    await p.ask('最大 test 轮数', String(curTest)), 10) || curTest,
  );

  // 保护文件
  p.section('保护文件');
  console.log(`  当前：${config.protected_files.join(', ')}`);
  const extraRaw = await p.ask('追加（逗号分隔，直接回车跳过）', '');
  const extra_protected_files = extraRaw
    ? extraRaw.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  return applyManual(config, {
    roles,
    max_agents,
    commit_lock,
    timeout_minutes,
    keep_on_success_minutes,
    keep_on_failure_minutes,
    orphan_check_interval_minutes,
    max_review_rounds,
    max_test_rounds,
    extra_protected_files,
  });
}

// ============================================================
// 配置文件读取
// ============================================================

/** 读取 floo.config.json；不存在或解析失败时返回 DEFAULT_CONFIG 的深拷贝 */
async function loadConfig(cwd: string): Promise<FlooConfig> {
  const configPath = join(cwd, 'floo.config.json');
  try {
    const content = await readFile(configPath, 'utf-8');
    return JSON.parse(content) as FlooConfig;
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

// ============================================================
// CLI 命令
// ============================================================

export const configCommand = new Command('config')
  .description('交互式配置向导（Quick Start 或 Manual）')
  .action(async () => {
    const cwd = process.cwd();
    const configPath = join(cwd, 'floo.config.json');
    const before = await loadConfig(cwd);

    const p = new Prompt();
    console.log('\n== Floo 配置向导 ==');

    const modeIdx = await p.select(
      '选择配置方式',
      [
        'Quick Start（3步完成，其余保持默认）',
        'Manual（完整配置每一项）',
        '查看当前配置',
        '退出',
      ],
      0,
    );

    // 退出
    if (modeIdx === 3) {
      p.close();
      return;
    }

    // 查看当前配置
    if (modeIdx === 2) {
      console.log('\n当前配置：');
      console.log(JSON.stringify(before, null, 2));
      p.close();
      return;
    }

    let after: FlooConfig;
    try {
      after = modeIdx === 0
        ? await runQuickStart(before, p)
        : await runManual(before, p);
    } finally {
      // 无论是否出错，都要关闭 readline，避免进程挂起
      p.close();
    }

    const changes = diffConfig(before, after);
    if (changes.length === 0) {
      console.log('\n无变化，配置未修改。');
      return;
    }

    await writeFile(configPath, JSON.stringify(after, null, 2) + '\n');
    console.log(`\n✓ 配置已更新：${configPath}`);
    changes.forEach(line => console.log(line));
  });
