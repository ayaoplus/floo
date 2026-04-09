/**
 * GET /api/tasks/:batchId/:taskId — 任务详情 + run 记录
 */

import { getTask, listRuns, readArtifact } from '@/lib/floo';

export const dynamic = 'force-dynamic';

type RouteParams = { batchId: string; taskId: string };

export async function GET(
  _request: Request,
  { params }: { params: Promise<RouteParams> },
) {
  const { batchId, taskId } = await params;
  const task = await getTask(batchId, taskId);
  if (!task) {
    return Response.json({ error: 'Task not found' }, { status: 404 });
  }

  const runs = await listRuns(batchId, taskId);

  // 检查哪些 artifact 存在
  const artifactNames = ['design.md', 'plan.md', 'review.md', 'test-report.md'];
  const artifacts: Record<string, string> = {};
  for (const name of artifactNames) {
    const content = await readArtifact(batchId, taskId, name);
    if (content) artifacts[name] = content;
  }

  return Response.json({ task, runs, artifacts });
}
