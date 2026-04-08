# Content Analysis

## Topic
Floo 编排系统的事件驱动回调机制 — 展示 agent 调用→执行→回调的完整链路

## Data Type
- 顺序流程（时序）
- 5 个参与者之间的消息传递
- 带循环（步骤 13 回到步骤 3）

## Complexity
中等 — 15 个步骤，5 个参与者，线性为主带一个循环

## Tone
技术文档，面向开发者

## Audience
Floo 项目开发者和使用者，需要理解内部回调机制

## Language
中文（技术术语保持英文）

## Key Design Considerations
- 需要清晰展示消息在参与者之间的流动方向
- 步骤 10（tmux wait-for）和步骤 15（CLI exit）需要突出标注
- 循环路径（步骤 13 → 步骤 3）需要可视化
- 技术风格，深色背景更适合代码/架构主题
