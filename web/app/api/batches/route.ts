/**
 * GET /api/batches — 列出所有批次
 */

import { listBatches } from '@/lib/floo';

export const dynamic = 'force-dynamic';

export async function GET() {
  const batches = await listBatches();
  return Response.json(batches);
}
