'use client';

/**
 * FilterBar — 客户端过滤工具条
 *
 * 把 status 下拉和搜索框写到 URL search params,这样:
 *   1. 服务端可以基于 searchParams 在渲染时过滤
 *   2. 用户复制链接能保留过滤状态
 *   3. 浏览器后退能回到之前的过滤
 *
 * 与 router.replace 配合 startTransition 让过滤反馈无感等待。
 */

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

export type StatusFilter = 'all' | 'running' | 'completed' | 'failed' | 'cancelled' | 'pending';

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'pending', label: 'Pending' },
];

interface Props {
  /** 当前可选 batch ID 列表(下拉 batch 过滤用) */
  batches: Array<{ id: string; description: string }>;
}

export function FilterBar({ batches }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const initialQ = searchParams.get('q') ?? '';
  const initialStatus = (searchParams.get('status') ?? 'all') as StatusFilter;
  const initialBatch = searchParams.get('batch') ?? '';

  const [search, setSearch] = useState(initialQ);
  const [debounced, setDebounced] = useState(initialQ);

  // 输入防抖 250ms,避免每键一击就 push URL
  useEffect(() => {
    const id = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(id);
  }, [search]);

  // debounced 变化或下拉切换时,统一同步到 URL
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (debounced) params.set('q', debounced);
    else params.delete('q');
    if (params.toString() !== searchParams.toString()) {
      startTransition(() => {
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const setStatus = (value: StatusFilter) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === 'all') params.delete('status');
    else params.set('status', value);
    startTransition(() => {
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    });
  };

  const setBatch = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (!value) params.delete('batch');
    else params.set('batch', value);
    startTransition(() => {
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    });
  };

  const clearAll = () => {
    setSearch('');
    setDebounced('');
    startTransition(() => {
      router.replace(pathname, { scroll: false });
    });
  };

  const hasActiveFilter = initialQ || initialStatus !== 'all' || initialBatch;

  return (
    <div className="bg-ivory rounded-xl border border-border-cream p-3 mb-6 flex flex-wrap items-center gap-3">
      {/* 搜索框 */}
      <div className="flex-1 min-w-[200px] relative">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search task description or ID..."
          className="w-full bg-parchment/50 border border-border-cream rounded-lg px-3 py-2 text-sm text-near-black placeholder:text-stone-gray focus:outline-none focus:border-olive-gray"
        />
      </div>

      {/* status 下拉 */}
      <select
        value={initialStatus}
        onChange={e => setStatus(e.target.value as StatusFilter)}
        className="bg-parchment/50 border border-border-cream rounded-lg px-3 py-2 text-sm text-near-black focus:outline-none focus:border-olive-gray cursor-pointer"
      >
        {STATUS_OPTIONS.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>

      {/* batch 下拉 */}
      {batches.length > 0 && (
        <select
          value={initialBatch}
          onChange={e => setBatch(e.target.value)}
          className="bg-parchment/50 border border-border-cream rounded-lg px-3 py-2 text-sm text-near-black focus:outline-none focus:border-olive-gray cursor-pointer max-w-[300px]"
          title="Filter by batch"
        >
          <option value="">All batches</option>
          {batches.map(b => (
            <option key={b.id} value={b.id}>{b.id}</option>
          ))}
        </select>
      )}

      {/* clear */}
      {hasActiveFilter && (
        <button
          type="button"
          onClick={clearAll}
          className="text-xs text-stone-gray hover:text-near-black underline-offset-2 hover:underline transition-colors"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
