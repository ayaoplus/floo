/**
 * GET /api/tasks/:batchId/:taskId/logs/:runId — 读取某个 run 的 session 输出日志
 */

import { readRunLog } from '@/lib/floo';

export const dynamic = 'force-dynamic';

type RouteParams = { batchId: string; taskId: string; runId: string };

export async function GET(
  _request: Request,
  { params }: { params: Promise<RouteParams> },
) {
  const { batchId, taskId, runId } = await params;
  const log = await readRunLog(batchId, taskId, runId);

  if (!log) {
    return Response.json({ error: 'Log not found' }, { status: 404 });
  }

  return new Response(log, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
