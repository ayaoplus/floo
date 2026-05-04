/**
 * Health 状态卡片 — Server Component
 * 显示系统是否健康,有 stale / inconsistent 时给出列表
 */

import Link from 'next/link';
import type { HealthSummary } from '@/lib/health';

const LEVEL_CONFIG = {
  ok: {
    label: 'Healthy',
    valueColor: 'text-success',
    dotColor: 'bg-success',
    description: 'No stale tasks',
  },
  warning: {
    label: 'Warning',
    valueColor: 'text-terracotta',
    dotColor: 'bg-terracotta',
    description: 'Some tasks haven\'t updated recently',
  },
  critical: {
    label: 'Critical',
    valueColor: 'text-error',
    dotColor: 'bg-error',
    description: 'Stuck or inconsistent tasks',
  },
} as const;

export function HealthCard({ health }: { health: HealthSummary }) {
  const cfg = LEVEL_CONFIG[health.level];
  const totalIssues = health.staleTasks.length + health.inconsistentTasks.length;

  return (
    <div className="bg-ivory rounded-xl border border-border-cream p-5">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs text-stone-gray">Health</p>
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${cfg.dotColor}`} />
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className={`text-2xl font-serif font-medium ${cfg.valueColor}`}>{cfg.label}</span>
        {totalIssues > 0 && (
          <span className="text-sm text-stone-gray">
            / {totalIssues} {totalIssues === 1 ? 'issue' : 'issues'}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * 详细的 health 问题列表 — 仅当 level !== ok 时显示
 */
export function HealthIssuesList({ health }: { health: HealthSummary }) {
  if (health.level === 'ok') return null;

  return (
    <section className="mt-10">
      <h2 className="font-serif text-xl font-medium text-near-black mb-4">
        Health Issues
      </h2>
      <div className="bg-ivory rounded-xl border border-border-cream overflow-hidden">
        {health.inconsistentTasks.map((task, idx) => (
          <Link
            key={`inc-${task.taskId}`}
            href={`/tasks/${task.batchId}/${task.taskId}`}
            className={`flex items-center justify-between px-5 py-3.5 hover:bg-warm-sand/30 transition-colors ${idx > 0 ? 'border-t border-border-cream' : ''}`}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 mb-0.5">
                <span className="font-mono text-xs text-stone-gray">{task.taskId}</span>
                <span className="text-xs uppercase tracking-wider text-error font-medium">Inconsistent</span>
              </div>
              <p className="text-sm text-charcoal-warm truncate">{task.description}</p>
            </div>
            <span className="text-xs text-stone-gray ml-4 shrink-0">running w/o phase</span>
          </Link>
        ))}
        {health.staleTasks.map((task, idx) => {
          const offset = health.inconsistentTasks.length + idx;
          const severity = task.staleSinceMinutes > 60 ? 'error' : 'terracotta';
          return (
            <Link
              key={`stale-${task.taskId}`}
              href={`/tasks/${task.batchId}/${task.taskId}`}
              className={`flex items-center justify-between px-5 py-3.5 hover:bg-warm-sand/30 transition-colors ${offset > 0 ? 'border-t border-border-cream' : ''}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-0.5">
                  <span className="font-mono text-xs text-stone-gray">{task.taskId}</span>
                  <span className={`text-xs uppercase tracking-wider font-medium text-${severity}`}>Stale @ {task.phase}</span>
                </div>
                <p className="text-sm text-charcoal-warm truncate">{task.description}</p>
              </div>
              <span className="text-xs text-stone-gray ml-4 shrink-0">
                {task.staleSinceMinutes >= 60
                  ? `${Math.floor(task.staleSinceMinutes / 60)}h ${task.staleSinceMinutes % 60}m`
                  : `${task.staleSinceMinutes}m`} since update
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
