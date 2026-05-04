# Floo Refactor Plan

> 目标:从当前固定 6 阶段管线 → [docs/design.md](./design.md) 描述的 plan-driven DAG 架构。
>
> 原则:**渐进迁移,旧测试不删,每一步都能跑通**。任何一步落地后,`npm test` 必须 100% 通过。

## 总体策略

整个重构按"先建底座,再换芯片"的顺序推进:

```
1. plan.yaml 落盘(只读不变行为)
   ↓
2. PHASE_ORDER → feature.yaml 模板
   ↓
3. skills frontmatter (事实源就位)
   ↓
4. executor 替换 dispatcher (一次到位读 frontmatter)
   ↓
5. runtimes 进 config (adapter 通用化)
   ↓
6. plan-patch 机制
   ↓
7. UI 改造 (graph + runs)
   ↓
8. --orchestrate (高级模式)
```

每一步都是**独立可发布**的状态。任何一步如果发现方案有问题,可以停在那里继续观察使用,而不影响日常使用 Floo。

---

## Step 1: plan.yaml 落盘 (只读模式)

### 目标

每次 `floo run` 在 `.floo/batches/<batchId>/plan.yaml` 落一份执行图,但 dispatcher 行为完全不变,plan.yaml 只是**当前状态机决策的镜像**。先把数据模型和文件落地,让后续 UI 和 executor 改造有锚点。

### 输入

- 当前 `dispatcher.ts` 的 `PHASE_ORDER` + 任务参数

### 输出

- `.floo/batches/<id>/plan.yaml` 文件(每次 run 一份)
- `src/core/plan.ts` 新模块:plan schema 定义 + 序列化
- 测试:`test/plan.test.ts` 覆盖序列化往返

### 不做

- 不改 dispatcher 行为
- 不让 dispatcher 读 plan(它仍然走代码内状态机)
- 不引入 capability 概念

### 验收

- `floo run` 后能看到 plan.yaml,内容正确反映当次执行的 phase 顺序、依赖、scope
- 现有测试全过

### 风险

低。纯增量。

---

## Step 2: 把 PHASE_ORDER 的事实源从代码迁到 yaml(行为不变)

### 目标

`PHASE_ORDER` 常量**仍然存在**(为兼容现有 export 和测试),但它的初始值不再写死,而是在模块加载时从 `templates/plans/feature.yaml` 派生:

```ts
// 旧
export const PHASE_ORDER: Phase[] = ['discuss', 'designer', ..., 'tester'];

// 新
export const PHASE_ORDER: Phase[] = loadTemplate('feature.yaml').steps.map(s => s.capability) as Phase[];
```

dispatcher 内部状态机不变,仍消费 `PHASE_ORDER`。**但 PHASE_ORDER 的"权威来源"已经搬到 yaml**——重启进程时,用户对 `feature.yaml` 的编辑会生效。

这是一个保守的"事实源迁移",不是"换一套执行模型"。后者留到 Step 4。

### 输入

- Step 1 完成(plan.yaml 落盘的数据模型已稳定)

### 输出

- `templates/plans/feature.yaml`:与当前 6 阶段语义等价
- `templates/plans/tiny.yaml`:仅 coder
- `templates/plans/quick.yaml`:coder → reviewer
- `src/core/plan.ts` 加 `loadTemplate(name)`(同步 IO,模块加载时即用)
- router 改成"先选模板,再从模板的 steps 里取 startPhase",但内部仍走 PHASE_ORDER 索引

### 不做

- 不删 `PHASE_ORDER` export(测试和 dispatcher 都依赖)
- dispatcher 不读 plan.yaml 执行(Step 4 才换)
- 不加 frontmatter(Step 3)
- 不动 runtime adapter

### 验收

- 用户编辑 `templates/plans/feature.yaml` 调整 step 顺序,**重启** Floo 后,`PHASE_ORDER` 反映新顺序,dispatcher 走新顺序
- `floo run --mode tiny|quick|feature` 三种模板都能跑通(实质上是改变启动时加载哪份 yaml,然后让 PHASE_ORDER 对应不同序列;`tiny` / `quick` 路径下 dispatcher 在跑到不存在的 phase 时跳过——具体跳过逻辑在 Step 1 的 plan.yaml 落盘里就要预演过)
- 现有测试 100% 通过(因为 `PHASE_ORDER` export 和值都保持等价)

### 风险

中。三个具体风险:

1. **模板加载失败的 fail-fast**:模块顶层加载 yaml 失败要打印清晰错误并 exit 1,不能让 PHASE_ORDER 变成 undefined。
2. **三个 mode 的语义对齐**:`tiny` 没有 designer 等 phase,但 dispatcher 状态机仍按 PHASE_ORDER 推进——需要在 dispatcher 入口前根据 mode 截断 startIdx/endIdx,而不是动 PHASE_ORDER 本身。
3. **测试稳定性**:`test/core.test.ts` 第 57 行 `assert(PHASE_ORDER.length === 6)` 是基于 `feature.yaml` 模板的硬断言。如果用户改了 yaml 测试就挂——这个测试需要改成"PHASE_ORDER 反映 feature.yaml"而不是"长度恒等于 6"。这是 Step 2 唯一不可避免的测试改动。

---

## Step 3: Skill Frontmatter (capability 元数据)

### 目标

把每个 `skills/*.md` 加上 frontmatter,声明 `name / write_policy / outputs / default_runtime / default_model / inputs`。skill loader 解析 frontmatter 并暴露 metadata API。

**这一步是 Step 4 的前置:executor 替换 dispatcher 时,要直接从 frontmatter 读 write_policy 等信息,而不是 hardcode。**

### 输入

- 现有 `skills/*.md`
- 设计文档里 capability 表格

### 输出

- 6 个 skill 文件加 frontmatter:
  - `discuss.md`:`write_policy: artifacts_only, outputs: [context.md], default_runtime: claude, default_model: opus`
  - `designer.md`:`write_policy: artifacts_only, outputs: [design.md, design-questions.md], default_runtime: claude, default_model: opus`
  - `planner.md`:`write_policy: artifacts_only, outputs: [plan.md], default_runtime: claude, default_model: sonnet`
  - `coder.md`:`write_policy: scope, outputs: [commits], default_runtime: claude, default_model: sonnet`
  - `reviewer.md`:`write_policy: readonly, outputs: [review.md], default_runtime: codex, default_model: codex-mini`
  - `tester.md`:`write_policy: readonly, outputs: [test-report.md], default_runtime: claude, default_model: sonnet`
- `src/core/skills/loader.ts` 解析 frontmatter,返回 `{metadata, body}`
- `src/core/types.ts` 加 `CapabilityMetadata` 类型
- 测试:loader 单测覆盖 frontmatter 解析

### 不做

- 不让 dispatcher / executor 强制执行 write_policy(下一步才做)
- 不动 runtime adapter
- 不加新的 capability

### 验收

- `loader.load("coder")` 返回 metadata + body,metadata 字段齐全
- 现有 dispatcher 仍能通过 loader 获取 prompt body(向后兼容)
- 现有测试全过

### 风险

低。frontmatter 是纯元数据,运行时还没消费。

---

## Step 4: Executor 替换 Dispatcher (核心一步)

### 目标

新写一个 `src/core/executor.ts`,以 plan.yaml 为唯一输入驱动调度。`dispatcher.ts` 要么删除,要么退化为 executor 的薄包装。frontmatter 中的 `write_policy` / `outputs` 由 executor 强制执行。

### 输入

- Step 1-3 完成
- `templates/plans/feature.yaml`
- 各 skill 的 frontmatter

### 输出

- `src/core/executor.ts`:DAG 拓扑调度循环
- `src/core/scope.ts`:沿用,接口微调以匹配 plan 节点
- `src/core/dispatcher.ts`:**保留为 compatibility shim**(不删),内部委托 executor
- 现有测试**不改**继续通过

### 测试迁移策略 (源码 shim 而不是 test helper)

事实:旧 `test/dispatcher.test.ts` 和 `test/core.test.ts` 直接 import 了:
- `PHASE_ORDER` from `src/core/types.ts`(`test/core.test.ts:18`)
- `runTask, createAndRun, type DispatcherOptions` from `src/core/dispatcher.ts`(`test/dispatcher.test.ts:11`)

加 `test/helpers/dispatcher-shim.ts` **救不了**这些直接 import。正确做法是**在源码层保留兼容 export**:

1. **`PHASE_ORDER` 保留**:Step 2 已经把它的事实源迁到 yaml,Step 4 保持这个迁移结果不变。
2. **`runTask` 保留为 thin wrapper**:
   ```ts
   export async function runTask(task, startPhase, opts) {
     const plan = synthesizeSinglePlan(task, startPhase, opts);
     const result = await executor.run(plan, opts);
     return adaptToLegacyResult(result);  // 把 executor 的输出格式翻译回旧契约
   }
   ```
3. **`createAndRun` 同理**:内部转 plan + 调 executor,但 export 签名和返回值结构不变。
4. **`DispatcherOptions` 类型保留**:可以是 `ExecutorOptions` 的别名或子集。
5. 旧测试一行不改,`npm test` 必须 100% 过。
6. 全过且观察期(1-2 周本机使用)无回归后,**新写** `test/executor.test.ts` 直接覆盖 plan-driven 路径。
7. 当 executor 测试覆盖等价于旧测试时,才允许把旧测试中"过时的 phase 概念"删掉,但 shim 本身可以保留更久,作为外部消费者(OpenClaw 等)的稳定接口。

**关键约束**:Step 4 不删 `dispatcher.ts`,只是把内部实现换成委托给 executor。"删除 dispatcher" 这件事推迟到测试和外部消费者都迁移完之后,可能是 Step 7 之后的清理工作。

### 不做

- 不引入 plan-patch(下一步才做,本步 plan 是静态的)
- 不改 runtime adapter
- 不改 UI
- 不删 `dispatcher.ts`(只换内部实现)
- 不删 `runTask` / `createAndRun` / `PHASE_ORDER` 任何 export

### 验收

- 旧测试 100% 通过,**且 import 行不动**
- 用户跑 `floo run` 行为与重构前完全一致
- `src/core/dispatcher.ts` 内部不再包含 phase 状态推进逻辑,改为构造 plan + 调用 executor

### 风险

**高**。这是整个重构最危险的一步。建议:

- 拉一个独立分支,跑通再合并
- 落地前先把 Step 1-3 用一段时间,确保 plan.yaml 数据模型稳定
- 落地后留 1-2 周观察期再做 Step 5
- 把 `runTask` / `createAndRun` 的输出契约**写成断言加进新 executor 测试**,防止之后的重构悄悄破坏外部消费者

---

## Step 5: Runtimes 进 Config (adapter 通用化)

### 目标

`floo.config.json` 增加 `runtimes` 段。新写一个 `GenericRuntimeAdapter`,根据配置启动 tmux + 执行 CLI + 解析输出。`adapters/{claude,codex}.ts` 退化为兜底,直至验证通用 adapter 稳定。

### 输入

- Step 4 完成
- `runtimes` 配置 schema 设计

### 输出

- `src/core/runtimes.ts`:加载 runtime 注册表
- `src/core/adapters/generic.ts`:通用 adapter
- `floo.config.json` schema 加 `runtimes` 段
- `floo init` 默认写入 claude / codex 两个 runtime
- 测试:`test/runtimes.test.ts` 覆盖配置加载 + adapter 启动

### 验收

- 用户在 config 里加一个 `gemini` runtime 配置后,plan 中可指定 `runtime: gemini` 并成功启动 Gemini CLI(假设已安装)
- 不再需要为每种 runtime 写 TypeScript 子类

### 风险

中。不同 CLI 的 stdout/stderr 格式差异大,通用 adapter 需要可配置的输出解析策略。

---

## Step 6: Plan-Patch 机制

### 目标

允许 worker step 在结束时输出 `.floo/batches/<id>/patches/<stepId>.yaml`,executor 应用补丁(只允许追加节点)。把当前 dispatcher 的 review-fail-loop / discuss-designer-loop 改写为 plan-patch 形态。

### 输入

- Step 5 完成
- patch schema 定义

### 输出

- `src/core/plan.ts` 加 `applyPatch(plan, patch)`:校验 + 追加节点
- executor 在每个 step 完成后扫描 patches/ 目录并 apply
- 多 worker 并发 patch 串行化
- patch 校验失败的处理路径(丢弃 + 记录到 ledger)
- `skills/reviewer.md` / `skills/designer.md` 更新 prompt:不再隐式触发循环,改为输出 patch 文件

### 验收

- reviewer 判 fail 时,自动追加新的 coder + reviewer 节点
- discuss 输出 design-questions blocker 时,自动追加新一轮 discuss
- 触达 `loop_limits.max_review_rounds` 时停止追加,记录未解决问题

### 风险

中。并发 patch 的串行化要小心 race condition。

---

## Step 7: UI 改造 (graph + runs)

### 目标

Web UI 围绕 plan DAG 展示。每个节点点进去看 run 详情(prompt / log / artifact / diff)。

### 输入

- Step 4-6 完成
- `web/` 当前 Next.js 应用

### 输出

- `web/lib/floo.ts` 数据访问层切到 plan/runs
- `web/app/batch/<id>/page.tsx`:DAG 可视化(用 react-flow 或类似库)
- `web/app/run/<id>/page.tsx`:run 详情页
- 实时刷新(SSE 或轮询)

### 不做

- 不实现重试 / 取消 mutation 端点(只读 UI 优先)
- 不实现 token 仪表盘(用户明确说不强需求)

### 验收

- 用户可以看到 plan DAG,点击节点进入 run 详情
- 多个并行节点同时跑时,UI 状态正确反映

### 风险

低。纯前端工作,数据层稳定后改 UI 风险可控。

---

## Step 8: --orchestrate (高级模式, opt-in)

### 目标

`floo run --orchestrate` 调用 orchestrator agent 生成 plan.yaml,而不是从模板复制。作为高级模式,**默认不开**。

### 输入

- Step 1-7 完成
- `skills/orchestrator.md` 新增 prompt

### 输出

- `skills/orchestrator.md`:让 LLM 根据任务 + capabilities + runtimes 生成 plan
- `src/commands/run.ts` 加 `--orchestrate` 标志
- plan 生成后做 schema 校验:capability 必须在注册中心、runtime 必须在 config、scope 不能为空(除非显式 wildcard)

### 验收

- `floo run --orchestrate "..."` 能生成合理的 plan.yaml
- 校验失败时有清晰报错,不会盲跑一份坏 plan

### 风险

低。这是一个可选功能,有问题用户不开就行。

---

## 不做的事 (明确放弃)

为避免过度工程,这些 idea 在重构期间**明确不做**,等真出现痛点再加:

- ❌ **policies 系统**(`prefer: [claude, codex]` + 角色策略表):个人工具用不到,任务里直接写 runtime 即可
- ❌ **usage_snapshot / recent_failure_rate**:用户明确说 token 不强需求
- ❌ **capability 单独 yaml**:frontmatter 已经是事实源,不要双源
- ❌ **OpenClaw worker adapter**:OpenClaw 是入口不是 worker,这个边界划在外部
- ❌ **token 仪表盘**:确认非强需求,不投入精力
- ❌ **跨机分发**:Floo 是本机 harness,不做分布式

## 文档同步要求

每个 step 完成后:

- 必须更新本文档,把对应 step 标记 ✅,并记录"实际落地与计划的偏差"
- 如果 step 中发现新问题或新约束,必须先更新 [docs/design.md](./design.md),再继续下一步
- README.md / README.zh-CN.md / SKILL.md 在 Step 4 完成后做一次集中更新,反映 plan-driven 新心智模型

## 进度跟踪

| Step | 状态 | 备注 |
|------|------|------|
| 1. plan.yaml 落盘(只读镜像) | ⬜ Pending | |
| 2. PHASE_ORDER 事实源迁 yaml(行为不变) | ⬜ Pending | |
| 3. Skill frontmatter | ⬜ Pending | Step 4 前置 |
| 4. Executor 内化(dispatcher 退化为 shim) | ⬜ Pending | **核心步骤,需独立分支** |
| 5. Runtimes 进 config | ⬜ Pending | |
| 6. Plan-patch | ⬜ Pending | |
| 7. UI 改造 | ⬜ Pending | |
| 8. --orchestrate | ⬜ Pending | opt-in 高级模式 |
