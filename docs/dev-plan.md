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
2. **subagent 并行**：同一 batch 内无依赖的模块可用 subagent 并行开发
3. **串行优先**：有依赖关系的模块严格串行
4. **每个 batch 结束后 review**：Claude 开发完 → 提交 → Codex review → 人工确认 → 下一个 batch
5. **原子提交**：每个模块一个 commit，commit message 说清楚干了什么

---

# Milestone 1：单任务全流程 ✅

> 已完成。`floo init → floo run → floo status` 全链路打通。

## Batch 1：地基 ✅

| # | 文件 | 状态 |
|---|------|------|
| 1.1 | `packages/core/src/types.ts` | ✅ |
| 1.2 | `packages/core/src/adapters/base.ts` | ✅ |
| 1.3 | `packages/core/src/scope.ts` | ✅ |
| 1.4 | `packages/core/src/skills/loader.ts` | ✅ |

## Batch 2：核心链路 ✅

| # | 文件 | 状态 |
|---|------|------|
| 2.1 | `packages/core/src/dispatcher.ts` | ✅ |
| 2.2 | `packages/core/src/monitor.ts` | ✅ |
| 2.3-2.4 | `adapters/claude.ts`, `adapters/codex.ts` | ✅ |
| 2.5 | `packages/core/src/router.ts` | ✅ |
| 2.6-2.9 | `skills/*.md` (4 个模板) | ✅ |

## Batch 3：CLI 集成 ✅

| # | 文件 | 状态 |
|---|------|------|
| 3.1-3.6 | CLI 命令 (init/run/status/cancel/monitor) | ✅ |

### M1 已知限制

- 单任务独占仓库，不支持并行
- Planner 输出用正则解析，不是完整 YAML 解析器
- 无 force-commit 兜底（设计文档有，代码未实现）
- 无 `--detach` 后台模式
- skill 模板需要在实际使用中迭代调优

---

# Milestone 2：多任务并行 + 质量提升

> 目标：多任务并行调度，编译门禁，通知文件输出，后台模式。

## Batch 4：多任务并行调度

> 核心目标：Planner 拆出多任务后，scope 无交集的任务并行 dispatch。

| # | 文件 | 说明 | 依赖 |
|---|------|------|------|
| 4.1 | `packages/core/src/dispatcher.ts` | 扩展 `runTask` 为 `runBatch`：解析 plan.md 拆出多任务，scope 冲突检测，并行 dispatch 无冲突任务，串行 dispatch 有冲突任务 | scope.ts |
| 4.2 | `packages/core/src/scope.ts` | commit 锁实际集成到 dispatcher 的 coder phase，序列化并发 commit | dispatcher |
| 4.3 | `packages/core/src/types.ts` | 新增 `BatchTask`（批次内子任务）类型，区分于当前的单任务模型 | - |
| 4.4 | `packages/core/src/monitor.ts` | 状态查询支持多任务视图，`floo status` 显示并行任务进度 | - |

### Batch 4 完成标志

```bash
floo run "重构支付模块"
# Planner 拆出 3 个子任务：T001 改 API, T002 改 DB, T003 改前端
# T001 和 T003 scope 无交集 → 并行 dispatch
# T002 和 T001 有交集 → T001 完成后再 dispatch T002
# floo status 显示三个任务各自的进度
```

### Batch 4 Review 重点

- dispatcher 的并行/串行判断逻辑
- commit 锁在实际并发场景下的可靠性
- 任务依赖解锁的正确性

---

## Batch 5：编译门禁 + force-commit

> 核心目标：agent commit 后自动编译检查，失败 soft reset；agent 退出时兜底未提交的代码。

| # | 文件 | 说明 |
|---|------|------|
| 5.1 | `packages/cli/src/commands/init.ts` | `floo init` 安装 post-commit git hook |
| 5.2 | `templates/post-commit.sh` | hook 模板：`tsc --noEmit` 检查改动文件的新错误，失败 `git reset --soft HEAD~1`（不做 auto push，并行安全考虑） |
| 5.3 | `packages/core/src/adapters/base.ts` | floo-runner 脚本加 force-commit：agent 退出后检查 `git status --porcelain`，scope 内未提交变更自动 `git add + commit` |

### Batch 5 完成标志

```bash
# agent commit 后：
# 1. post-commit hook 跑 tsc
# 2. 编译失败 → git reset --soft（保留代码让 agent 继续修）
# 3. 编译通过 → 继续（不自动 push，并行安全考虑）
# agent 退出后：
# 4. 有未提交的 scope 内文件 → 自动 commit
```

---

## Batch 6：后台模式 + 通知文件

> 核心目标：`floo run --detach` 后台运行，关键节点写通知文件。

| # | 文件 | 说明 |
|---|------|------|
| 6.1 | `packages/cli/src/commands/run.ts` | 加 `--detach` 选项：fork 子进程后立即返回 |
| 6.2 | `packages/core/src/dispatcher.ts` | 在关键节点写通知文件到 `.floo/notifications/` |
| 6.3 | `packages/core/src/notifications.ts` | 通知文件读写：结构化 JSON（事件类型、时间戳、任务 ID、阶段、结果摘要） |
| 6.4 | `packages/cli/src/commands/monitor.ts` | 读取 notifications/ 实时显示，新通知高亮 |

### 通知时间点

| 事件 | 写入内容 |
|------|---------|
| 任务启动 | session 名、模型、任务描述 |
| phase 完成 | 任务 ID、phase、exit_code、耗时 |
| review 结论 | verdict、反馈摘要 |
| 失败/重试 | 错误原因、当前 attempt |
| 全部完成 | 整体结果、总耗时 |

### 通知消费方式

- **CLI 同步模式**：`floo run` 直接 stdout 打印进度，不需要读 notification 文件
- **CLI 后台模式**：`floo run --detach` 后，用 `floo monitor` 读 notification 实时显示
- **外部 agent 调用**（OpenClaw 等）：调用方自己读 `.floo/notifications/`，按自己的通道转发

**Floo 不直接调用任何通知通道（Telegram/飞书/Slack），只写文件。调用方负责呈现。**

---

## Batch 7：Tester 角色 + 整体 Review ✅

> 核心目标：在 reviewer 之后加 tester 阶段，批次完成后做整体 review 报告。

| # | 文件 | 状态 |
|---|------|------|
| 7.1 | `skills/tester.md` | ✅ |
| 7.2 | `packages/core/src/types.ts` | ✅ |
| 7.3 | `packages/core/src/dispatcher.ts` | ✅ |
| 7.4 | `packages/cli/src/commands/init.ts` | ✅ |
| 7.5 | `packages/core/src/dispatcher.ts` | ✅ |

---

# Milestone 3：运维与进化

> 目标：系统自我维护、经验积累、配置同步。

## Batch 8：house-elf

| # | 任务 | 说明 |
|---|------|------|
| 8.1 | lesson 记录 | 任务失败重试成功后，对比差异自动提取 lesson |
| 8.2 | `floo learn "经验"` | 手动添加 lesson |
| 8.3 | 规则提炼 | lesson 积累后归纳 → 写入 `.floo/context/project-rules.md` |
| 8.4 | `floo sync` | 读 project-rules.md 生成 CLAUDE.md / AGENTS.md |
| 8.5 | 健康检查 | orphan session 清理、stale task 检测、日志轮转 |
| 8.6 | dispatch heartbeat | 每 5 分钟刷新 updated_at，health-check 15 分钟无更新报警 |

## Batch 9：Skill 模板迭代

| # | 任务 | 说明 |
|---|------|------|
| 9.1 | 模板迭代 | 根据实际跑通的经验调优 4 个 skill 模板 |
| 9.2 | house-elf.md | 系统运维角色的 skill 模板 |
| 9.3 | 项目级覆盖 | 支持目标项目自定义 skill 模板覆盖默认模板 |

---

# Milestone 4：Web UI + 扩展

> 目标：可视化监控面板，更多 runtime 支持。

## Batch 10：Web UI

| # | 任务 | 说明 |
|---|------|------|
| 10.1 | `packages/web/` | Next.js 只读监控面板 |
| 10.2 | 任务列表页 | 状态徽章、runtime 标签、耗时、批次分组 |
| 10.3 | 任务详情页 | artifact 文件内容、run 历史、日志 |
| 10.4 | `floo serve` | Hono HTTP server 读 .floo/ 返回 JSON |

## Batch 11：扩展 Runtime

| # | 任务 | 说明 |
|---|------|------|
| 11.1 | OpenClaw adapter | 第三个 runtime |
| 11.2 | 自定义 adapter 机制 | 插件式注册新 runtime |
| 11.3 | reasoning effort 配置 | Codex 的 medium/high/extra-high，重试时自动升级 |

---

## 测试策略

### 当前测试覆盖（44 cases）

- Batch 1：types 导入、scope 冲突、commit 锁、skill 模板、tmux adapter
- Batch 2：router 路由、adapter 导入、YAML 引号处理
- Batch 3：手动验证 init → run → status 链路

### M2 需要补充的测试

- [x] 多任务并行 dispatch + scope 冲突检测（scopesOverlap / detectConflicts / findOutOfScope）
- [x] commit 锁并发场景（基础 acquire/release/reentrant 已覆盖，真并发未测）
- [ ] force-commit 兜底
- [ ] post-commit hook 编译门禁（通过 + 失败两条路径）
- [ ] `--detach` 后台模式 + notification 文件生成
- [ ] cancel 在并行任务场景下的正确性
