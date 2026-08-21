# 影子价格必须说宿主的 token 语言（shadow-price-host-vocabulary-design）

> 状态：已落地（PR #56，issue #54）。本文记录**决策过程与为什么**；AGENTS.md 规则 12 是规范本身；docs/dsh-porting-verification.md 有 UPSTREAM 追踪行。

## 1. 事故背景（issue #54）

session `session-3aa366c3`（Obsidian 面试笔记，中文密集）在两次 `compress` 后**永久卡死**：宿主 token-meter 的 `contextBreakdown` 投影把 `messageTokens` 累成负数（≈ −31K），投影 schema（`zod` `nonnegative`）拒绝每一轮 → `{"code":"too_small","path":["messageTokens"],"message":"Too small: expected number to be >=0"}`，重试无效。

根因：引擎把 `compaction/summary`/`compaction/prune` 事件的 `shadowedTokenCount`（影子价格）用 `defaultCountTokens`（CJK 1 字符/token）计价，而宿主账本按扁平 4 字符/token 记账。中文内容下 claim 虚报 ~4 倍：宿主累计 42,076，claim 共 74,858 → 账本被扣穿。

## 2. 核心区分：准确性数字 ≠ 一致性数字（账本货币）

| | 用途 | 词汇 | 现状 |
|---|---|---|---|
| **准确性数字** | nudge 百分比、`acp_status` 账本展示、压缩结果文案、kernel 决策 | 越准越好：`defaultCountTokens`（CJK 1 字符/token）→ `createBpeTokenizer` / `config.countTokens` 模型系数 | 规则 1，未变 |
| **一致性数字（影子价格）** | 写入宿主事件的 `shadowedTokenCount`，宿主账本据此加减 | **必须是宿主计价词汇**（扁平 `ceil(chars/4)+4`/块、`+4`/消息） | 本 PR 修复 |

**影子价格不是"token 数量"，是"账本货币"**。宿主 token-meter 的 `foldSurfaceProjection`（`dsh-token-meter/lib/types/surface-projection.js`）把每个 `compaction/summary`/`compaction/prune` 的 `shadowedTokenCount` 当作 claim，对下一个 surface replace 消费：`messageTokens += estimateMessage(新节点) − claim.tokens`。投影是**有界状态**（"never retains per-node prices"），**无法重建被替换范围的实际价值**——它只信任 claim。claim 与宿主自己的计价不一致 → 账本漂移（占用率低估）；中文一多 → 扣穿变负 → schema 拒绝 → session 卡死。

宿主自己的 `compaction-basic` 遵守契约：`const meter = this.ctx.tokenMeter; meter.measure(session)` → `selectedNodes.reduce((t, n) => t + n.tokens, 0)`（`dsh-compaction-basic/lib/index.js:536-544,859`）。契约注释原文：*"the counts are exact by construction: producers derive them from the same fixed estimator this module prices appends with"*。

## 3. 设计决策（L1 修复）

### 3.1 主路径：借用宿主 meter 的价格（exact by construction）

`shadowedTokensViaMeter(session, seqs, ctx)`（`src/host-tokens.ts`）：

```ts
const meter = ctx?.get?.('tokenMeter')   // 宿主 compaction-basic 同款（this.ctx.tokenMeter）
const nodes = meter.measure(session).nodes  // [{seq, tokens}] — 宿主在 append 时记的价
const claim = seqs.reduce((sum, seq) => sum + bySeq.get(seq)!, 0)
```

- **exact by construction**：claim 就是宿主自己的记账值，账本必然自洽（终值 == `measure().surfaceTokens`）。
- **宿主未来改估算器（如 CJK-aware / BPE）自动跟随**——镜像不需要同步。
- 与宿主 compaction-basic 同一条代码路径，生产验证过。
- `try/catch` 兜底：`measure` 对无 `step/start` 的 log 会 THROW（`token meter: assistant/message at seq N has no matching step/start event`），任何异常回退镜像。

### 3.2 兜底（默认）：本地镜像（fallback DEFAULT 必须是镜像，绝不 `defaultCountTokens`）

`estimateHostContent`/`estimateHostMessage`/`hostPriceEvent`（`src/host-tokens.ts`）逐行复刻 `@deepseek-ai/dsh-token-meter/lib/types/estimate.js`：

- `CHARS_PER_TOKEN = 4`、`BLOCK_OVERHEAD = 4`、`ROLE_OVERHEAD = 4`
- text/reasoning：`ceil(len/4) + 4`
- tool-call：`ceil(name/4) + ceil(arguments/4) + 4`
- tool-result：递归 `estimateContent(block.content) + 4`——**content 为字符串时按可迭代对象逐字符**，每字符落入 default 分支（`4 + ceil(JSON.stringify(char)/4)` = 5/字符）
- default（未知块）：`4 + ceil(JSON.stringify(block)/4)`，`JSON.stringify` 作用于**宿主原对象**
- `estimateMessage = estimateContent(content) + 4`
- `hostPriceEvent = deriveEventMessage(event) === null ? 0 : estimateMessage(message)`——`deriveEventMessage` 从 `@deepseek-ai/dsh-session` 导入（user/message → `event.data`；assistant/message 空 content → null；tool/result → `event.data.message`；其余 → null）

**为什么镜像必须是默认**：`hideSurfaceSeqs` 的调用方（`deferCompressPairHide` 微任务、`stripOrphanedSurfaceToolMessages`、`buildCompressibleSeqRanges` nudge 路径）**没有 agent ctx**，拿不到 meter。镜像就是宿主词汇（已修复 #54）；meter 只是增强。

### 3.3 三处写入点 + 一处同 PR 崩溃修复

- `handleCompress`（`src/tools.ts`）：`shadowedTokensViaMeter(session, shadowed, agent.ctx)`
- `hideSurfaceSeqs`（`src/region.ts`）：新增 `priceEvent: (event) => number = hostPriceEvent` 参数，默认镜像
- `/acp compress`（`src/commands.ts`）：`shadowedTokensViaMeter(session, shadowed, agent.ctx)`
- **`src/commands.ts:88` raw-vs-resolved 崩溃**（审阅发现）：旧代码用 raw `startSeq/endSeq` 调 `shadowedSeqsOf`，事务用 resolved `{start, end}`——边界被调整时 `indexOf = −1` → 垃圾跨度 → `assertProvenance` THROW（/acp compress 现存崩溃）。已改为 resolved 边界，同 PR 修复。

`rebuildBlockLedger` 回填（`src/region.ts:422-427`）保持 `defaultCountTokens`——仅展示，宿主不读。

### 3.4 测试（L3）

真实 `TokenMeter` + `SessionProjectionRegistry` 端到端（`tests/shadow-price.test.ts`，5 测试）：

- 真实 `ctx.plugin(SessionProjectionRegistry)` + `ctx.plugin(TokenMeter)`，`snapshot(session)` 走真实 `contextBreakdown` 投影（生产抛错的同一 fold）
- CJK fixture 必须带 `step/start` 事件（真实 `measure` 对无 step 的 log 会 THROW）
- 断言：claim == meter 价、镜像 == claim、投影非负且 == `measure().surfaceTokens`、旧 `defaultCountTokens` claim 会打穿账本（#54 算术复现）
- **不做本地 fold 复刻作 oracle**：宿主 fold 不可导入，自复刻证明不了宿主不崩
- 覆盖三条写入路径（compress 工具 / /acp compress / prune）

测试基建两个陷阱（已绕过）：
1. 投影 cell 是**事件驱动**的（`ctx.on('session/event')`），detached 测试 session 无事件流 → `snapshot` 后事务不更新 cell → 需对事务后新增事件手动 `registry.drive(session, event)`
2. `resolveTokenCount` 会在事务前 `snapshot`（预折叠 cell）→ 全量 drive 会双重折叠 → 只 drive `beforeEvents` 之后的事件

## 4. 遗留问题与上游（L2）

- **宿主扁平 4 字符/token 对 CJK 占用率低估 ~4×**（占用率显示不准是宿主既有问题）：治本 = 向 deepseek-harness 提议 `dsh-token-meter` 改 CJK-aware（或可配置系数）。宿主采纳后：占用率显示变准、插件准确性数字与宿主词汇天然一致、镜像可删除。
- **宿主估算器未从包导出**（`estimateContent`/`estimateMessage` 在 `lib/types/estimate.js`，但 `package.json` exports 只有 `.`/`./invariant`/`./client`/`./src/*`）：镜像是对此的临时绕行。宿主导出后：删镜像、用导出实现对拍 `meter.estimateMessage`（UPSTREAM 追踪行见 docs/dsh-porting-verification.md）。
- 事故 session 抢救：`scripts/rescue-shadow-price.mjs`（改 claim 为镜像价 + 备份 + 默认 dry-run + `--force`）；`session-3aa366c3` 已抢救（64722→30604、10054→7836、82→1731；fold −30,822 → +3,865，全程最小 +183）。
