/**
 * runTask 的运行时状态(Step 4c)
 *
 * 用一份 step 数组 + 计数器 + currentIdx 替代散在各处的 phaseIdx/reviewRounds/testRounds
 * 局部变量。runStateMachine 主循环操作这个对象。
 *
 * 当前阶段(Step 4c v1):
 *   - RunStep.id 等同 RunStep.phase(由 PHASE_ORDER 派生),没有跨 step 的 id 唯一性需求
 *   - reviewer/tester fail 通过 rollbackToPhase 回退到最近的 coder step,沿用 PHASE_ORDER 时代的语义
 *   - 后续(Step 4d)会改成"reviewer fail → 通过 plan-patch append 新 coder + reviewer step",
 *     plan.steps 变成 append-only ledger,id 必须唯一
 */

import { PHASE_ORDER, type Phase } from '../types.js';
import type { PlanStep, PlanTemplateStep } from '../plan.js';

/** step 状态枚举 */
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';

/** 执行时关心的 step 字段(plan.yaml 里的 PlanStep 是声明,RunStep 是运行时投影) */
export interface RunStep {
  /** step ID,目前等同 phase */
  id: string;
  /** capability 名,等同 Phase */
  phase: Phase;
  /** 状态,运行过程中变化 */
  status: StepStatus;
}

/** runStateMachine 的运行时状态 */
export interface RunState {
  /** 主 step 序列。Step 4d 后允许 append(plan-patch) */
  steps: RunStep[];
  /** 当前正在/即将执行的 step idx */
  currentIdx: number;
  /** review 循环计数(reviewer fail → coder retry) */
  reviewRounds: number;
  /** test 循环计数(tester fail → coder retry) */
  testRounds: number;
  /** 全局 run 计数,saveRun 用 */
  runCounter: number;
}

/** 当前正在执行的 step,越界返回 undefined */
export function currentStep(state: RunState): RunStep | undefined {
  return state.steps[state.currentIdx];
}

/** 推进到下一 step */
export function advance(state: RunState): void {
  state.currentIdx++;
}

/**
 * 回退到最近的某 phase step(向左找)。找到则把 currentIdx 设到那,返回 true。
 *
 * reviewer/tester fail 时:rollbackToPhase(state, 'coder') 把指针拉回最近的 coder。
 * 注意是"最近一个"——多 round 后只回到最近一次的 coder,与原 dispatcher 语义一致。
 */
export function rollbackToPhase(state: RunState, phase: Phase): boolean {
  for (let i = state.currentIdx; i >= 0; i--) {
    if (state.steps[i]?.phase === phase) {
      state.currentIdx = i;
      return true;
    }
  }
  return false;
}

/**
 * 按 (startPhase, endPhase) 范围合成线性 step 序列。
 *
 * 这是 Step 4c v1 的兼容路径:把"phase 范围"转成"step 列表",
 * runTask 入口仍用 phase 签名,内部 makeStepsForPhaseRange 合成。
 *
 * Step 4d 后,createAndRun 直接消费 plan.steps,这个函数只服务老入口。
 */
export function makeStepsForPhaseRange(startPhase: Phase, endPhase?: Phase): RunStep[] {
  const startIdx = PHASE_ORDER.indexOf(startPhase);
  if (startIdx === -1) throw new Error(`Invalid start phase: ${startPhase}`);
  const endIdx = endPhase ? PHASE_ORDER.indexOf(endPhase) : PHASE_ORDER.length - 1;
  if (endIdx === -1 || endIdx < startIdx) {
    throw new Error(`Invalid end phase: ${endPhase}`);
  }
  return PHASE_ORDER.slice(startIdx, endIdx + 1).map((phase): RunStep => ({
    id: phase,
    phase,
    status: 'pending',
  }));
}

/**
 * 把 plan.yaml 的声明 step 数组(PlanStep 或 PlanTemplateStep)转成运行时 RunStep[]。
 *
 *   - 跳过 deferred 占位(planner 拆 task 后才知道形态)
 *   - 顺序保持 plan 声明序
 *
 * 注意:这里不解析 step.depends_on / loop_with / scope 等高级字段,
 * 因为 Step 4c v1 还是线性执行,不做 DAG 调度。
 */
export function planStepsToRunSteps(planSteps: ReadonlyArray<PlanStep | PlanTemplateStep>): RunStep[] {
  const out: RunStep[] = [];
  for (const ps of planSteps) {
    if (ps.status === 'deferred') continue;
    out.push({
      id: ps.id,
      phase: ps.capability,
      status: 'pending',
    });
  }
  return out;
}

/** 用一组 step 创建初始 RunState */
export function makeRunState(steps: RunStep[]): RunState {
  return {
    steps,
    currentIdx: 0,
    reviewRounds: 0,
    testRounds: 0,
    runCounter: 0,
  };
}
