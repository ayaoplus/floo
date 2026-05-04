/**
 * GET /api/batches/[batchId]/plan
 *
 * 返回 batch 的 plan.yaml 当前快照 + 所有 plan-patch 列表 + DAG 布局结果。
 * UI 直接渲染,不再做拓扑排序。
 */

import { getBatchPlan, getBatchPatches, layoutDag } from '@/lib/plan';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ batchId: string }> },
) {
  const { batchId } = await params;
  const plan = await getBatchPlan(batchId);
  if (!plan) {
    return Response.json(
      { ok: false, reason: `plan.yaml not found for batch ${batchId}` },
      { status: 404 },
    );
  }
  const patches = await getBatchPatches(batchId);
  const dag = layoutDag(plan, patches);
  return Response.json({ ok: true, plan, patches, dag });
}
