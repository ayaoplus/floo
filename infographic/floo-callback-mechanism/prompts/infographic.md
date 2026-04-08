Create a professional infographic following these specifications:

## Image Specifications

- **Type**: Infographic
- **Layout**: linear-progression
- **Style**: technical-schematic
- **Aspect Ratio**: 16:9
- **Language**: zh (Chinese, with English technical terms preserved)

## Core Principles

- Follow the layout structure precisely for information architecture
- Apply style aesthetics consistently throughout
- Keep information concise, highlight keywords and core concepts
- Use ample whitespace for visual clarity
- Maintain clear visual hierarchy

## Text Requirements

- All text must match the specified style treatment
- Main titles should be prominent and readable
- Key concepts should be visually emphasized
- Labels should be clear and appropriately sized
- Use Chinese for all text content, keep technical terms in English

## Layout Guidelines

Sequential progression showing steps in a process flow.

Structure:
- Horizontal linear arrangement with 5 major phases
- Nodes/markers at key points with connecting lines/arrows
- Clear start (left) and end (right) points
- Directional flow indicators (arrows)
- One loop-back arrow from phase 4 back to phase 2 (representing dispatch next phase)

Variant: Process — action steps with numbered sequence, action icons.

## Style Guidelines

Technical diagrams with engineering precision and clean geometry.

Color Palette:
- Primary: Blues (#2563EB), teals, grays, white lines
- Background: Deep blue (#1E3A5F) with subtle grid pattern
- Accents: Amber highlights (#F59E0B) for key callouts, cyan for annotations
- Use amber/gold star markers for the two critical steps (step 10 and step 15)

Visual Elements:
- Geometric precision throughout
- Grid pattern background
- Clean vector shapes with consistent stroke weights
- Technical annotations with callout lines
- Dimension-style labels

Typography:
- Technical stencil or clean sans-serif
- All-caps for phase headers
- Regular weight for step descriptions

---

Generate the infographic based on the content below:

# Floo 事件驱动回调机制

A horizontal flow diagram showing 5 phases of the Floo orchestration system's event-driven callback mechanism. Each phase is a distinct visual block connected by arrows.

## Phase 1: INVOKE (调用阶段)
Icon: terminal/command prompt
- 调用方 Agent (CC/Codex/OpenClaw) 执行 `floo run "task"`
- CLI 阻塞等待，调用 `createAndRun()`

## Phase 2: DISPATCH (派发阶段)
Icon: network/branch
- Dispatcher 调用 `adapter.spawn()`
- 创建 tmux session
- Runner 脚本启动工作 Agent

## Phase 3: EXECUTE (执行阶段)
Icon: code/gear
- 工作 Agent 自主编码
- `git commit` (post-commit hook 编译门禁)
- Agent 退出 → exit_code

## Phase 4: COLLECT (回收阶段)
Icon: package/archive
- Runner: force-commit 兜底
- Runner: 收集 files_changed
- Runner: 写 exit artifact (.exit JSON)

## Phase 5: CALLBACK (回调阶段) ★ HIGHLIGHT THIS
Icon: signal/lightning bolt
Two key callbacks highlighted with amber/gold stars:

★ 内部回调: `tmux wait-for` 信号
  → Dispatcher 零延迟唤醒
  → 状态机推进 → 下一个 phase

★ 外部回调: CLI exit code + stdout
  → 调用方 Agent 收到结果
  → 任务完成

## Loop Arrow
From Phase 5 back to Phase 2: "下一个 phase/任务" (循环调度)

## Bottom Banner
"事件驱动 · 零延迟 · 不需要轮询 · 不需要 webhook · tmux wait-for = on-complete.sh"

Text labels (in zh):
- 标题: Floo 事件驱动回调机制
- Phase 1: 调用
- Phase 2: 派发
- Phase 3: 执行
- Phase 4: 回收
- Phase 5: 回调
- 关键标注 1: ★ tmux wait-for 零延迟回调
- 关键标注 2: ★ CLI exit = 调用方回调
- 循环标注: 下一个 phase/任务
- 底部: 事件驱动 · 零延迟 · 不需要轮询 · 不需要 webhook
