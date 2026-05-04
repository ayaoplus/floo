/**
 * Dispatcher — thin shim
 *
 * 状态机实现已搬到 src/core/executor/ 子模块。本文件只剩 re-export,
 * 保持外部 import 路径(包括 dispatcher.test 与 src/core/index)兼容。
 *
 * 实际实现位置:
 *   - runTask:           src/core/executor/state-machine.ts
 *   - runBatch:          src/core/executor/batch.ts(未导出,仅 createAndRun 内部用)
 *   - createAndRun:      src/core/executor/batch.ts
 *   - DispatcherOptions: src/core/executor/state-machine.ts
 *
 * 后续 commit 会让 createAndRun / runTask 接受 PlanState 而非 (task, startPhase),
 * 真正实现 plan-driven 调度。当前 shim 阶段只是物理位置变了,语义不变。
 */

export { runTask, type DispatcherOptions } from './executor/state-machine.js';
export { createAndRun } from './executor/batch.js';
