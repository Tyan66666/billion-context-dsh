# DSH 移植验证报告与可行路径

> 本文档是移植前验证的完整记录：每一项论断都有源码/运行证据，最后给出经过验证的可行路径。前置背景见 [dsh-porting-analysis.md](dsh-porting-analysis.md)。

## 第一部分：验证结果

### V1. acp-kernel 可独立运行 ✅

在 Node 22 下用项目自带 `node_modules/acp-kernel` 直接运行完整生命周期（`/tmp/acp-engine-probe*.mjs` 系列探针）：

| 阶段 | 结果 |
|---|---|
| `defaultConfig(limit)` 生成合法配置 | ✅ |
| `processTurn` 分配 ref 标签（`<acp tokens="15" type="text">m00001</acp>`） | ✅ |
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
- 搜索：`ctx.sessionQuery.searchEvents(request, exec)` / `searchSessions`（`packages/session-query/session-query/src/index.ts:113-124`），SQLite 后端 `openAt: 'never' | 'first-search' | 'startup'`（默认 `never`，需在组合中改为 `first-search` 才启用全文搜索）。
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
2. **自动触发的接缝**与 compaction-basic 相同：`agent/pre-step`（pressure）与 `agent/request-error`（context-overflow 恢复，`CONTEXT_WINDOW_EXCEEDED_CODE`）。ACP 引擎照抄这两个 listener 即可。
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
  ├── /acp 命令（V3）
  └── ACP 块状态持久化（日志事件 或 ctx.storage，V3/V5）
```

### 组合接入（两处改动）

1. **host 组合**（`dsh-base` 或部署层 patch）：加一行 `- id: compaction-acp: name: '@deepseek-ai/dsh-compaction-acp'`（在 host 平面提供 `ctx.compaction`）。
2. **preset**（新建 `acp` preset 或改 `standard`）：`compaction` isolate realm 里把 `compaction-basic` 换成 ACP 后端行；`session-query-sqlite` 的 `openAt` 改为 `first-search`（启用 search_context 的全文索引）。

### 关键设计决策（每项都有验证依据）

| # | 决策 | 验证依据 |
|---|---|---|
| D1 | **ref 机制**：放弃内存打 `<acp>` 标签，改用"seq 即 ref"，nudge/注入消息携带 seq→内容映射表 | V4：无内存改写钩子；V2 架构事实 4 |
| D2 | **压缩落地**：模型 `compress` 工具 → durable `surfaceOp: {op:'replace'}` 遮蔽范围，摘要 = 模型写的 summary（正是 ACP 省 token 的卖点，无需二次 LLM 摘要调用） | V2、V5 |
| D3 | **decompress**：读取日志原始事件，replace 回原文 | V5 |
| D4 | **自动触发**：`agent/pre-step` + `agent/request-error`，与 compaction-basic 相同 | V2 架构事实 2 |
| D5 | **块状态**：ACP block 状态写成会话日志事件（如 `acp/block`，回放/checkpoint 免费）或 `ctx.storage` key | V5、V3 |
| D6 | **搜索**：`search_context` 基于 `ctx.sessionQuery.searchEvents`；acp-kernel `searchBlocks` 仅作块内兜底 | V3、V1 |
| D7 | **nudge**：pre-step 注入（现有注入通道，会成为日志中的 `user/message`） | V4 中 pre-step 语义 |
| D8 | **delegate 工具**：直接映射 DSH 现有 subagent/jobs 体系，不移植 Pi 专用实现 | 组合现状 |

### 里程碑（每步可独立验证）

| 里程碑 | 内容 | 验证方式 |
|---|---|---|
| M0 | 包骨架 + seam 挂载 | **已完成（V7 探针即原型）** |
| M1 | 消息适配层：Session 事件 ↔ acp-kernel CoreMessage（user/assistant/tool-call/tool-result 投影，参考 `src/messages.ts` 的 `entriesToCoreMessages`/`projectMessage`） | 单测 + 日志回放 |
| M2 | 块状态持久化（日志事件 schema + load/merge） | 单测（重启恢复） |
| M3 | 4 个模型工具（工具 schema 用 typebox/schemastery，参考 `src/compress-tool.ts`） | 工具级单测 |
| M4 | nudge 注入 + seq-as-ref 范围表 + `/acp` 命令 | 注入消息单测 |
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
|---|---|---|---|
| 1 | `acp_status` 显示 `tokens compressed: 0`（多个大块） | 写事务时 `shadowedTokenCount` 写死 0 | 压缩时按实际遮蔽消息估算并写入账本 |
| 2 | nudge 显示 `230%` 荒谬占用 | 用了 token-meter 的 `totalTokens`（请求+响应压力，含响应预估） | 改用 `surfaceTokens`（纯输入侧），显示 cap 100% |
| 3 | 估算对中文失准 | 用了 `estimateTokensFast`（纯 4 字符/token） | 改用 acp-kernel 的 `defaultCountTokens`（CJK 1 字符/token + 其他 4 字符/token，与 billion-context-pi 一致） |
| 4 | 压缩单条工具结果报 `no tool-pairing-balanced range` | `resolveSurfaceRange` 只向内收缩，单条 tool 消息收缩到空 | 收缩失败时**向外扩展到最小完整配对**（单条结果自动带上其调用） |
| 5 | 模型说"压无可压"（大工具结果在范围表隐形） | kernel 的 ref 映射在长会话压缩后漂移，`compressibleRanges` 漏掉大段 | nudge 范围表改为**从 surface 自算**（跳过保护区 + 摘要节点，边界配对平衡） |
| 6 | 旧块 `tokens compressed` 仍为 0 | 修复前写入的块没有 token 数据 | 账本重建时对 0 值**从日志原文补算** |
| 7 | 官方 API 在 compress 后下一请求 400（摘要插在 compress call 与 result 之间） | `compress` 工具在 turn 中途执行，摘要 `user/message` 先于当前 `tool/result` 落库；且 `session.append` **不可重入**——在 `session/event` 监听内同步 append 会抛 "session append cannot reenter" 并被 dispatcher 静默吞掉 | `session/event` 监听把隐藏推迟到**微任务**（`deferCompressPairHide`，在下一个请求构建前落库），把该 call/result 对整体替换为普通 user 消息（保留结果文本）；只隐藏**单 call 节点**（多 call 节点隐藏会孤儿化兄弟结果，留作可见对——当前 harness 按 surface 位置序序列化，本就安全） |
| 8 | nudge 范围表只剩 ~28 tokens / 大段 compress 被 `no tool-pairing-balanced` 拒绝 | 孤儿工具消息（无配对 result 的 call、无配对 call 的 result）破坏配对平衡缓存或打碎大段；老版本 bug 还在 call 与 result 之间插入摘要形成死锁 "broken pair" | 范围求解前自动剥离孤儿（`compaction/prune` + 空 assistant 替换）：`agent/pre-step` **无条件执行**（低压力会话也不被崩溃孤儿 400）+ `buildCompressibleSeqRanges` + `handleCompress` 顶部；剥离覆盖孤儿 result、全孤儿 call 节点、以及 call→非工具节点→result 的 broken pair（自动治愈遗留死锁会话）；`handleCompress` 保护当前 step **全部 in-flight call**（`openToolCallIds`），兄弟工具不会被误剪 |
| 9 | 批量 compress 中单个 kernel 拒绝的范围拖垮整个调用（成功块被丢弃） | kernel 对"已被活动块 `effectiveMessageIds` 吸收但仍存活于 surface"的范围抛 `Range contains no compressible messages`；旧代码对任一 error 即整体返回失败并丢弃 `applied.state` | 仅当 `blocksCreated === 0` 才整体失败；否则照常落账成功块，失败范围作为 advisory 行报告（phantom range 不再毒化批次） |

**实机验证数据**（修复后）：

```
compress({ startSeq: 64757, endSeq: 265056, ... })
→ Compressed 1 block(s), ~139200 tokens reclaimed. block 9458eab3, 583 messages shadowed
→ acp_status: blocks: 16 | tokens compressed: 145305 | estimated context: 26165 / 128000 (20%)
```

一次压缩回收 **~13.9 万 tokens**，上下文 **129% → 20%**，模型自述"当前摘要块里完整保留了所有关键信息（提交历史、代码架构、mask 编码、本地化、测试命令、点击问题结论），后续任何需求都能无缝接续"——ACP 闭环在真实长会话中完整走通。

**issue #18 修复实机验证**（2026-08-17，v0.2.1，PR #21 `c1d4045`，DSH web profile 符号链接直连 worktree 构建，重启加载）：

- **deferred pair-hide 落库序列**（逐事件核对会话日志）：`assistant/message(compress 调用) → tool/result 落地 → compaction/prune shadowedSeqs=[callSeq,resultSeq] → user/message surfaceOp replace（携带 compress 结果文本，sourceEventSeqs=[callSeq,resultSeq]）`——隐藏发生在 `tool/result` 之后的微任务（修复 A：`deferCompressPairHide`），监听内不再同步 append；compress 后每一轮请求正常，无 400。
- **nudge 范围表恢复真实数字**：把 profile `cordis.patch.yml` 的 `nudgeMaxContextLimitPct` 临时调低到 0.03（配 `nudgeMinContextLimitPct: 0.02`），nudge 在 ~5% 压力下于下一 pre-step 立即触发（证明 profile 补丁被 HMR 热重载、无需重启；重启后 growth 基线清零，只有阈值降低能触发）。范围表显示真实大小：
  `Surface: 143 nodes, seqs 82609..204994; ranges: seq 143804..196596 — 111 messages, ~37634 tokens; seq 197852..203758 — 21 messages, ~5018 tokens`
  ——issue #18 的 "~28 tokens" 死值消失（修复 8 的 `buildCompressibleSeqRanges` 实机输出真实范围）；大范围把旧 compress 对（surface 相邻健康对）正常纳入，不再整段 reject。测完已恢复 `0.5`。

**关键教训**：`acp-kernel` 的 ref 映射在**经过 surface 替换（压缩）的超长会话**中会漂移（范围表出现 `end < start` 的乱序段、大工具结果拿不到 ref）。任何依赖 kernel `compressibleRanges` 的宿主侧逻辑都应**从 surface 自算兜底**——这是移植中最值得记住的一课。
