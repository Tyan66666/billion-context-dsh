# DSH 移植验证报告与可行路径

> 本文档是移植前验证的完整记录：每一项论断都有源码/运行证据，最后给出经过验证的可行路径。前置背景见 [dsh-porting-analysis.md](dsh-porting-analysis.md)。

## 第一部分：验证结果

### V1. acp-kernel 可独立运行 ✅

在 Node 22 下用项目自带 `node_modules/acp-kernel` 直接运行完整生命周期（`/tmp/acp-engine-probe*.mjs` 系列探针）：

| 阶段 | 结果 |
| --- | --- |
| `defaultConfig(limit)` 生成合法配置 | ✅ |
| `processTurn` 分配 ref 标签（`<acp tokens="15" type="text">m00001</acp-prune>`） | ✅ |
| 紧急 nudge 决策（usage ≥80% 注入） | ✅ |
| `applyCompression` 建块（12 条消息压 5 条 → `blocksCreated:1, tokensCompressed:7255`） | ✅ |
| 下一轮 `processTurn` 剪掉被覆盖消息（12 → 9 条，块活跃） | ✅ |
| `decompress('b1')` 恢复块（含 summary） | ✅ |
| `searchBlocks(docs, query, {limit})`（blockDocs + messageDocs 组合检索） | ✅ |

证据要点：`compress`/`decompress`/`search`/`status` 等 API 全部 `export`（`dist/index.d.ts` 第 1–30 行），`CompressionCore` 接口（`processTurn`/`applyCompression`/`decompress`/`search`/`status`）是完整的纯函数内核，**无 host 依赖，可直接原样复用**。

### V2. CompactionEngine seam 契约 ✅

`packages/compaction/compaction/src/index.ts` 逐一核验：

- `abstract class CompactionEngine extends Service`，构造 `super(ctx, 'compaction')`，默认导出类本身（与 compaction-basic 相同的插件形态）。
- 3 个抽象方法：`compactIfNeeded(agent, trigger, signal)`、`compactNow(agent, signal, sourceCommandId?)`、`compactRegion(start, end, agent, signal?)`。
- `CompactionAgentContext = { session, options: {provider?, model?} }` —— 只需要 session + 路由信息，**不依赖 agent 包**。
- 配套导出：`CompactionResult`、`CompactionId`、`toolPairingBalancedBefore/After`（范围边界 tool-call/result 配对校验）、`compactCheckpointSource`/`isCompactCheckpointSource`（checkpoint 消息溯源）、`ManualCompactionError`（6 类预期失败码）。
- seam 文档明确："A tokenizer- or template-based backend is a sibling package implementing the same interface"——**ACP 后端就是设计预期内的 sibling backend**。

### V3. 工具/命令/搜索 API ✅

- 模型工具：`ctx.tools.register(ToolDefinition)`（`packages/core/tools/src/index.ts:1037`），`ToolDefinition` 含 `output`、`execute(args, exec)`、`finalizeContent?`、`timeoutMs?`、`isConcurrencySafe?`。
- 命令：`ctx.commands.register(CommandDefinition)`（`packages/interaction/commands/src/index.ts:245`），`command-compact` 是 `/compact` 的现成参考。
- 搜索：`ctx.sessionQuery.searchEvents(request, exec)` / `searchSessions`（`packages/session-query/session-query/src/index.ts:113-124`），SQLite 后端 `openAt: 'never' | 'first-search' | 'startup'`（默认 `never`，需在组合中改为 `first-search` 才启用全文搜索）——能力已验证但**本引擎未采用**（见 D6：改用 acp-kernel `searchBlocks`，无 opt-in 依赖）。
- 状态持久化备选：web 组合里有 `ctx.storage`（`dsh-storage-json`，root `$DSH_HOME/storages`）。

### V4. 不存在"内存改写"钩子（最关键的负向验证）✅

穷举了 DSH 全部可能的改写点，结论是**有意为之、无路可绕**：

- `agent/pre-step` waterfall：只能 `reject` 或替换 **inbox 注入消息**（会被 append 成 `user/message` 事件），不能改写已派生的历史消息数组（`packages/core/agent/src/runtime-types.ts:53-55,231`）。
- `agent/request` waterfall：JSDoc 明写 "Model-visible content must use logged channels; this waterfall cannot mutate messages"（同上 :244）。
- `session.deriveMessages()`：纯投影，`surface.ts` 与 `index.ts:726` 确认无变换钩子、结果 deep-frozen。
- `llm/stream` waterfall（`packages/llm/llm/src/index.ts:64`）：唯一能碰到完整请求的地方，但 loop 构建的请求 `markAgentLoopRequest` **deep-frozen**，注释明写 "listeners read it, never rewrite it"——这是 reconstructability 原则（请求内容必须是会话日志的纯函数）。
- `session.append` 会校验/冻结一切数据，改不了历史。

**结论：DSH 不存在（也不允许）Pi `context` 事件式的"内存改写消息再发"。** 移植必须接受 durable-surface 模型。

### V5. decompress 可行性 ✅

- `session.events` 暴露完整 append-only 日志（deep-frozen，`index.ts:559`），`surface.ts` 明写 replace 只"遮蔽"：**"The model-visible surface deliberately shadows replaced ranges… durable source material; replacement copies stay model-only"**——被压缩的原始事件永远留在日志里。
- 因此 DSH 原生实现 decompress = 读取日志中的原始事件 → 用 `surfaceOp: {op:'replace'}` 把 checkpoint 节点替换回原文。不需要 Pi 式的旁车状态。
- 附带收益：整个会话（含被压缩历史）天然可回放、可导出、可被 session-query 精确读取。

### V6. 新包构建/挂载机制 ✅

- 叶子包约定（以 `command-compact` 为标本）：`@deepseek-ai/dsh-*`，`exports` map（`.` → `lib/index.js` + `lib/types/index.d.ts`，另有 `./invariant`、`./src/*` 子路径），peerDeps 用 `workspace:^`，构建为 `tsc -b` + `tsdown`（`build:lib:host`）。
- 挂载：组合行按包名引用（如 `name: '@deepseek-ai/dsh-compaction-basic'`）；preset 的 agent 平面行必须放在 `isolate` realm（`cordis:group` + `isolate: {compaction: true, ...}`），否则 root realm 服务冲突会被 `dsh-agent-presets` 拒绝挂载。
- 本机部署：`~/.dsh/profiles/node_modules/@deepseek-ai/*` 是**指向 checkout workspace 的符号链接**，新 workspace 包 `pnpm install` 后即被组合行解析，无需重建 profile。

### V7. 挂载探针（端到端最小原型）✅

在真实 Cordis 环境验证了 sibling backend 的完整链路（`/tmp/acp-engine-probe4.mjs`，成功输出）：

```
constructor running
ctx.compaction instanceof CompactionEngine: true
is AcpEngineProbe: true
kernel present: true
compactIfNeeded -> null
PROBE OK
```

即：`class AcpEngineProbe extends CompactionEngine`（内含 acp-kernel `createCore`）→ `ctx.plugin(AcpEngineProbe)` → `ctx.compaction` 解析为本实例 → 方法可调用。**"ACP 作为 CompactionEngine 后端"在运行时已被证明可行**，探针本身就是一个最小原型骨架。

## 第二部分：验证中发现的关键架构事实

1. **region 事务不在 seam 里**：durable 替换事务（`compactSurfaceRegion`，~400 行：范围校验 → `compaction/start` 锁 → 摘要 → `compaction/summary` + `user/message` replace → `compaction/end`）实现在 `compaction-basic/src/region.ts` 内部且**未导出**。ACP 后端要复用事务机制只有两条路：自带一份（按同一模式重写，源码可见可照抄），或把事务机制**上游化到 seam 包**（更符合 seam 哲学：seam 拥有事务、后端拥有策略，是一个干净的小型 DSH 贡献）。
2. **自动触发的接缝**与 compaction-basic 相同：`agent/pre-step`（pressure）与 `agent/request-error`（context-overflow 恢复，`CONTEXT_WINDOW_EXCEEDED_CODE`）。**现状（采用 PR #153 后）**：压力侧**故意不照抄**——`agent/pre-step` 只注入 nudge，压缩与否由模型决定（设计决策 3）；超窗半侧已实现——`agent/request-error` 确认 `CONTEXT_WINDOW_EXCEEDED_CODE` → 引擎自写 marker 摘要做一次紧急隐藏 → `{kind:'retry'}`，预算 `maxOverflowRetries`（默认 1）。没有这个监听器时错误被原样重抛、没有重试。详见 docs/overflow-recovery-design.md。
3. **checkpoint 溯源协议已就绪**：任何后端的替换消息都必须用 `compactCheckpointSource(compactionId)` 标记，`isCompactCheckpointSource` 识别——ACP 的"块摘要节点"可直接复用这个协议（块 id 作为消息内容的一部分，`compactionId` 作为事务标识）。
4. **seq 即 ref** 的数据基础存在：`session.surface.nodes` 给出有序 seq 列表，模型侧引用可用 seq 范围（由 nudge/注入消息携带映射表），无需给历史消息打内存标签。
5. **配置文件路径**：web 组合 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml` 挂载 `agent-presets`（default: standard）；preset 本体在 `apps/cli/config/agent-presets/standard/`；host 平面行在 `dsh-base/cordis.patch.yml`。

## 第三部分：可行路径（经过验证）

### 总体方案：ACP 作为新的 CompactionEngine 后端

```
新包 @deepseek-ai/dsh-compaction-acp（或独立 npm 包 billion-context-pi-dsh）
  ├── AcpCompactionEngine extends CompactionEngine   ← V7 已验证可挂载
  │     ├── acp-kernel CompressionCore（复用，V1 已验证）
  │     ├── agent/pre-step（pressure）+ agent/request-error（overflow）监听
  │     └── 自带/上游化 region 事务（V2 架构事实 1）
  ├── 4 个模型工具：compress / decompress / search_context / acp_status（V3）
  ├── /acp-prune 命令（V3）
  └── ACP 块状态持久化（日志事件 或 ctx.storage，V3/V5）
```

### 组合接入（两处改动）

1. **host 组合**（`dsh-base` 或部署层 patch）：加一行 `- id: compaction-acp: name: '@deepseek-ai/dsh-compaction-acp'`（在 host 平面提供 `ctx.compaction`）。
2. **preset**（新建 `acp` preset 或改 `standard`）：`compaction` isolate realm 里把 `compaction-basic` 换成 ACP 后端行；`session-query-sqlite` 的 `openAt` 改为 `first-search`（启用 search_context 的全文索引）。

### 关键设计决策（每项都有验证依据）

| # | 决策 | 验证依据 |
| --- | --- | --- |
| D1 | **ref 机制**：放弃内存打 `<acp>` 标签，改用"seq 即 ref"，nudge/注入消息携带 seq→内容映射表 | V4：无内存改写钩子；V2 架构事实 4 |
| D2 | **压缩落地**：模型 `compress` 工具 → durable `surfaceOp: {op:'replace'}` 遮蔽范围，摘要 = 模型写的 summary（正是 ACP 省 token 的卖点，无需二次 LLM 摘要调用） | V2、V5 |
| D3 | **decompress**：读取日志原始事件，replace 回原文 | V5 |
| D4 | **自动触发**：`agent/pre-step` + `agent/request-error`，与 compaction-basic 相同（压力侧只 nudge、不自动摘要；超窗侧已实现：引擎写 marker 摘要做一次紧急隐藏并让宿主重试，预算 `maxOverflowRetries`，PR #153） | V2 架构事实 2；docs/overflow-recovery-design.md |
| D5 | **块状态**：ACP block 状态写成会话日志事件（如 `acp/block`，回放/checkpoint 免费）或 `ctx.storage` key | V5、V3 |
| D6 | **搜索**：`search_context` 从日志重建统一文档集（块摘要 + 被遮蔽的原始消息），交给 acp-kernel `searchBlocks`（默认 hybrid：BM25 词干化 + CJK bigram + 字符 n-gram 模糊）；**信任内核**——引擎不设无命中闸门/阈值（曾有一版 BM25 闸门过滤 fuzzy 假阳性，实测误杀 6/46 条同义词与词干化查询，违反"算法归内核"原则后移除），评分直接呈现，弱命中（fuzzy 兜底分 ≈0.3 上下）由模型凭分数判断；消息命中回链最内层所属块 | V3、V1 |
| D7 | **nudge**：pre-step 注入（现有注入通道，会成为日志中的 `user/message`） | V4 中 pre-step 语义 |
| D8 | **delegate 工具**：直接映射 DSH 现有 subagent/jobs 体系，不移植 Pi 专用实现 | 组合现状 |

### 里程碑（每步可独立验证）

| 里程碑 | 内容 | 验证方式 |
| --- | --- | --- |
| M0 | 包骨架 + seam 挂载 | **已完成（V7 探针即原型）** |
| M1 | 消息适配层：Session 事件 ↔ acp-kernel CoreMessage（user/assistant/tool-call/tool-result 投影，参考 `src/messages.ts` 的 `entriesToCoreMessages`/`projectMessage`） | 单测 + 日志回放 |
| M2 | 块状态持久化（日志事件 schema + load/merge） | 单测（重启恢复） |
| M3 | 4 个模型工具（工具 schema 用 typebox/schemastery，参考 `src/compress-tool.ts`） | 工具级单测 |
| M4 | nudge 注入 + seq-as-ref 范围表 + `/acp-prune` 命令 | 注入消息单测 |
| M5 | region 事务 + 自动触发（pressure/overflow） | 端到端（压到阈值触发） |
| M6 | 组合接入 + preset + 搜索开启 + 全量测试（复用 acp-kernel 45 测 + DSH 测试工具） | 集成测试 |

### 建议的下一步（最小闭环）

1. 从 V7 探针出发，在 DSH 仓库新建 `packages/compaction/compaction-acp/` 包骨架（package.json/exports/tsconfig 照 `command-compact` 抄）。
2. 先实现 M1 消息适配层 + M3 的 `compress` 工具（不接自动触发），用一个真实会话验证"模型调用 compress → durable 替换 → 上下文变小"闭环。
3. 若接受"事务机制上游化"这个小型 DSH 贡献，先提一个把 `compactSurfaceRegion` 事务从 compaction-basic 移到 seam 的 PR（纯重构、行为不变），ACP 后端即可复用，避免 400 行重复实现。
4. 拒绝路径 B（核心加内存改写钩子）：与 reconstructability 原则冲突，需要 DSH 维护者拍板，作为非阻塞的独立讨论。

---

## 附录：v0.1.1 实战——长会话排障报告

在真实部署（DSH web profile + `acp` preset，Rectangle 项目的一个长会话）中验证时，压缩闭环暴露了 6 个问题，全部在 v0.1.1 修复（[Release v0.1.1](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.1)）：

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | `acp_status` 显示 `tokens compressed: 0`（多个大块） | 写事务时 `shadowedTokenCount` 写死 0 | 压缩时按实际遮蔽消息估算并写入账本 |
| 2 | nudge 显示 `230%` 荒谬占用 | 用了 token-meter 的 `totalTokens`（请求+响应压力，含响应预估） | 改用 `surfaceTokens`（纯输入侧），显示 cap 100% |
| 3 | 估算对中文失准 | 用了 `estimateTokensFast`（纯 4 字符/token） | 改用 acp-kernel 的 `defaultCountTokens`（CJK 1 字符/token + 其他 4 字符/token，与 billion-context-pi 一致）——**后续演进（issue #54 / AGENTS.md 规则 12）**：`defaultCountTokens` 仅限内部估算与展示（nudge 百分比、账本、压缩结果文案）；写入宿主事件的 `shadowedTokenCount` 必须用宿主扁平 4 字符/token 词汇（`ctx.tokenMeter.measure` 优先，`src/host-tokens.ts` 镜像兜底）——中文密集会话曾因用 `defaultCountTokens` 计价 claim 被宿主账本扣穿而永久卡死（见 docs/shadow-price-host-vocabulary-design.md） |
| 4 | 压缩单条工具结果报 `no tool-pairing-balanced range` | `resolveSurfaceRange` 只向内收缩，单条 tool 消息收缩到空 | 收缩失败时**向外扩展到最小完整配对**（单条结果自动带上其调用） |
| 5 | 模型说"压无可压"（大工具结果在范围表隐形） | kernel 的 ref 映射在长会话压缩后漂移，`compressibleRanges` 漏掉大段 | nudge 范围表改为**从 surface 自算**（跳过保护区 + 摘要节点，边界配对平衡）——**后续演进（issue #122）**：该自算是临时绕行（`UPSTREAM:` workaround，追踪于 issue #38）。上游按数组邻接重写了分段（acp-kernel#207 → PR #209，v0.0.59 发布），本仓库 pin 升到 0.0.63 后**删除自算逻辑**，几何改回 kernel `compressibleRanges`，只保留宿主守卫（AGENTS.md 规则 3） |
| 6 | 旧块 `tokens compressed` 仍为 0 | 修复前写入的块没有 token 数据 | 账本重建时对 0 值**从日志原文补算** |
| 7 | 官方 API 在 compress 后下一请求 400（摘要插在 compress call 与 result 之间） | `compress` 工具在 turn 中途执行，摘要 `user/message` 先于当前 `tool/result` 落库；且 `session.append` **不可重入**——在 `session/event` 监听内同步 append 会抛 "session append cannot reenter" 并被 dispatcher 静默吞掉 | `session/event` 监听把隐藏推迟到**微任务**（`deferCompressPairHide`，在下一个请求构建前落库），把该 call/result 对整体替换为普通 user 消息（保留结果文本）；只隐藏**单 call 节点**（多 call 节点隐藏会孤儿化兄弟结果，留作可见对——当前 harness 按 surface 位置序序列化，本就安全） |
| 8 | nudge 范围表只剩 ~28 tokens / 大段 compress 被 `no tool-pairing-balanced` 拒绝 | 孤儿工具消息（无配对 result 的 call、无配对 call 的 result）破坏配对平衡缓存或打碎大段；老版本 bug 还在 call 与 result 之间插入摘要形成死锁 "broken pair" | 范围求解前自动剥离孤儿（`compaction/prune` + 替换节点；0.1.5 前为不可见的空 assistant 节点，dsh-session ≥0.1.5 禁止 assistant 携带 `sourceEventSeqs`，改为可见的 `PRUNE_NOTE` user 消息——issue #136）：`agent/pre-step` **无条件执行**（低压力会话也不被崩溃孤儿 400）+ `buildCompressibleSeqRanges` + `handleCompress` 顶部；剥离覆盖孤儿 result、全孤儿 call 节点、以及 call→非工具节点→result 的 broken pair（自动治愈遗留死锁会话）；`handleCompress` 保护当前 step **全部 in-flight call**（`openToolCallIds`），兄弟工具不会被误剪 |
| 9 | 批量 compress 中单个 kernel 拒绝的范围拖垮整个调用（成功块被丢弃） | kernel 对"已被活动块 `effectiveMessageIds` 吸收但仍存活于 surface"的范围抛 `Range contains no compressible messages`；旧代码对任一 error 即整体返回失败并丢弃 `applied.state` | 仅当 `blocksCreated === 0` 才整体失败；否则照常落账成功块，失败范围作为 advisory 行报告（phantom range 不再毒化批次） |
| 10 | nudge 范围表与 kernel 几何长期脱钩（issue #38 / #122） | kernel `compressibleRanges` 曾按 ref 算术分段：surface 替换后 checkpoint 节点带着更大 ref 落在数组中段，区间乱序（`end < start`）、大工具结果丢 ref | 上游改按**数组邻接**分段（acp-kernel#207 → PR #209，v0.0.59 发布）；本 PR 把 pin 由 `0.0.29` 升到 `0.0.63`，`src/region.ts` 的 `buildCompressibleSeqRanges(session, kernelView, opts)` 只做内核做不到的两件事——ref→surface seq 翻译 + 宿主守卫（指令行屏障 / 检查点 / 系统节点 / 最近尾与真实 user 保护）；新增 `tests/kernel-range-source.test.ts`（真实 kernel：refs→live seqs、被遮蔽范围不回流、中段压缩无空洞、指令行仍是屏障；变异验证：删屏障或改回 ref 算术都会让测试变红）；e2e harness 同步放大 fixture（`count: 110`→`250`）以越过内核 0.0.63 的 nudge 收益下限（`minPressureBenefitTokens = max(5000, 1% × window)` + `minCompressRange = 5000 chars`，否则 nudge 被静默抑制、e2e 假红；见 docs/e2e-harness-design.md 约束 9） |
| 11 | 截图会话里图片区间在范围表显示 ~0 token；图片-only 的 user 消息没有 ref，最后一条提问可能被压掉 | `image` / `file` 块没有字符，`extractText` 静默丢弃 → 该消息在内核视图里不存在（无 ref、非边界、内核的"最近尾 + 最近 user"保护看不到它），且所有文本估算器把它按 0 token 计价 | 投影层为图片/文件块生成确定性占位符（`[image …]` / `[file …]`，照抄宿主对文件的 handle 文本投影：dsh-llm `FileBlock` docblock "request assembly projects every occurrence to deterministic handle text"）；媒体价格读宿主 token-meter 节点的两个真实价格之差（`tokens − heuristicTokens` = 路由多收的部分；该节点不暴露任何 `*StructuralTokens` 字段）并叠加宿主的固定结构价镜像（`hostMediaStructuralPrice`，对应 `estimateStructuralBlock`），范围行标注 `[+N images \| +M files]`；`acp_status` 在含媒体时补一行两套标尺说明（issue #117，AGENTS.md 规则 19、docs/media-visibility-design.md） |

**实机验证数据**（修复后；acp_status 自 v0.2.2 起为上游对齐格式——CONTEXT BREAKDOWN 占可见总量、无窗口行，见 docs/acp-status-align-design.md）：

```
compress({ startSeq: 64757, endSeq: 265056, ... })
→ Compressed 1 block(s), ~139200 tokens reclaimed. block 9458eab3, 583 messages shadowed
→ acp_status: CONTEXT BREAKDOWN ... | COMPRESSED BLOCKS — 16 active ... | Nudge: idle/ACTIVE — reason
```

一次压缩回收 **~13.9 万 tokens**，模型自述"当前摘要块里完整保留了所有关键信息（提交历史、代码架构、mask 编码、本地化、测试命令、点击问题结论），后续任何需求都能无缝接续"——ACP 闭环在真实长会话中完整走通。

**issue #18 修复实机验证**（2026-08-17，v0.2.1，PR #21 `c1d4045`，DSH web profile 符号链接直连 worktree 构建，重启加载）：

- **deferred pair-hide 落库序列**（逐事件核对会话日志）：`assistant/message(compress 调用) → tool/result 落地 → compaction/prune shadowedSeqs=[callSeq,resultSeq] → user/message surfaceOp replace（携带 compress 结果文本，sourceEventSeqs=[callSeq,resultSeq]）`——隐藏发生在 `tool/result` 之后的微任务（修复 A：`deferCompressPairHide`），监听内不再同步 append；compress 后每一轮请求正常，无 400。
- **nudge 范围表恢复真实数字**：把 profile `cordis.patch.yml` 的 `nudgeMaxContextLimitPct` 临时调低到 0.03（配 `nudgeMinContextLimitPct: 0.02`），nudge 在 ~5% 压力下于下一 pre-step 立即触发（证明 profile 补丁被 HMR 热重载、无需重启；重启后 growth 基线清零，只有阈值降低能触发）。范围表显示真实大小：
  `Surface: 143 nodes, seqs 82609..204994; ranges: seq 143804..196596 — 111 messages, ~37634 tokens; seq 197852..203758 — 21 messages, ~5018 tokens`
  ——issue #18 的 "~28 tokens" 死值消失（修复 8 的 `buildCompressibleSeqRanges` 实机输出真实范围）；大范围把旧 compress 对（surface 相邻健康对）正常纳入，不再整段 reject。测完已恢复 `0.5`。

**关键教训（2026-09 修订，issue #122）**：`acp-kernel` 的 ref 映射曾在**经过 surface 替换（压缩）的超长会话**中漂移（范围表出现 `end < start` 的乱序段、大工具结果拿不到 ref）。当时的兜底是宿主自算，但那是**临时绕行**（`UPSTREAM:` 注释 + issue #38 追踪），不是架构；上游随后按数组邻接重写分段（acp-kernel#207 → PR #209，v0.0.59 发布），本仓库 pin 升到 0.0.63 后删除自算、几何回归内核。移植中最值得记住的一课因此是**规则 7/11 的闭环**：内核缺陷走上游（issue → PR → bump pin → 删绕行），而不是在宿主里长出第二套算法。

> **`UPSTREAM:` workaround 追踪（AGENTS.md design decision 7 / rule 11）**——上述"从 surface 自算范围表"（`buildCompressibleSeqRanges`）是对 kernel ref-map 漂移缺陷的**临时宿主侧绕行**，不是长期架构。按 rule 11，该缺陷的最终修复属于上游 acp-kernel（issue + PR）；**每次 kernel bump 时检查漂移是否已在上游修复，若已修复则删除 `buildCompressibleSeqRanges` 自算逻辑、改回 kernel `compressibleRanges`**（AGENTS.md §4b hot-spot 第 3 条已同步此检查项）。**当前上游状态：已修复并解除（issue #122）**——acp-kernel **#207**（CLOSED 2026-09-07T15:27Z，来源即本项目 issue #38，标题 "Range segmentation assumes refNum order == message array order — surface-replace hosts get end<start ranges + spurious fragmentation"）→ PR **#209**（`fix: segment compressible ranges by array adjacency, not ref arithmetic`）→ 发布 **v0.0.59**；本 PR 把 pin 由 `0.0.29` 升到 **0.0.63**（§4b SOP 热区复核：CJK `defaultCountTokens` 断言、`state.messageRefs` 形状、ref 分配、`CoreMessage`/`NudgeDecision` 类型，加全量 265 测试绿），`src/region.ts` 的 `buildCompressibleSeqRanges(session, kernelView, opts)` 现只做 ref→surface seq 翻译 + 宿主守卫，自算逻辑与 `UPSTREAM:` 注释已删除；docs/upstream-tracker.md 与 issue #38 同步为 `resolved`。回归钉：`tests/kernel-range-source.test.ts`（4 测，真实 kernel + 变异验证）。

> **`UPSTREAM:` 宿主 token-meter 估算器未导出 + 扁平 4 字符/token 低估 CJK（AGENTS.md rule 12 / issues #54 and #103）**——影子价格必须说宿主词汇（`compaction/summary`/`compaction/prune` 的 `shadowedTokenCount`），引擎用 `ctx.tokenMeter.measure(session)` 的 `node.heuristicTokens ?? node.tokens`（宿主自算的**固定启发价**，exact by construction；0.1.2+ 的 `node.tokens` 是路由重定价后的请求压力价——图片路由计价下读它会让含图片区间的 claim 虚报视觉价、扣穿账本，issue #103，0.1.1- 单字段形状的 `tokens` 就是固定启发价），兜底用 `src/host-tokens.ts` 的**镜像**（`estimateHostContent`/`estimateHostMessage`/`hostPriceEvent` 逐行复刻 `@deepseek-ai/dsh-token-meter/lib/types/estimate.js`）。该镜像是对宿主估算器**未从包导出**的临时绕行，且宿主扁平 4 字符/token 本身对 CJK 占用率低估 ~4×（宿主占用率显示偏低的既有问题）。按 rule 11/12：**当 dsh-token-meter 导出 `estimateContent`/`estimateMessage`（或宿主估算器改为 CJK-aware）时，删除镜像，改用导出的估算器并对拍 `meter.estimateMessage`**；L2 上游提议（dsh-token-meter CJK-aware 计价）见 issue #54。当前上游状态：估算器未导出；本项目追踪 issue #54（完整事故档案：session-3aa366c3 卡死、fold 复算、抢救脚本 `scripts/rescue-shadow-price.mjs`）+ issue #103（图片路由重定价通道：`route-pricing.js` `priceSurface` 让 `node.tokens ≠ node.heuristicTokens`，影子价格基准改为固定启发价；机制与测试见 docs/shadow-price-host-vocabulary-design.md §3.1）。

> **`UPSTREAM:` dsh-compaction 工具配对平衡缓存读取已删除的 `session.events`（AGENTS.md rule 11 / issue #124）— 已按移除门解除**——原状：0.1.2 宿主上 `toolPairingBalancedBefore/After` 读已删除的 `session.events` getter（`eventForSeq` 做 `events[seq]`）→ 一切压缩必炸 `TypeError: Cannot read properties of undefined (reading '<seq>')`（含宿主自带 `dsh-compaction-basic`）；引擎曾以本地镜像 `src/tool-pairing.ts` 绕行（算法逐行复刻宿主 `tool-pairing` 模块，事件读取改走跨版本 `eventAtOf`）。**移除（issue #136）**：peer 下限为 `>=0.1.5-alpha.1`（当时上界 `<0.1.6-0`，#190 验证后放宽至 `<0.2.1-0`），且对已发布 tarball 的逐版本核对显示 npm 线上 dsh-compaction ≥0.1.2-rc.1 的这两个 helper 已经由 `eventAt()`/`snapshotEvents()` 读取事件、其依赖的 `surface.replaceGeneration` 亦存在于 dsh-session 0.1.5 —— 宿主 helper 在真实 0.1.5 会话上直接可用（`tests/tool-pairing-host.test.ts`：全节点布尔断言 + `resolveSurfaceRange` E2E + 反转后的 source guard）。本地镜像已删除，`src/region.ts` 恢复 import 宿主 helper。上游状态：**已解决**（完整事故与取证档案保留于 issue #124）。

> **`UPSTREAM:` nudge 正文瘦身（剥离 kernel 哲学/规则段）尚无内核开关（AGENTS.md rule 11 / PR #143）**——`src/nudge.ts` 的 `stripNudgeGuidance` 在**事后**从 kernel `renderNudgeText` 渲染出的正文里摘掉 `COMPRESS_PHILOSOPHY` / `HOW_TO_COMPRESS_RULES` / `TIER2_DISTILL_RULES` / `TIER3_CONDENSE_RULES` 四段（这些文案已住在系统提示与工具描述里；长会话实测 nudge 正文 6.1 KB/次 × 3 = 18.4 KB 重复计费），属宿主侧后处理而非内核能力。按 rule 11：**当 acp-kernel 提供「精简 nudge」选项（渲染期开关或 `renderNudgeText` 的可选参数）时，删除 `stripNudgeGuidance`，改用内核选项**。当前上游状态：内核无此类开关，**尚未向上游开 issue（next step）**；设计记录见 docs/injection-governance-design.md §4（B6）。

> **dsh-session 0.1.5 协议漂移与 peer 下限（issue #136，非绕行——协议决策记录）**——replace surfaceOp 字段在 0.1.5 线改名 `{ op, start, end }` → `{ op, startSeq, endSeq }`，且校验严格为**恰好三键**（≤0.1.3-alpha.2 收旧名、≥0.1.5-alpha.1 收新名，逐版本从已发布 tarball 核实；四键形态两边都拒）→ 双方言共发不可能，引擎单一方言输出 + peer 下限 `>=0.1.5-alpha.1`（当时上界 `<0.1.6-0`，#190 验证 0.1.6/0.1.7/0.2.0 线后放宽至 `<0.2.1-0`；显式区间，caret 会悄悄放进未验证的版本线）。同线两个连带破坏一并处理：① assistant/message 内嵌 provider stream、**禁止携带 `sourceEventSeqs`**（运行时抛错）→ 隐形剪枝节点不复存在，`hideSurfaceSeqs` 改写可见 `PRUNE_NOTE` user 消息，范围表末位 user 保护扫描经 `isPruneTombstone` 跳过占位节点；② 宿主系统提示成为 surface node 0（`system/message`）且受保护（非 system 替换覆盖它即抛 "node 0 holds the system prompt"）→ `isSystemNode` 将其排除出可压缩表与 stale-range 恢复。回归钉：`tests/surfaceop-dialect.test.ts`（真实 0.1.5 会话 E2E：事务成功 + 恰好三键 shape 断言 + 孤儿剥离新方言 + node-0 保护）、`tests/peer-range.test.ts`（整线接受 / 其余版本线全部拒绝）。

> **nudge 上下文 breakdown 口径：全日志 vs 活跃 surface（AGENTS.md rule 2）**——`buildNudge` 为支持 T2/T3 蒸馏锚点，必须把**整个日志**（`allLogMessages`，含已被压缩进 block 的历史消息）喂给 `kernel.processTurn`；kernel 的 `computeContextBreakdown` 对这份消息数组分类加总，于是 nudge 展示带上**历史累积**口径——实测 nudge 报 `85.2K tool`，而 acp_status 报真实活跃 `8.5K tool`，相差约 10 倍。`acp_status` 用 `buildStatusReport` 喂**活跃 surface**（排除 `source.plugin==='compact'` 的 checkpoint 摘要节点——`/acp-prune` status 的 `isCheckpointEvent`），所以它反映当前真实上下文。修复：`src/nudge.ts` 导出 `computeSurfaceBreakdown(state, messages, total, growth)`——分类复刻 kernel（tool-call/tool-result→tool、role system→system、含```→code、否则→text），但 **summaries 直接取 active blocks 的 `block.summary`**（kernel 源码靠消息文本 `[Compressed conversation section]` 前缀识别摘要，而 DSH checkpoint 节点从不带此前缀，故须读 block 而非消息文本）；`buildNudge` 用活跃 surface（排除 checkpoint 节点）调用它覆盖 `nudge.contextBreakdown`。两条渲染路径（kernel `renderNudgeText` + 模板 `renderNudgeFromTemplates`）都读 `nudge.contextBreakdown`，覆盖一次即统一。该字段纯展示、不参与 `shouldInject` 决策，覆盖安全。回归测试 tests/nudge.test.ts（活跃 surface tool < 全日志 tool + block summaries>0；无块形状校验）。测试易踩坑：`compress` 工具的 `resolveSurfaceRange` pass-2 会把相邻 tool 对一并扩展吃掉（`adjusted from 2..3 to balanced edges` 扩到 1..4），若测试要保留 surface tool，须用 `runCompactionTransaction` 直接精确压范围而非走 compress 工具。

> **DSH 0.1.7-alpha.1 seam 核查（issue #163，非绕行——验证记录；peer 区间未放宽）**——0.1.7 在 `@deepseek-ai/dsh-session-persistence-jsonl`（编译自宿主 `session-format-v3-to-v4`）新增 source 编码准入：`kind` 必须为非空字符串且**不等于 `'plugin'`**（谓词注释：refuses retired plugin wrappers），旧 wrapper 形状 `{ kind:'plugin', plugin:'<名>' }` 被整批拒收、滞留内存队列，下一轮报 `format v4 message requires a producer-owned source kind`（受害会话日志戛然而止于 `step/end`，毒行与报错文本不落盘）。已对**已发布 tarball** 逐字核实该谓词（dsh-session-persistence-jsonl@0.1.7-alpha.1 `lib/worker.cjs`）。修复（本 PR）：引擎两处持久化写入改发规范 producer kind（nudge echo `plugin:acp-nudge`、prune/compress-pair tombstone `plugin:billion-context-dsh`——宿主 V3→V4 迁移对未注册插件的规范产出即此形状），读侧经 `sourcePluginOf` 双形状解析（迁移前的旧日志行与迁移后的新行分类一致）；probe 证实 dsh-session 0.1.5-rc.2 会话接受新形状（宽松校验），故无需版本门。回归钉：`tests/v4-source-kind.test.ts`。**放宽 peer 区间前仍待验证（另立 issue 跟踪）**：① checkpoint 读侧——0.1.7 `compactCheckpointSource()` 产出 `{ kind:'compact-checkpoint', compactionId }`，而 `isCheckpointNode` / `summarySeqIndex` 仍按 `source.plugin === 'compact'` 读取 → 迁移后 checkpoint 行被误判为 real（状态双计、保护窗误判）；② ~~REAL_CONTENT 宿主行被 rename map 改写为直接 kind~~ **已修（issue #169）**——rename map 全量核对自同一 tarball（另含 `dsh-compaction-basic` → `compact-basic`）；分类器现同时匹配两种拼写：可折叠内容通道走 `REAL_CONTENT_KINDS`（`runtime-context`/`ptc-mode`，语义与旧 plugin 名一致——可折叠、非用户轮次），`compact-basic` 并入 `HOST_INSTRUCTION_KINDS`（其旧名从未在白名单内，legacy 行本就是 barrier，改名后沿用同等待遇而非降为可折叠内容），且保守默认扩展到 kind 命名空间本身：任何未审计的直接 kind 一律 barrier、不赢 last-real-user 保护窗（无 source / 无 kind 的行保持 0.1.7 前行为）。回归钉：`tests/v4-direct-kinds.test.ts`（单元矩阵 + 保护窗集成测试，含 legacy 形状同判 parity）。①（checkpoint 读侧 `compact-checkpoint`）仍开放，跟踪于 issue #168。按 AGENTS.md §4 SOP：对 0.1.7 seam 完成全量验证并移动 devDep 基线后才放宽 `tests/peer-range.test.ts` 钉住的区间。

> **DSH 0.1.7 checkpoint source 写侧归一化（issue #181，非绕行——适配层修复）**——#163 的准入同样咬住 checkpoint 行，但那个形状由宿主供应的 `compactCheckpointSource()` 产出：插件 peer 下限 `>=0.1.5-alpha.1 <0.1.6-0` 在 0.1.7 宿主上**独立**解析到 0.1.5-rc.3（0.1.5 线无 final release），其 `COMPACT_CHECKPOINT_MARKER` 仍是退役 V3 wrapper `{ kind:'plugin', plugin:'compact' }`（已对已发布 tarball 逐字核实；rc.2 同函数已产 `{ kind:'compact-checkpoint', compactionId }`）。引擎把该形状原样写入 v4 会话时，persistence writer 整批拒收并滞留内存（`drainPaused=true`、毒批永久留在缓冲头部、后续事件全部堆积其后，失败仅经 `ctx.logger.warn` 上报）→ 会话 wedged 到重启，症状与 #163 一致但毒行不是引擎自己的两个 writer（#165 修好的两种形状在受害会话里都正常落盘）。修复：`checkpointSourceFor`（src/region.ts）在 `session.header.version >= 4` 时把恰好这一种 legacy 形状归一化为 `{ kind:'compact-checkpoint', compactionId }`（保留 `sourceCommandId`）——writer 由会话格式版本决定而非哪个包被解析；其余输出原样直通：旧宿主仍说 wrapper（零行为变化）、新 dsh-compaction 副本已产 producer kind。移除门：peer 下限移过最后一个 wrapper-emitting 线后删除。回归钉：`tests/checkpoint-source-kind.test.ts` #181 段（v3 直通 / v4 改写 / 事务与解析副本字节一致）。端到端验证：真实 rc.2 persistence writer + 嵌套 0.1.5 dsh-compaction 解析的复现 harness，修前精确复现 wedged（后台 drain 报同款错误文本、文件止于 compress 前一轮），修后完整事务落盘、checkpoint 行形状逐字核对。

> **DSH 0.2.0 seam 线迁移（issue #192，非绕行——验证记录；peer 区间整体移动）**——背景：DSH 发布 0.2.0-rc.2 后，宿主的插件兼容性门禁（peer 范围核对）拒绝安装本插件，插件市场自动立项 #192。按 §4 SOP 先全量验证再移动基线。逐项结果（均对已发布 0.2.0-rc.2 tarball + e2e 实测）：① replace surfaceOp 方言**未变**（仍严格三键 `{ op, startSeq, endSeq }`）——e2e 压缩场景照常落盘，`tests/surfaceop-dialect.test.ts` 在真实 0.2.0 会话上通过；② **tool/result 事件载荷形状变更**：事件体即工具结果消息本身，`toolCallId` 提升到消息级（旧嵌套块读取返回空）→ `src/messages.ts` 共享提取器 `toolCallIdOfResultEvent` 改读 `message.toolCallId ?? source.callId`（单一实现，region.ts 的 call/result 配对同源），`src/index.ts` 的 tool/result 处理器同步改（AGENTS.md rule 10）；③ **settings 服务改名**：`installSection` 移除（更名 SettingsForms）→ 所有受支持宿主上能力探测**按设计失败**：一次性 warn、不注册、`/acp-prune config` list/status 保持只读、set/reset 返回指引文本（AGENTS.md rule 17(d)）；恢复写路径需引擎声明自己的 `static Config` schema，已另立 follow-up issue（来源 #192）；④ **LLM 适配器 wire 协议切换**：dsh-llm-deepseek 由 OpenAI 风格 SSE（`choices`/`delta`）改为 Anthropic Messages SSE（`message_start`/`content_block_delta`/`message_delta`…），注册契约由 namespace-apply 改为 `registerDeepSeekProvider(ctx, provider, { options, resolveAuth, providerName, discoverModels })`（内部要求 settings 服务）→ e2e harness 移植：挂 no-op `StubSettings`，fake-llm.mjs 重写为发 Anthropic SSE 帧（scripts/e2e/harness.mjs + fake-llm.mjs）；⑤ overflow 错误映射未变：providerError 仍经 `isContextWindowExceededError` 正则识别 maximum-context-length 措辞 → CONTEXT_WINDOW_EXCEEDED，overflow-recovery 场景通过；⑥ KNOWN_SESSION_EVENT_TYPES 新增 `developer/message`、`image/offload`（对分类器无影响：未审计 kind 按保守默认一律 barrier，rule 16）。最终验证：typecheck clean、单测 384/384（合入 #182 后在本分支实测）、build 通过、e2e 五场景全绿（basic-compress / nudge-rhythm / compress-then-decompress / acp-status / overflow-recovery）。peer 决策：下限 `0.2.0-rc.2`（已发布的 0.2.x 仅 rc.1/rc.2，取 rc.2 全量验证），上限 `<0.3.0-0`；< 0.2.0 的宿主无法安装本线（兼容性门禁拒装），请停留在 ≤ v0.2.26（最后一条 0.1.5 线发行版）。回归钉：`tests/peer-range.test.ts`（整条 0.2.0 线接受 / 其余版本线全部拒绝，含 0.2.1-rc.1 同元组预发布规则不对称）、`tests/surfaceop-dialect.test.ts`（真实 0.2.0 会话 E2E）。

> **DSH ≥0.1.7 SettingsForms 设置服务契约核查（issue #193，非绕行——验证记录）**——0.1.7 线把 settings 服务更名 `SettingsForms` 并移除 `installSection`（#173 的发现），#191 放宽 peer 区间后该线进入受支持带，写路径必须迁移。已对**已发布 tarball** 逐字核实契约：dsh-settings **0.1.7-rc.2 与 0.2.0-rc.2 的 `lib/index.js` 字节相同**，一次核实覆盖两条线。公开 API：`configure / describe / update / replace / mutate / writable / documentPath / prepareDocument` + `SettingsConflictError`（位置参数 `(ns, expected, actual)`，`code: 'SETTINGS_CONFLICT'`）；段按 **profile entry id** 寻址（本插件为 `compaction-acp`，即组合行 `- id:`）；`describe` 行形状 `{ ns, autoGenerate, schema, value, revision, base?, user?, applies: 'live' }`，value/base/user 均为表单投影（只含 `.volatile()` 字段）。写语义：`update = mergeLayers(projectForm(form, raw), input)`、`replace = mergeLayers(projectForm(form, inherited), input)`、最终 entry config = `mergeLayers(strip(raw, form), next)` —— **非 volatile 键在写后原样保留**（用户手写的 prompts/coreOverrides 不会被冲掉）；revision map 按 entry id 计、从 0 起、raw 变化时 +1；未传 expectedRevision 时跳过冲突检查。volatile 接线：cordis-plugin-loader 挂载期把插件静态 Config schema 里**每个** `.volatile()` 字段包成 ref cell（含从未写入的键），表单写入经 `updateVolatile` 在步间提交进同一批 ref（entry.ts:143-189）并发出 `loader/volatile-update`——本引擎**不订阅该事件**，热应用靠 env getter live 读 ref（提交即下次读取可见）+ 每 pre-step 顶部的 `resyncSettings()`（重解快照基线、触发 min/max 倒挂等 diff 诊断）。引擎侧锚点：`AcpPluginConfigSchema`（src/settings.ts:184，六键各标 `.volatile()`、故意不设默认值——schema 默认会遮蔽 preset 填充的 base）、`static readonly Config`（src/index.ts:386）、双轨能力探测（src/index.ts:535-604：先 `installSection` 后 `describe+update+replace`，两轨都不匹配单条 warn 干净降级）、live thunk 换入（src/index.ts:573）、resync 赋值（src/index.ts:507）+ pre-step 调用（src/index.ts:722，autoNudge 门之前）。设计细节：docs/settings-integration-design.md §4.9。回归钉：tests/settings.test.ts forms 五用例（静态 schema 契约走 schemastery `.dict` 而非 zod `.shape`——后者 typecheck 通过但运行时 undefined；热应用 next-read + 有序步静默；`/acp-prune config` 往返 set→ref+revision bump+list `user` 归属、reset→引擎默认；服务级陈旧 revision 抛真 `SettingsConflictError` 且不覆盖胜出值；倒挂对每步驱动恰好告警一次）。验证结果（0.2.0-rc.2 基线）：typecheck 绿、settings standalone 全过、全量 386 条定义中 375 过 / 0 败 / **11 跳过**（跳过的是 `installSection` 老接缝用例——0.2.0 线该服务方法已移除；覆盖缺口见下条记录）、build 绿、e2e 五场景全过。参考实现溯源：PR #180（0.1.7 线的同设计实现，未合并）；本 PR 将其扩展到现行 peer 带 `>=0.1.5-alpha.1 <0.2.1-0`。

> **`>=0.1.5-alpha.1 <0.2.1-0` 宽带的双基线验证矩阵 + `.volatile()` 能力门（issue #190/#192/#193 整合，非绕行——验证记录）**——PR #194（0.2.0 行为移植：消息级 toolCallId、Anthropic SSE、`developer/message`、窄带 `>=0.2.0-rc.2 <0.3.0-0` + settings 写路径只读降级）与 PR #195（宽带 + SettingsForms 写路径；前三个 commit 与 #191 完全相同，故 #191 被严格包含、已关闭）不是竞争实现，二者**深联合**后逐项实测：**0.1.5-rc.2 基线** typecheck 绿、397/397 全过（0 跳过）、build 绿、e2e 五场景全过；**0.2.0-rc.2 基线** typecheck 绿、397 条定义中 386 过 / 0 败 / 11 跳过、build 绿、e2e 五场景全过。以上是**并入 main 后的复测值**（较本条记录首次落笔时的 386/375 各多 11 条）：main 侧带来 #182/#202 的回归用例，本分支又把 main 侧三条**只在本分支缺失**的只读断言回搬进 forms 套件（`autoModelContextLimit` 的组合值门、组合值胜过 preset、`settingsEnabled: false` 连 warn 都不发），因此两条基线的跳过数（0 / 11）与失败数（0 / 0）均未变。同一构建产物在两条基线上跑 e2e（harness 探测 `LlmDeepSeek.apply` 决定插件挂载路径还是 `registerAdapter`）——这是「单一构建、全区间」的第一个可测证据。
>
> **覆盖矩阵的两个非对称缺口**（不允许用单一基线的绿冒充全绿）：① 11 条 `installSection` 老接缝用例（filtered `base`、seam→window 门、provider detach、reset 保留手写键、#176 preset 填充 base）**只在 0.1.5 基线执行**——0.2.0 线该服务方法已移除，测试自带 skip 门，于是 rule 17 的行为在 0.2.0 基线上无覆盖；② SettingsForms 五用例两条基线都跑（自带 fixture 服务）。**CI 建议（尚未落地）**：CI 改成 0.1.5-rc.2 / 0.2.0-rc.2 双基线矩阵，否则缺口 ① 在 CI 上永久静默。
>
> **整合中发现并修掉的真 blocker（`.volatile()` 在旧线不存在）**：0.1.5/0.1.6 线随附 schemastery 3.18.2，**没有** `.volatile()` 方法（实测 `typeof string().volatile === 'undefined'`；0.2.0 线 3.18.4 为 `function`）。`AcpPluginConfigSchema` 是模块级常量且 `static readonly Config` 在 import 期求值，因此无条件调用会在**模块加载期**炸：实测 `TypeError: z.number(...).step(...).min(...).volatile is not a function`——即在宽带声明下这些宿主的插件根本无法加载（不是功能降级，是加载失败）。修复：`markVolatile`（src/settings.ts）按运行时有则施加；依据是标记的唯一消费方 `dsh-settings` 的 `volatileForm`（SettingsForms 机制）与 cordis volatile-update 接线都不存在于老线，老线走 `installSection` 且热应用来自 live 读 + 每 pre-step `resyncSettings()`，故跳过无损失。附带一处纯类型面差异：0.1.5 线的 `SessionEvent` 联合不含 `developer/message`，直接比较会 TS2367，改为经宽化局部变量比较（运行期语义不变）。回归钉：tests/settings.test.ts 静态 schema 用例按运行时能力分支断言（有则断言标记存在、无则断言**刻意缺失**——两分支都执行、都不跳过）。

> **acp-kernel pin 升级 0.0.63 → 0.0.101（issues #187 / #46 / #159 整合，非绕行——验证记录）**——§4b SOP 全流程走完（选 tag → 热区复核 → bump → 全量验证 → 门解除），逐项均为实测。① **ref 位宽（#187）**：两版 `node_modules/acp-kernel/dist/index.js` 的 `MAX_INDEX` 常量为 `99999`（0.0.63）→ `9999999`（0.0.101），修源于上游 [acp-kernel#483](https://github.com/ranxianglei/acp-kernel/issues/483) → PR [#496](https://github.com/ranxianglei/acp-kernel/pull/496)（MERGED 2026-10-02）；这是 issue #187 的关闭依据，README 两条对应条目已从「已知问题」改写为「已修复（v0.2.27 起）」。② **checkpoint carrier（#159 / 上游 #335）**：0.0.101 的 `CoreMessage` 新增 `summaryOfBlockId?: string`（`dist/types.d.ts`），`applySingleRange` 对 plain 范围（`boundaryKind !== 'block'`）保留活跃块的 carrier，并在警告里点名「reference the block ids (bN..bM) instead」，`bN..bM` 边界仍照折——修法是**宿主契约**，所以本 PR 必须同时做两半：投影给 checkpoint 节点挂 kernel block id（`kernelBlockIdByCompactionId` → `projectEvent`，src/messages.ts），以及跨 live carrier 的 plain T1 硬拒（`liveCheckpointCarriersInSpan` src/region.ts + `liveCarrierRejectionNote` src/tools.ts，compress 工具与 `/acp-prune compress` 都拦），否则内核保留了 carrier、事务的单次 `surfaceOp` 又把它藏掉。③ **规则 API（issue #189 的阻塞）**：0.0.101 入口已导出 `RULE_TOOL_NAME` / `addRule` / `removeRule` / `clearRules` / `formatRulesForPrompt` / `formatRulesList` / `resolveRuleLimits`（`dist/index.d.ts:46`，实现来自 `dist/rules.js`），state 里也有 `rules` / `nextRuleId` —— pin 阻塞解除，剩下的是移植工作本身（第五工具 + `config.rules` 接线）。④ **三条断言随内核侧变化适配**（都是内核自有行为变化，不是我们回归）：`tests/prompts.test.ts` 两条改为钉 0.0.101 的 tip 原文；`tests/kernel-count-tokens-default.test.ts` 的余量断言从「≥2×」改为钉实测值（CJK fixture 的 pending T1 = 6460 vs `minPressureBenefitTokens` 5000 = 1.29×）——**分词器本身未变**（100 汉字 = 100 token，两版逐字一致）；缩水的真因**不是记账、也不是门序**，而是 `mergeRangesToThreshold` 改为按**数组索引间隙**切批、并**丢弃**低于 `minCompressRange` 的批，而该阈值按**字符**计、其余阈值按 **token** 计 —— CJK 组过了 token 门却过不了字符门（同一形态 fixture：拉丁 6 段 / CJK 1600 字符每条 3 段（尾部整段不可回收）/ CJK 4000 字符每条回到 6 段，尺寸对照证明是字符门）；已加 characterization 测试 `tests/kernel-range-source.test.ts`（含对照），上游修复待提。全量：**412 条 / 401 过 / 0 败 / 11 跳过**，typecheck 与 build 绿，e2e 五场景全绿。⑤ **复核澄清两处与 issue 叙述不一致的上游状态**：issue #46 引用的上游 PR #123 实为 `CLOSED`（`mergedAt = null`，2026-06-11 关闭），#227/#228（`hybridAlgorithm.score` 的 `Math.max(...scores)` 崩溃）同样 `CLOSED` 未合并——前者不关闭、tracker 行更正为 `upstream-declined`；后者保持「未修复」记录，AGENTS.md rule 14 的措辞同步更正为「CLOSED, never merged, 崩溃未验证在 0.0.101 上是否仍存在」。⑥ **复核发现三项（已在本 PR 内处置）**：(a) **mN 宽度**：`src/tools.ts` 的 `MN_RE` 仍钉 5 位/99999，而 0.0.101 的 ref 上限已是 7 位/9999999 —— 长会话里 acp_status 自己给的 `m100000` 会被 `compress` 当「不是 ref」拒收，恰好抵消本次升级的目的；已改 `\d{1,7}` + 上限 9999999 + 导出 `mnRefIndex`，并加 `tests/tools.test.ts` 契约测试（用内核 `indexToRef` 往返 99999/100000/9999999；变异回 5 位 → 测试 25 变红）。(b) **tiers 默认值**：`defaultConfig.tiers.tier2Trigger`/`tier3Trigger` 5/10 → 1000/2000（引擎不覆写 `tiers`），块数触发的 T2/T3 实际失效，README 中英文两条 `min` 说明已补。(c) **引导常量变长**：`HOW_TO_COMPRESS_RULES` 5240→5856、`TIER2_DISTILL_RULES` 2919→3445、`TIER3_CONDENSE_RULES` 2021→2190 字符（`COMPRESS_PHILOSOPHY` 不变），而这四段同时被 `src/prompts.ts` 拼进系统提示 → **每次请求 +1311 字符 ≈ +330 token** 固定成本（文案属内核，本地裁剪等于分叉，记录成本即可）。
