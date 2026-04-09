/**
 * 任务列表页
 * 按批次分组展示所有任务，支持状态筛选
 */

import Link from 'next/link';
import { listBatches, listTasks } from '@/lib/floo';
import { StatusBadge } from '@/components/status-badge';
import { PhaseBadge, PhaseProgress } from '@/components/phase-badge';
import { EmptyState } from '@/components/empty-state';
import { formatRelative, formatElapsed } from '@/components/duration';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function TasksPage() {
  const batches = await listBatches();

  // 加载每个批次的任务
  const batchesWithTasks: Array<{
    batch: typeof batches[0];
    tasks: Task[];
  }> = [];

  for (const batch of batches) {
    const tasks = await listTasks(batch.id);
    batchesWithTasks.push({ batch, tasks });
  }

  const totalTasks = batchesWithTasks.reduce((sum, b) => sum + b.tasks.length, 0);

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      {/* 标题 */}
      <div className="mb-8">
        <h1 className="font-serif text-3xl font-medium text-near-black mb-2">Tasks</h1>
        <p className="text-olive-gray text-sm">
          {totalTasks} tasks across {batches.length} batches
        </p>
      </div>

      {batchesWithTasks.length === 0 ? (
        <EmptyState
          title="No batches found"
          description="Run `floo run` to create tasks. The dashboard reads from the .floo/ directory."
        />
      ) : (
        <div className="space-y-8">
          {batchesWithTasks.map(({ batch, tasks }) => (
            <section key={batch.id}>
              {/* 批次标题 */}
              <div className="flex items-center gap-3 mb-3">
                <h2 className="font-serif text-lg font-medium text-near-black">
                  {batch.id}
                </h2>
                <StatusBadge status={batch.status} />
                <span className="text-xs text-stone-gray ml-auto">
                  {formatRelative(batch.created_at)}
                </span>
              </div>

              {/* 批次描述 */}
              <p className="text-sm text-olive-gray mb-4">{batch.description}</p>

              {/* 任务列表 */}
              <div className="bg-ivory rounded-xl border border-border-cream overflow-hidden">
                {/* 表头 */}
                <div className="grid grid-cols-[1fr_100px_100px_120px_80px] gap-4 px-5 py-2.5 text-xs text-stone-gray border-b border-border-cream bg-parchment/50">
                  <span>Task</span>
                  <span>Status</span>
                  <span>Phase</span>
                  <span>Progress</span>
                  <span className="text-right">Time</span>
                </div>

                {tasks.length === 0 ? (
                  <div className="px-5 py-8 text-center text-sm text-stone-gray">
                    No tasks in this batch
                  </div>
                ) : (
                  tasks.map((task, idx) => (
                    <Link
                      key={task.id}
                      href={`/tasks/${batch.id}/${task.id}`}
                      className={`grid grid-cols-[1fr_100px_100px_120px_80px] gap-4 px-5 py-3.5 items-center hover:bg-warm-sand/20 transition-colors ${
                        idx > 0 ? 'border-t border-border-cream' : ''
                      }`}
                    >
                      {/* Task Info */}
                      <div className="min-w-0">
                        <div className="font-mono text-xs text-stone-gray mb-0.5">{task.id}</div>
                        <div className="text-sm text-charcoal-warm truncate">{task.description}</div>
                      </div>

                      {/* Status */}
                      <div>
                        <StatusBadge status={task.status} />
                      </div>

                      {/* Phase */}
                      <div>
                        {task.current_phase ? (
                          <PhaseBadge phase={task.current_phase} />
                        ) : (
                          <span className="text-xs text-stone-gray">--</span>
                        )}
                      </div>

                      {/* Progress */}
                      <div>
                        <PhaseProgress currentPhase={task.current_phase} status={task.status} />
                      </div>

                      {/* Time */}
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
                  ))
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
