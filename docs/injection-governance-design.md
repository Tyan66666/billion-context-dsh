# 注入治理设计（injection governance design）

> **状态**：已实现（PR #132，经维护者评审后收敛为 B1 + B3 + B6；B2 已移除）。
> **来源**：PR #132（TheTouYu）最初提交 B1–B6 六项注入治理改动；维护者评审（见 issue #132 楼层）确认三个阻断项与四个宿主行为问题后，本 PR 收敛为三项落地、一项移除。

## 0. 结论先行（TL;DR）

| 项 | 内容 | 结局 |
|---|---|---|
| B1 | 模型自写摘要前置框架行（source framing） | **落地**（英文标记、创建时一次性写入双持久化点） |
| B2 | 未变化注入帧折叠为 `[unchanged: sha1:…]` stub | **移除**（宿主从不"可见时重注"→ 零节省；stub 会偷走 #93 的 newest-row pin → 净损失） |
| B3 | compress 每 range 附 `verifiedReadings` | **落地**（随 rawOutput ledger 持久化——绝不顶层成员；compress 结果回显 `verified: …`） |
| B4/B5 | 状态面（state face）微调 | 随实现保留在 nudge/index 接线中（无独立语义变更） |
| B6 | nudge 瘦身（哲学/规则段移出正文） | **落地**（kernel 路径与模板路径同摘；系统提示不变） |

## 1. B1 —— 摘要标源

### 问题
模型自写的压缩摘要里常出现义务句（"必须 X"、"不要 Y"——从被压缩的用户消息蒸馏而来）。摘要本身是模型转述，不是用户原话；模型若把其中的义务句当成用户当前指令直接执行，等于让旧上下文里的二手指令继续驱动行为。

### 方案
`src/messages.ts` 导出 `SUMMARY_FRAME_PREFIX = '[Model-written summary — not user words; re-verify any obligations before relying on them]'` 与幂等的 `withSummaryFramePrefix(text)`。

写入点（**创建时一次成型**，两处持久化文本完全一致）：
- `runCompactionTransaction`（src/region.ts）：`const framedSummary = prefixSummaryBlocks(input.summary)` 同时作为 `compaction/summary` 事件的 `summary` 字段与 checkpoint 节点（`user/message`, `source.plugin === 'compact'`）的 content。事件与节点不一致会让 decompress 头行与投影文本分叉（评审 P2）。
- 投影路径（`projectEvent`）：对 checkpoint 节点（`isCheckpointNode`：`user/message` 且 `source?.plugin === 'compact'`）补框——幂等，仅为**升级前的旧块**兜底。新块到达投影时已带框，`withSummaryFramePrefix` 直接返回原文。

评审修正：
- 原实现用私有谓词 `isCompactionCheckpoint()` 重复了 `isCheckpointNode` 的判断——删除，单一谓词（评审 fix #5）。
- 原中文标记改为英文：工具输出（decompress 头行、nudge breakdown、acp_status 块行）整体是英文词汇表，中文标记在其中是异类（评审 fix #8；若后续要本地化应整表一起做）。
- 真实用户消息（`source.kind === 'user'`）**永不加框**（tests/injection-governance.test.ts B1-4）。

## 2. B2 —— 未变化注入帧折叠：**为什么移除**

PR 原设计：`agent/pre-step` 时，若注入帧（agent-instructions / skill-catalog / runtime / runtime-context）的 `kind+sha1(文本)` 在 surface 上仍有可见副本，则把本次注入替换成 38 字节的 `[unchanged: sha1:<12hex>]` stub。

移除依据（逐条可复验）：

1. **零节省**：宿主没有任何通道会在"相同副本仍可见"时重注。
   - runtime/dynamic-context 快照：`dsh-agent-loop` 的 `RuntimeContextProjection` 有 retained-check（`if (this.retained?.text === snapshot) return;`）——相同快照不重发；只有副本被 shadow 后才全量重注（此时原设计也要求全量，stub 不适用）。
   - agent-instructions：注入器在宿主 web bundle（npm seam 不可见），但 #93 与 rule 16 的线上审计已确立同一 presence gate——当前副本离开 surface 才重注。
   - 作者自己的线上审计（PR OP）同样记录：观察到的重注全部发生在旧副本被压缩之后，**节省字节数 = 0，且发生 2 次内容丢失**。
   - 维护者评审的问题 1 即以此为准绳："If none, B2's byte savings are zero and I'd drop it."
2. **stub 会偷走 #93 的 newest-row pin（净损失路径）**：v0 冻结读取器对 `kind:'agent-instructions'` 校验 EXACT keys `{kind, form:'instructions', changes[]}`，每个 change 含 `scope`/`path`。原 stub 用对象展开保留了 `source`（含 `changes[].scope`），于是 stub 成为该 scope 的最新指令行 → 被 `newestInstructionSeqsOf` 钉住受保护，而真正的完整副本沦为 stale 副本 → 可被压缩 → 压掉后 surface 上的 AGENTS.md 字节归零，且因 presence gate 按身份判定、stub 携带身份，宿主不会补注。
3. **白名单与真实形态错位**：真实 runtime-context 帧携带 `kind:'plugin'` + `plugin:'@deepseek-ai/dsh-system-prompt'`（`form:'snapshot'`），而 `DEDUPE_SOURCES` 只匹配 `source.kind ∈ {agent-instructions, skill-catalog, runtime, runtime-context}`——两个 kind 在整个 npm seam 中不存在。即 B2 最多只对一种真实帧生效。

结论：B2 在当前宿主契约下**只产生风险、不产生收益**。若未来宿主真的引入"可见时重注"通道，应按当时的真实 `source` 形态重新设计（stub 不得携带 `changes[]` 身份，且须分类为 engine metadata 而非 instruction），届时另开 issue/PR。

## 3. B3 —— verifiedReadings（已核实读取记录）

### 问题
长会话中模型反复读同一批文件来"确认"细节。压缩时若把"我读过并核实过什么"丢掉，后续回合只能重读。

### 方案
- `compress` 的每个 content item 增加可选 `verifiedReadings: string[]`（schema 保持 `additionalProperties: false`，tests/g5-governance.test.ts B3-4 锁定）。
- **持久化纪律（rule 15 / issue #141）**：v0 冻结读取器对 `compaction/summary` 做 EXACT member allow-list 校验，任何顶层新成员都会让升级前日志在宿主切换读取器时 brick。因此 `verifiedReadings` 作为第七个字段进入 `encodeAcpBlockLedger` 的 rawOutput 命名空间 JSON（`$dshAcpBlockLedger`, version 1；空数组省略），**绝不写顶层**。
- 读取面：`verifiedReadingsOf(event)`（src/region.ts）= `decodeAcpBlockLedger(data.rawOutput).verifiedReadings ?? data.verifiedReadings`（legacy 顶层回退），`Array.isArray` 守卫、永不抛错（非摘要事件返回 `[]`）。`rebuildBlockLedger` 同步提取进 `AcpBlockLedgerEntry.verifiedReadings`。
- **可读性（评审 fix #6）**：compress 结果按块回显 `, verified: <a; b>`（仅非空时），否则该数据模型可见但永不被看见——纯负债。

## 4. B6 —— nudge 瘦身

- `src/nudge.ts` 导出 `stripNudgeGuidance(text)`：摘除 `COMPRESS_PHILOSOPHY` / `HOW_TO_COMPRESS_RULES` / `TIER2_DISTILL_RULES` / `TIER3_CONDENSE_RULES` 四段（这些已在系统提示里，每次 nudge 重复一遍纯属浪费），随后折叠多余空行并 trim。
- kernel 默认路径（`adaptKernelNudgeToSeq`）与模板路径（`renderNudgeFromTemplates`）都应用——模板槽位由宿主覆盖时同样生效（独立复核发现的软缺口，B6-4 测试锁定）。
- 实测（probe，12 节点会话）：正文（`Surface:` 之前）≈ 224 字节 ≤ 300 预算；触发框架句与 `Context breakdown:` 保留。
- 测试纪律：断言 pin **真实渲染输出**的子串（框架句、breakdown 存在；哲学/规则缺席），不用"用常量拼输入再断言常量被摘掉"的同义反复形式。

## 5. 验证

- `npm run typecheck` ✓；`npm test` 273/273 ✓（含 tests/injection-governance.test.ts B1-1..4、tests/g5-governance.test.ts B3-1..4/B6-1..4 重写版、tools.test.ts M3 头行断言更新）；`npm run build` ✓；`npm run test:e2e` ✓（4 场景全 PASS）。
- dist/ 不进 PR（dist-bot 合并后刷新；AGENTS.md §5）。
