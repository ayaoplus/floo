# Floo 事件驱动回调机制

## Learning Objectives
- 理解 Floo 的回调不依赖轮询或 webhook，而是 tmux wait-for 事件驱动
- 理解 CLI exit code 本身就是对调用方 agent 的回调信号
- 理解 runner 脚本在 agent 退出后的兜底流程

## Section 1: 调用阶段
**Key Concept**: 调用方 Agent 通过 CLI 同步调用 Floo
**Content**:
- 调用方 Agent (CC/Codex/OpenClaw) 执行 `floo run "task description"`
- CLI 阻塞等待，调用 Dispatcher 的 `createAndRun()`
- 对调用方来说就是一个普通的 CLI 命令
**Visual**: 左侧两个节点（调用方 → CLI → Dispatcher），箭头标注命令

## Section 2: 派发阶段
**Key Concept**: Dispatcher 通过 tmux 启动 agent
**Content**:
- Dispatcher 调用 `adapter.spawn()` 创建 tmux session
- Runner 脚本在 tmux 内执行，启动工作 Agent (claude/codex CLI)
- 工作 Agent 自主编码，通过 git commit 提交（post-commit hook 做编译门禁）
**Visual**: 中间节点（Dispatcher → Runner → Agent），箭头标注 tmux new-session

## Section 3: 回收阶段（Runner 兜底）
**Key Concept**: Runner 脚本做 3 件事：兜底提交、收集变更、写信号
**Content**:
- force-commit: scope 内未提交变更自动 `git add + commit`
- 收集 files_changed: `git diff` 汇总所有变更文件
- 写 exit artifact: JSON 落盘到 `.floo/signals/{taskId}-{phase}.exit`
**Visual**: Runner 节点内的 3 个子步骤，垂直排列

## Section 4: 回调阶段（核心）
**Key Concept**: tmux wait-for 是零延迟事件回调
**Content**:
- Runner 发送 `tmux wait-for -S 'floo-xxx-done'` 信号
- Dispatcher 的 `waitForCompletion()` 立即被唤醒（零延迟，不是轮询）
- Dispatcher 读取 exit artifact → 状态机推进到下一个 phase
- 写通知文件到 `.floo/notifications/`（供外部消费者）
**Visual**: Runner → Dispatcher 的粗箭头，标注 "tmux wait-for (零延迟)" ★ 关键路径高亮
**Label**: ★ 核心回调机制 — 等价于 agent-swarm 的 on-complete.sh

## Section 5: 循环与完成
**Key Concept**: 状态机循环直到所有 phase 完成，CLI exit 就是最终回调
**Content**:
- 如果还有下一个 phase（如 coder → reviewer）→ 回到派发阶段
- 所有 phase 完成 → Dispatcher 返回 `{ batch, tasks }`
- CLI 输出结果并 `exit 0`（成功）或 `exit 1`（失败）
- 对调用方 Agent 来说：CLI 退出 = 任务完成 = 回调触发
**Visual**: 循环箭头回到 Section 2；完成时箭头从 Dispatcher → CLI → 调用方
**Label**: ★ 同步模式下 CLI exit = 回调。不需要轮询，不需要 webhook。

## Bottom Note
对比：agent-swarm 用 `on-complete.sh` 脚本回调 → Floo 用 `tmux wait-for` 信号回调。本质相同：事件驱动，零延迟。
