# acp_status 对齐上游设计（acp_status upstream-alignment design）

> **状态**：设计评审稿 v2（已吸收首轮子代理评审意见，见修订记录）。进入实现前需完成 §6 接线改动，以 §8 测试计划为验收。
>
> **修订记录(v2,吸收首轮子代理代码评审 3×P1 + 6×P2,全部源码级验证):**
> - **P1-1**:**删除 §4.2 手写映射表**——`rebuildBlockLedger` 返回**全部** `compaction/summary` 块(含已被蒸馏的 inactive 父块),原"ledger 只含 active 块"表述是事实错误;`active` 必须用 `!consumed.has(blockId)` 判定。
> - **P1-2**:改用 **`env.store.stateFor(session)`**(live 内存态,已由 processTurn 维护)或 **`rebuildKernelBlocks`**(`src/state.ts:25-85`,log 重建)作为 `CompressionState` 来源——两者均已正确处理 `active`/`directBlockIds`(父块内核 bN,非 compaction UUID)/`runId`/`survivedCount`/`generation`/legacy 回退;不再新增 adapter。
> - **P1-3**:**`buildStatusReport` 的 `messages` 必须排除 checkpoint 摘要节点**(`source.plugin === 'compact'` 的 `user/message`,见 `src/region.ts:383-390,397-404`)——否则摘要同时计入 `summaryTokens`(经 block.summary)与 `totalText`(经投影的 text 消息),**双重计数**,破坏"字节对齐上游"目标。
> - **P2-1**:topic 未进 ledger,块行将恒显 `(no topic)`——§6 增补"在 `compaction/summary` 记录 topic"(推荐,小改动)。
> - **P2-2**:§6.1 明确 `handleStatus` 调 processTurn 时 `tokenCount` 用 `resolveTokenCount(agent, surfaceMessages)`(遵守硬性规则 2),且**不持久化 turn.state**(避免同 turn 二次推进 nudge 基线;`Nudge:` 行只用 `turn.nudge.reason`)。
> - **P2-3**:§9 scope 钻取后续项加 ref 兼容性预警(`seq#callId` 自映射值在 `renderUncompressedRanges`/`renderMessageDrilldown` 的 `/\d+/` 解析与连续合并逻辑下语义漂移)。
> - **P2-4**:§4.3/§6.5 "抽共享渲染函数"降级为**可选、仅共享 ledger→块行片段**(改后两路径分叉,共享面极小;现状两函数本就有差异:handleStatus 有 surface 行、statusText 有 `[T${tier}]` 标签)。
> - **P2-5**:§8.2.3 ACTIVE 态测试构造补强(需同时满足 usage≥阈值 且 pending≥`minCompressRange`,否则 reason 落 "nudge suppressed");§4.3 的 /acp 示例删去 surface 行(当前 `statusText` 不输出该行)。
> - **P2-6**:§4.2 块排序措辞修正——overview 块列表按 `compressedTokens desc || createdAt desc`(`index.js:2472-2474`),非 numericPart 序(numericPart 仅用于 buildRecap)。

## 0. 结论先行（TL;DR）

把模型工具 `acp_status` 的输出从"移植版自研格式（含 `estimated context: X / Y (Z%)` 与 `context window: Y (source)` 两行窗口语义）"改为**复用 acp-kernel 自带的 `buildStatusReport`** 渲染 `CONTEXT BREAKDOWN` + `COMPRESSED BLOCKS`（百分比为**占可见总量**、不含窗口），并拼接 kernel nudge 决策行的 `Nudge: idle/ACTIVE — reason`。**模型可见的 acp_status 不再出现任何上下文窗口信息**，与上游 billion-context-pi 一致；人类 `/acp` 斜杠命令保留窗口展示（上游 `/acp` 面板同样展示窗口）。kernel 升级提示词/渲染逻辑时本引擎零改动自动跟随（复用 `renderNudgeText` 的既有模式）。

## 1. 背景与目标

### 1.1 问题

当前移植版 `acp_status` 输出（`src/tools.ts:441-464`）：

```
ACP status — session <id>
  blocks: 0
  tokens compressed: 0
  estimated context: 74879 / 1000000 (7%)
  context window: 1000000 (configured)
  surface: 104 nodes, seqs 8..20594
```

模型在思考环节看到 `estimated context: 74879 / 1000000 (7%)` 后，直接依据"7% 占用"决定不压缩。该行是**移植版独有**：上游 billion-context-pi 的模型工具 `acp_status` 输出中没有任何窗口语义（见 §3 逐字复现）。窗口占用只在 nudge **触发时**以 `usage X%` 出现在 reason 里；idle 时完全不出现。

### 1.2 上游行为（模型工具 vs 人类命令的区分）

上游对"模型工具"与"人类命令"是**两条不同的渲染路径**：

| 路径 | 输出 | 是否含窗口 |
|---|---|---|
| 模型工具 `acp_status`（`src/status-tool.ts` → kernel `buildStatusReport`） | `CONTEXT BREAKDOWN`（tool/text/summaries 估算 + **占可见总量百分比**）+ `COMPRESSED BLOCKS` + `Nudge: idle/ACTIVE — reason` + `Compressible ranges` + `Delegate usage` | **否** |
| 人类 `/acp` 命令（`src/commands.ts` → `buildStatusPanel`，billion-context-kit） | 面板：tokenCount + modelContextLimit + 进度条等 | **是**（人类排查需要） |

移植版目前**两条路径共用同一份自研格式**（`src/tools.ts` 的 `handleStatus` 与 `src/commands.ts` 的 `statusText` 结构相同），导致模型工具也被迫看到窗口行。

### 1.3 目标

1. **模型工具 `acp_status` 对齐上游**：输出 `CONTEXT BREAKDOWN` + `COMPRESSED BLOCKS` + `Nudge` 行（+ 保留移植版 `surface` 行，见 §4.4），**删除 `estimated context` 与 `context window` 两行**；
2. **复用 acp-kernel 自带接口**：用 `buildStatusReport` / kernel nudge reason 渲染，引擎只做拼装，不自研格式（与上游 status-tool 的职责划分一致）；
3. **人类 `/acp` 命令保留窗口**：与上游 `/acp` 面板一致，窗口信息仍是人类排查的有效手段（`window.ts` 探测逻辑不动）；
4. **kernel 升级零改动**：与 `config.prompts` 默认路径复用 `renderNudgeText`（`src/nudge.ts:178`）同理，acp_status 渲染完全由 kernel 提供文案，kernel 更新提示词/格式时本引擎自动跟随；
5. **默认输出字节对齐上游**（除 §4.4 surface 行为移植版特有扩展）。

### 1.4 提示词来源三层原则（本项目基线，本设计必须遵守）

模型可见文本的来源优先级，逐段判定：

1. **kernel 有现成的 → 直接调用，不复制**。kernel 提供渲染函数（`buildStatusReport` / `formatRanges` / nudge reason / `renderNudgeText`），引擎只拼装、不复制文案到本项目。kernel 升级提示词时本引擎零改动自动跟随（本设计 §4.1 的 `CONTEXT BREAKDOWN` / `COMPRESSED BLOCKS` / `Tip:` 即此例）。
2. **kernel 没有、pi 有 → 与 pi 保持一致，复制过来**。kernel 明确不拥有的 surface-level 文本（工具描述、状态行拼装格式）归 adapter 层（pi 插件源码），此类与 pi 逐字对齐（本设计 §4.4 的 `Nudge:` 行、§4.5 工具描述即此例）。
3. **两者都没有、或不符合本项目 → 用自己的**。DSH 特有的 seq 锚点语义（`Surface:` 行）、schema 不支持的参数说明（scope 钻取，`statusParameters = {}`）、未引入的依赖（billion-context-kit 的 `/acp` 面板）——此类用移植版自己的文案，不做无谓对齐。

> 边界判定依据：kernel `dist/prompts.d.ts` 头注释明确声明 *"Surface-level text (summary section headers, status-report chrome, tool descriptions) is intentionally NOT part of this interface — it is owned by the adapter"*——工具描述等 surface 文本按 kernel 自身设计归 adapter 层，因此 §4.5 复制 pi 的 description 属于第 2 条，不是"kernel 有却复制"。

## 2. 现状盘点（移植版）

| 项 | 位置 | 现状 |
|---|---|---|
| 模型工具 handler | `src/tools.ts:441-464` `handleStatus` | 自研：`rebuildBlockLedger` + `resolveTokenCount` + `env.windowFor` 手工拼行 |
| 工具描述 | `src/prompts.ts:212`（`DEFAULT_RESOLVED.tools.acpStatus`） | `"Report the ACP block ledger: compressed blocks, reclaimed tokens, and current context pressure."` |
| 人类命令 | `src/commands.ts:23-45` `statusText` | 与模型工具同格式（含窗口行）；`/acp` 命令注册于 `src/commands.ts:97-117` |
| 窗口探测 | `src/window.ts`（`detectContextWindow` / `windowSourceLabel`） | 仍为 nudge 决策与 `/acp` 所需，**保留** |
| nudge 决策 | `src/nudge.ts:133` `env.kernel.processTurn` → `buildNudge` | 已走 kernel 管线；acp_status 未复用 |
| nudge 文案 | `src/nudge.ts:178` `renderNudgeText(nudge)` | 默认路径已复用 kernel 文案（v6 R1） |
| 块账本 | `src/region.ts` `AcpBlockLedgerEntry` + `rebuildBlockLedger` | 自研 ledger，含 `tier`/`shadowedTokenCount`/`kernelBlockId` 等 |

### 2.1 现有测试对窗口行的断言（对齐后必须更新）

- `tests/tools.test.ts:180`：`/context window: 128000 \(configured\)/`
- `tests/tools.test.ts:193`：`/estimated context:/`
- `tests/tools.test.ts:210-211`：`/context window: 1000000 \(auto-detected from test-provider\/test-model\)/`、`/estimated context: \d+ \/ 1000000/`
- `tests/window.test.ts`：`detectContextWindow` 单元测试——**保留**（窗口仍用于 nudge 与 `/acp`）

## 3. 上游基准（kernel 真实渲染结果）

用 acp-kernel **0.0.24**（移植版锁定版本，`package.json:49`）真实运行 `processTurn` + `buildStatusReport` + `handleStatus` 拼装逻辑，模型工具无参调用返回逐字文本：

### 3.1 无压缩（大会话）

```
CONTEXT BREAKDOWN
  10.1K tool (95%) | 498 text (5%) | 0 summaries (0%)
  Top tools: bash (48%), read (47%), text (5%)

COMPRESSED BLOCKS
  No compressed blocks.

Tip: buildStatusReport({scope:"uncompressed", view:"messages", tool:"bash"}) for per-message listing

Nudge: idle — max compressible 9894 < threshold 50000; growth 0 < floor 22500

Compressible ranges (6, oldest first):
  m00003–m00006  4 msgs  1.6K [tool 100% | text 0%]
  m00009–m00012  4 msgs  1.6K [tool 100% | text 0%]
  ...

Delegate usage: none this session.
```

### 3.2 压缩 1 块后

```
CONTEXT BREAKDOWN
  8.5K tool (94%) | 498 text (6%) | 39 summaries (1%)
  Top tools: bash (47%), read (47%), text (6%)

COMPRESSED BLOCKS — 1 active (39 summary, 1.6K original)

  b1 (T1)  1.6K→39  4 msgs  "billing flaky tests R1-2"

Tip: buildStatusReport({scope:"uncompressed", view:"messages", tool:"bash"}) for per-message listing

Nudge: idle — max compressible 8245 < threshold 50000; growth 0 < floor 22500

Compressible ranges (5, oldest first):
  m00009–m00012  4 msgs  1.6K [tool 100% | text 0%]
  ...

Delegate usage: none this session.
```

### 3.3 关键语义（§3.1/§3.2 与移植版现状的差异）

1. **百分比是占可见总量，不是占窗口**：`buildStatusReport` 内 `pct(n, total)` 的 `total = summaryTokens + totalTool + totalText`（`src/report.ts` 的 `renderOverview`），与模型上下文窗口无关。
2. **token 数为估算**：`defaultCountTokens`（CJK 感知 chars/4），非 provider 实测；模型工具路径从不展示 `getContextUsage()` 的真实 usage。
3. **窗口只进 nudge 决策，不进工具输出**：`usage = tokenCount / modelContextLimit` 仅用于 kernel nudge 决策（`minContextLimitPct 0.45 / maxContextLimitPct 0.75 / emergencyThresholdPct 0.95`，移植版经 `src/index.ts` DEFAULT_CONFIG 降为 0.70/0.85）与触发时 reason 里的 `usage X%`。
4. **ref 语义（mNNNNN）仅出现在 ranges/钻取**：`buildStatusReport` 的 overview **不显示 ref**（§3 两例的 breakdown 与 blocks 均无 m 号）；ref 只在 `scope:'uncompressed', view:'messages'` 钻取模式与 `Compressible ranges` 里出现。

## 4. 目标设计

### 4.1 模型工具 `acp_status` 新输出

复用 `handleStatus`（`src/tools.ts:441`），改为：

```
CONTEXT BREAKDOWN
  8.5K tool (94%) | 498 text (6%) | 39 summaries (1%)
  Top tools: bash (47%), read (47%), text (6%)

COMPRESSED BLOCKS — 1 active (39 summary, 1.6K original)

  b1 (T1)  1.6K→39  4 msgs  "billing flaky tests R1-2"

Nudge: idle — max compressible 8245 < threshold 50000; growth 0 < floor 22500

Surface: 8 nodes, seqs 1..8
```

实现要点：

- **主体**：调用 kernel `buildStatusReport(state, messages, countTokens, {})` 渲染 `CONTEXT BREAKDOWN` + `COMPRESSED BLOCKS`（含 Tip 行，与上游逐字一致）；
- **Nudge 行**：拼接 `Nudge: ${nudge.shouldInject ? 'ACTIVE' : 'idle'} — ${nudge.reason}`（reason 为 kernel 生成的字符串，如 §3 示例）；
- **Surface 行**（移植版特有，必须保留）：`Surface: ${surfaceSummary(session)}`——DSH 的 seq 是压缩工具的锚点（`compress({ startSeq, endSeq })`），模型靠它定位 seq；上游 ref（mNNNNN）语义在 DSH 不适用，故移植版补这一行；
- **删除**：`estimated context: X / Y (Z%)`、`context window: Y (source)`、`tokens compressed:` 行（上游无；`COMPRESSED BLOCKS` 已含 original/summary 数字）；
- **`blocks: N` 行**：上游无此独立行（信息由 `COMPRESSED BLOCKS` 承载），删除。

### 4.2 数据来源：复用 `stateFor` / `rebuildKernelBlocks`，不新增 adapter

`buildStatusReport` 签名（0.0.24 `dist/report.d.ts:9`）：

```ts
buildStatusReport(state: CompressionState, messages: CoreMessage[], countTokens: (t: string) => number, options?: StatusReportOptions): string
```

`state` 需满足 kernel `CompressionState`（0.0.24 `dist/types.d.ts:53-60`：`blocks / messageRefs / nudge / stats / nextBlockId / nextRunId`）。**不手写映射**——仓库已有两份正确的来源，直接复用：

1. **`env.store.stateFor(session)`**（`src/state.ts:102`）——live 内存态，由 `processTurn` 持续维护，`handleCompress`（`tools.ts:166`）与 `buildNudge`（`nudge.ts:126`）均用它。acp_status 走同一入口，语义与 nudge/compress 完全一致。
2. **`rebuildKernelBlocks(events)`**（`src/state.ts:25-85`）——从日志重建（重启后首次访问由 `stateFor` 内部触发），已正确处理：
   - `active: !consumed.has(entry.blockId)`（蒸馏后父块 inactive，`state.ts:50-53,81`）；
   - `directBlockIds` = 父块的**内核 bN**（`parentKernelIds` 映射，`state.ts:43-48,76`），非 compaction UUID；
   - `runId: rN` / `survivedCount: 0` / `generation: 'young'` / legacy 块回退（`state.ts:69-82`）。

> 若场景需要"即使 live 态不可用也能从纯日志渲染"，用 `rebuildKernelBlocks`；否则用 `stateFor`。两者都满足 TS 严格类型（`CompressionState` 全字段），无合成占位。

**消息集（P1-3 关键约束）**：传给 `buildStatusReport` 的 `messages` 必须**排除 checkpoint 摘要节点**：

- checkpoint 节点 = `source.plugin === 'compact'` 的 `user/message`（`src/region.ts:383-390` 写入，`397-404` 的 `summarySeqOfCompaction` 即按此识别），在 surface 上投影为 `id=seq` 的 text CoreMessage；
- 它不在任何 block 的 `effectiveMessageIds` 里（effective 是**原始消息** id），若不排除，`collectVisible` 会把它计入 `totalText`，而同一份摘要又经 `block.summary` 计入 `summaryTokens`——**双重计数**，`text` 百分比虚高，偏离上游字节基准（上游 §3.2 `text=498` 不含 39-token 摘要）；
- 实现：`surfaceEventsOf(session)` 后按事件 `source.plugin === 'compact'` 过滤，再 `eventsToCoreMessages`；`messageRefs.byRaw` 自然只覆盖非 checkpoint 消息（id 自映射即可——kernel `refForRaw` 无格式校验，`index.js:25-27`；overview 不输出 ref 值，`renderOverview` 仅读 breakdown 数字）。

**tokenCount 口径（P2-2）**：`handleStatus` 调 `processTurn` 时 `tokenCount` 用 `resolveTokenCount(agent, surfaceMessages)`（surface 口径，与 `handleCompress`/`buildNudge` 一致，遵守硬性规则 2）；**不持久化 turn.state**（`env.store.set` 不调用），避免同 turn 二次推进 nudge 基线、`Nudge:` 行只用 `turn.nudge.reason`。

### 4.3 人类 `/acp` 命令

`src/commands.ts:23-45` `statusText` **保留窗口行**（对齐上游 `/acp` 面板语义：人类排查需要窗口）。`/acp` 与模型工具**不强制共用渲染函数**（P2-4）：改后两条路径分叉（模型工具走 kernel 渲染、`/acp` 保留现状窗口格式），且现状两函数本就有差异（`handleStatus` 有 `surface:` 行、`statusText` 无；`statusText` 块行带 `[T${tier}]` 标签、`handleStatus` 不带）。可共享的仅"ledger→块列表行"这一小段，列为可选重构，不引入耦合。`/acp` 输出保持现状：

```
ACP status — session <id>          ← 保留（人类友好）
  blocks: 1
  tokens compressed: 145305
  estimated context: 26165 / 128000 (20%)
  context window: 128000 (auto-detected from ...)
  - b1: seqs 1..5 — Refactor auth to JWT...
```

即：`/acp` 保留现状窗口格式，模型工具走 kernel 渲染——两条路径各自对齐上游的对应路径。

### 4.4 保留/删除清单（模型工具 `acp_status`）

| 行 | 处置 | 理由 |
|---|---|---|
| `CONTEXT BREAKDOWN ...` | ✅ kernel 渲染 | 上游核心诊断信息 |
| `COMPRESSED BLOCKS ...` | ✅ kernel 渲染 | 上游块账本 |
| `Tip: buildStatusReport(...)` | ✅ kernel 渲染（逐字保留） | 上游逐字一致；虽暴露内部函数名，但对齐优先 |
| `Nudge: idle/ACTIVE — reason` | ✅ 拼装 | 上游有；reason 为 kernel 生成 |
| `Surface: N nodes, seqs ...` | ✅ 移植版特有，保留 | DSH seq 锚点，压缩工具必需 |
| `estimated context: X / Y (Z%)` | ❌ 删除 | 窗口语义，上游无 |
| `context window: Y (source)` | ❌ 删除 | 窗口语义，上游无 |
| `blocks: N` / `tokens compressed: N` | ❌ 删除 | 上游无；由 `COMPRESSED BLOCKS` 承载。注：上游 `N active` 是 **active** 块数（`buildStatusReport` 只列 active 块），而 DSH 现状 `blocks: N` 是**总**块数（含被蒸馏的 inactive 父块）；对齐后模型看不到已蒸馏块总数，与上游语义一致，可接受 |
| `session <id>` | ❌ 删除（模型工具） | 上游模型工具无 session 头；`/acp` 保留 |
| `Compressible ranges` / `Delegate usage` | ⏸ 暂不实现 | 上游有但依赖 `billion-context-kit`（`viableRanges`/delegate 三件套）；移植版无此依赖，ranges 由 nudge 范围表承载（`src/nudge.ts`）。列入 §9 后续项 |

### 4.5 工具描述

`src/prompts.ts:212` 描述更新为上游对齐（与上游 status-tool `description` 一致）：

```
Context status: overview, compressed blocks, or uncompressed ranges/messages.
No args = overview + totals + compressible ranges.
scope:'uncompressed' + view:'messages' for per-message listing.
scope:'compressed' for block drilldown.
```

（若 §4.4 的 scope 钻取暂不实现，描述删去 scope 两行，见 §9。）

## 5. 关键决策与理由

| # | 决策 | 理由 |
|---|---|---|
| D1 | 模型工具删窗口行，`/acp` 保留 | 对齐上游"模型无窗口、人类有窗口"的双路径；窗口仍是人类排查手段 |
| D2 | 用 kernel `buildStatusReport` 而非自研 | 上游 status-tool 即此职责划分；百分比"占可见总量"、块列表格式、Tip 行全部逐字复用；kernel 升级自动跟随 |
| D3 | nudge 行直接用 kernel reason | `buildNudge` 已走 `env.kernel.processTurn`（`nudge.ts:133`）；reason 字符串（`max compressible ... < threshold ...`）由 kernel 生成，零手抄 |
| D4 | `byRaw` 自映射而非分配真实 mNNNNN ref（且**排除 checkpoint 节点**，P1-3） | overview 不显示 ref（§3.3.4）；分配真实 ref 会与 DSH seq 语义冲突、无收益；排除 checkpoint 杜绝摘要双重计数 |
| D5 | 保留 `Surface: seqs` 行 | DSH 压缩锚点是 seq（`compress({ startSeq, endSeq })`），删掉模型无法定位范围；上游 ref 语义不适用 |
| D6 | `session` 头仅 `/acp` 保留 | 上游模型工具无头；人类命令保留便于多会话排查 |
| D7 | Tip 行逐字保留（不裁剪） | 对齐优先；裁剪会造成与上游字节级偏差，且 kernel 升级可能调整该行文案 |

## 6. 接线改动（逐文件）

1. **`src/tools.ts`** `handleStatus`（441-464）：
   - **不新增 adapter**：`state` 用 `env.store.stateFor(session)`（或 `rebuildKernelBlocks`，§4.2）；`messages` 用 `surfaceEventsOf(session)` 过滤 `source.plugin === 'compact'` 后 `eventsToCoreMessages`（P1-3）；
   - 调 `env.kernel.processTurn`（`tokenCount` = `resolveTokenCount(agent, surfaceMessages)`，P2-2）取原始 `turn.nudge`——**不能**用 `buildNudge`（`shouldInject=false` 时返回 null，拿不到 idle reason）；
   - **不持久化** turn.state（P2-2）；渲染 `buildStatusReport(state, messages, defaultCountTokens, {})` + `Nudge: ${...} — ${turn.nudge.reason}` 行 + `Surface:` 行；
   - 删除窗口/总量行；同步更新工具描述导入。
2. **`src/commands.ts`** `statusText`（23-45）：**不动**（保留现状窗口格式）。可选：仅抽"ledger→块列表行"小片段供两处复用（P2-4，低优先级）。
3. **`src/prompts.ts`**：更新 `tools.acpStatus` 描述（§4.5）。
4. **`src/region.ts`**（P2-1，推荐）：`compaction/summary` 事件与 `AcpBlockLedgerEntry` 增记 `topic`（`runCompactionTransaction` 已接收 `input.topic`；`handleCompress` 已传 topic，`tools.ts:90,110,127`）。否则块行恒显 `(no topic)`。若本 PR 不做，§4.1 示例的 `"topic"` 改为 `"(no topic)"` 并在 CHANGELOG 记偏差。
5. **`src/nudge.ts`**（可选）：抽出 `runKernelTurn(session)` 共享函数供 `buildNudge` 与 `handleStatus` 复用，避免两次 `processTurn` 各算一遍（低优先级，非本 PR 必需）。
6. **`src/window.ts`**：**不动**（窗口仍用于 nudge 决策与 `/acp`）。
7. **`src/index.ts`**：`DEFAULT_CONFIG` 阈值（0.70/0.85）不动（nudge 决策语义与 acp_status 展示解耦）。

## 7. 与既有设计的一致性

- **kernel 文案复用**：与 `configurable-prompts-design.md` R1（默认 nudge 走 `renderNudgeText`）同一模式——本 PR 把同一原则扩展到 acp_status。kernel 升级提示词/格式，引擎零改动（用户明确要求的方向）。
- **seq 是 ref**：与 AGENTS.md 设计决策 2（seq 是压缩锚点）一致；`Surface` 行是移植版对 DSH 的适配，不破坏上游字节基准（上游无此行，属新增扩展行）。
- **测试 fixture 原则**：新增测试沿用真实 DSH 结构（§8），遵循 AGENTS.md 硬性规则 5。

## 8. 测试计划

### 8.1 更新既有断言

- `tests/tools.test.ts:173-195`（`acp_status reports the block ledger and pressure`）：
  - 删除 `context window: 128000 (configured)`、`estimated context:` 断言；
  - 新增 `CONTEXT BREAKDOWN` / `COMPRESSED BLOCKS` / `Nudge:` / `Surface:` 断言（空会话 + 压缩后各一）；
- `tests/tools.test.ts:197-212`（`shows the auto-detected context window and source`）：**重写**——窗口探测仍有效（`/acp` 路径），但模型工具不再展示窗口；改为断言模型工具输出**不含** `context window`/`estimated context`，且 `/acp`（`statusText`）仍含。
- `tests/window.test.ts`：不动。

### 8.2 新增回归

1. **kernel 渲染回归**：空会话 → 输出含 `CONTEXT BREAKDOWN`、`No compressed blocks.`、`Nudge: idle —`、`Surface:`；不含 `estimated context`/`context window`。
2. **压缩后回归**：压缩 1 块后 → `COMPRESSED BLOCKS — 1 active`、块行 `bN (T1) X→Y N msgs "topic"`（若 P2-1 topic 未落地则为 `"(no topic)"`）、`Surface` 节点数 = 12 - 5 + 1 = 8（沿用现有 `surface: 8 nodes` 断言语义）。
3. **idle/ACTIVE 双态**（P2-5 补强）：`shouldInject` 需同时满足 **usage ≥ 阈值** 且 **有 ≥ `minCompressRange`（默认 5000 字符）的可压缩内容**，否则 reason 落 "nudge suppressed ... below minCompressRange" 仍是 idle。构造法：**小 `modelContextLimit`（如 500）+ 长文本 session**（每条 ≈900 token）确定性触发 pressure 分支，断言 `Nudge: ACTIVE —` 前缀及具体 reason 子串；对照组用正常 window + 短会话断言 `Nudge: idle —`。
4. **checkpoint 排除回归（P1-3）**：压缩 1 块后，断言 `CONTEXT BREAKDOWN` 的 `text` 计数**不含**摘要 token（可断言 `summaries` 段的数值与 `block.summary` 的 `defaultCountTokens` 一致、且 `text` 未重复计入——即 `text + tool + summaries` 的总量等于排除 checkpoint 后的 surface 估算）。
5. **字节基准快照**：对固定 fixture 断言完整输出文本（逐字），防格式漂移。注：快照随 kernel 升级而更新（`AGENTS.md` §4b 第 4 步已覆盖此代价）。

### 8.3 验收

`npm run typecheck && npm test && npm run build` 全绿；§8.2 新增测试数 ≥ 4（实际 +9：bN decompress、畸形输入、碰撞优先级、blockIdOfKernelRef 单元、合成交叉断言、ACTIVE 双态、checkpoint 排除、surfaceSummary min..max、prompt 防混淆文案）；README/INSTALL/AGENTS.md 同步（§10）。

## 9. 未决项与后续

- **`Compressible ranges` / `Delegate usage`**：上游有，但依赖 `billion-context-kit`（`viableRanges`）与 delegate 三件套。移植版无此依赖；当前 ranges 信息由 nudge 范围表（`src/nudge.ts`）承载。**本 PR 不做**，记为后续项：引入 `billion-context-kit` 后补齐。
- **scope 钻取**：上游支持 `scope:'compressed'/'uncompressed'` 钻取。本 PR 模型工具仅无参 overview；如需钻取，参数 schema 与 `buildStatusReport` 的 `StatusReportOptions` 直通（kernel 已支持），后续加。**预警（P2-3）**：启用钻取前需重新评估 ref 值——`renderUncompressedRanges`/`renderMessageDrilldown` 用 `/\d+/` 解析并做连续编号合并，`byRaw` 自映射的 seq 纯数值碰巧可用，但 `seq#callId` 会被截成裸 seq 显示，语义漂移；若启用钻取应改为向 kernel 提供真实递增 ref 或另写钻取渲染。
- **Tip 行**：D7 决定逐字保留；若评审认为暴露内部函数名不可接受，可后续裁剪（记入 CHANGELOG 的偏差说明）。

## 9b. 双 id 空间：acp_status 显示 `bN`，decompress 接受 `bN` 与 compaction id（后续实现，已评审）

**问题**：`buildStatusReport` 的 `COMPRESSED BLOCKS` 块行渲染的是 kernel 块 ref（`b1 (T1) …`），而 `decompress`/`search_context` 原本只接受 compaction UUID（`aa463345-…`）前缀——模型看到 `b1` 调 `decompress({ blockId: 'b1' })` 会 "not found"，模型可见 id 与可用 id 脱节（上游 pi 自洽：块 id 就是 `bN`，`decompress b3` 直接可用）。

**决策（选项 1，优于选项 2）**：让 `decompress`/`/acp decompress` 接受**双 id 空间**——先精确匹配 `bN`（`/^b\d+$/` 锚定，经新增 `blockIdOfKernelRef`（`src/region.ts`）解析为 compaction id），再回退 compaction-id 前缀匹配（search_context 返回的 UUID 继续可用）。**不**在 `handleStatus` 里把 `bN` 文本替换为 UUID（选项 2）——那需要解析 kernel 渲染输出（对 kernel 文案/格式升级脆弱）、无法覆盖 nudge/tier 文本里的 `bN`、且违反硬性规则 9。

**kernel 兼容性论证（子代理评审确认）**：`blockIdOfKernelRef` 只依赖**自有数据层**（持久化 `kernelBlockId` 字段 + `blockRegistry` 合成逻辑，`region.ts:762-795`），不解析 `buildStatusReport` 文本。kernel 升级改渲染文案/块 id 来源时本方案无感；仅对 §4b 已列出的 "ref assignment 格式" 热区敏感，现有测试网兜底。`rebuildKernelBlocks`（`state.ts:25-85`）与 `blockRegistry` 的 `bN` 合成为同一逻辑——已加**交叉断言测试**（P1-2）防止两处漂移导致同类 id 脱节复发。

**实现要点**：
- `blockIdOfKernelRef(session, bN): string | null`——精确 `bN` → compaction id；非 `bN` 形态返回 null（调用方回退前缀匹配）；
- `resolveBlockId`（`src/tools.ts`）先 `blockIdOfKernelRef` 后前缀匹配；`/acp decompress`（`src/commands.ts`）同逻辑（P1-1）；
- 畸形输入（`b0`/`b01`/`B1`/`b1 `）不归一化，一律 "not found"（P2-6）；
- 碰撞优先级：`/^b\d+$/` 带 `$` 锚定，UUID 前缀（含 hex）不可能匹配，先 `bN` 后前缀无歧义（P2-5，测试固化）；
- `search_context` 保持返回 compaction id（`decompress` 接受前缀，闭环成立）（P2-3）；
- 工具描述更新：`decompressParameters.blockId`（`tools.ts`）、`prompts.ts` 工具描述与 system prompt 的 `decompress({ blockId })` 行（P2-7）。

## 10. 文档同步清单（本 PR 必须完成）

- `README.md:133/152/173`（工具表、acp_status 描述、`autoModelContextLimit` 行——"`acp_status` 展示窗口来源"改为"`/acp` 展示窗口来源"）；
- `README.en.md` 对应行（132/151/172）；
- `docs/INSTALL.md:135`（验证步骤 2："返回块数、压缩 token、估计上下文占用" → "返回 CONTEXT BREAKDOWN、压缩块列表、nudge 状态"）；
- `docs/README.md`（发布说明 + 模块图 `tools.ts` 描述）；
- `AGENTS.md`（模块图 M3 描述 + 硬性规则新增：**acp_status 必须复用 kernel `buildStatusReport`，禁止在引擎侧复制 breakdown 格式**；更新 INSTALL 验证口径）；
- `README`/`README.en` 工具表的 `decompress` 参数说明（接受 `bN` 或 compaction id，§9b）。

## 11. 版本与提交

- 行为变更（模型工具输出结构）→ **minor**：`npm version minor --no-git-tag-version`；
- 提交信息：`(feat) align acp_status with upstream — reuse kernel buildStatusReport, drop window rows from the model tool`（PR 标题即 squash 主题，遵循 AGENTS.md §4）；
- PR 合并且由人类执行（AGENTS.md §5）。
