/**
 * Skill 模板加载器
 *
 * Step 3 引入 frontmatter:每个 skills/*.md 顶部以 `---` 包围一段 yaml,
 * 描述 capability metadata (name / write_policy / outputs / default_runtime / ...)。
 *
 * 向后兼容:
 *   - loadSkill(dir, name, vars) 老 API 保留,内部去掉 frontmatter 后渲染变量,行为与旧版一致
 *   - loadSkillWithMetadata(dir, name) 新 API 返回 { metadata, body },body 是未渲染模板
 *   - 缺 frontmatter 的文件不报错(把整个文件当 body),metadata 返回 null
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { CapabilityMetadata, Phase, Runtime, WritePolicy } from '../types.js';

/** 模板变量表 */
export type TemplateVars = Record<string, string>;

/** 解析结果:metadata 可为 null(无 frontmatter 时) */
export interface SkillFile {
  metadata: CapabilityMetadata | null;
  body: string;
}

const VALID_PHASES = new Set<Phase>(['discuss', 'designer', 'planner', 'coder', 'reviewer', 'tester']);
const VALID_RUNTIMES = new Set<Runtime>(['claude', 'codex']);
const VALID_POLICIES = new Set<WritePolicy>(['scope', 'artifacts_only', 'readonly']);

/**
 * 老 API:加载 skill 模板文件并替换变量
 * 模板中的 {{varName}} 会被替换为对应值,未匹配的变量保留原样
 *
 * @param skillsDir - skill 模板目录(如 /project/skills/)
 * @param skillName - 模板名(不含 .md 后缀,如 "designer")
 * @param vars - 要替换的变量
 */
export async function loadSkill(
  skillsDir: string,
  skillName: string,
  vars: TemplateVars,
): Promise<string> {
  const { body } = await loadSkillWithMetadata(skillsDir, skillName);
  return renderTemplate(body, vars);
}

/**
 * 新 API:加载 skill 文件,返回 frontmatter metadata 和模板 body(未渲染)
 *
 * 用途:
 *   - executor (Step 4+) 需要根据 metadata 强制 write_policy
 *   - UI / tooling 列出 capabilities
 *   - 单元测试验证 frontmatter 的存在与正确性
 */
export async function loadSkillWithMetadata(
  skillsDir: string,
  skillName: string,
): Promise<SkillFile> {
  const filePath = join(skillsDir, `${skillName}.md`);
  const raw = await readFile(filePath, 'utf-8');
  return parseSkillFile(raw, skillName);
}

/** 把 raw 文件内容拆成 frontmatter + body,纯函数,便于测试 */
export function parseSkillFile(raw: string, skillName: string): SkillFile {
  // frontmatter 必须是文件第一行 `---\n`,然后到下一个 `---\n`(或文件末尾)
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    return { metadata: null, body: raw };
  }
  // 在首行之后找闭合 `---`(允许尾部直接 EOF)
  const closePattern = /\n---\s*(\r?\n|$)/;
  const closeMatch = closePattern.exec(raw.slice(4));
  if (!closeMatch) {
    // 没有闭合,容错:把整个文件当 body,frontmatter 视为 null
    return { metadata: null, body: raw };
  }
  const closeIdx = 4 + closeMatch.index; // 闭合 `---` 在原文里的起始位置
  const yamlText = raw.slice(4, closeIdx);
  // body 从闭合后的换行之后开始
  const bodyStart = closeIdx + closeMatch[0].length;
  const body = raw.slice(bodyStart);

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (err) {
    throw new Error(`skill ${skillName}: frontmatter yaml 解析失败 — ${(err as Error).message}`);
  }
  const metadata = validateCapabilityMetadata(parsed, skillName);
  return { metadata, body };
}

/** schema 校验:frontmatter 字段齐全且取值合法 */
export function validateCapabilityMetadata(parsed: unknown, skillName: string): CapabilityMetadata {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`skill ${skillName}: frontmatter 顶层不是 object`);
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.name !== 'string' || !VALID_PHASES.has(obj.name as Phase)) {
    throw new Error(
      `skill ${skillName}: frontmatter.name "${String(obj.name)}" 非法 (允许:${[...VALID_PHASES].join('/')})`,
    );
  }
  if (typeof obj.write_policy !== 'string' || !VALID_POLICIES.has(obj.write_policy as WritePolicy)) {
    throw new Error(
      `skill ${skillName}: frontmatter.write_policy "${String(obj.write_policy)}" 非法 (允许:${[...VALID_POLICIES].join('/')})`,
    );
  }
  if (!Array.isArray(obj.outputs) || obj.outputs.length === 0 || !obj.outputs.every(o => typeof o === 'string')) {
    throw new Error(`skill ${skillName}: frontmatter.outputs 必须是非空 string 数组`);
  }
  if (typeof obj.default_runtime !== 'string' || !VALID_RUNTIMES.has(obj.default_runtime as Runtime)) {
    throw new Error(
      `skill ${skillName}: frontmatter.default_runtime "${String(obj.default_runtime)}" 非法 (允许:${[...VALID_RUNTIMES].join('/')})`,
    );
  }
  if (typeof obj.default_model !== 'string' || obj.default_model.length === 0) {
    throw new Error(`skill ${skillName}: frontmatter.default_model 缺失或非字符串`);
  }
  let inputs: string[] | undefined;
  if (obj.inputs !== undefined) {
    if (!Array.isArray(obj.inputs) || !obj.inputs.every(i => typeof i === 'string')) {
      throw new Error(`skill ${skillName}: frontmatter.inputs 必须是 string 数组`);
    }
    inputs = obj.inputs as string[];
  }

  return {
    name: obj.name as Phase,
    write_policy: obj.write_policy as WritePolicy,
    outputs: obj.outputs as string[],
    default_runtime: obj.default_runtime as Runtime,
    default_model: obj.default_model as string,
    ...(inputs ? { inputs } : {}),
  };
}

/**
 * 模板变量替换
 * 支持 {{var}} 格式,空格容错:{{ var }} 也能匹配
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    return key in vars ? vars[key] : match;
  });
}

/**
 * 从模板内容中提取所有变量名(用于调试和验证)
 */
export function extractVariables(template: string): string[] {
  const matches = template.matchAll(/\{\{\s*(\w+)\s*\}\}/g);
  const vars = new Set<string>();
  for (const m of matches) {
    vars.add(m[1]);
  }
  return [...vars];
}
