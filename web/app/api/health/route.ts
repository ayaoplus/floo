/**
 * GET /api/health — 系统健康摘要
 *
 * 只读检查,基于 listAllTasks 派生 stale / inconsistent 列表。
 * 不接触 tmux session、不轮转日志(那些副作用属 core/health,由 CLI 触发)。
 */

import { listAllTasks } from '@/lib/floo';
import { deriveHealth } from '@/lib/health';

export const dynamic = 'force-dynamic';

export async function GET() {
  const tasks = await listAllTasks();
  const health = deriveHealth(tasks);
  return Response.json(health);
}
