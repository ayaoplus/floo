/**
 * 耗时显示组件
 * 格式化秒数或 ISO 时间差为可读字符串
 */

/** 将秒数格式化为 Xh Xm Xs */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** 计算从 ISO 时间到现在的持续时间 */
export function formatElapsed(startedAt: string): string {
  const elapsed = (Date.now() - new Date(startedAt).getTime()) / 1000;
  return formatDuration(elapsed);
}

/** 格式化相对时间（如 "3 分钟前"） */
export function formatRelative(isoTime: string): string {
  const diff = (Date.now() - new Date(isoTime).getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

/** Duration 显示组件 */
export function Duration({ seconds }: { seconds: number | null }) {
  if (seconds === null) return <span className="text-stone-gray">--</span>;
  return <span className="font-mono text-sm text-olive-gray">{formatDuration(seconds)}</span>;
}

/** 已用时间显示（从开始时间算起） */
export function Elapsed({ startedAt }: { startedAt: string }) {
  return <span className="font-mono text-sm text-olive-gray">{formatElapsed(startedAt)}</span>;
}
