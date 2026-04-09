/**
 * GET /api/tasks — 列出所有任务（跨批次）
 */

import { listAllTasks } from '@/lib/floo';

export const dynamic = 'force-dynamic';

export async function GET() {
  const tasks = await listAllTasks();
  return Response.json(tasks);
}
