/**
 * GET /api/sessions — 列出所有 tmux session
 */

import { listSessions } from '@/lib/floo';

export const dynamic = 'force-dynamic';

export async function GET() {
  const sessions = await listSessions();
  return Response.json(sessions);
}
