/**
 * Dashboard 首页
 * 展示系统总览：批次/任务统计卡片 + 最近活动
 */

import Link from 'next/link';
import { getStats, listBatches, listAllTasks } from '@/lib/floo';
import { StatusBadge } from '@/components/status-badge';
import { PhaseProgress } from '@/components/phase-badge';
import { EmptyState } from '@/components/empty-state';
import { formatRelative } from '@/components/duration';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const stats = await getStats();
  const batches = await listBatches();
  const allTasks = await listAllTasks();

  // 最近更新的任务（取前 5 个）
  const recentTasks = [...allTasks]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 5);

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      {/* 标题 */}
      <div className="mb-10">
        <h1 className="font-serif text-3xl font-medium text-near-black mb-2">
          Dashboard
        </h1>
        <p className="text-olive-gray">
          Multi-Agent Vibe Coding Harness
        </p>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
        <StatCard label="Active Batches" value={stats.activeBatches} total={stats.totalBatches} />
        <StatCard label="Running" value={stats.runningTasks} accent />
        <StatCard label="Completed" value={stats.completedTasks} />
        <StatCard label="Failed" value={stats.failedTasks} error={stats.failedTasks > 0} />
      </div>

      {/* 最近活动 */}
      <section>
        <h2 className="font-serif text-xl font-medium text-near-black mb-4">Recent Activity</h2>
        {recentTasks.length === 0 ? (
          <EmptyState
            title="No tasks yet"
            description="Run `floo run` to create your first batch and tasks."
          />
        ) : (
          <div className="bg-ivory rounded-xl border border-border-cream overflow-hidden">
            {recentTasks.map((task, idx) => (
              <Link
                key={`${task.batch_id}-${task.id}`}
                href={`/tasks/${task.batch_id}/${task.id}`}
                className={`flex items-center justify-between px-5 py-4 hover:bg-warm-sand/30 transition-colors ${
                  idx > 0 ? 'border-t border-border-cream' : ''
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1">
                    <span className="font-mono text-xs text-stone-gray">{task.id}</span>
                    <StatusBadge status={task.status} />
                  </div>
                  <p className="text-sm text-charcoal-warm truncate">{task.description}</p>
                </div>
                <div className="flex items-center gap-4 ml-4 shrink-0">
                  <PhaseProgress currentPhase={task.current_phase} status={task.status} />
                  <span className="text-xs text-stone-gray">{formatRelative(task.updated_at)}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* 批次概览 */}
      {batches.length > 0 && (
        <section className="mt-10">
          <h2 className="font-serif text-xl font-medium text-near-black mb-4">Batches</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {batches.map(batch => {
              const batchTasks = allTasks.filter(t => t.batch_id === batch.id);
              const completed = batchTasks.filter(t => t.status === 'completed').length;
              return (
                <Link
                  key={batch.id}
                  href={`/tasks?batch=${batch.id}`}
                  className="bg-ivory rounded-xl border border-border-cream p-5 hover:shadow-[rgba(0,0,0,0.05)_0px_4px_24px] transition-shadow"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono text-sm text-near-black">{batch.id}</span>
                    <StatusBadge status={batch.status} />
                  </div>
                  <p className="text-sm text-olive-gray mb-3">{batch.description}</p>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-stone-gray">
                      {completed}/{batchTasks.length} tasks completed
                    </span>
                    {/* 进度条 */}
                    <div className="w-24 h-1.5 rounded-full bg-border-cream overflow-hidden">
                      <div
                        className="h-full rounded-full bg-success transition-all"
                        style={{ width: batchTasks.length > 0 ? `${(completed / batchTasks.length) * 100}%` : '0%' }}
                      />
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

/** 统计卡片 */
function StatCard({
  label,
  value,
  total,
  accent,
  error,
}: {
  label: string;
  value: number;
  total?: number;
  accent?: boolean;
  error?: boolean;
}) {
  let valueColor = 'text-near-black';
  if (accent && value > 0) valueColor = 'text-terracotta';
  if (error) valueColor = 'text-error';

  return (
    <div className="bg-ivory rounded-xl border border-border-cream p-5">
      <p className="text-xs text-stone-gray mb-1">{label}</p>
      <div className="flex items-baseline gap-1.5">
        <span className={`text-2xl font-serif font-medium ${valueColor}`}>{value}</span>
        {total !== undefined && (
          <span className="text-sm text-stone-gray">/ {total}</span>
        )}
      </div>
    </div>
  );
}
