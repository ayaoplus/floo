# Floo 项目规范

## 项目概述

Multi-Agent Vibe Coding Harness — 轻量多 agent 编排系统，面向个人开发者。
设计文档: `docs/design.md` | 开发计划: `docs/dev-plan.md`
远程仓库: `git@github.com:ayaoplus/floo.git` (private)

## 目录结构

```
floo/
├── src/                  # CLI + 编排核心（TypeScript，编译到 dist/）
│   ├── core/             # 核心逻辑
│   │   ├── types.ts
│   │   ├── dispatcher.ts
│   │   ├── scope.ts
│   │   ├── monitor.ts
│   │   ├── router.ts
│   │   ├── notifications.ts
│   │   ├── health.ts
│   │   ├── lessons.ts
│   │   ├── adapters/     # claude.ts / codex.ts / base.ts
│   │   └── skills/       # loader.ts
│   ├── commands/         # CLI 命令（init/run/status/cancel/monitor/learn/sync）
│   └── index.ts          # CLI 入口（bin: floo）
├── web/                  # Next.js 监控面板（独立 package.json，M4 实现）
│   ├── app/              # App Router 页面
│   └── package.json
├── test/                 # 测试脚本
│   ├── core.test.ts
│   └── dispatcher.test.ts
├── skills/               # Agent role 模板（designer/planner/coder/reviewer/tester）
├── templates/            # git hook 模板（post-commit.sh）
├── docs/                 # 设计文档
│   ├── design.md
│   ├── dev-plan.md
│   └── img/
├── SKILL.md              # 跨 agent 集成（CC/Codex/OpenClaw 自动发现 floo）
└── package.json          # 主包（name: floo，bin: floo）
```

## 技术栈

- TypeScript 单包，Node.js ESM（`"type": "module"`）
- CLI 编译：`tsc` → `dist/`，入口 `dist/index.js`
- Web：Next.js + Tailwind CSS（独立构建，不参与主包 tsc）
- 目标运行环境: macOS, tmux

## 原子提交规则

每次提交应该是一个**独立可理解的变更单元**，不多不少。

### 格式

```
<type>(<scope>): <description>

[可选 body: 解释 why，不超过 3 行]
```

**type**: `feat` | `fix` | `refactor` | `test` | `chore`
**scope**: `core` | `cli` | `web` | `skills` | `docs` | `config`
**description**: 英文，一句话，祈使语气（add 不是 added）

### 粒度原则

- 一个模块/文件一个 commit（如 types.ts 单独提���）
- 紧密耦合的改动可以合并（如接口定义 + 唯一实现）
- 配置文件变更（tsconfig、package.json）跟随触发它的代码一起提交
- 测试跟随被测代��一起提交，不单独拆
- 文档变更独立提交

### 示例

```
feat(core): implement AgentAdapter interface and tmux operations
feat(core): add scope conflict detection and commit lock
fix(core): handle tmux server exit in waitForCompletion
chore(config): initialize project structure and dependencies
```

### 推送规则

- 每次完成一个任务（batch 内的完整模块）后，commit 并 push 到 origin/main
- 开发完代码按任务��度自动 commit + push，不需要额外确认
- 禁止 force push

### 禁止

- 不提交 `.env`、credentials、secrets
- 不提交 `node_modules/`、`dist/`、`.floo/`
- 不写空 commit
- 不在一个 commit 里混合不相关的改动
- 禁止 `git add -A` 或 `git add .`，必须按文件名 stage，避免误带无关文件

## 编码规范

- 每个函数/方法写注释，关键逻辑写注释
- 注释是写给半年后的自己看的
- 代码就是文档，可读性优先
- 同样的代码出现三次就抽象
- 先想边界情况再写主逻辑
- 变量作用域越小越好
- 出错时提示要有用
- 不过度工程化，如无必要勿增实体
