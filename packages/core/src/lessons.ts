/**
 * Lessons — 经验教训记录与规则蒸馏
 * 记录项目中遇到的问题和解决方案，积累后自动蒸馏为项目规则。
 * 存储位置：.floo/lessons/ (单条经验)、.floo/context/project-rules.md (蒸馏规则)
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** 单条经验教训 */
export interface Lesson {
  problem: string;      // 问题描述
  cause?: string;       // 原因（可选）
  solution: string;     // 解决方案
  tags: string[];       // 标签
}

/** 经验记录（含元数据，用于列表展示） */
export interface LessonRecord {
  id: string;           // 文件名（不含 .md）
  date: string;         // 日期 yyyy-MM-dd
  problem: string;
  solution: string;
  tags: string[];
}

/**
 * 生成日期前缀（yyyy-MM-dd 格式）
 */
function datePrefix(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 将文本转为 URL 安全的 slug
 * 保留英文字母、数字和连字符，中文等非 ASCII 字符直接丢弃
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'lesson';
}

/**
 * 将 Lesson 对象序列化为 markdown 格式
 */
function formatLesson(lesson: Lesson): string {
  const lines: string[] = [];
  lines.push('# 问题');
  lines.push(lesson.problem);
  lines.push('');

  if (lesson.cause) {
    lines.push('# 原因');
    lines.push(lesson.cause);
    lines.push('');
  }

  lines.push('# 解决');
  lines.push(lesson.solution);
  lines.push('');

  lines.push('# 标签');
  lines.push(lesson.tags.join(', '));
  lines.push('');

  return lines.join('\n');
}

/**
 * 从 markdown 内容解析出 LessonRecord（宽松解析，缺字段不报错）
 */
function parseLesson(content: string, filename: string): LessonRecord | null {
  const id = filename.replace(/\.md$/, '');

  // 提取日期：文件名前 10 个字符应为 yyyy-MM-dd
  const dateMatch = id.match(/^(\d{4}-\d{2}-\d{2})/);
  const date = dateMatch ? dateMatch[1] : 'unknown';

  // 按一级标题拆分 sections
  const sections = new Map<string, string>();
  const sectionRegex = /^# (.+)$/gm;
  let match: RegExpExecArray | null;
  const positions: Array<{ title: string; start: number }> = [];

  while ((match = sectionRegex.exec(content)) !== null) {
    positions.push({ title: match[1].trim(), start: match.index + match[0].length });
  }

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].start;
    const end = i + 1 < positions.length ? positions[i + 1].start - positions[i + 1].title.length - 2 : content.length;
    sections.set(positions[i].title, content.slice(start, end).trim());
  }

  const problem = sections.get('问题') ?? '';
  const solution = sections.get('解决') ?? '';
  const tagsRaw = sections.get('标签') ?? '';
  const tags = tagsRaw
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

  if (!problem && !solution) return null;

  return { id, date, problem, solution, tags };
}

// ============================================================
// 公开 API
// ============================================================

/**
 * 添加一条经验教训
 * 写入 .floo/lessons/{date}-{slug}.md
 */
export async function addLesson(flooDir: string, lesson: Lesson): Promise<string> {
  const dir = join(flooDir, 'lessons');
  await mkdir(dir, { recursive: true });

  const date = datePrefix();
  const slug = slugify(lesson.problem);
  // 加时间戳后缀（HHmmss）防止同日同 slug 覆盖，中文问题 slug 为空时也能唯一
  const timeSuffix = new Date().toISOString().slice(11, 19).replace(/:/g, '');
  const id = `${date}-${timeSuffix}-${slug}`;
  const filename = `${id}.md`;

  await writeFile(join(dir, filename), formatLesson(lesson));
  return id;
}

/**
 * 从失败重试中自动提取经验教训
 * dispatcher 在某个 phase 失败后重试成功时调用。
 * 只记录原始事实，不做 AI 生成。
 */
export async function extractLesson(
  flooDir: string,
  taskId: string,
  batchId: string,
  failedPhase: string,
  errorContext: string,
  successContext: string,
): Promise<string> {
  const lesson: Lesson = {
    problem: `Task ${taskId} (batch ${batchId}) failed at phase "${failedPhase}"`,
    cause: errorContext.slice(0, 500) || undefined,
    solution: successContext.slice(0, 500),
    tags: [failedPhase, 'auto-extracted', 'retry-success'],
  };

  return addLesson(flooDir, lesson);
}

/**
 * 列出所有经验教训（按文件名排序，即时间正序）
 */
export async function listLessons(flooDir: string): Promise<LessonRecord[]> {
  const dir = join(flooDir, 'lessons');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const mdFiles = entries.filter(f => f.endsWith('.md')).sort();
  const records: LessonRecord[] = [];

  for (const file of mdFiles) {
    try {
      const content = await readFile(join(dir, file), 'utf-8');
      const record = parseLesson(content, file);
      if (record) records.push(record);
    } catch {
      // 跳过损坏的文件
    }
  }

  return records;
}

/**
 * 蒸馏规则：读取所有经验，按标签分组，生成 project-rules.md
 * 只聚合出现 2 次以上的标签（模式检测），不依赖 AI。
 */
export async function distillRules(flooDir: string): Promise<void> {
  const lessons = await listLessons(flooDir);

  // 生成 project-rules.md（始终写文件，即使无规则——避免下游 sync 读不到文件）
  const lines: string[] = [];
  lines.push('# Project Rules');
  lines.push('');
  lines.push('> 由 floo lessons 自动蒸馏生成，勿手动编辑。');
  lines.push('');

  if (lessons.length === 0) {
    lines.push('暂无足够经验记录来提炼规则。继续使用 `floo learn` 记录经验。');
    lines.push('');
  } else {
    // 按标签分组
    const tagMap = new Map<string, LessonRecord[]>();
    for (const lesson of lessons) {
      for (const tag of lesson.tags) {
        const group = tagMap.get(tag) ?? [];
        group.push(lesson);
        tagMap.set(tag, group);
      }
    }

    // 只保留出现 2+ 次的标签（模式检测）
    const frequentTags = [...tagMap.entries()]
      .filter(([, group]) => group.length >= 2)
      .sort((a, b) => b[1].length - a[1].length);

    if (frequentTags.length === 0) {
      lines.push('经验记录尚未形成模式（需要同一标签出现 2 次以上）。');
      lines.push('');
    } else {
      for (const [tag, group] of frequentTags) {
        lines.push(`## ${tag}`);
        lines.push('');

        // 对同一标签下的 solution 去重
        const seen = new Set<string>();
        for (const lesson of group) {
          if (seen.has(lesson.solution)) continue;
          seen.add(lesson.solution);
          lines.push(`- ${lesson.solution}`);
        }
        lines.push('');
      }
    }
  }

  const contextDir = join(flooDir, 'context');
  await mkdir(contextDir, { recursive: true });
  await writeFile(join(contextDir, 'project-rules.md'), lines.join('\n'));
}
