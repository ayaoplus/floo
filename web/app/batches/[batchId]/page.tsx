/**
 * Batch DAG 页面 (Step 7)
 *
 * 围绕 plan.yaml 展示 batch 的执行图:
 *   - 标题区:batch 元数据 + 当前状态
 *   - DAG SVG:plan.steps 拓扑分层布局,depends_on 边可视化,patch 追加节点高亮
 *   - patch 时间线:plan-patch ledger 演化历史
 *   - 节点点击 → 跳到对应 task 详情
 *
 * 设计取舍:
 *   - 用纯 SVG 自己布局而非 react-flow:floo 是单人本机工具,DAG 通常 < 20
 *     节点 < 6 层,不值得加 200KB 依赖。维护性优先于交互性。
 *   - step → task 映射不精确:plan.yaml 是开局快照,planner 拆 task 后不更新;
 *     这里粗略把所有 step 链到 initial_task。Step 8 引入精确 step↔run 映射时再说。
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getBatch, listTasks } from '@/lib/floo';
import { getBatchPlan, getBatchPatches, layoutDag, type DagNode } from '@/lib/plan';
import { StatusBadge } from '@/components/status-badge';
import { PhaseBadge } from '@/components/phase-badge';
import { AutoRefresh } from '@/components/auto-refresh';
import { formatRelative } from '@/components/duration';

export const dynamic = 'force-dynamic';

export default async function BatchDagPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId } = await params;
  const batch = await getBatch(batchId);
  if (!batch) notFound();

  const plan = await getBatchPlan(batchId);
  const patches = await getBatchPatches(batchId);
  const tasks = await listTasks(batchId);
  const initialTaskId = plan?.initial_task.id ?? tasks[0]?.id ?? null;

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      {/* 标题 + 自动刷新 */}
      <div className="mb-8 flex items-start justify-between">
        <div>
          <div className="text-xs text-stone-gray mb-1">
            <Link href="/" className="hover:text-near-black">Dashboard</Link>
            <span className="mx-2">/</span>
            <Link href="/tasks" className="hover:text-near-black">Tasks</Link>
            <span className="mx-2">/</span>
            <span>Batch DAG</span>
          </div>
          <h1 className="font-serif text-3xl font-medium text-near-black mb-2">
            {batch.description}
          </h1>
          <div className="flex items-center gap-3 text-sm text-olive-gray">
            <span className="font-mono text-xs">{batch.id}</span>
            <StatusBadge status={batch.status} />
            <span className="text-xs text-stone-gray">{formatRelative(batch.created_at)}</span>
          </div>
        </div>
        <AutoRefresh intervalMs={5000} />
      </div>

      {/* plan 缺失提示 */}
      {!plan ? (
        <div className="bg-ivory rounded-xl border border-border-cream p-6 text-center text-olive-gray">
          <p className="mb-2">plan.yaml not found for this batch.</p>
          <p className="text-sm text-stone-gray">
            老 dispatcher 路径不写 plan.yaml(Step 1 之前的 batch),或 plan 文件被手动删除。
          </p>
        </div>
      ) : (
        <>
          {/* DAG */}
          <section className="mb-8">
            <h2 className="font-serif text-xl font-medium text-near-black mb-4">
              Plan DAG
              {patches.length > 0 && (
                <span className="ml-3 text-sm font-normal text-stone-gray">
                  ({patches.length} patch{patches.length === 1 ? '' : 'es'} applied)
                </span>
              )}
            </h2>
            <PlanDagSvg plan={plan} patches={patches} initialTaskId={initialTaskId} batchId={batchId} />
          </section>

          {/* Patch 时间线 */}
          {patches.length > 0 && (
            <section className="mb-8">
              <h2 className="font-serif text-xl font-medium text-near-black mb-4">Patch Timeline</h2>
              <div className="space-y-3">
                {patches.map(p => (
                  <div key={p.patch_id} className="bg-ivory border border-border-cream rounded-lg p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-mono text-sm text-near-black">{p.patch_id}</span>
                      <span className="text-xs text-stone-gray">{formatRelative(p.generated_at)}</span>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-olive-gray mb-2">
                      <span><span className="text-stone-gray">parent:</span> {p.parent_step}</span>
                      <span><span className="text-stone-gray">reason:</span> {p.reason}</span>
                      <span><span className="text-stone-gray">by:</span> {p.generated_by}</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {p.append_steps.map(s => (
                        <span key={s.id} className="font-mono text-xs px-2 py-0.5 bg-warm-cream rounded border border-border-cream">
                          + {s.id}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* plan metadata */}
          <section className="mb-8">
            <h2 className="font-serif text-xl font-medium text-near-black mb-4">Plan Metadata</h2>
            <dl className="bg-ivory border border-border-cream rounded-lg p-5 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              <dt className="text-stone-gray">Mode</dt>
              <dd className="font-mono text-near-black">{plan.mode}</dd>
              <dt className="text-stone-gray">Start phase</dt>
              <dd><PhaseBadge phase={plan.start_phase} /></dd>
              <dt className="text-stone-gray">Total steps</dt>
              <dd className="text-near-black">{plan.steps.length}</dd>
              <dt className="text-stone-gray">Initial task</dt>
              <dd className="font-mono text-near-black text-xs">{plan.initial_task.id}</dd>
            </dl>
          </section>

          {/* notes */}
          {plan.notes.length > 0 && (
            <section>
              <h2 className="font-serif text-xl font-medium text-near-black mb-4">Notes</h2>
              <ul className="bg-ivory border border-border-cream rounded-lg p-5 space-y-1.5 text-sm text-olive-gray">
                {plan.notes.map((n, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="text-stone-gray mt-0.5">·</span>
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

// ============================================================
// SVG DAG 渲染
// ============================================================

const NODE_W = 160;
const NODE_H = 56;
const LAYER_GAP = 220;   // 层间距(横向)
const COL_GAP = 80;      // 同层列间距(纵向)
const PAD_X = 24;
const PAD_Y = 16;

function nodeX(layer: number): number {
  return PAD_X + layer * LAYER_GAP;
}
function nodeY(column: number): number {
  return PAD_Y + column * COL_GAP;
}

/** SVG DAG。节点大小和层级位置全由布局函数决定,这里只渲染 */
function PlanDagSvg({
  plan,
  patches,
  initialTaskId,
  batchId,
}: {
  plan: Parameters<typeof layoutDag>[0];
  patches: Parameters<typeof layoutDag>[1];
  initialTaskId: string | null;
  batchId: string;
}) {
  const { nodes, edges } = layoutDag(plan, patches);

  if (nodes.length === 0) {
    return (
      <div className="bg-ivory border border-border-cream rounded-lg p-8 text-center text-stone-gray">
        empty plan
      </div>
    );
  }

  const maxLayer = Math.max(...nodes.map(n => n.layer));
  const maxCol = Math.max(...nodes.map(n => n.column));
  const width = nodeX(maxLayer) + NODE_W + PAD_X;
  const height = nodeY(maxCol) + NODE_H + PAD_Y;

  const nodeMap = new Map(nodes.map(n => [n.id, n] as const));

  return (
    <div className="bg-ivory border border-border-cream rounded-lg p-4 overflow-x-auto">
      <svg width={width} height={height} className="block" viewBox={`0 0 ${width} ${height}`}>
        {/* 边 */}
        <g>
          {edges.map((e, i) => {
            const from = nodeMap.get(e.from);
            const to = nodeMap.get(e.to);
            if (!from || !to) return null;
            return <DagEdgePath key={`${e.from}-${e.to}-${i}`} from={from} to={to} />;
          })}
        </g>
        {/* 节点 */}
        <g>
          {nodes.map(n => (
            <DagNodeRect
              key={n.id}
              node={n}
              initialTaskId={initialTaskId}
              batchId={batchId}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}

/** 一条 cubic bezier 边:from 节点右边 → to 节点左边 */
function DagEdgePath({ from, to }: { from: DagNode; to: DagNode }) {
  const x1 = nodeX(from.layer) + NODE_W;
  const y1 = nodeY(from.column) + NODE_H / 2;
  const x2 = nodeX(to.layer);
  const y2 = nodeY(to.column) + NODE_H / 2;
  const dx = (x2 - x1) / 2;
  const path = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  return (
    <path
      d={path}
      fill="none"
      stroke="#c9c4b6"
      strokeWidth={1.5}
    />
  );
}

/** 一个 step 节点:矩形 + capability icon + id */
function DagNodeRect({
  node,
  initialTaskId,
  batchId: _batchId,
}: {
  node: DagNode;
  initialTaskId: string | null;
  batchId: string;
}) {
  const x = nodeX(node.layer);
  const y = nodeY(node.column);

  // 状态视觉:appended_by_patch = 边框红色暗示,deferred = 虚线,pending = 默认
  const strokeColor = node.appended_by_patch ? '#c84a3a' : '#c9c4b6';
  const strokeDash = node.status === 'deferred' ? '4 3' : undefined;
  const fill = '#fbf8f0';

  const taskHref = initialTaskId
    ? `/tasks/${_batchId}/${initialTaskId}`
    : null;

  const content = (
    <g>
      <rect
        x={x}
        y={y}
        width={NODE_W}
        height={NODE_H}
        rx={8}
        ry={8}
        fill={fill}
        stroke={strokeColor}
        strokeWidth={1.5}
        strokeDasharray={strokeDash}
      />
      <text
        x={x + 12}
        y={y + 22}
        className="font-mono"
        fontSize={11}
        fill="#2a2a2a"
      >
        {truncate(node.id, 20)}
      </text>
      <text
        x={x + 12}
        y={y + 40}
        fontSize={10}
        fill="#7a7563"
      >
        {node.capability}
      </text>
      {/* patch 追加节点的右上角红点 */}
      {node.appended_by_patch && (
        <circle cx={x + NODE_W - 8} cy={y + 8} r={3} fill="#c84a3a" />
      )}
      {/* deferred 节点右上角斜线标记 */}
      {node.status === 'deferred' && (
        <text x={x + NODE_W - 28} y={y + 14} fontSize={9} fill="#9a9580">
          defer
        </text>
      )}
    </g>
  );

  if (!taskHref) return content;
  // SVG 内的 <a> 接 next/link 不太自然,这里直接走原生 <a> + relative href
  return (
    <a href={taskHref} className="cursor-pointer">
      {content}
    </a>
  );
}

/** 简单截断字符串,超过 max 用 … 替代尾部 */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
