/**
 * floo.config.json 加载 + 与 DEFAULT_CONFIG 合并。
 *
 * 失败语义(Step 6 review fix #6):
 *   - 文件不存在 (ENOENT) → 用 DEFAULT_CONFIG(常见,新仓库未 floo init)
 *   - 文件存在但读/解析失败 → 抛错(fail-fast)
 *
 * 之前的实现 catch 一切错误统一回退默认,坏 config 会被静默忽略,
 * 用户可能在不知情的情况下用 DEFAULT_CONFIG.runtimes / protected_files 跑任务。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_CONFIG, type FlooConfig } from './types.js';

/**
 * 同步加载 floo.config.json。
 *
 * @param cwd 项目根目录(包含 floo.config.json 的目录)
 * @returns 合并后的 FlooConfig;文件不存在时返回 DEFAULT_CONFIG
 * @throws 如果文件存在但读取/解析失败
 */
export function loadFlooConfig(cwd: string): FlooConfig {
  const path = join(cwd, 'floo.config.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return DEFAULT_CONFIG;
    }
    throw new Error(`floo.config.json 读取失败 (${path}): ${err instanceof Error ? err.message : err}`);
  }

  // 用户 config 是部分字段 + 可能含未知字段,放宽到 Record 后逐字段合并
  let userConfig: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('floo.config.json 顶层必须是 object');
    }
    userConfig = parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(`floo.config.json 解析失败 (${path}): ${err instanceof Error ? err.message : err}`);
  }

  // DEFAULT_CONFIG.limits / runtimes 必有值,user 部分 spread 不会引入 undefined,
  // 类型断言避免 spread 后的 Partial 推断
  return {
    roles: { ...DEFAULT_CONFIG.roles, ...(userConfig.roles as FlooConfig['roles'] | undefined) },
    concurrency: { ...DEFAULT_CONFIG.concurrency, ...(userConfig.concurrency as FlooConfig['concurrency'] | undefined) },
    session: { ...DEFAULT_CONFIG.session, ...(userConfig.session as FlooConfig['session'] | undefined) },
    limits: { ...DEFAULT_CONFIG.limits!, ...(userConfig.limits as FlooConfig['limits']) },
    // runtimes:用户 entry 整体覆盖默认 entry(避免 args 数组拼接的二义性)
    runtimes: { ...DEFAULT_CONFIG.runtimes!, ...(userConfig.runtimes as FlooConfig['runtimes']) },
    protected_files: (userConfig.protected_files as string[] | undefined) ?? DEFAULT_CONFIG.protected_files,
  };
}
