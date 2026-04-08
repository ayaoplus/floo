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

### M1 已知限制（已在 M2 中解决）

- ~~单任务独占仓库，不支持并行~~ → Batch 4 多任务并行
- ~~Planner 输出用正则解析~~ → 已改为 yaml 包完整解析
- ~~无 force-commit 兜底~~ → Batch 5 实现
- ~~无 `--detach` 后台模式~~ → Batch 6 实现
- skill 模板需要在实际使用中迭代调优（Batch 9）

---

# Milestone 2：多任务并行 + 质量提升 ✅

> 目标：多任务并行调度，编译门禁，通知文件输出，后台模式。

## Batch 4：多任务并行调度 ✅

> scope 无交集的任务并行 dispatch，有交集串行，commit 锁序列化 git 写操作。

## Batch 5：编译门禁 + force-commit ✅

> post-commit hook 跑 tsc，失败 soft reset；agent 退出后 scope 内未提交变更自动 commit。

## Batch 6：后台模式 + 通知文件 ✅

> `floo run --detach` 后台运行，关键节点写通知文件到 `.floo/notifications/`。

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

## Batch 8：house-elf ✅

| # | 任务 | 状态 |
|---|------|------|
| 8.1 | lesson 记录 | ✅ |
| 8.2 | `floo learn "经验"` | ✅ |
| 8.3 | 规则提炼 | ✅ |
| 8.4 | `floo sync` | ✅ |
| 8.5 | 健康检查 | ✅ |
| 8.6 | dispatch heartbeat | ✅ |

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

### 当前测试覆盖（70 cases）

**test-batch1.ts**（46 cases）：
- types 导入、scope 冲突检测（含空 scope）、commit 锁、skill 模板、tmux adapter
- router 路由、adapter 导入、YAML 引号处理

**test-dispatcher.ts**（24 cases）：
- 单任务 happy path（coder → reviewer → tester）
- reviewer fail → coder 重试 → reviewer pass
- tester fail → coder 重试 → tester pass
- max review rounds → failed
- coder 重试 MAX_RETRIES → failed
- review_level scan/skip
- createAndRun 多任务并行调度
- head_after exit artifact 字段验证
