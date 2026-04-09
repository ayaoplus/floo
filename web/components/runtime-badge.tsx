/**
 * Runtime 标签
 * 显示 agent 运行时类型：claude / codex
 */

import type { Runtime } from '@/lib/types';

export function RuntimeBadge({ runtime }: { runtime: Runtime }) {
  const style = runtime === 'claude'
    ? 'border-terracotta/30 text-terracotta'
    : 'border-olive-gray/30 text-olive-gray';

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono border ${style}`}>
      {runtime}
    </span>
  );
}
