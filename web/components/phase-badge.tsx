/**
 * 任务阶段徽章
 * 显示当前执行阶段：discuss/designer/planner/coder/reviewer/tester
 */

import type { Phase } from '@/lib/types';
import { PHASE_ORDER } from '@/lib/types';

const PHASE_ICONS: Record<Phase, string> = {
  discuss:  '\u{1F4AC}',
  designer: '\u{1F3A8}',
  planner:  '\u{1F4CB}',
  coder:    '\u{1F4BB}',
  reviewer: '\u{1F50D}',
  tester:   '\u{1F9EA}',
};

const PHASE_LABELS: Record<Phase, string> = {
  discuss:  'Discuss',
  designer: 'Designer',
  planner:  'Planner',
  coder:    'Coder',
  reviewer: 'Reviewer',
  tester:   'Tester',
};

export function PhaseBadge({ phase }: { phase: Phase }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-ivory text-olive-gray border border-border-cream">
      <span>{PHASE_ICONS[phase]}</span>
      {PHASE_LABELS[phase]}
    </span>
  );
}

/** 阶段进度条:展示完整 6 阶段的完成情况(顺序以 PHASE_ORDER 为准) */
export function PhaseProgress({ currentPhase, status }: { currentPhase: Phase | null; status: string }) {
  const phases = PHASE_ORDER;
  const currentIdx = currentPhase ? phases.indexOf(currentPhase) : -1;
  const isCompleted = status === 'completed';
  const isFailed = status === 'failed';

  return (
    <div className="flex items-center gap-0.5">
      {phases.map((phase, idx) => {
        let dotStyle = 'bg-border-warm'; // 未到达
        if (isCompleted) {
          dotStyle = 'bg-success';
        } else if (isFailed && idx <= currentIdx) {
          dotStyle = idx === currentIdx ? 'bg-error' : 'bg-success';
        } else if (idx < currentIdx) {
          dotStyle = 'bg-success';
        } else if (idx === currentIdx) {
          dotStyle = 'bg-terracotta animate-pulse';
        }

        return (
          <div key={phase} className="flex items-center" title={PHASE_LABELS[phase]}>
            <div className={`h-2 w-2 rounded-full ${dotStyle}`} />
            {idx < phases.length - 1 && (
              <div className={`h-px w-3 ${idx < currentIdx || isCompleted ? 'bg-success' : 'bg-border-warm'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}
