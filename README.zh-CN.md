# Floo

**Multi-Agent Vibe Coding Harness**

面向个人开发者的轻量多 Agent 编排系统——多 agent 并行开发、交叉 review、自动重试、任务追踪。

> **Language / 语言**: [English](./README.md) | 中文

---

## 它做什么

Floo 协调多个 AI 编码 agent（Claude Code、Codex 等）通过结构化流水线协作：

```
用户描述任务 → Designer → Planner → Coder(s) → Reviewer → Tester → 整体报告
```

- **并行执行**：Planner 拆分子任务，scope 无交集的任务同时运行
- **交叉审核**：Reviewer 默认使用与 Coder 不同的 runtime（如 Codex 审核 Claude 的代码）
- **自动重试**：失败的阶段带上错误上下文重试，最多 3 次
- **Scope 隔离**：每个任务只能改指定文件，commit 锁防止并发冲突
- **无头设计**：Floo 是调度器，不是 UI——任何 agent 或脚本都能调用

## 架构

```
用户 ↔ 任意 agent (Claude Code / Codex / OpenClaw) ↔ Floo CLI ↔ 调度器 ↔ 工作 agent
        交互层                                        编排层        执行层
```

Floo 本身是**无头的编排层**，不绑定任何交互方式。谁调用 CLI 谁就是交互层。

### 六个角色

| 角色 | 职责 | 产出 |
|------|------|------|
| **Designer** | 需求分析、scope 定义 | `design.md` |
| **Planner** | 任务拆分、依赖编排 | `plan.md`（严格 YAML） |
| **Coder** | 写代码、原子提交 | git commits |
| **Reviewer** | 代码审查（只读不改） | `review.md`（pass/fail） |
| **Tester** | E2E / 集成测试 | `test-report.md`（pass/fail） |
| **house-elf** | 系统运维 | 经验记录、配置同步、清理 |

### 默认角色绑定

```yaml
designer:  { runtime: claude, model: sonnet }
planner:   { runtime: claude, model: sonnet }
coder:     { runtime: claude, model: sonnet }
reviewer:  { runtime: codex,  model: codex-mini }  # 默认交叉审核
tester:    { runtime: claude, model: sonnet }
```

可在 `floo.config.json` 中按项目覆盖，或由 Planner 按任务动态指定。

## 快速开始

```bash
# 克隆并安装
git clone https://github.com/ayaoplus/floo.git
cd floo && npm install

# 构建
npm run build

# 在你的项目中初始化
cd /path/to/your/project
floo init                        # 创建 .floo/、配置文件、skill 模板
floo init --with-playwright      # 同时安装 Playwright 用于 E2E 测试

# 运行任务
floo run "给 API 加上用户认证"

# 查看进度
floo status                      # 当前任务快照
floo monitor                     # 实时进度流

# 后台模式
floo run "重构支付模块" --detach
floo monitor                     # 实时查看通知
```

## 任务生命周期

```
floo run "重构支付模块"
  │
  ├─ Designer → design.md（需求 + scope）
  ├─ Planner  → plan.md（YAML 子任务列表）
  │
  ├─ scope 无交集的子任务 → 并行执行
  │   ├─ task-001: Coder → Reviewer → Tester ✓
  │   ├─ task-002: Coder → Reviewer → Tester ✓
  │   └─ task-003:（依赖 task-001）→ 等待 → Coder → Reviewer → Tester ✓
  │
  └─ 全部通过 → 整体 Review（只读报告）
```

**失败处理**：
- Reviewer fail → 回到 Coder（最多 2 轮）
- Tester fail → 回到 Coder → Reviewer → Tester（最多 2 轮）
- 阶段崩溃 → 带错误上下文重试（最多 3 次）
- 重试耗尽 → 暂停，通知人工介入

## 项目结构

```
floo/
├── packages/
│   ├── core/          # 调度器、适配器、scope、路由、监控
│   ├── cli/           # CLI 命令（init, run, status, cancel, monitor）
│   └── web/           # Next.js 监控面板（计划中）
├── skills/            # Skill 模板（designer, planner, coder, reviewer, tester）
├── templates/         # Git hooks、配置模板
└── docs/
    ├── design.md      # 完整设计文档
    └── dev-plan.md    # 开发路线图
```

## 技术栈

- TypeScript monorepo（npm workspaces）
- Node.js ESM
- tmux（每个 agent 一个 session）
- 除 AI CLI 工具本身外无外部依赖

## 开发进度

| 里程碑 | 状态 | 说明 |
|--------|------|------|
| M1: 单任务 | 已完成 | `floo init → run → status` 全链路打通 |
| M2: 多任务 + 质量提升 | 已完成 | 并行调度、编译门禁、后台模式、tester、批次总结 |
| M3: 运维与进化 | 计划中 | 经验积累、配置同步、健康检查 |
| M4: Web UI | 计划中 | Next.js 可视化监控面板 |

## 设计哲学

- **做调度器，不做引擎** — Floo 编排，agent 干活
- **Elvis 的实用 + Peter 的极简** — tmux + 文件信号，不用框架
- **Skill 模板才是产品** — 精心调优的 prompt，不是花哨的代码
- **如无必要勿增实体** — 还不需要的功能就不做

## License

MIT
