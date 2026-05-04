'use client';

/**
 * CancelButton — 任务取消按钮
 *
 * 仅对 running 状态的任务渲染。点击后:
 *   1. confirm 二次确认(避免误点)
 *   2. POST /api/tasks/<batch>/<task>/cancel
 *   3. 成功 router.refresh() 让任务详情页重渲
 *   4. 失败弹 alert 显示后端 reason
 *
 * 不引入 toast / dialog 库,保持依赖轻。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  batchId: string;
  taskId: string;
}

export function CancelButton({ batchId, taskId }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleCancel = () => {
    if (!confirm(`Cancel task ${taskId}? This will kill the agent session and roll back unstaged scope changes.`)) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/tasks/${batchId}/${taskId}/cancel`, { method: 'POST' });
        const body: { ok: boolean; reason?: string } = await res.json();
        if (!body.ok) {
          setError(body.reason ?? `HTTP ${res.status}`);
          return;
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleCancel}
        disabled={isPending}
        className="px-4 py-2 text-sm bg-error/10 text-error border border-error/30 rounded-lg hover:bg-error/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {isPending ? 'Cancelling…' : 'Cancel Task'}
      </button>
      {error && (
        <span className="text-xs text-error">{error}</span>
      )}
    </div>
  );
}
