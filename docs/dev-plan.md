# Floo Development Plan

> 架构文档:[docs/design.md](./design.md)
>
> 重构路径:[docs/refactor-plan.md](./refactor-plan.md)

本文档记录已完成的 milestones(M1-M3 已交付,M4 进行中)。**M5 / M6 原计划已被新架构吸收,具体执行步骤迁移至 [refactor-plan.md](./refactor-plan.md)**,本文档不再作为新功能的 roadmap,只保留历史。

## Completed Milestones

### M1: Single Task Pipeline

Status: Done

Delivered:

- `floo init`;
- `floo run`;
- `floo status`;
- core types, dispatcher, adapters, router, scope checks, monitor reads;
- initial role templates;
- TypeScript build and baseline tests.

### M2: Multi-Task and Quality Gates

Status: Done

Delivered:

- planner YAML parsing with the `yaml` package;
- multi-task batch scheduling;
- scope conflict detection;
- git write serialization for coder phases;
- force-commit fallback for scoped dirty changes;
- pre-commit and post-commit compile gates;
- `floo run --detach`;
- JSON notifications under `.floo/notifications/`;
- tester phase;
- batch-level summary review.

### M3: Operations and Configuration

Status: Done

Delivered:

- `floo learn`;
- `floo learn --list`;
- `floo learn --distill`;
- `.floo/context/project-rules.md`;
- `floo sync`;
- `floo config`;
- health checks for stale tasks, sessions, and logs;
- dispatcher heartbeat while phases are running;
- task log capture for Web UI replay.

## Current Milestone

### M4: Web UI

Status: In progress

Delivered:

- `web/` Next.js app;
- `floo serve`;
- dashboard page;
- task list page;
- session page;
- task detail page;
- API routes for batches, tasks, sessions, artifacts, and logs;
- shared Web UI data access in `web/lib/floo.ts`.

Remaining:

- polish dashboard information density;
- add richer filtering/search;
- add live refresh or SSE;
- expose health-check state;
- decide whether the UI stays read-only or gains explicit operations such as retry/cancel.

## Planned Milestones (已迁移至 refactor-plan.md)

> ⚠️ **以下 M5 / M6 计划已废弃**,被新架构(plan-driven DAG)吸收。新方向见 [refactor-plan.md](./refactor-plan.md)。
>
> 关键变化:
> - **M5 (Runtime Expansion)** → 重构后,新 runtime 只需在 `floo.config.json.runtimes` 加一段配置,不需要写 adapter 子类。详见 refactor-plan Step 5。
> - **M6 (PRD / Ralph-Style Mode)** → 重构后,Ralph 风格只是一份 `templates/plans/loop.yaml` 模板,不是独立 milestone。PRD 风格是 `templates/plans/prd.yaml`。详见 refactor-plan Step 2。
>
> 原文保留以备追溯:

### ~~M5: Runtime Expansion~~ (deprecated)

- OpenClaw adapter
- custom adapter registration
- richer model/runtime config
- Codex reasoning effort config
- retry-time model escalation

### ~~M6: PRD / Ralph-Style Mode~~ (deprecated)

- accept a `prd.json` or markdown PRD as input
- convert user stories into Floo batch tasks
- preserve Floo's reviewer/tester/parallelism benefits while allowing Ralph-style fresh story loops
- record story progress back to PRD-like state

## Current Tests

Run:

```bash
npm test
```

Coverage areas:

- type imports and default config shape;
- scope conflict and out-of-scope logic;
- commit lock helpers;
- skill template loading;
- router start-phase decisions;
- adapter construction;
- dispatcher happy path;
- reviewer fail -> coder retry -> reviewer pass;
- tester fail -> coder retry -> reviewer -> tester pass;
- max review rounds;
- coder retry exhaustion;
- `review_level` scan/skip behavior;
- multi-task batch scheduling;
- `head_after` exit artifact diff tracking.

## Maintenance Rules

- Keep documentation paths aligned with the actual repository layout.
- When adding a CLI command, update both README files and this plan.
- When changing phase order, update `README*`, `docs/design.md`, `SKILL.md`, and role templates together.
- When changing `.floo/` persistence, update `docs/design.md` and the Web UI data access layer notes.
