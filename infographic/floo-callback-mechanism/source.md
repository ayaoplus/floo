# Floo 事件驱动回调机制

## 参与者
1. 调用方 Agent (CC/Codex/OpenClaw)
2. floo CLI
3. Dispatcher (Node.js 进程)
4. Runner 脚本 (tmux session)
5. 工作 Agent (coder/reviewer)

## 时序流程
1. 调用方 Agent → floo CLI: `floo run "task"` (阻塞等待)
2. floo CLI → Dispatcher: createAndRun()
3. Dispatcher → Runner: adapter.spawn() → tmux new-session
4. Runner → 工作 Agent: 启动 agent CLI 命令
5. 工作 Agent 自主编码 + git commit (post-commit hook 编译门禁)
6. 工作 Agent → Runner: exit (exit_code)
7. Runner: force-commit (scope 内未提交变更兜底)
8. Runner: 收集 files_changed (git diff)
9. Runner: 写 exit artifact (.floo/signals/*.exit)
10. Runner → Dispatcher: tmux wait-for 信号 (零延迟事件回调)
11. Dispatcher: 读 exit artifact → 状态机推进
12. Dispatcher: 写通知文件 (.floo/notifications/)
13. Dispatcher: dispatch 下一个 phase 或任务 (循环回到步骤3)
14. Dispatcher → floo CLI: 返回 { batch, tasks }
15. floo CLI → 调用方 Agent: exit code + stdout (CLI 本身就是回调)

## 关键标注
- 步骤10: "零延迟" — tmux wait-for 是核心回调机制
- 步骤15: "同步模式下 CLI exit = 回调"
- 整体: 不需要轮询，不需要 webhook，事件驱动

## 设计要点
- 与 agent-swarm 的 on-complete.sh 回调等价
- tmux wait-for 替代了传统的轮询/webhook
- CLI 的 exit code + stdout 本身就是对调用方 agent 的回调
