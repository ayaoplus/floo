/**
 * 任务详情页
 * 展示任务元数据、阶段进度、run 历史、artifact 文件内容
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTask, listRuns, readArtifact } from '@/lib/floo';
import { StatusBadge } from '@/components/status-badge';
import { PhaseBadge, PhaseProgress } from '@/components/phase-badge';
import { RuntimeBadge } from '@/components/runtime-badge';
import { Duration, formatRelative } from '@/components/duration';
import type { RunRecord, Phase } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** 页面参数类型 */
type PageParams = { batchId: string; taskId: string };

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<PageParams>;
}) {
  const { batchId, taskId } = await params;
  const task = await getTask(batchId, taskId);
  if (!task) notFound();

  const runs = await listRuns(batchId, taskId);

  // 加载 artifact 文件
  const artifactNames = ['design.md', 'plan.md', 'review.md', 'test-report.md'] as const;
  const artifacts: Array<{ name: string; content: string }> = [];
  for (const name of artifactNames) {
    const content = await readArtifact(batchId, taskId, name);
    if (content) artifacts.push({ name, content });
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      {/* 面包屑 */}
      <nav className="flex items-center gap-2 text-sm text-stone-gray mb-6">
        <Link href="/tasks" className="hover:text-near-black transition-colors">Tasks</Link>
        <span>/</span>
        <span className="font-mono">{batchId}</span>
        <span>/</span>
        <span className="font-mono text-near-black">{taskId}</span>
      </nav>

      {/* 标题区域 */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="font-serif text-2xl font-medium text-near-black">{taskId}</h1>
          <StatusBadge status={task.status} />
          {task.current_phase && <PhaseBadge phase={task.current_phase} />}
        </div>
        <p className="text-olive-gray">{task.description}</p>
      </div>

      <div className="grid md:grid-cols-3 gap-8">
        {/* 左侧：元数据 + runs */}
        <div className="md:col-span-2 space-y-8">
          {/* 阶段进度 */}
          <section className="bg-ivory rounded-xl border border-border-cream p-5">
            <h3 className="text-sm font-medium text-charcoal-warm mb-3">Phase Progress</h3>
            <div className="flex items-center gap-2">
              <PhaseProgress currentPhase={task.current_phase} status={task.status} />
              {task.current_phase && (
                <span className="text-sm text-olive-gray ml-2">
                  @ {task.current_phase}
                </span>
              )}
            </div>
          </section>

          {/* Run 历史 */}
          <section>
            <h3 className="font-serif text-lg font-medium text-near-black mb-3">Run History</h3>
            {runs.length === 0 ? (
              <div className="bg-ivory rounded-xl border border-border-cream p-5 text-center text-sm text-stone-gray">
                No runs recorded yet
              </div>
            ) : (
              <div className="bg-ivory rounded-xl border border-border-cream overflow-hidden">
                {/* 表头 */}
                <div className="grid grid-cols-[1fr_80px_80px_60px_80px_60px] gap-3 px-5 py-2.5 text-xs text-stone-gray border-b border-border-cream bg-parchment/50">
                  <span>Run</span>
                  <span>Phase</span>
                  <span>Runtime</span>
                  <span>Attempt</span>
                  <span>Duration</span>
                  <span className="text-right">Exit</span>
                </div>

                {runs.map((run, idx) => (
                  <RunRow key={run.id} run={run} bordered={idx > 0} />
                ))}
              </div>
            )}
          </section>

          {/* Artifact 文件 */}
          {artifacts.length > 0 && (
            <section>
              <h3 className="font-serif text-lg font-medium text-near-black mb-3">Artifacts</h3>
              <div className="space-y-4">
                {artifacts.map(artifact => (
                  <ArtifactViewer key={artifact.name} name={artifact.name} content={artifact.content} />
                ))}
              </div>
            </section>
          )}
        </div>

        {/* 右侧：元信息面板 */}
        <aside className="space-y-4">
          <MetaCard label="Batch" value={task.batch_id} mono />
          <MetaCard label="Review Level" value={task.review_level} />
          <MetaCard label="Created" value={formatRelative(task.created_at)} />
          <MetaCard label="Updated" value={formatRelative(task.updated_at)} />

          {/* Scope */}
          {task.scope.length > 0 && (
            <div className="bg-ivory rounded-xl border border-border-cream p-4">
              <h4 className="text-xs text-stone-gray mb-2">Scope</h4>
              <div className="space-y-1">
                {task.scope.map(file => (
                  <div key={file} className="font-mono text-xs text-olive-gray truncate">
                    {file}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Acceptance Criteria */}
          {task.acceptance_criteria.length > 0 && (
            <div className="bg-ivory rounded-xl border border-border-cream p-4">
              <h4 className="text-xs text-stone-gray mb-2">Acceptance Criteria</h4>
              <ul className="space-y-1.5">
                {task.acceptance_criteria.map((criterion, i) => (
                  <li key={i} className="flex gap-2 text-xs text-olive-gray">
                    <span className="text-stone-gray shrink-0">{task.status === 'completed' ? '\u2713' : '\u2022'}</span>
                    {criterion}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Dependencies */}
          {task.depends_on.length > 0 && (
            <div className="bg-ivory rounded-xl border border-border-cream p-4">
              <h4 className="text-xs text-stone-gray mb-2">Dependencies</h4>
              <div className="space-y-1">
                {task.depends_on.map(dep => (
                  <div key={dep} className="font-mono text-xs text-olive-gray">{dep}</div>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/** Run 行组件 */
function RunRow({ run, bordered }: { run: RunRecord; bordered: boolean }) {
  const exitColor =
    run.exit_code === null ? 'text-stone-gray' :
    run.exit_code === 0 ? 'text-success' : 'text-error';

  return (
    <div className={`grid grid-cols-[1fr_80px_80px_60px_80px_60px] gap-3 px-5 py-3 items-center ${
      bordered ? 'border-t border-border-cream' : ''
    }`}>
      <div>
        <span className="font-mono text-sm text-near-black">{run.id}</span>
        <div className="text-xs text-stone-gray mt-0.5">{run.session_name}</div>
      </div>
      <div><PhaseBadge phase={run.phase} /></div>
      <div><RuntimeBadge runtime={run.runtime} /></div>
      <div className="text-sm text-olive-gray">#{run.attempt}</div>
      <div><Duration seconds={run.duration_seconds} /></div>
      <div className={`text-right font-mono text-sm ${exitColor}`}>
        {run.exit_code === null ? '--' : run.exit_code}
      </div>
    </div>
  );
}

/** Artifact 文件查看器 */
function ArtifactViewer({ name, content }: { name: string; content: string }) {
  return (
    <div className="bg-ivory rounded-xl border border-border-cream overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-cream bg-parchment/50">
        <span className="font-mono text-xs text-olive-gray">{name}</span>
      </div>
      <pre className="px-4 py-3 text-xs text-charcoal-warm font-mono leading-relaxed overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap">
        {content}
      </pre>
    </div>
  );
}

/** 元信息卡片 */
function MetaCard({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bg-ivory rounded-xl border border-border-cream p-4">
      <h4 className="text-xs text-stone-gray mb-1">{label}</h4>
      <p className={`text-sm text-charcoal-warm ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  );
}
