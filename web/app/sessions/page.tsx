/**
 * Tmux Sessions 面板
 * 展示所有 tmux session 的状态、关联任务、存活时间
 */

import { listSessions } from '@/lib/floo';
import { PhaseBadge } from '@/components/phase-badge';
import { EmptyState } from '@/components/empty-state';
import { formatElapsed, formatRelative } from '@/components/duration';

export const dynamic = 'force-dynamic';

export default async function SessionsPage() {
  const sessions = await listSessions();

  const aliveSessions = sessions.filter(s => s.alive);
  const deadSessions = sessions.filter(s => !s.alive);

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      {/* 标题 */}
      <div className="mb-8">
        <h1 className="font-serif text-3xl font-medium text-near-black mb-2">Sessions</h1>
        <p className="text-olive-gray text-sm">
          {aliveSessions.length} active, {deadSessions.length} terminated
        </p>
      </div>

      {sessions.length === 0 ? (
        <EmptyState
          title="No sessions"
          description="Sessions appear when tasks start running in tmux."
        />
      ) : (
        <div className="space-y-8">
          {/* Active Sessions */}
          {aliveSessions.length > 0 && (
            <section>
              <h2 className="font-serif text-lg font-medium text-near-black mb-3 flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-terracotta animate-pulse" />
                Active
              </h2>
              <div className="grid gap-4 md:grid-cols-2">
                {aliveSessions.map(session => (
                  <SessionCard key={session.name} session={session} />
                ))}
              </div>
            </section>
          )}

          {/* Dead Sessions */}
          {deadSessions.length > 0 && (
            <section>
              <h2 className="font-serif text-lg font-medium text-near-black mb-3">
                Terminated
              </h2>
              <div className="grid gap-4 md:grid-cols-2">
                {deadSessions.map(session => (
                  <SessionCard key={session.name} session={session} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/** Session 卡片 */
function SessionCard({ session }: { session: { name: string; task_id: string; phase: string; alive: boolean; started_at: string; last_activity: string | null } }) {
  return (
    <div className={`bg-ivory rounded-xl border p-5 ${
      session.alive ? 'border-terracotta/30' : 'border-border-cream'
    }`}>
      {/* 标题行 */}
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono text-sm text-near-black">{session.name}</span>
        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${
          session.alive ? 'text-terracotta' : 'text-stone-gray'
        }`}>
          <span className={`h-1.5 w-1.5 rounded-full ${
            session.alive ? 'bg-terracotta animate-pulse' : 'bg-stone-gray'
          }`} />
          {session.alive ? 'Alive' : 'Dead'}
        </span>
      </div>

      {/* 信息行 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-stone-gray">Task</span>
          <span className="font-mono text-xs text-olive-gray">{session.task_id}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-stone-gray">Phase</span>
          <PhaseBadge phase={session.phase as 'designer' | 'planner' | 'coder' | 'reviewer' | 'tester'} />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-stone-gray">Uptime</span>
          <span className="font-mono text-xs text-olive-gray">
            {session.alive ? formatElapsed(session.started_at) : formatRelative(session.started_at)}
          </span>
        </div>
        {session.last_activity && (
          <div className="flex items-center justify-between">
            <span className="text-xs text-stone-gray">Last Activity</span>
            <span className="text-xs text-olive-gray">{formatRelative(session.last_activity)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
