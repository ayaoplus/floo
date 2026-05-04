'use client';

/**
 * AutoRefresh — 客户端自动刷新组件
 *
 * Server Components 数据是请求时快照,本组件用 router.refresh() 触发重渲染。
 * Next 16 的 router.refresh() 会重新跑当前路由的 Server Components(包括 fetch 数据),
 * 不丢用户输入(filter / search 等 client state 保留)。
 *
 * 用法:
 *   <AutoRefresh intervalMs={5000} />
 *
 * 暂停条件:document.hidden(标签页切走)时不刷新,避免后台空跑。
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  /** 刷新间隔(毫秒)。默认 5000 */
  intervalMs?: number;
  /** 显示倒计时指示。默认 true */
  showIndicator?: boolean;
}

export function AutoRefresh({ intervalMs = 5000, showIndicator = true }: Props) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(true);
  const [tickCount, setTickCount] = useState(0);

  useEffect(() => {
    if (!enabled) return;

    const tick = () => {
      // 标签页隐藏时不刷新,避免无意义流量
      if (typeof document !== 'undefined' && document.hidden) return;
      router.refresh();
      setTickCount(c => c + 1);
    };

    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs, router]);

  if (!showIndicator) return null;

  return (
    <button
      type="button"
      onClick={() => setEnabled(e => !e)}
      className="inline-flex items-center gap-1.5 text-xs text-stone-gray hover:text-near-black transition-colors"
      aria-label={enabled ? 'Pause auto-refresh' : 'Resume auto-refresh'}
      title={enabled ? `Auto-refresh every ${intervalMs / 1000}s · click to pause` : 'Auto-refresh paused · click to resume'}
    >
      <span
        className={`inline-block w-1.5 h-1.5 rounded-full ${enabled ? 'bg-success animate-pulse' : 'bg-stone-gray'}`}
      />
      {enabled ? `Live · ${tickCount}` : 'Paused'}
    </button>
  );
}
