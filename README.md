# Floo

**Multi-Agent Vibe Coding Harness**

A lightweight orchestration layer for solo developers who want multiple AI coding agents working together — parallel development, cross-review, automatic retry, and task tracking.

> **Language / 语言**: English | [中文](./README.zh-CN.md)

---

## What It Does

Floo coordinates AI coding agents (Claude Code, Codex, etc.) through a structured pipeline:

```
User describes task → Designer → Planner → Coder(s) → Reviewer → Tester → Summary Report
```

- **Parallel execution**: Planner splits work into subtasks; non-conflicting tasks run simultaneously
- **Cross-review**: Reviewer uses a different runtime than Coder (e.g., Codex reviews Claude's code)
- **Automatic retry**: Failed phases retry with error context, up to 3 attempts
- **Scope isolation**: Each task is restricted to specific files; commit locks prevent conflicts
- **Headless design**: Floo is a dispatcher, not a UI — any agent or script can call it

## Architecture

```
User ↔ Any agent (Claude Code / Codex / OpenClaw) ↔ Floo CLI ↔ Dispatcher ↔ Worker agents
         interaction layer                            orchestration     execution
```

Floo itself is a **headless orchestration layer**. It doesn't bind to any interaction method. Whoever calls the CLI is the interaction layer.

### Six Roles

| Role | Job | Output |
|------|-----|--------|
| **Designer** | Requirements analysis, scope definition | `design.md` |
| **Planner** | Task decomposition, dependency ordering | `plan.md` (strict YAML) |
| **Coder** | Write code, atomic commits | git commits |
| **Reviewer** | Code review (read-only) | `review.md` (pass/fail) |
| **Tester** | E2E / integration testing | `test-report.md` (pass/fail) |
| **house-elf** | System maintenance | lessons, config sync, cleanup |

### Default Role Bindings

```yaml
designer:  { runtime: claude, model: sonnet }
planner:   { runtime: claude, model: sonnet }
coder:     { runtime: claude, model: sonnet }
reviewer:  { runtime: codex,  model: codex-mini }  # cross-review by default
tester:    { runtime: claude, model: sonnet }
```

Override per-project in `floo.config.json`, or per-task via Planner output.

## Quick Start

```bash
# Clone and install
git clone https://github.com/ayaoplus/floo.git
cd floo && npm install

# Build
npm run build

# Initialize in your project
cd /path/to/your/project
floo init                        # creates .floo/, config, skill templates
floo init --with-playwright      # also installs Playwright for E2E testing

# Run a task
floo run "Add user authentication to the API"

# Monitor progress
floo status                      # snapshot of current tasks
floo monitor                     # live progress feed

# Background mode
floo run "Refactor payment module" --detach
floo monitor                     # watch notifications in real time
```

## Task Lifecycle

```
floo run "Refactor payment module"
  │
  ├─ Designer → design.md (requirements + scope)
  ├─ Planner  → plan.md (subtasks in YAML)
  │
  ├─ Subtasks with no scope overlap → run in parallel
  │   ├─ task-001: Coder → Reviewer → Tester ✓
  │   ├─ task-002: Coder → Reviewer → Tester ✓
  │   └─ task-003: (depends on task-001) → waits → Coder → Reviewer → Tester ✓
  │
  └─ All tasks pass → Summary Review (read-only report)
```

**Failure handling**:
- Reviewer fail → back to Coder (max 2 rounds)
- Tester fail → back to Coder → Reviewer → Tester (max 2 rounds)
- Phase crash → retry with error context (max 3 attempts)
- All retries exhausted → pause, notify human

## Project Structure

```
floo/
├── packages/
│   ├── core/          # Dispatcher, adapters, scope, router, monitor
│   ├── cli/           # CLI commands (init, run, status, cancel, monitor)
│   └── web/           # Next.js dashboard (planned)
├── skills/            # Skill templates (designer, planner, coder, reviewer, tester)
├── templates/         # Git hooks, config templates
└── docs/
    ├── design.md      # Full design document
    └── dev-plan.md    # Development roadmap
```

## Tech Stack

- TypeScript monorepo (npm workspaces)
- Node.js ESM
- tmux (one session per agent)
- No external dependencies beyond the AI CLI tools themselves

## Development Status

| Milestone | Status | Description |
|-----------|--------|-------------|
| M1: Single task | Done | `floo init → run → status` end-to-end |
| M2: Multi-task + quality | Done | Parallel dispatch, compile gate, detach mode, tester, batch summary |
| M3: Operations | Planned | Lessons, config sync, health checks |
| M4: Web UI | Planned | Next.js monitoring dashboard |

## Design Philosophy

- **Dispatcher, not engine** — Floo orchestrates; agents do the work
- **Elvis's pragmatism + Peter's minimalism** — tmux + file signals, no frameworks
- **Skill templates are the product** — carefully tuned prompts, not clever code
- **No over-engineering** — if it's not needed yet, don't build it

## License

MIT
