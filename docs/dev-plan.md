# Floo 开发计划

> 设计文档: [docs/design.md](./design.md)
> 本文档是开发执行计划，供所有参与者读取。

## 参与者与分工

| 角色 | 职责 | 说明 |
|------|------|------|
| **Claude** | 全部开发 | 所有代码编写，可用 subagent 并行处理独立模块 |
| **Codex** | Review | 每个 batch 结束后 review，重点模块深度审查 |
| **人类** | 决策 | 设计变更确认、review 意见仲裁、batch 推进确认 |

## 开发原则

1. **Claude 独占开发**：所有代码由 Claude 编写，避免多开发者上下文分裂
2. **subagent 并行**：同一 batch 内无依赖的模块可用 subagent 并行开发（如 adapter 实现 + skill 模板）
3. **串行优先**：有依赖关系的模块严格串行，types → adapter → scope → dispatcher
4. **每个 batch 结束后 review**：Claude 开发完 → 提交 → Codex review → 人工确认 → 下一个 batch
5. **原子提交**：每个模块一个 commit，commit message 说清楚干了什么

---

## Batch 1：地基

> 目标：类型系统 + 核心接口 + 基础设施。串行完成。

| # | 文件 | 说明 | 完成标志 |
|---|------|------|---------|
| 1.1 | `packages/core/src/types.ts` | 所有类型定义：Task, Batch, Phase, RunRecord, ExitArtifact, Config 等 | tsc 编译通过 |
| 1.2 | `packages/core/src/adapters/base.ts` | AgentAdapter 接口 + tmux 操作封装 + floo-runner 逻辑（spawn → 捕获退出码 → 写 exit artifact → 发 wait-for 信号） | 能启动 tmux session 跑 `echo hello`，检测完成，并读取 exit artifact |
| 1.3 | `packages/core/src/scope.ts` | scope 冲突检测 + commit 锁（lockfile 实现） | 单元测试：scope 交叉检测、锁获取/释放 |
| 1.4 | `packages/core/src/skills/loader.ts` | 加载 skill markdown + `{{var}}` 模板变量替换 | 能加载 skill 模板并替换变量输出完整 prompt |

### Batch 1 完成标志

```bash
# 能跑通这个验证：
# 1. import types, adapter, scope, loader 全部类型检查通过
# 2. adapter.spawn() 启动 tmux session（通过 floo-runner 包装）
# 3. adapter.isAlive() 返回 true
# 4. session 结束后 .floo/signals/ 下有 exit artifact（含退出码）
# 5. isAlive() 返回 false
```

### Batch 1 Review

提交后交 Codex 做首轮 review。重点：
- `base.ts`：tmux 操作边界（spawn 失败、session name 冲突、floo-runner 信号可靠性）
- `scope.ts`：commit 锁的 crash 安全性（进程崩溃后锁文件是否能正确清理）

---

## Batch 2：核心链路

> 目标：dispatcher 驱动单任务跑完 designer → planner → coder → reviewer 全流程。

### 串行（有依赖）

| # | 文件 | 说明 | 依赖 |
|---|------|------|------|
| 2.1 | `packages/core/src/dispatcher.ts` | 状态机 + on-complete 回调 + dispatch 下一阶段 | types, adapter, scope, loader |
| 2.2 | `packages/core/src/monitor.ts` | tmux wait-for 监听 + 轮询外部状态 + 超时检测 | types, adapter（与 dispatcher 紧耦合）|

### 可并行（subagent）

以下模块接口已定义、互不依赖，可用 subagent 并行开发：

| # | 文件 | 说明 |
|---|------|------|
| 2.3 | `packages/core/src/adapters/claude.ts` | Claude Code adapter 实现 |
| 2.4 | `packages/core/src/adapters/codex.ts` | Codex CLI adapter 实现 |
| 2.5 | `packages/core/src/router.ts` | 任务自动路由（根据描述判断起始阶段） |
| 2.6 | `skills/designer.md` | Designer skill 模板 |
| 2.7 | `skills/planner.md` | Planner skill 模板（输出严格 YAML） |
| 2.8 | `skills/coder.md` | Coder skill 模板 |
| 2.9 | `skills/reviewer.md` | Reviewer skill 模板 |

### 建议执行顺序

1. 先用 subagent 并行写 2.3-2.5（adapter 实现 + router），同时主线程写 2.1 dispatcher
2. dispatcher 完成后写 2.2 monitor
3. skill 模板（2.6-2.9）可在任意时机用 subagent 并行写

### Batch 2 完成标志

```bash
# 端到端验证：
# 1. 手动组装 dispatcher + adapter + skill
# 2. dispatcher.run("add a health check endpoint")
# 3. 观察：designer session 启动 → 完成 → planner session 启动 → ... → reviewer 完成
# 4. .floo/batches/ 下有完整的任务记录
```

### Batch 2 Review（最关键的一轮）

提交后交 Codex 深度 review。**这是整个项目最重要的 review 节点。**

| 模块 | Review 要点 |
|------|------------|
| `dispatcher.ts` | 状态转换是否完备、on-complete 是否处理所有 exit 情况、重试逻辑是否正确、最大重试次数是否生效 |
| `monitor.ts` | wait-for 和轮询是否有竞态、超时处理是否安全、session 清理是否可靠 |

轻 Review（确认接口调用正确即可）：
- `claude.ts` / `codex.ts`：填充 base 接口，逻辑简单
- `router.ts`：路由错了只是起点不对，不会崩
- skill 模板：在实际使用中迭代

---

## Batch 3：CLI 集成

> 目标：`floo run "..."` 一条命令跑通全流程。

| # | 文件 | 说明 |
|---|------|------|
| 3.1 | `packages/cli/src/index.ts` | CLI 入口（commander 注册命令） |
| 3.2 | `packages/cli/src/commands/init.ts` | `floo init`：创建 .floo/ 目录 + 默认配置 |
| 3.3 | `packages/cli/src/commands/run.ts` | `floo run "desc"`：创建任务 + clean check + 调用 dispatcher |
| 3.4 | `packages/cli/src/commands/status.ts` | `floo status`：读 .floo/ 文件输出状态 |
| 3.5 | `packages/cli/src/commands/cancel.ts` | `floo cancel <id>`：kill session + scope 内回滚 + 更新状态 |
| 3.6 | `packages/cli/src/commands/monitor.ts` | `floo monitor`：持续监控输出 |

CLI 命令都是胶水代码，可用 subagent 并行开发多个命令。

| # | 任务 | 说明 |
|---|------|------|
| 3.7 | 集成测试 | 端到端：init → run → status → 等待完成 → 验证产出文件 |
| 3.8 | 错误路径测试 | 失败重试 + 取消 + 超时 |

### Batch 3 完成标志

```bash
cd some-test-project
floo init
floo run "add a health check endpoint"
floo status  # 能看到任务进度
# 等任务跑完，.floo/batches/ 下有完整记录
```

### Batch 3 Review

轻 Review：CLI 是胶水层，确认参数解析和 core API 调用正确即可。

---

## 测试重点

### Batch 1 结束时必须验证

- [ ] tmux session spawn + floo-runner exit artifact 落盘
- [ ] tmux session 异常退出时的检测
- [ ] scope 交叉检测（有交集/无交集）
- [ ] commit 锁获取、释放、crash 后恢复
- [ ] skill 模板加载 + 变量替换

### Batch 2 结束时必须验证

- [ ] 单任务全流程：designer → planner → coder → reviewer
- [ ] 失败重试：coder 失败 → 带错误信息重试 → 成功
- [ ] reviewer fail → 回 coder → 再 review（最多 2 轮）
- [ ] 超时处理：session 超时 → 正确清理
- [ ] 任务取消：cancel → session kill → 状态更新

### Batch 3 结束时必须验证

- [ ] `floo init` 在空项目和已有项目下都正常
- [ ] `floo run` 拒绝 dirty working tree
- [ ] `floo run` → 全流程跑通
- [ ] `floo cancel` 只回滚 scope 内文件
- [ ] `floo status` 输出准确反映实际状态
