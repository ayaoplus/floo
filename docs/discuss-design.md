# Discuss Phase 设计

## 1. 为什么加 discuss

Floo 当前流程 `designer → planner → coder → reviewer → tester`，designer 直接基于用户一句话的 description 产出 design.md。观察到的问题：

- 95% 的需求描述属于「用户自以为说清楚了，但仍有大量未挖掘的深层决策点」
- designer 遇到模糊点只能自己猜，猜错了 planner/coder 跟着错
- 现有 designer.md 里塞了「需求审视」「待澄清问题」两章，但用户不回答，agent 只能自问自答

**结论：在 designer 之前插入独立的 discuss phase，把「需求澄清」从 designer 的副业升级为正式环节。**

## 2. 设计原则

### 2.1 线性卡住，不伪装异步
discuss 阶段本来就要求用户在场。不做假异步，前台 blocking 到 context.md 产出为止。

### 2.2 Skill 化，不做 harness
discuss 行为定义在 `skills/discuss.md` 的 prompt 里，不在代码里。任何支持 skill 的前端（Claude Code / Codex / OpenClaw）都能承载这段 prompt。Floo 核心不引入 LLM SDK、不实现问答循环。

### 2.3 Progressive Enhancement
discuss prompt 以「能力无关的行为描述」写法为主：

```
优先使用前端可用的结构化工具提供选项（如 AskUserQuestion、inline keyboard）；
若无此类工具，以自然语言直接提问。无论哪种方式：一次一个问题，等答案，再问下一个。
```

强能力前端（Claude Code 的 AskUserQuestion）叠加体验增强；弱能力前端（Telegram channel）退化为纯对话。输出质量有差异是固有事实，不强求拉平。

### 2.4 跨前端差异的诚实记录
channel-based 前端（OpenClaw）产出的 context.md 精度天然低于 Claude Code，decisions 可能只能记录「用户倾向 A（推测）」。designer 要容忍这种软性输入。

## 3. Context Schema（YAML in Markdown）

产物文件：`{taskId}-context.md`，内容是带 YAML 代码块的 Markdown。格式和 `plan.md` 统一。

```markdown
# Discuss Context

## 决策摘要
（agent 1-2 句自然语言总结用户核心诉求）

## 决策数据

\```yaml
first_principle:
  core_problem: 用户真正要解决的痛（一两句话）
  if_not_solved: 不做会怎样（系统不可用 / 体验降级 / 也没什么）
  alternatives_considered: []   # 讨论过的替代方案

stakeholders:
  - who: 谁
    scenario: 什么场景下遇到
    frequency: 多频繁

scope:
  in: []        # 本次要做的
  out: []      # 明确不做（deferred）
  unclear: []  # 还没定的灰区

decisions:
  - id: D-01
    topic: 讨论主题
    choice: 最终选择
    rationale: 为什么这么选
    confidence: high | medium | low

acceptance_criteria:
  - condition: 用户操作 / 系统输入
    expected: 预期结果（可自动验证）

open_questions:
  - id: Q-01
    question: 用户还没答清楚的点
    blocker: true   # true 阻塞后续 phase，false 只是提醒

meta:
  round: 1                       # 第几轮 discuss
  designer_feedback_applied: false
  last_updated: 2026-04-13
  user_approved: false            # 用户显式 approve 才算定稿
\```
```

### 字段约束

| 字段 | 必填 | 说明 |
|------|------|------|
| `first_principle.core_problem` | 是 | 没这个 = discuss 没挖到底，视为失败 |
| `scope.in` | 是 | 至少 1 项，否则 planner 无从下手 |
| `scope.out` | 强烈建议 | 「不做什么」比「做什么」更重要 |
| `decisions[].confidence` | 是 | designer 凭此判断哪些决策是软的、可能返工 |
| `acceptance_criteria` | 是 | 至少 1 条可自动验证断言，否则 reviewer/tester 没基准 |
| `open_questions[].blocker` | 是 | 决定 designer 会不会反向触发新一轮 discuss |
| `meta.round` | 是 | 飞轮收敛用 |

## 4. Discuss Skill 行为规范

`skills/discuss.md` 按以下五段结构编写：

1. **第一性原理（前置）**：先挖透「不做会怎样 / 真正的痛是什么 / 有没有替代」
2. **角色定位**：thinking partner，不是 interviewer；用户是 visionary，你是 builder
3. **追问纪律**：ONE AT A TIME、答案模糊就 push、无证据需求要挑战
4. **领域探针**：根据需求类型激活不同问题组（UI / API / 数据处理 / 后台任务）
5. **Red flags 触发深挖**：「用户会喜欢」「以后可能需要」「业界都这么做」这类话要追问到具体
6. **停止条件**：scope 边界明确 + ≥1 条可自动验证断言 + 用户显式 approve

Prompt 里不引用具体工具名（如 AskUserQuestion），只描述行为，由前端 agent 自适应。

## 5. Discuss ↔ Designer 飞轮

### 5.1 正常流程

```
discuss (round 1)
   ↓ 产出 context.md
designer
   ↓ 读 context.md 作为输入
   ↓ 如果所有 decisions 都够用 → 产出 design.md → planner
   ↓ 如果发现 blocker 级问题 → 产出 design-questions.md → 回 discuss (round 2)
```

### 5.2 designer 反向质疑产物

文件：`{taskId}-design-questions.md`（同样 YAML in Markdown 格式）

```yaml
questions:
  - id: Q-01
    target: D-03               # 针对 context.md 中哪条 decision
    issue: 描述为什么这个决策不够用 / 有冲突 / 缺失
    severity: blocker | concern | note
    suggested_resolutions: []  # designer 给出的备选方向
```

### 5.3 收敛规则

**规则 1（severity 过滤）**：只有 `severity: blocker` 的 question 才会触发回退到 discuss，`concern/note` 记录在 design.md 中继续往下走。

**规则 2（最大轮数）**：`discuss ↔ designer` 最多 2 轮，第 3 轮强制放行，把所有未解决的 `open_questions` 转为「假设」并在 design.md 中标注。`max_discuss_rounds` 在 config.limits 中可调。

**规则 3（用户 approve gate）**：默认关闭（`user_approved: false` 允许 designer 直接跑）。如果用户打开 `--strict-discuss` 标志（或配置），则 designer 开始前检查 `context.meta.user_approved === true`，否则停住等用户 approve。M1 版本不做 strict 模式，默认一直允许往下。

### 5.4 第二轮 discuss 的输入

当从 designer 回退到 discuss（round 2）时，新一轮 discuss 的输入多一个变量 `{{design_questions}}`，prompt 会引导 agent 针对这些 blocker 问题**只问与 blocker 相关**的问题，不从头再问一遍。

## 6. Router 路由策略

默认起点从 `designer` 改为 `discuss`。新优先级：

| 条件 | 起点 |
|------|------|
| `--from <phase>` 显式指定 | 尊重用户 |
| 有 scope + 描述 < 50 字 | coder（小改动） |
| 含 bug/fix/修复/报错 | coder |
| 含 review/审查 | reviewer |
| 含具体文件路径 + 描述 < 100 字 | planner |
| 有现成 context.md（如用户已手工写好） | designer |
| **其他所有情况** | **discuss** |

大部分需求走 discuss，简单修复短路跳过 discuss。

## 7. 实现范围

### 7.1 M1 在做（本轮）

- Phase 类型扩展（`Phase` union 加 `discuss`，`PHASE_ORDER` 开头插入）
- `skills/discuss.md` prompt 编写
- `skills/designer.md` 改造（读 context.md，可选产出 design-questions.md）
- `dispatcher.ts` 接线：discuss phase 执行 + 飞轮循环
- `router.ts` 默认起点改 discuss
- 单元测试覆盖路由和飞轮

### 7.2 M1 不做（留待后续）

- discuss 的前台 stdio 交互模式（先和其他 phase 一样走 tmux，用户 attach）
- 多 runtime 的 AskUserQuestion 精准适配（先靠 prompt 纯对话兜底）
- Web 面板里的 discuss 问答 UI
- `--strict-discuss` 的 user_approved 闸门
- Context assumptions 模式（对标 GSD 的 `workflow.discuss_mode`，让 agent 读代码后主动列假设让用户否决）

## 8. 文件与命名一览

| 产物 | 路径 | 产出方 |
|------|------|--------|
| discuss 输出 | `{taskId}-context.md`（项目根） → `context.md`（任务目录） | discuss agent |
| 反向质疑 | `{taskId}-design-questions.md` → `design-questions.md` | designer agent（可选） |
| 设计方案 | `{taskId}-design.md` → `design.md` | designer agent |

## 9. 代码改动点清单

1. `src/core/types.ts`：Phase、PHASE_ORDER、MAX_DISCUSS_ROUNDS、DEFAULT_CONFIG.roles、DEFAULT_CONFIG.limits
2. `src/core/dispatcher.ts`：PHASE_ARTIFACT_BASES 加 discuss、buildPrompt 加 discuss/designer 新变量、createAndRun 中串 discuss phase 与飞轮、增加 design-questions 收集
3. `src/core/router.ts`：默认从 discuss；context.md 已存在时短路到 designer
4. `src/commands/run.ts`：--from 参数的 Phase union 验证
5. `skills/discuss.md`：新增
6. `skills/designer.md`：读 context 输入、可选产出 design-questions
7. `test/core.test.ts` / `test/dispatcher.test.ts`：覆盖新路由与飞轮收敛
