/**
 * 任务详情页
 * 展示任务元数据、阶段进度、事件时间线、run 历史 + session 日志、artifact 文件
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTask, listRuns, readArtifact, listTaskNotifications, readRunLog, listRunLogs } from '@/lib/floo';
import { StatusBadge } from '@/components/status-badge';
import { PhaseBadge, PhaseProgress } from '@/components/phase-badge';
import { RuntimeBadge } from '@/components/runtime-badge';
import { Duration, formatRelative } from '@/components/duration';
import type { RunRecord, Notification } from '@/lib/types';

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
  const notifications = await listTaskNotifications(taskId);
  const logFiles = await listRunLogs(batchId, taskId);

  // 加载 artifact 文件
  const artifactNames = ['design.md', 'plan.md', 'review.md', 'test-report.md'] as const;
  const artifacts: Array<{ name: string; content: string }> = [];
  for (const name of artifactNames) {
    const content = await readArtifact(batchId, taskId, name);
    if (content) artifacts.push({ name, content });
  }

  // 加载每个 run 的 session 日志（服务端渲染，直接读取）
  const runLogs: Record<string, string> = {};
  for (const logFile of logFiles) {
    const runId = logFile.replace('.log', '');
    const content = await readRunLog(batchId, taskId, runId);
    if (content) runLogs[runId] = content;
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
        {/* 左侧：主内容区 */}
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

          {/* 事件时间线 */}
          {notifications.length > 0 && (
            <section>
              <h3 className="font-serif text-lg font-medium text-near-black mb-3">Timeline</h3>
              <div className="bg-ivory rounded-xl border border-border-cream p-5">
                <div className="relative">
                  {/* 竖线 */}
                  <div className="absolute left-[7px] top-2 bottom-2 w-px bg-border-warm" />

                  <div className="space-y-4">
                    {notifications.map((notif) => (
                      <TimelineEvent key={notif.id} notification={notif} />
                    ))}
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* Run 历史 + Session 日志 */}
          <section>
            <h3 className="font-serif text-lg font-medium text-near-black mb-3">Run History</h3>
            {runs.length === 0 ? (
              <div className="bg-ivory rounded-xl border border-border-cream p-5 text-center text-sm text-stone-gray">
                No runs recorded yet
              </div>
            ) : (
              <div className="space-y-3">
                {runs.map((run) => (
                  <RunCard key={run.id} run={run} log={runLogs[run.id] ?? null} />
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

// ============================================================
// 子组件
// ============================================================

/** 时间线事件图标和颜色映射 */
const EVENT_CONFIG: Record<string, { icon: string; color: string; label: string }> = {
  phase_started:    { icon: '\u25B6', color: 'bg-terracotta', label: 'Phase Started' },
  phase_completed:  { icon: '\u2713', color: 'bg-success',    label: 'Phase Completed' },
  review_concluded: { icon: '\u2691', color: 'bg-olive-gray', label: 'Review' },
  task_completed:   { icon: '\u2605', color: 'bg-near-black', label: 'Task Done' },
  retry:            { icon: '\u21BB', color: 'bg-coral',      label: 'Retry' },
  error:            { icon: '\u2717', color: 'bg-error',      label: 'Error' },
  task_started:     { icon: '\u25CF', color: 'bg-terracotta', label: 'Task Started' },
  batch_progress:   { icon: '\u25CB', color: 'bg-warm-sand',  label: 'Progress' },
  batch_completed:  { icon: '\u2605', color: 'bg-success',    label: 'Batch Done' },
};

/** 时间线单个事件 */
function TimelineEvent({ notification }: { notification: Notification }) {
  const config = EVENT_CONFIG[notification.event] || { icon: '\u25CF', color: 'bg-stone-gray', label: notification.event };
  const time = new Date(notification.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const date = new Date(notification.timestamp).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });

  // 构建事件描述
  const details = buildEventDetails(notification);

  return (
    <div className="flex gap-3 relative">
      {/* 圆点 */}
      <div className={`w-4 h-4 rounded-full ${config.color} shrink-0 flex items-center justify-center z-10`}>
        <span className="text-[8px] text-white leading-none">{config.icon}</span>
      </div>

      {/* 内容 */}
      <div className="flex-1 min-w-0 pb-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-charcoal-warm">{config.label}</span>
          {notification.phase && (
            <span className="text-xs text-olive-gray">@ {notification.phase}</span>
          )}
          <span className="text-xs text-stone-gray ml-auto shrink-0">{date} {time}</span>
        </div>
        {details && (
          <p className="text-xs text-olive-gray mt-0.5">{details}</p>
        )}
      </div>
    </div>
  );
}

/** 从 notification.data 构建可读描述 */
function buildEventDetails(notif: Notification): string | null {
  const d = notif.data;
  switch (notif.event) {
    case 'phase_started':
      return `${d.runtime}/${d.model} \u2192 ${d.session}`;
    case 'phase_completed':
      return `exit=${d.exit_code}, ${d.duration_seconds}s`;
    case 'review_concluded':
      return `verdict: ${d.verdict}${d.round ? ` (round ${d.round})` : ''}`;
    case 'retry':
      return `attempt ${d.attempt}/${d.max_retries}${d.error ? ` \u2014 ${String(d.error).slice(0, 100)}` : ''}`;
    case 'task_completed':
      return `status: ${d.status}${d.reason ? ` (${d.reason})` : ''}`;
    default:
      return null;
  }
}

/** Run 卡片组件（包含可展开的 session 日志） */
function RunCard({ run, log }: { run: RunRecord; log: string | null }) {
  const exitColor =
    run.exit_code === null ? 'text-stone-gray' :
    run.exit_code === 0 ? 'text-success' : 'text-error';

  const borderColor =
    run.exit_code === null ? 'border-border-cream' :
    run.exit_code === 0 ? 'border-success/20' : 'border-error/20';

  return (
    <div className={`bg-ivory rounded-xl border ${borderColor} overflow-hidden`}>
      {/* Run 头部信息 */}
      <div className="flex items-center gap-4 px-5 py-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-near-black">{run.id}</span>
            <PhaseBadge phase={run.phase} />
            <RuntimeBadge runtime={run.runtime} />
          </div>
          <div className="text-xs text-stone-gray mt-0.5">
            {run.session_name} &middot; attempt #{run.attempt}
          </div>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          <Duration seconds={run.duration_seconds} />
          <span className={`font-mono text-sm ${exitColor}`}>
            exit {run.exit_code === null ? '--' : run.exit_code}
          </span>
        </div>
      </div>

      {/* Session 日志（如果有） */}
      {log && (
        <details className="group">
          <summary className="flex items-center gap-2 px-5 py-2 border-t border-border-cream bg-parchment/50 cursor-pointer text-xs text-olive-gray hover:text-near-black transition-colors select-none">
            <span className="group-open:rotate-90 transition-transform text-stone-gray">\u25B6</span>
            Session Output
            <span className="text-stone-gray">({(log.length / 1024).toFixed(1)} KB)</span>
          </summary>
          <pre className="px-5 py-3 text-xs text-charcoal-warm font-mono leading-relaxed overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap border-t border-border-cream bg-near-black/[0.02]">
            {log}
          </pre>
        </details>
      )}
    </div>
  );
}

/** Artifact 文件查看器 */
function ArtifactViewer({ name, content }: { name: string; content: string }) {
  return (
    <details className="group bg-ivory rounded-xl border border-border-cream overflow-hidden" open>
      <summary className="flex items-center justify-between px-4 py-2.5 border-b border-border-cream bg-parchment/50 cursor-pointer select-none">
        <span className="font-mono text-xs text-olive-gray">{name}</span>
        <span className="group-open:rotate-90 transition-transform text-xs text-stone-gray">\u25B6</span>
      </summary>
      <pre className="px-4 py-3 text-xs text-charcoal-warm font-mono leading-relaxed overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap">
        {content}
      </pre>
    </details>
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
