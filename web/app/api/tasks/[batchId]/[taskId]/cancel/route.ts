/**
 * POST /api/tasks/[batchId]/[taskId]/cancel
 *
 * 取消正在运行的任务。仅响应 POST(GET 返回 405),保护用户避免点链接误取消。
 * 成功 200 + { ok: true, task },失败 400/404 + { ok: false, reason }。
 */

import { resolve } from 'node:path';
import { cancelTask } from '@/lib/cancel';

/** 跟 web/lib/floo.ts 保持一致的 .floo 解析(两处都拿 process.env.FLOO_DIR 兜底) */
function getFlooDir(): string {
  return process.env.FLOO_DIR || resolve(process.cwd(), '..', '.floo');
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ batchId: string; taskId: string }> },
) {
  const { batchId, taskId } = await params;
  const result = await cancelTask(getFlooDir(), batchId, taskId);

  if (!result.ok) {
    // not running / not found → 400(用户操作语义无效),其余按 400 处理
    return Response.json(result, { status: 400 });
  }
  return Response.json(result);
}
