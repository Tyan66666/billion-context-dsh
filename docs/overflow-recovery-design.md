# 上下文超窗自动恢复设计（overflow recovery design）

> **状态**：已实现（采用 PR #153，作者 Premshay 的思路；本仓库补齐文档、修掉 3 处缺陷与 1 处端到端不一致后合入）。
> **来源**：PR #153（`fix/agent-request-error-overflow-recovery`）。
> **背景**：装本插件时会禁用宿主的 `compaction-basic`（bundle 补丁，同一 realm 只能有一个 `ctx.compaction` owner），而 `compaction-basic` 原本是 `agent/request-error` 的响应者——于是超窗错误被原样抛出、没有重试。本设计把这一块补上。

## 0. 结论先行（TL;DR）

- **ACP 唯一的自动压缩动作**：仅在 provider 明确确认上下文超窗（`failure.code === CONTEXT_WINDOW_EXCEEDED_CODE`）时，引擎自己挑一段最大且合规的范围隐藏一次（**不调模型**），再应答宿主的 `agent/request-error` 让该请求重试。
- **压力侧不变**：仍然只 nudge、由模型决定压缩什么（设计决策 3）。两者不冲突——超窗时请求根本发不出去，不存在可以做出决策的模型回合。
- **预算**：`maxOverflowRetries`（默认 `1`，与宿主 compaction-basic 的「一次自己拥有的重试」对齐；`0` 关闭）。按请求计数，模型有进展（落一条 assistant 消息）或 agent 回到 idle 即重置。
- **摘要是引擎写的标记**（engine-written marker），不是模型摘要，也不加「Model-written」前缀；原文全部留在日志里，`search_context` / `decompress` 找得回，模型之后还能用 `compress` 覆盖它、写一份真摘要。

## 1. 问题：禁用 compaction-basic 之后，超窗没人接

`docs/dsh-porting-verification.md`（架构事实 2）记录：宿主自动触发的接缝有两个——`agent/pre-step`（压力提醒）与 `agent/request-error`（超窗恢复）。bundle 补丁为「同一 realm 只能有一个 `ctx.compaction` owner」而禁用 `compaction-basic`，于是第二个接缝失去唯一的响应者：

- seam 层（`dsh-agent-loop`）在请求失败后**会重新抛出**该错误，除非某个监听器对 `agent/request-error` 返回 `{ kind: 'retry' }`；
- ACP 引擎此前只注册了 `agent/pre-step`（只 nudge，从不自动压缩），因此超窗后用户看到的是一个裸错误，重试要靠人手动再发一次。

## 2. 为什么这里允许自动，而压力侧仍然不行

- **压力侧自动压缩 = 替模型做语义判断**「哪段内容已经消化完」——这正是 ACP 的立身之本（设计决策 3：自动策略只 nudge，模型决定）。引擎没有这份判断，压缩错了就是永久的信息损失。
- **超窗是硬失败**：provider 已经拒绝了该请求，模型没有回合，`compress` 工具无法被调用；引擎不动手，会话就卡在错误上。
- **动作可逆、可重写**：隐藏的是 durable block，原文留在 append-only 日志（`search_context` 仍索引原文、`decompress` 可恢复），模型之后还能对这个 block 再跑一次 `compress` 写一份真正的摘要。信息没有丢，只是暂时折叠。
- **自动动作的范围不超过模型本来能选的范围**：选举走的是同一张表 `buildCompressibleSeqRanges`（`src/region.ts`），宿主 guard 全部照旧生效——保护近尾（`preserveRecent: 5`）、最后一条真实 user turn（`isRealUserTurn`）、当前指令行（rule 16）、checkpoint、系统节点。因此紧急路径**压不到**模型自己都不允许压的东西。

## 3. 机制

### 3.1 监听器（`src/index.ts`）

```
ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => { … })
```

1. `failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted` → `next()`（其他错误原样交给宿主，会话取消不做事）。
2. 预算检查：`retries >= max` → 打日志、`next()`（原始错误保留，不吞）。
3. 记下 `agent.session.surface.replaceGeneration`，调 `compactForOverflow(agent, signal)`。
4. 成功且 `replaceGeneration` 增长（durable 事务确实落地）→ 记一次预算、返回 `{ kind: 'retry' }`。
5. 抛异常但 `replaceGeneration` 已增长 → 表面已缩小，从替换后的表面重试是更优选择（同样记预算并 retry）。
6. 其余情况（未落地、被取消、`null`）→ `next()`。

`CONTEXT_WINDOW_EXCEEDED_CODE` 从 `@deepseek-ai/dsh-llm` 导入（`src/index.ts:41`）——不自己写字符串，宿主改了常量我们跟着走。

### 3.2 选择与落地（`compactForOverflow`）

- `processTurn({ …, renderTags: 'none' })` 拿到 ref 映射（与 `handleCompress` 同一契约；`renderTags: 'none'` 保证不改写消息文本，我们只读 ref 表）。
- 用 `byRaw` 求出可见表面的首/尾 seq，构造**一个**覆盖整个表面的 kernel range view，交给 `buildCompressibleSeqRanges` 切分并施加宿主 guard。
- 取 `range.tokens` **最大**的一段（与 nudge 范围表同一套计价，含 rule 19 的媒体加价 / `mediaPriceOf`）——「一次有用的、平衡的缩减」，与宿主 compaction-basic 的行为对齐。
- `kernel.applyCompression` → `shadowedSeqsOf` → `shadowedTokensViaMeter`（**宿主词表**计价，rule 12：绝不写 `defaultCountTokens` 的账）→ `runCompactionTransaction`（tier 1，`topic: 'context-overflow recovery'`）。

值得单独说明的两处「显式 pin」，因为它们都是**自动路径**的安全边际，不能跟着 advisory 表漂移：

- `preserveRecent: 5`：这是 `region.ts` 自己的默认值，这里**显式写出**——nudge 表的这个参数将来若为提醒效果调参，自动路径的安全边际不应被静默带走。
- `shadowedTokensViaMeter`：宿主投影按自己的固定启发式累加 append，claim 口径必须一致，否则 `messageTokens` 会被折成负数、整个会话的后续请求全部被投影 schema 拒掉（issue #54 / #103 的砖化事故）。

### 3.3 预算与重置

- `overflowRetries: Map<Agent, number>`（每次重试 +1）与 `overflowSessions: Map<Session, Agent>`（供状态查询）两份簿记。
- **两条终态路径**都会清理：`agent/status` 变为 `idle`，以及模型有进展（落一条 `assistant/message`）。缺任何一条都会让 Map 永久持有 Agent/Session 引用（本 PR 修掉的第一处缺陷就是这个）。
- **归一化必须发生在配置解析处**（`resolveAcpConfig`，`src/index.ts:257-265`）：`maxOverflowRetries` 校验后要把归一化结果写回返回值。只校验不写回的话，`Partial` 里显式的 `undefined` 会存活到 `this.config`，监听器里的 `?? 0` 就会把它读成「关闭」——一个从未设过的键静默地关掉了恢复功能。监听器里的 `?? 1` 仅是给未来配置形态兜底，**必须是 1**（宿主自己的默认值），不能是 0。

## 4. 摘要是引擎写的，不是模型写的

超窗恢复的 summary 用 `overflowMarkerSummary(hiddenCount)`（`src/messages.ts`）构造，文案以 `ENGINE_SUMMARY_LEAD = '[engine-written summary — context-overflow emergency compaction'` 开头，说明「多少个表面消息因为超窗被隐藏、原文在日志里、可用 search_context/decompress 取回、也可再用 compress 覆盖写正式摘要」。

它**不加** `SUMMARY_FRAME_PREFIX`（「Model-written summary — not user words…」）——那句话宣称的是模型写的来源，贴在引擎 marker 上就是造假。

**豁免在内容识别处收口，而不是在调用方加开关**：`withSummaryFramePrefix`（`src/messages.ts`）是**唯一**的加帧函数，创建期写入（`region.ts` `prefixSummaryBlocks`）与投影期补帧网（`messages.ts` `projectEvent`）都走它；函数内先判 `isEngineWrittenSummary(text)` 再决定是否加缀。

PR #153 原实现走的是另一条路：`CompactionTransactionInput` 加一个 `framed?: boolean`，超窗事务传 `framed: false`。这是**真缺陷**，不是风格问题：调用方的 flag 读侧看不见，而 `projectEvent` 对任何 checkpoint 节点都会按内容加帧，于是

- 模型在上下文里看到的前缀是「Model-written summary — …」（与事实不符），而
- durable 事件与 `decompress` 头读到的是无前缀文本 → **存/投文本分裂**（正是 rule 18 留档过的那类 `prefix/raw mismatch`，评审时已抓到过一次）。

修法把豁免移到 `withSummaryFramePrefix` 里，于是 durable 字节与模型可见字节**由构造保证一致**，`framed` 选项与 `framed: false` 调用点一并删除。老不变式仍有守：`tests/injection-governance.test.ts:38` pin 住 `SUMMARY_FRAME_PREFIX` 字面量，`:84` 断言「投影期也会给 legacy 块补帧」，`tests/tools.test.ts:314` 断言解压头回显该帧。

## 5. 已知边界

1. **一次最大缩减可能仍然不够**：默认预算 `1` 表示「一次自己拥有的重试」（宿主行为对齐）。若单个最大合规范围压完仍在窗口之上，重试会再次失败、预算已耗尽 → 错误原样抛出。要更激进就把 `maxOverflowRetries` 调大（每次请求各算一次）。
2. **marker 不是摘要**：恢复后的上下文质量低于模型自己写的摘要。模型可以之后对同一 block 再 `compress` 一次（block 仍然 live、checkpoint seq 可在 `acp_status` 看到）写一份正式摘要。
3. **媒体密集会话依赖计量表**：选择哪一段最大，用的是范围表的 `range.tokens`，其中媒体加价来自宿主计量（rule 19）。计量器缺失/抛错时退回固定结构价，排名可能不最优，但不会把图片当 0 成本。
4. **不覆盖其他失败**：只处理 `CONTEXT_WINDOW_EXCEEDED_CODE`。provider 的限流、网关错误等仍交给宿主原本的重试策略。
5. **宿主版本门**：本仓库的 peer 区间是 `>=0.1.5-alpha.1 <0.1.6-0`（§4 规定），`{ kind: 'retry' }` 协议与 `agent/request-error` 的载荷形状都在这个区间内验证过。

## 6. 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `maxOverflowRetries` | `1` | 每次超窗错误允许的自动抢救次数；`0` 关闭；非负整数，构造期校验（`resolveAcpConfig`）。**组合行专用**——刻意不进 settings 层：它是安全预算而不是可调旋钮，也不该在会话中途被改来改去 |

## 7. 验证

- `tests/overflow-recovery.test.ts`（12 项）：其他错误码/取消直接 `next()`；恢复路径写出正确的 durable 事务（block / checkpoint / claim 口径）；预算耗尽后保留原始错误；两条终态路径清空簿记 Map；无合规范围时 `null`；`resolveAcpConfig` 的默认值与 `undefined` 陷阱；投影文本 == durable 文本且不含模型摘要前缀。
- `scripts/e2e/scenarios/overflow-recovery.json`：真实宿主进程内跑通「超窗 → 自动隐藏 → 重试成功」，并断言线级请求体（假 LLM 收到的原文）里原文已消失、marker 已出现。
- 变异验证（开发期）：把 `withSummaryFramePrefix` 的内容豁免去掉 → 投影断言立刻变红（证明该断言真的在守存/投一致，而不是恒真）。
