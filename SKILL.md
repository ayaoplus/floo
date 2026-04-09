---
name: floo
description: |
  Multi-agent parallel coding harness. Use when a task needs design → planning →
  coding → review → testing pipeline, or when multiple files/modules need to be
  developed in parallel with cross-agent review. Invoked via `floo run "description"`.
  Do NOT use for simple questions, single-line fixes, or casual chat.
---

# Floo — Multi-Agent Coding Harness

Floo 是本项目的多 agent 编排层。当任务需要完整的开发流程时，把任务交给 floo，
它会自动编排 Designer → Planner → Coder → Reviewer → Tester 流水线。

## 何时使用 floo

**使用 floo（`floo run`）：**
- 新增功能、模块或 API endpoint
- 重构影响多个文件的代码
- 需要设计评审或交叉 code review 的改动
- 用户明确说"帮我开发 / 实现 / 重构 / 新增"
- 任务需要 3 个以上文件改动

**不使用 floo（直接处理）：**
- 解释代码、回答问题
- 单行 bugfix 或配置修改
- 用户只是在聊天或做技术讨论
- `floo status` / `floo cancel` 等管理操作本身

判断原则：**任务是"做出来"而不是"说清楚"时，用 floo。**

## 命令

### floo run — 核心命令

```bash
floo run "任务描述"
```

- 描述用自然语言，尽量包含：要做什么、影响哪个模块、验收标准
- 命令会阻塞直到全流程完成，输出最终状态和结果摘要
- 退出码：0 = 成功，1 = 失败/取消

**示例：**
```bash
floo run "给 /api/health 添加健康检查接口，返回 { status, version, uptime }"
floo run "重构支付模块，拆分成 PaymentService 和 CurrencyConverter，支持多币种"
floo run "修复登录页在移动端的布局错位问题，复现步骤：viewport 375px 下按钮溢出"
```

**--from 参数（跳过前置阶段）：**
```bash
floo run "..." --from coder      # 跳过 designer/planner，直接编码
floo run "..." --from reviewer   # 只做 review
```

**--detach 参数（后台运行）：**
```bash
floo run "..." --detach   # 立即返回，任务在后台跑
```

### floo status — 查看进度

```bash
floo status                  # 最近批次的任务状态
floo status --batch <id>     # 指定批次
```

### floo cancel — 取消任务

```bash
floo cancel <taskId>
```

### floo monitor — 持续监控

```bash
floo monitor    # 持续轮询，任务有变化时输出状态更新
```

### floo learn — 记录经验

```bash
floo learn "发现 reviewer 太激进，需要在 prompt 里限制只检查验收标准"
```

### floo sync — 同步配置

```bash
floo sync    # 从 .floo/context/project-rules.md 重新生成 CLAUDE.md / AGENTS.md
```

## 输出解读

`floo run` 成功后输出：
```
batch: 2026-04-08-health-endpoint
  task-001  completed  coder=claude  reviewer=codex  2m34s
结果：1 completed, 0 failed
```

失败时输出失败阶段和错误摘要，可用 `floo status` 查看详情。

## 把用户意图传给 floo

用户的原始描述可以直接作为 `floo run` 的参数。如果用户描述比较口语化，
可以稍作整理使其更具体，但**不要改变用户的意图**。

```
用户说：「帮我加个登录功能」
→ floo run "实现用户登录功能：POST /api/login，支持邮箱+密码，返回 JWT token"

用户说：「这个 bug 修一下，报错是 Cannot read property of undefined」
→ 太简单，直接修，不用 floo

用户说：「把整个 auth 模块重构一下，改成 OAuth2」
→ floo run "重构 auth 模块，迁移到 OAuth2 协议，支持 Google 和 GitHub 登录"
```

## 项目配置

`floo.config.json`（项目根目录）控制每个角色的 runtime 和并发设置。
`.floo/` 目录存放运行时数据，已加入 `.gitignore`。

### floo config — 交互式配置向导

当用户想调整 floo 的配置时，运行：

```bash
floo config
```

向导提供两种模式：
- **Quick Start**：3个问题快速完成（并发数、review 轮数、runtime 预设）
- **Manual**：逐项配置所有字段（角色绑定、超时、保护文件等）

**触发时机**——用户说以下任意意图时，调用 `floo config`：
- "帮我改一下并发数 / max_agents"
- "review 轮数太多了，调少一点"
- "把 reviewer 换成 claude"
- "floo 的配置怎么改"
- "我想配置一下 floo"
- "timeout 设长一点"
- 任何涉及修改 `floo.config.json` 字段的请求

**不要**直接手动编辑 `floo.config.json`，用向导保证格式正确。
