/**
 * 任务/批次状态徽章
 * 根据状态显示不同颜色，遵循 Claude 暖色调设计
 */

import type { TaskStatus, BatchStatus } from '@/lib/types';

const STATUS_STYLES: Record<string, string> = {
  pending:   'bg-warm-sand text-charcoal-warm',
  running:   'bg-terracotta text-ivory',
  completed: 'bg-success text-ivory',
  failed:    'bg-error text-ivory',
  cancelled: 'bg-stone-gray text-ivory',
  active:    'bg-terracotta text-ivory',
};

const STATUS_LABELS: Record<string, string> = {
  pending:   'Pending',
  running:   'Running',
  completed: 'Completed',
  failed:    'Failed',
  cancelled: 'Cancelled',
  active:    'Active',
};

export function StatusBadge({ status }: { status: TaskStatus | BatchStatus }) {
  const style = STATUS_STYLES[status] || STATUS_STYLES.pending;
  const label = STATUS_LABELS[status] || status;

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-medium ${style}`}>
      {status === 'running' && (
        <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-white/80 animate-pulse" />
      )}
      {label}
    </span>
  );
}
