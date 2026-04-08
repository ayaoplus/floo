/**
 * Skill 模板加载器
 * 从 markdown 文件加载 skill 模板，替换 {{var}} 变量，输出完整 prompt
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 模板变量表 */
export type TemplateVars = Record<string, string>;

/**
 * 加载 skill 模板文件并替换变量
 * 模板中的 {{varName}} 会被替换为对应值，未匹配的变量保留原样
 *
 * @param skillsDir - skill 模板目录（如 /project/skills/）
 * @param skillName - 模板名（不含 .md 后缀，如 "designer"）
 * @param vars - 要替换的变量
 */
export async function loadSkill(
  skillsDir: string,
  skillName: string,
  vars: TemplateVars,
): Promise<string> {
  const filePath = join(skillsDir, `${skillName}.md`);
  const template = await readFile(filePath, 'utf-8');
  return renderTemplate(template, vars);
}

/**
 * 模板变量替换
 * 支持 {{var}} 格式，空格容错：{{ var }} 也能匹配
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    return key in vars ? vars[key] : match;
  });
}

/**
 * 从模板内容中提取所有变量名（用于调试和验证）
 */
export function extractVariables(template: string): string[] {
  const matches = template.matchAll(/\{\{\s*(\w+)\s*\}\}/g);
  const vars = new Set<string>();
  for (const m of matches) {
    vars.add(m[1]);
  }
  return [...vars];
}
