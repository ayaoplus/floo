/**
 * 任务列表页
 *
 * 按批次分组展示所有任务,支持基于 URL search params 的过滤:
 *   ?status=running       仅展示 running 任务
 *   ?q=auth               按描述/ID 模糊搜索
 *   ?batch=<batchId>      锁定单个批次
 *
 * Server Component 在渲染时按 searchParams 过滤,空批次自动隐藏。
 * 客户端 FilterBar 修改 URL 触发重渲染。
 */

import Link from 'next/link';
import { listBatches, listTasks } from '@/lib/floo';
import { StatusBadge } from '@/components/status-badge';
import { PhaseBadge, PhaseProgress } from '@/components/phase-badge';
import { EmptyState } from '@/components/empty-state';
import { formatRelative, formatElapsed } from '@/components/duration';
import { AutoRefresh } from '@/components/auto-refresh';
import { FilterBar, type StatusFilter } from '@/components/filter-bar';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{
    status?: string;
    q?: string;
    batch?: string;
  }>;
}

export default async function TasksPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const statusFilter = (params.status ?? 'all') as StatusFilter;
  const queryRaw = (params.q ?? '').trim().toLowerCase();
  const batchFilter = params.batch ?? '';

  const allBatches = await listBatches();
  const visibleBatches = batchFilter
    ? allBatches.filter(b => b.id === batchFilter)
    : allBatches;

  // 加载每个批次的任务并应用过滤
  const batchesWithTasks: Array<{
    batch: typeof allBatches[0];
    tasks: Task[];
    matchedCount: number;
  }> = [];

  for (const batch of visibleBatches) {
    const all = await listTasks(batch.id);
    const filtered = all.filter(task => {
      if (statusFilter !== 'all' && task.status !== statusFilter) return false;
      if (queryRaw) {
        const haystack = `${task.id} ${task.description}`.toLowerCase();
        if (!haystack.includes(queryRaw)) return false;
      }
      return true;
    });
    if (filtered.length > 0) {
      batchesWithTasks.push({ batch, tasks: filtered, matchedCount: filtered.length });
    }
  }

  const totalMatched = batchesWithTasks.reduce((sum, b) => sum + b.matchedCount, 0);
  const hasFilter = statusFilter !== 'all' || queryRaw || batchFilter;

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      {/* 标题 + 自动刷新 */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="font-serif text-3xl font-medium text-near-black mb-2">Tasks</h1>
          <p className="text-olive-gray text-sm">
            {hasFilter
              ? `${totalMatched} matched · ${visibleBatches.length} batches scanned`
              : `${totalMatched} tasks across ${allBatches.length} batches`}
          </p>
        </div>
        <AutoRefresh intervalMs={5000} />
      </div>

      {/* 过滤工具条 */}
      <FilterBar
        batches={allBatches.map(b => ({ id: b.id, description: b.description }))}
      />

      {batchesWithTasks.length === 0 ? (
        <EmptyState
          title={hasFilter ? 'No tasks match' : 'No batches found'}
          description={
            hasFilter
              ? 'Try clearing filters or relaxing the search.'
              : 'Run `floo run` to create tasks. The dashboard reads from the .floo/ directory.'
          }
        />
      ) : (
        <div className="space-y-8">
          {batchesWithTasks.map(({ batch, tasks }) => (
            <section key={batch.id}>
              <div className="flex items-center gap-3 mb-3">
                <h2 className="font-serif text-lg font-medium text-near-black">
                  {batch.id}
                </h2>
                <StatusBadge status={batch.status} />
                <span className="text-xs text-stone-gray ml-auto">
                  {formatRelative(batch.created_at)}
                </span>
              </div>

              <p className="text-sm text-olive-gray mb-4">{batch.description}</p>

              <div className="bg-ivory rounded-xl border border-border-cream overflow-hidden">
                <div className="grid grid-cols-[1fr_100px_100px_120px_80px] gap-4 px-5 py-2.5 text-xs text-stone-gray border-b border-border-cream bg-parchment/50">
                  <span>Task</span>
                  <span>Status</span>
                  <span>Phase</span>
                  <span>Progress</span>
                  <span className="text-right">Time</span>
                </div>

                {tasks.map((task, idx) => (
                  <Link
                    key={task.id}
                    href={`/tasks/${batch.id}/${task.id}`}
                    className={`grid grid-cols-[1fr_100px_100px_120px_80px] gap-4 px-5 py-3.5 items-center hover:bg-warm-sand/20 transition-colors ${
                      idx > 0 ? 'border-t border-border-cream' : ''
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="font-mono text-xs text-stone-gray mb-0.5">{task.id}</div>
                      <div className="text-sm text-charcoal-warm truncate">{task.description}</div>
                    </div>
                    <div>
                      <StatusBadge status={task.status} />
                    </div>
                    <div>
                      {task.current_phase ? (
                        <PhaseBadge phase={task.current_phase} />
                      ) : (
                        <span className="text-xs text-stone-gray">--</span>
                      )}
                    </div>
                    <div>
                      <PhaseProgress currentPhase={task.current_phase} status={task.status} />
                    </div>
                    <div className="text-right">
                      {task.status === 'running' ? (
                        <span className="font-mono text-xs text-terracotta">
                          {formatElapsed(task.updated_at)}
                        </span>
                      ) : (
                        <span className="text-xs text-stone-gray">
                          {formatRelative(task.updated_at)}
                        </span>
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
