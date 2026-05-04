# Floo Architecture

> 状态:本文档描述目标架构。当前实现仍处于过渡期(固定 6 阶段管线),按 [refactor-plan.md](./refactor-plan.md) 的步骤逐步演进到目标态。文档中的"目标态 / 过渡期"标签会标注差异。

Floo 是一个面向**单人多 agent 协同**的本机 harness。它本身不实现编码引擎,而是把多个 AI coding 工具(Claude Code、Codex,以及未来可能加入的 Gemini、OpenClaw、opencode 等)启动在 tmux 中,按一份**显式的执行图(plan)**调度它们,并把所有产物落到 `.floo/` 下供观测和恢复。

## 设计哲学

- **简单 > 完备**:这是个人工具,不是企业平台。能用 30 行代码解决的不写 300 行,能写在配置里的不写在代码里。
- **harness 能力依靠 prompt 和整体设计,而不是具体实现**:每个 capability 的行为定义在 `skills/*.md`,Floo 核心不引入 LLM SDK,只负责调度和数据流。
- **流程不写死**:执行流程是一份 plan 的产物,而不是代码里的状态机。改流程 = 改一份 yaml,不改 TS。
- **兼容性强**:加一个新 runtime / 新 capability,不需要改框架代码,只需要加一份配置 / 一份 prompt 模板。
- **dispatcher,not engine**:Floo 协调生命周期、状态、重试、产物。Agent 负责推理和写代码。
- **files over services**:`.floo/` 就是运行时数据库,无后台守护进程,无外部 DB。
- **event-driven completion**:`tmux wait-for` 是内部回调,文件通知是观测者的副产物。
- **scope-first parallelism**:由 plan 声明的 file scope 决定哪些节点可以并行。

## 目标架构:5 个核心抽象

```
┌──────────────────────────────────────────────────────────────┐
│  Skill Metadata        │  skills/*.md frontmatter            │
│  Runtime Config        │  floo.config.json.runtimes          │
│  Plan Templates        │  templates/plans/*.yaml             │
│  Batch Plan            │  .floo/batches/<id>/plan.yaml       │
│  DAG Executor + Ledger │  src/core/executor.ts + .floo/...   │
└──────────────────────────────────────────────────────────────┘
```

### 1. Skill Metadata (capability 注册中心)

`skills/*.md` 既是 prompt 模板,也是 capability 定义。frontmatter 描述这个 capability 的契约:

```markdown
---
name: coder
write_policy: scope          # scope | artifacts_only | readonly
outputs: [commits]           # commits | artifact filenames
default_runtime: claude
default_model: sonnet
inputs:                      # 这个 capability 期望读到的上游产物
  - context.md
  - design.md
  - plan.md
---

(prompt body...)
```

`write_policy` 由 executor 在运行时强制执行:
- `scope`:只能写声明的 file scope 内的文件,会跑 git wrapper 拦截 out-of-scope 写入
- `artifacts_only`:只能写本任务目录下的 markdown 产物(context.md / design.md / plan.md 等)
- `readonly`:只能读,任何 git 改动会被拒绝

**capability 注册中心 = `ls skills/`**。新增一个 capability = 加一份 `skills/<name>.md`。不需要再维护一份 `capabilities.yaml`(避免双事实源)。

当前内置 capabilities:

| capability | write_policy | outputs | 用途 |
|---|---|---|---|
| discuss | artifacts_only | context.md | 需求澄清(详见 [discuss-design.md](./discuss-design.md)) |
| designer | artifacts_only | design.md, design-questions.md | 技术设计 |
| planner | artifacts_only | plan.md | 拆解任务为可执行单元 |
| coder | scope | commits | 实施一个任务并提交 |
| reviewer | readonly | review.md | 评审 diff |
| tester | readonly | test-report.md | 验证与回归 |

### 2. Runtime Config (runtime 注册中心)

`floo.config.json` 增加 `runtimes` 段,登记本机可用的 agent CLI:

```json
{
  "runtimes": {
    "claude": {
      "command": "claude",
      "args": ["--dangerously-skip-permissions", "--print"],
      "models": ["sonnet", "opus", "haiku"],
      "default_model": "sonnet"
    },
    "codex": {
      "command": "codex",
      "args": ["exec", "--model", "{model}"],
      "models": ["gpt-5.2", "gpt-5.3-codex"],
      "default_model": "gpt-5.2"
    }
  }
}
```

新接 Gemini / OpenClaw / opencode = 加一段配置。Adapter 层退化为"按配置启动 tmux,捕获 stdout/stderr"的通用执行器,不再为每种 runtime 单独写 TypeScript 类。

> **过渡期备注**:当前 `src/core/adapters/{claude,codex}.ts` 仍是硬编码类。重构会保留它们作为 fallback,直到通用 runtime adapter 验证稳定。

### 3. Plan Templates (静态默认流程)

`templates/plans/*.yaml` 内置几份执行图,按任务类型选择:

```
templates/plans/
├── tiny.yaml         # 仅 coder, 用于一行 typo / 文案
├── quick.yaml        # coder → reviewer (跨 runtime), 小修复
├── feature.yaml      # discuss → designer → planner → coder → reviewer → tester (= 当前默认 6 阶段)
├── cross-review.yaml # coder (claude) → reviewer (codex), 质量敏感任务
├── loop.yaml         # Ralph 风格:单 agent fresh-context 循环 prd.json
└── prd.yaml          # 长 PRD,planner 拆 → 多 coder 并行 → 各自 reviewer
```

选哪个模板由 `router` 根据任务关键词决定,或用户用 `floo run --mode feature` 显式指定。

**这里没有 LLM 编排**:模板是静态的、可读的、可手编辑的。如果你想要 LLM 动态生成 plan,见后面的 `--orchestrate` 高级模式。

### 4. Batch Plan (本次执行的实际图)

每次 `floo run` 把选中的模板复制到 `.floo/batches/<batchId>/plan.yaml`,并填入实际任务参数:

```yaml
batch_id: "2026-05-04-080748-abcd-feature"
mode: feature
budget:
  max_runs: 12
  max_wall_minutes: 60

steps:
  - id: discuss
    capability: discuss
    runtime: claude
    model: opus

  - id: design
    capability: designer
    runtime: claude
    model: opus
    depends_on: [discuss]

  - id: plan
    capability: planner
    runtime: claude
    depends_on: [design]

  - id: implement-001
    capability: coder
    runtime: claude
    scope: ["src/api/health.ts"]
    depends_on: [plan]

  - id: review-001
    capability: reviewer
    runtime: codex     # 跨 runtime 评审
    depends_on: [implement-001]

  - id: test-001
    capability: tester
    runtime: claude
    depends_on: [implement-001, review-001]
```

**plan.yaml 是这次执行的唯一事实源**。executor 只读这份文件,不知道也不关心"6 阶段"是什么。所有可恢复、可审计、可调试的需求都围绕它展开。

#### plan-patch (动态调整,中等强度)

每个 step 跑完后,worker agent **可以**输出 `.floo/batches/<id>/patches/<stepId>.yaml`,executor 在调度下一节点前 apply:

```yaml
add_steps:
  - id: fix-typo
    capability: coder
    runtime: codex
    scope: ["docs/README.md"]
    depends_on: [review-001]
```

约束:
- patch 只能**追加**节点,不能修改/删除已存在节点
- 多个 worker 同时 patch 时,executor 串行 apply,先到先得
- patch 不通过 schema 校验则丢弃,记录到 ledger

这是"动态编排"住的地方:**离任务最近的 worker 决定下一步,而不是上层 LLM 编排者**。

#### --orchestrate (高级模式,opt-in)

`floo run --orchestrate` 会先调用一个 orchestrator agent(`skills/orchestrator.md`),让它读任务描述 + 项目上下文 + 当前 capabilities + runtimes,**生成**完整 plan.yaml,而不是从模板复制。

这是 opt-in,不是默认。理由:

- 大多数任务用静态模板就够,LLM 编排额外消耗 token
- LLM 编排引入二级故障域,debug 成本上升
- orchestrator 必须在 capability registry 内选步骤,不能凭空发明节点(executor 校验)

### 5. DAG Executor + Run Ledger

#### Executor

`src/core/executor.ts` 是 plan-driven 调度器,核心循环:

```
1. 读 plan.yaml
2. 计算就绪节点(deps 满足 + scope 不冲突 + 未达 max_runs)
3. 启动节点 → 通过 runtime adapter 跑 tmux
4. 等待完成信号(tmux wait-for)
5. 收集 artifact,记录 run 到 ledger
6. apply plan-patch (如有)
7. 检查终止条件(全部完成 / budget 耗尽 / 不可恢复错误)
8. 回到 step 2
```

executor 不感知"phase 顺序",只感知"DAG 拓扑"。

#### Run Ledger

每次 step 执行落盘一条 run 记录:

```
.floo/batches/<batchId>/
├── plan.yaml
├── patches/
│   └── implement-001.yaml
├── runs/
│   ├── implement-001-1.json    # 第一次尝试
│   ├── implement-001-2.json    # 重试
│   └── review-001-1.json
└── artifacts/
    ├── context.md
    ├── design.md
    └── plan.md
```

run 记录包含:

```json
{
  "step_id": "implement-001",
  "attempt": 1,
  "capability": "coder",
  "runtime": "claude",
  "model": "sonnet",
  "started_at": "...",
  "finished_at": "...",
  "exit_code": 0,
  "head_before": "abc123",
  "head_after": "def456",
  "files_changed": ["src/api/health.ts"],
  "session_name": "floo-...",
  "log_path": ".floo/.../logs/implement-001-1.log"
}
```

ledger 是 UI 和恢复的数据源。

## Routing (起点选择)

`src/core/router.ts` 根据任务文本和参数选择 plan template:

| 条件 | 选用模板 |
|------|---------|
| `--mode <name>` 显式指定 | 用户指定模板 |
| 描述含 `bug/fix/typo` 且 scope 单文件 | `tiny.yaml` 或 `quick.yaml` |
| 含 `review/audit` | 单步 reviewer |
| 含 PRD 文件路径 | `prd.yaml` |
| 含具体文件路径且 < 100 字 | 跳过 discuss/designer 的简化 plan |
| 其他 | `feature.yaml`(完整 6 步) |

`--from <step>` 退出整个 template 选择,直接构造单步或后缀 plan。

## 状态机 vs DAG

> **过渡期 vs 目标态**:目标是 DAG executor。当前仍是 6 阶段状态机。两者的语义对应关系:

| 当前状态机概念 | 目标 DAG 概念 |
|----------------|----------------|
| `PHASE_ORDER` 常量 | `feature.yaml` 模板的 step 顺序 |
| `dispatcher.ts` 状态推进 | `executor.ts` 拓扑调度 |
| Discuss/Designer 飞轮 | discuss step 的 plan-patch(自我追加新轮 discuss) |
| Reviewer fail → Coder retry | reviewer step 的 plan-patch(追加新 coder + reviewer) |
| MAX_RETRIES = 3 | budget.max_runs + step.attempts |
| `--from <phase>` | router 选模板 + 截断 |
| `review_level: scan/skip` | plan 里 reviewer step 的存在与否 |

完整迁移路径见 [refactor-plan.md](./refactor-plan.md)。

## Parallel Scheduling

executor 启动一个 step 的条件:

- 所有 `depends_on` 已 completed
- 与所有 running step 的 `scope` 无重叠(empty scope = 全局锁)
- 未达 `concurrency.max_agents`
- 未达 `budget.max_runs`

`coder` capability 的 git 写操作由 runner 注入的 git wrapper 串行化(`concurrency.commit_lock` 启用时)。

## Cancellation

`floo cancel <batchId>` / `floo cancel <stepId>`:

- 找到运行中的 tmux session,kill
- 写一条 `cancelled` 状态的 run 记录
- 标记 step 为 cancelled,不影响其他 step
- 不做全局 git reset

## Runtime Data Layout

```
.floo/
├── batches/
│   └── <batchId>/
│       ├── plan.yaml
│       ├── patches/
│       ├── runs/
│       ├── artifacts/
│       └── logs/
├── sessions/
├── signals/             # tmux 完成信号文件
├── notifications/       # 给 UI / monitor 的事件
├── lessons/             # floo learn 记录的经验
├── context/             # floo learn --distill / sync 输出
└── logs/                # 全局日志
```

## Operations

### Lessons

`floo learn` 在 `.floo/lessons/` 记录经验。`floo learn --distill` 提取稳定规则到 `.floo/context/project-rules.md`。`floo sync` 由这份规则生成 `CLAUDE.md` / `AGENTS.md`。这部分流程不受重构影响。

### Health

`src/core/health.ts` 检查 orphan session、stale running step、log 轮转。心跳更新 step 的 `last_heartbeat`。

### Configuration

`floo.config.json` 包含:

- `runtimes`:runtime 注册中心(目标态新增)
- `concurrency`:max_agents、commit_lock
- `budget_defaults`:默认 max_runs / max_wall_minutes
- `loop_limits`:max_review_rounds、max_discuss_rounds(plan-patch 追加新节点的上限)
- `protected_files`:任何 step 都不能改的文件

## Web UI

`floo serve` 启动 `web/` 下的 Next.js 应用。目标态 UI 围绕**plan graph + runs**展示:

- batch 列表
- 单个 batch 的 DAG 可视化(节点 = step,边 = depends_on)
- 点击节点进入该 step 的 run 详情(prompt / log / artifact / diff / commit / 用量)
- 实时刷新

> **过渡期**:当前 UI 围绕 task/phase 展示,需要在 executor 落地后调整数据访问层。

## Testing

```bash
npm test
```

当前测试覆盖路由、scope 冲突、commit lock、skill loader、adapter、dispatcher 完整路径、reviewer/tester 循环、scan/skip 分级、多任务调度、`head_after` 追踪。

**重构期间这些测试是契约**:executor 重写必须先通过适配层让现有测试继续过,才能动旧 dispatcher。详见 [refactor-plan.md](./refactor-plan.md) 第 4 步。

## Key Files (目标态)

- `src/core/executor.ts`:plan-driven DAG 执行器(目标新增)
- `src/core/plan.ts`:plan 加载、校验、patch apply(目标新增)
- `src/core/runtimes.ts`:runtime registry 加载(目标新增)
- `src/core/skills/loader.ts`:skill metadata + body 解析
- `src/core/scope.ts`:scope 冲突与越界检查(沿用)
- `src/core/router.ts`:模板选择(简化)
- `src/core/monitor.ts`:ledger 读 + cancellation(沿用接口,数据源切到 plan/runs)
- `src/core/lessons.ts`:经验记录与蒸馏(沿用)
- `src/core/health.ts`:运维检查(沿用)
- `skills/*.md`:capability 行为契约(增加 frontmatter)
- `templates/plans/*.yaml`:静态执行图模板(目标新增)

## 相关文档

- [refactor-plan.md](./refactor-plan.md):从当前过渡到目标架构的具体步骤、测试策略、风险点
- [dev-plan.md](./dev-plan.md):milestone 历史与未来规划
- [discuss-design.md](./discuss-design.md):discuss capability 的内部设计细节(在新架构下作为内置 capability 之一)
