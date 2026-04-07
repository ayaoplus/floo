# Floo: Multi-Agent Vibe Coding Harness

## Context

当前 AI coding agent（Claude Code、Codex、OpenClaw）各自独立运行，缺乏协同。个人开发者需要一个轻量的编排层来实现：多 agent 并行开发、交叉 review、任务追踪、失败重试、经验积累。

参考了 5 个项目/文章后的核心判断：
- **Superpowers**：skill 模板 + 质量门禁 → 借鉴 skill 模板和设计检查清单
- **gstack**：全流程软件工厂 → 太重，但 review 置信度分级、QA 分类体系值得提炼
- **OMX**：异构 agent 编排 → 架构思路最接近，但 TS+Rust 双栈太复杂
- **Elvis/OpenClaw**：task JSON + worktree + tmux + cron 监控 → 实用模式，直接采用
- **Peter/Moltbot**：反框架，原子提交，对话式开发 → 哲学上最对，避免过度工程化

**设计原则：Elvis 的实用工具 + Peter 的极简哲学。做调度器，不做引擎。**

---

## 一、架构概览

### 系统三层架构

```
用户 ↔ 任意 agent (CC/Codex/OpenClaw) ↔ Floo CLI/API ↔ 调度系统 ↔ 工作 agent
         交互层                              编排层              执行层
```

Floo 本身是**无头的编排层**，不绑定任何交互方式。谁调用 CLI 谁就是交互层。
可以是 Telegram 上的 OpenClaw，也可以是本地终端的 Claude Code。

### 目录结构

```
floo/
├── package.json                      # TypeScript monorepo (npm workspaces)
├── packages/
│   ├── core/                         # 编排核心
│   │   └── src/
│   │       ├── types.ts              # 所有类型定义
│   │       ├── dispatcher.ts         # 调度器（核心：状态机 + on-complete + dispatch）
│   │       ├── adapters/
│   │       │   ├── base.ts           # AgentAdapter 接口 + tmux 操作
│   │       │   ├── claude.ts         # Claude Code adapter
│   │       │   └── codex.ts          # Codex adapter
│   │       ├── skills/
│   │       │   └── loader.ts         # 加载 markdown skill 模板
│   │       ├── monitor.ts            # 状态监控（tmux/git/PR/CI 检查）
│   │       ├── router.ts             # 任务自动路由（判断从哪个阶段开始）
│   │       └── scope.ts             # scope 冲突检测 + commit 锁
│   ├── cli/                          # CLI 入口
│   │   └── src/
│   │       ├── index.ts
│   │       └── commands/
│   │           ├── run.ts            # floo run "task description"
│   │           ├── status.ts         # floo status
│   │           ├── monitor.ts        # floo monitor (持续监控)
│   │           ├── cancel.ts         # floo cancel <taskId>
│   │           ├── learn.ts          # floo learn "经验描述"
│   │           ├── sync.ts           # floo sync (配置同步)
│   │           ├── init.ts           # floo init
│   │           └── serve.ts          # floo serve (Web UI)
│   └── web/                          # Next.js 监控面板
│       └── src/
│           └── app/
│               ├── page.tsx          # 任务列表
│               ├── tasks/[id]/       # 任务详情
│               └── sessions/         # tmux session 状态面板
├── skills/                           # 默认 skill 模板（精心调试，核心竞争力）
│   ├── designer.md
│   ├── planner.md
│   ├── coder.md
│   ├── reviewer.md
│   ├── tester.md
│   └── house-elf.md                  # 系统运维角色
└── templates/                        # 初始化模板
    ├── claude.md.tmpl                # CLAUDE.md 模板
    └── agents.md.tmpl                # AGENTS.md 模板
```

---

## 二、核心概念

### 1. 六个角色

| 角色 | 职责 | 输入 | 输出 | 权限 |
|------|------|------|------|------|
| **Designer** | 需求分析 + 设计方案 + 定义 scope | 用户原始需求 | design.md（自由 markdown）| 可写: design.md |
| **Planner** | 任务拆分与编排 | design.md + 代码库结构 | plan.md（严格 YAML 格式）| 可写: plan.md |
| **Coder** | 写代码，原子提交 | 单个任务 + design.md | commit(s) | 可写: scope 内的代码文件 |
| **Reviewer** | 代码审查（只读不改）| diff + design.md + 验收标准 | review.md（verdict: pass/fail）| 只读代码，可写: review.md |
| **Tester** | E2E 测试与集成测试 | 代码变更 + 需求 | test-report.md（result: pass/fail）| 只读代码，可写: test-report.md |
| **house-elf** | 系统运维（清洁工）| 事件触发 | lesson / 配置更新 / 清理 | 可写: .floo/ 下的系统文件 |

前五个处理业务任务，house-elf 处理系统自身维护。

### 2. 角色绑定（三层配置）

**优先级：任务级 > 项目级 > 系统默认**

系统默认绑定：
```yaml
roles:
  designer:  { runtime: claude, model: sonnet }
  planner:   { runtime: claude, model: sonnet }
  coder:     { runtime: claude, model: sonnet }
  reviewer:  { runtime: codex,  model: codex-mini }  # 默认交叉审核
  tester:    { runtime: claude, model: sonnet }
```

项目级覆盖：`floo.config.yaml` 中配置
任务级覆盖：Planner 编排时动态指定，或用户显式指定

**交叉审核规则**：Reviewer 默认使用与 Coder 不同的 runtime（建议，非强制）

### 3. 批次（Batch）

任务按批次组织，批次之间隔离：

```
.floo/batches/
├── 2026-04-07-auth-refactor/
│   ├── batch.yaml              # 批次元数据
│   ├── tasks/
│   │   ├── task-001/
│   │   │   ├── task.yaml       # 任务元数据（状态、scope、runtime）
│   │   │   ├── design.md
│   │   │   ├── plan.md
│   │   │   ├── review.md
│   │   │   ├── test-report.md
│   │   │   └── runs/
│   │   │       ├── 001-designer.yaml
│   │   │       └── 002-coder.yaml
│   │   └── task-002/
│   └── summary.md              # 整体 review 报告
```

批次完整生命周期：
```
用户提需求 → Designer → Planner → [Coder × N] → 任务级 Review → Tester
  → 整体 Review（只读报告）→ 提交给用户 → 批次关闭
  → 用户有修改意见 → 开新批次
```

---

## 三、执行模式

### 1. tmux session（一个 agent 一个 session）

每个任务的每个 phase 绑定一个 tmux session，session 是 agent 的生命周期容器。

启动：
```bash
tmux new-session -d -s "floo-{taskId}-{phase}" \
  "floo-runner {taskId} {phase} {runtime} '{prompt}'"
```

### 2. floo-runner（agent 生命周期包装器）

每个 agent 进程都由 `floo-runner` 包装，负责三件事：

1. **启动 agent 进程**，捕获退出码
2. **写 exit artifact**：`.floo/signals/{taskId}-{phase}.exit`（退出码 + 产物清单 + 时间戳 + git diff summary）
3. **发 tmux wait-for 信号**：`tmux wait-for -S floo-{taskId}-{phase}-done`

```bash
# floo-runner 伪代码
run_agent "$runtime" "$model" "$prompt"
EXIT_CODE=$?
write_exit_artifact "$TASK_ID" "$PHASE" "$EXIT_CODE"
tmux wait-for -S "floo-${TASK_ID}-${PHASE}-done"
```

这保证了 dispatcher 收到信号时，exit artifact 已经落盘，可以直接读取判据。

### 3. 回调机制

**核心用 `tmux wait-for` 做 agent 完成回调（零延迟）。**

```
Agent 退出 → floo-runner 写 exit artifact → tmux wait-for 信号触发
  → dispatcher 读 exit artifact（退出码、产物、diff）
  → 状态机判断下一步
  → dispatch 下一个 agent 或暂停等人
```

**辅以轻量轮询（30-60s）检查外部状态**：CI 结果、PR checks 等。

### 4. tmux session 生命周期

```yaml
session_lifecycle:
  on_success: keep 30min, then cleanup
  on_failure: keep 24h, then cleanup
  orphan_check: every 10min       # house-elf 负责
  timeout: 30min                  # 可配置
  timeout_handling: house-elf 检查内部活动，有交互不杀，长时间无响应才处理
  naming: "floo-{taskId}-{phase}" # 如 floo-T004-coder
```

### 5. Agent Adapter 接口

```typescript
interface AgentAdapter {
  runtime: 'claude' | 'codex';
  spawn(opts: {
    prompt: string;
    cwd: string;
    sessionName: string;
    model?: string;
  }): Promise<void>;                  // 只启动，不等待

  isAlive(sessionName: string): Promise<boolean>;
  getOutput(sessionName: string): Promise<string>;
  sendMessage(sessionName: string, msg: string): Promise<void>;  // mid-task redirect
}
```

---

## 四、调度逻辑

### 1. 隔离策略：主分支 + scope 锁

不使用 worktree。所有 agent 在主分支上工作，通过 scope（文件列表）避免冲突。

- **Milestone 1 强约束**：`floo run` 启动前检查 `git status --porcelain`，working tree 不干净则拒绝启动；单任务独占仓库
- **Planner 定义每个任务的 scope**（要改哪些文件）
- scope 无交集的任务可以并行
- scope 有交集的任务必须串行
- **commit 锁**：序列化 commit 操作（lockfile），避免并发 git add/commit 冲突

### 2. scope 越界处理

Coder 完成后检查 `git diff --name-only` vs scope：
- 越界文件与其他 running task 无冲突 → 接受，更新 scope 记录
- 越界文件有冲突 → 整个任务回退重新编排

### 3. 调度实现：状态机 80% + agent 20%

**正常流转（状态机，JS 硬编码）：**
```
Designer 完成 → 触发 Planner
Planner 完成  → 解析 plan.md（YAML），提取任务列表和 scope，判断并行/串行，dispatch Coder(s)
Coder 完成    → dispatch Reviewer（不同 runtime）
Reviewer pass → dispatch Tester
Tester pass   → 标记完成
所有任务完成  → 触发整体 Review → 报告给用户
```

**异常路径（agent 判断）：**
- Planner 输出格式解析失败 → agent 重新提取
- 失败后的决策（回退到哪个阶段）→ agent 分析
- scope 冲突时的重编排 → agent 判断

dispatch 异常处理 agent 的 prompt 需要人工精心编写。

### 4. 任务入口：自动路由 + 显式覆盖

```bash
# 自动判断从哪个阶段开始
floo run "重构支付模块，支持多币种"        # → Designer 开始
floo run "给 /api/health 加 version"      # → 自动判断可跳过 Designer
floo run "登录按钮没反应"                  # → 自动判断 bugfix

# 显式覆盖
floo run "..." --from coder               # 跳到 Coder
floo run "..." --from reviewer --scope src/payment/  # 整体 review
```

router.ts 根据描述长度、关键词（bug/fix/refactor）、是否指定具体文件来自动路由。

---

## 五、Review 策略

### 1. 验收标准驱动

task.yaml 中定义验收标准（Designer 或用户定义）：
```yaml
acceptance_criteria:
  - /api/health 返回 { status: "ok", version: "1.0.0" }
  - 有对应的单元测试
  - 错误时返回 500 而非 crash
```

Reviewer 对着验收标准逐条检查，不做开放式评判。

### 2. Review 模式

```yaml
review_mode: auto | human
```

- 有 design.md → 默认 auto（pass 自动流转，fail 回 Coder）
- 无 design.md → 默认 human（结果提交给人确认）
- 可由用户显式覆盖

### 3. 防止 Review 循环

- Reviewer 只读不改代码，只输出 review.md
- Reviewer 只检查：验收标准是否满足、明显 bug/安全漏洞、scope 越界。不检查风格偏好
- Coder 收到 review 反馈后有权拒绝不合理意见（目标是满足验收标准）
- **最多 2 轮 review**，2 轮还 fail → 暂停通知人介入

### 4. 整体 Review

批次完成后自动触发，只读报告，不修改代码。用户看完决定是否开新批次修改。

---

## 六、错误处理

| 失败环节 | 处理策略 |
|---------|---------|
| Designer/Planner 崩溃 | 直接重试，最多 3 次 |
| Planner 输出格式不对 | 重试，追加格式要求 |
| Coder scope 越界 | 检查冲突，无冲突接受，有冲突整体回退 |
| Coder 代码编译失败 | 重试，带错误信息 |
| Reviewer fail | 回 Coder，带 review 反馈 |
| Tester fail | 回 Coder，带测试报告 |
| 连续 fail 不收敛 | 到达重试上限（3 次）暂停，通知用户 |

重试机制：第一次原始 prompt → 第二次带错误反馈 → 第三次可切换 runtime。

### 任务取消

`floo cancel <taskId>`：kill tmux session → 回滚 scope 内的 unstaged changes（`git checkout -- <scope files>`）→ 更新状态为 cancelled。不做全局 `git checkout -- .`，避免误伤用户或其他任务的改动。

---

## 七、数据流与持久化

### 全文件，不用 DB

项目级配置文件 `floo.config.yaml` 放在项目根目录（用户可编辑，进 git）。
`.floo/` 下只放运行时数据，全部 gitignore。

```
.floo/
├── batches/                          # 批次和任务数据（见上文）
├── sessions/
│   └── {sessionName}.yaml            # tmux session 状态记录
├── signals/
│   └── {taskId}-{phase}.exit         # agent 完成信号
├── notifications/
│   └── {timestamp}-{event}.md        # 通知文件（交互层读取转发）
├── lessons/
│   └── 2026-04-07-codex-review.md    # 经验记录
├── context/
│   └── project-rules.md              # 唯一信息源（sync 生成 CLAUDE.md/AGENTS.md）
├── logs/
│   ├── system.log                    # 当前系统日志
│   ├── system.log.1                  # 轮转归档
│   └── system.log.2
└── .gitignore
```

### 上下文传递（两层分离）

1. **全局上下文**：`project-rules.md` 中的稳定规则（编码规范、commit 风格、保护文件等）→ `floo sync` 生成 CLAUDE.md / AGENTS.md，agent 启动时自动加载
2. **任务上下文**：design.md、plan.md、验收标准、前次 review 反馈等 → 全部通过 dispatch prompt 传给 agent，不写进全局配置

agent 不需要知道 Floo 的存在，只通过 prompt 和项目配置文件获取上下文。
任务态内容不污染全局上下文，并发任务时各自的 prompt 互不干扰。

---

## 八、通知机制

### 通知分层

- **Floo 输出**：结构化数据（任务 ID、状态、耗时、结果）写入 `.floo/notifications/`
- **交互层 agent**：读取通知文件，用自然语言包装后通过自己的通道（Telegram/终端）发给用户

### 通知时间点

| 事件 | 内容 |
|------|------|
| 任务启动 | session 名、模型、任务描述 |
| 单任务完成 | 任务 ID、agent、结果摘要 |
| 批次进度汇报 | 已完成列表、下一波任务、建议分配 |
| 全部完成汇总 | 整体 review 报告 |
| 异常/需人介入 | 错误详情、建议操作 |

---

## 九、学习与进化系统

### 项目级 lessons

```markdown
# .floo/lessons/2026-04-07-codex-review.md
# 问题
Codex review 时修改了设计意图

# 原因
Reviewer prompt 没有包含 design.md

# 解决
已更新 Reviewer skill 模板

# 标签
reviewer, codex, design-intent
```

产生方式：
- **自动**：任务失败重试成功后，house-elf 对比差异提取 lesson
- **手动**：`floo learn "codex review 太激进"`

lesson 积累到一定量 → house-elf 归纳提炼规则 → 写入 project-rules.md → `floo sync` 同步到 CLAUDE.md / AGENTS.md

### 系统级 lessons

存放在 `~/.floo/lessons/`，只积累，人工定时复盘。

### 配置同步机制

**单一信息源 + 生成器**：

`.floo/context/project-rules.md` → 唯一维护的文件（只放稳定规则：编码规范、commit 风格、保护文件等）
`floo sync` → 读取 project-rules.md，适配格式后生成 CLAUDE.md 和 AGENTS.md

注意：任务态内容（design.md、plan.md、验收标准）不进 project-rules.md，只通过 dispatch prompt 传递。

### house-elf 职责

事件驱动，有需要才调起（不是定时 heartbeat）：
- 记录和归纳 lesson
- 同步配置文件（CLAUDE.md ↔ AGENTS.md）
- 健康检查（孤儿 session 清理、stale task 检测）
- tmux session 超时检查（有交互不杀，无响应才处理）
- 日志轮转清理
- 未来可扩展

触发方式：
- 被动：on-complete 检测到特定事件 → 调起
- 主动：`floo sync`、`floo learn`
- 可选：monitor 进程里低频检查（如每小时看一次 lesson 数量）

---

## 十、日志系统

**系统日志，给 AI 排障用，不是业务日志。**

```
[2026-04-07 14:30:01] [dispatch] task=T004 phase=coder runtime=codex session=floo-T004-coder started
[2026-04-07 14:45:03] [callback] task=T004 phase=coder exit_code=0 duration=15m02s
[2026-04-07 14:45:04] [scope-check] task=T004 files_changed=[src/api/health.ts] scope_match=true
[2026-04-07 14:50:12] [error] task=T004 phase=reviewer exit_code=1 error="timeout"
[2026-04-07 14:50:13] [retry] task=T004 phase=reviewer attempt=2/3 runtime=claude
```

单行纯文本，时间戳 + 模块 + 关键字段。按大小轮转（5MB/文件，保留 3 个），house-elf 负责清理。

---

## 十一、配置体系

### floo.config.yaml

```yaml
# 角色绑定（项目级覆盖）
roles:
  designer:  { runtime: claude, model: sonnet }
  planner:   { runtime: claude, model: sonnet }
  coder:     { runtime: claude, model: sonnet }
  reviewer:  { runtime: codex,  model: codex-mini }
  tester:    { runtime: claude, model: sonnet }

# 并行配置
concurrency:
  max_agents: 3
  commit_lock: true

# session 生命周期
session:
  timeout: 30min
  keep_on_success: 30min
  keep_on_failure: 24h
  orphan_check_interval: 10min

# 保护机制（prompt 约束）
protected_files:
  - .env
  - floo.config.yaml
  - CLAUDE.md
  - AGENTS.md
```

### 初始化（floo init）

**新项目**：
1. 创建 `.floo/` 完整目录结构
2. 生成 `floo.config.yaml` 默认配置
3. `.floo` 加入 `.gitignore`
4. 检测有无 CLAUDE.md / AGENTS.md：无 → 从模板生成（含通用规范）；有 → 追加 floo section
5. 扫描项目技术栈，记录到配置

**老项目**：
同上 + 扫描 git history 了解 commit 风格 + 生成 project-structure.md

---

## 十二、Web UI

**Next.js，Milestone 1 纯监控面板（只读）。**

### 页面

1. **任务列表**：状态徽章、runtime 标签、耗时、批次分组
2. **任务详情**：artifact 文件内容、tmux 日志、PR 链接、run 历史
3. **tmux Session 面板**：所有 session 的状态、关联任务、存活时间、活跃度

### API（后端 Hono，读文件系统返回 JSON）

```
GET  /api/batches                  # 批次列表
GET  /api/tasks                    # 任务列表
GET  /api/tasks/:id                # 任务详情 + runs
GET  /api/sessions                 # tmux session 状态
POST /api/tasks/:id/retry          # 重试（唯一写操作）
GET  /api/artifacts/*              # 静态文件
```

---

## 十三、E2E 测试

Playwright 可选安装，非默认。

```bash
floo init --with-playwright        # 安装 Playwright + 配置 MCP
```

Tester skill 模板包含 Playwright 规范：
- 使用 `getByRole` / `getByText` 定位元素
- 每个用例聚焦一个用户场景
- 截图作为证据

---

## 十四、Skill 模板设计原则

**约定输出格式，不约定过程。** 模板是核心竞争力，精心调试，允许项目级覆盖。

每个角色的输出约定：
- **Designer** → 自由 markdown（含设计检查清单 + 需求澄清机制）
- **Planner** → 严格 YAML（dispatch 要解析）
- **Coder** → 产出是 commit，无特殊格式
- **Reviewer** → `verdict: pass/fail` + 反馈（含置信度分级：critical/important/suggestion）
- **Tester** → `result: pass/fail` + 失败详情（按 QA 分类：console errors, broken links, form failures...）

从参考项目提炼的微观实践（写入 skill 模板初始版本）：
- Designer：Superpowers 的设计检查清单 + OMX 的需求澄清机制
- Reviewer：Superpowers 的两阶段 review + gstack 的置信度分级
- Tester：gstack 的 QA 分类体系
- Coder："root cause first" 原则

---

## 十五、第一里程碑：单任务全流程

**目标**：`floo run "add a health check endpoint"` → Designer → Planner → Coder → Reviewer（交叉）→ 通知用户

### 实现顺序

**Phase 1: 基础设施**
1. `packages/core/src/types.ts` — 所有类型定义
2. `packages/core/src/scope.ts` — scope 冲突检测 + commit 锁
3. `floo.config.yaml` schema 定义

**Phase 2: Agent 适配器**
4. `packages/core/src/adapters/base.ts` — 接口 + tmux 操作（spawn/isAlive/getOutput/sendMessage）
5. `packages/core/src/adapters/claude.ts` — Claude Code adapter
6. `packages/core/src/adapters/codex.ts` — Codex adapter

**Phase 3: 核心调度**
7. `packages/core/src/skills/loader.ts` — 加载 skill markdown + {{var}} 替换
8. `skills/designer.md` + `skills/planner.md` + `skills/coder.md` + `skills/reviewer.md` — 四个核心 skill
9. `packages/core/src/router.ts` — 任务自动路由
10. `packages/core/src/dispatcher.ts` — 核心调度（状态机 + on-complete + dispatch）
11. `packages/core/src/monitor.ts` — 状态监控（tmux wait-for + 轮询 CI）

**Phase 4: CLI**
12. `packages/cli/src/index.ts` — CLI 入口 (commander)
13. `packages/cli/src/commands/init.ts` — 项目初始化
14. `packages/cli/src/commands/run.ts` — 创建任务并执行
15. `packages/cli/src/commands/status.ts` — 查看状态
16. `packages/cli/src/commands/cancel.ts` — 取消任务
17. `packages/cli/src/commands/monitor.ts` — 启动持续监控

**Phase 5: Web UI**
18. `packages/web/` — Next.js 项目
19. 任务列表 + 任务详情 + tmux Session 面板
20. Hono HTTP server (`packages/cli/src/commands/serve.ts`)

### Milestone 1 不做

- ❌ 多任务并行（先跑通单任务全流程）
- ❌ Tester 角色（先验证核心链路）
- ❌ 整体 Review（需要先有批次）
- ❌ house-elf（lessons/sync 等）
- ❌ OpenClaw adapter
- ❌ 实时 WebSocket/SSE
- ❌ Telegram 通知
- ❌ Token 消耗追踪

### Milestone 2 方向

- 多任务并行调度 + scope 冲突检测
- Tester 角色 + Playwright 集成
- 批次管理 + 整体 Review
- house-elf（lessons、配置同步、健康检查）
- 通知系统
- `floo learn` + `floo sync`

---

## 十六、验证方式

1. **端到端**：在真实项目下运行 `floo run "add a /health endpoint"`
2. 验证链路：tmux session 启动 ✓ → agent 执行 ✓ → wait-for 回调触发 ✓ → 状态机流转 ✓ → review agent 启动 ✓ → 文件记录正确 ✓
3. **Web UI**：`floo serve` → 浏览器看到任务和 session 状态
4. **失败重试**：给一个会失败的任务 → 验证重试 + 错误上下文传递
5. **取消任务**：`floo cancel` → 验证 session kill + 状态更新

---

## 关键文件

- `packages/core/src/dispatcher.ts` — 核心调度逻辑（状态机 + on-complete + dispatch）
- `packages/core/src/adapters/base.ts` — agent 适配器接口 + tmux 操作
- `packages/core/src/monitor.ts` — 监控（tmux wait-for 回调 + 轮询）
- `packages/core/src/scope.ts` — scope 冲突检测 + commit 锁
- `packages/core/src/router.ts` — 任务自动路由
- `skills/*.md` — skill 模板（核心竞争力）
