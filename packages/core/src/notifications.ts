/**
 * Notifications — 通知文件读写
 * dispatcher 在关键节点写通知到 .floo/notifications/，
 * monitor/外部 agent 读取通知了解任务进展
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Notification, NotificationEvent, Phase } from './types.js';

/**
 * 生成通知 ID（用作文件名，保证时间排序 + 并行安全）
 * 格式：yyyyMMddTHHmmssSSS-{taskId}-{event}-{random}
 * 加 taskId 和随机后缀防止同一毫秒的并行任务覆盖
 */
function generateId(event: NotificationEvent, taskId: string): string {
  const now = new Date();
  const ts = now.toISOString()
    .replace(/[-:]/g, '')
    .replace('T', 'T')
    .replace(/\.\d+Z$/, now.getMilliseconds().toString().padStart(3, '0'));
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}-${taskId}-${event}-${rand}`;
}

/**
 * 写入一条通知（便捷函数）
 * 自动生成 id 和 timestamp，通知写入失败不抛错（不阻塞主流程）
 */
export async function notify(
  flooDir: string,
  event: NotificationEvent,
  fields: {
    batch_id: string;
    task_id: string;
    phase?: Phase | null;
    [key: string]: unknown;
  },
): Promise<void> {
  const { batch_id, task_id, phase, ...data } = fields;
  const id = generateId(event, task_id);

  const notification: Notification = {
    id,
    timestamp: new Date().toISOString(),
    batch_id,
    task_id,
    event,
    phase: phase ?? null,
    data,
  };

  try {
    const dir = join(flooDir, 'notifications');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${id}.json`), JSON.stringify(notification, null, 2));
  } catch {
    // 通知写入失败不阻塞主流程
  }
}

/** 通知查询过滤条件 */
export interface NotificationFilter {
  batch_id?: string;
  task_id?: string;
  since?: Date;
}

/**
 * 列出通知（按时间正序）
 * 支持按 batch_id、task_id、时间过滤
 */
export async function listNotifications(
  flooDir: string,
  filters?: NotificationFilter,
): Promise<Notification[]> {
  const dir = join(flooDir, 'notifications');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  // 按文件名排序（文件名以时间戳开头，天然有序）
  const jsonFiles = entries.filter(f => f.endsWith('.json')).sort();

  const notifications: Notification[] = [];
  for (const file of jsonFiles) {
    try {
      const content = await readFile(join(dir, file), 'utf-8');
      const notif = JSON.parse(content) as Notification;

      // 应用过滤条件
      if (filters?.batch_id && notif.batch_id !== filters.batch_id) continue;
      if (filters?.task_id && notif.task_id !== filters.task_id) continue;
      if (filters?.since && new Date(notif.timestamp) < filters.since) continue;

      notifications.push(notif);
    } catch {
      // 跳过损坏的通知文件
    }
  }

  return notifications;
}
