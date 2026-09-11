# 图片与文件块的可见性设计（issue #117）

## 问题

DSH 会话里 `image` / `file` 块没有字符内容，而引擎的每一层都用文本估算器看会话。一个块没有字符，于是：

1. **投影丢弃**：`extractText`（`src/messages.ts`）只取 `type: 'text'` 块，图片/文件块静默丢弃；`projectEvent` 对"图片-only"的 user 消息返回空数组 —— 这条消息在 acp-kernel 视图里**根本不存在**，没有 ref，因此
   - 不能作为压缩边界：`hasPlainRef`（`src/region.ts`）要求事件文本非空，于是 `resolveSurfaceRange` 向内收缩时越过它、把邻接内容一起吞掉；收缩失败时报的却是 "no tool-pairing-balanced range"（与真因无关）；
   - 不受内核保护：`handleCompress` 交给内核的 `coreMessages` 里没有它，内核的"最近尾 + 最近一条 user 消息"保护（`protectedMessageIds`）看不到它 —— **截图会话里最后一条消息常常就是图片-only 的提问，它可以被整段压掉**。Dousy 侧的"最后一条真实 user 消息"保护只在范围表路径（`buildCompressibleSeqRanges`）生效。
2. **两套标尺混印**：nudge 的压力闸门用 `resolveTokenCount` → `sessionProjections.contextPressure.projectedTokens`（provider 口径，含图片 token），而 `acp_status` 的上下文分解、nudge 范围表、`/acp status` 的块统计全部用 `defaultCountTokens(extractEventText(...))`（纯文本口径）。picture 密集会话里两条数字来自两个世界，偏差约等于所有图片的价格（单张图千级 token 被记 0）。
3. **压缩优先级误导**：范围表按 tokens 排序，图片密集区间显示 ~0 token，模型于是优先压"看起来最不占空间"的内容。
4. **召回静默丢失**：`decompress` / `search_context` 都走 `extractEventText`，恢复出来的文本里图片上下文整体消失。

## 方案选择

| 方案 | 结果 |
| --- | --- |
| A. 投影层为图片/文件块生成确定性占位文本（**采纳**） | 同时修好 ref、边界、内核保护、范围表计入、搜索/恢复可见性 —— 一处改动，四个断点全解 |
| B. 只做定价（不投影） | 治不了 ref/边界：消息在内核视图里不存在时**根本无法被压缩**，也无法进入 `effectiveMessageIds` |
| C. 等宿主/内核给多媒体一等支持 | `acp-kernel` 的 `countTokens` 边界是 `(text: string) => number`，内核拿不到媒体；宿主侧改动无期限 |
| D. 只在 `acp_status` 里标注两套标尺 | 诚实但没用：结构性问题一个没修 |

选 A 的理由：它**不是新约定，而是照抄宿主自己的做法** —— `@deepseek-ai/dsh-llm` 的 `FileBlock` 文档块写明：文件永远不会原样送到 provider，因为 "request assembly projects every occurrence to deterministic handle text (name, byte size, read-only saved path)"。引擎对图片/文件做同样的事，宿主与插件就只有一个投影约定。

## 实现

| 位置 | 改动 |
| --- | --- |
| `src/messages.ts` | `extractText` 对 `image` / `file` 块（任意嵌套深度，含 `tool-result` 的 `content`）生成占位符 `[image <mediaType> <name?> <WxH> <size>]` / `[file <name> <size>]`；`formatBytes`、`attachmentPlaceholder`（形状不符时返回 null，贡献空串而不造假数据）；`countAttachmentBlocks` / `countAttachments` / `attachmentsOfEvent` 用于统计（生产路径不分配对象） |
| `src/region.ts` | `MediaPriceOf` 类型 + `SeqCompressibleRange.images/files`；`compressibleSegmentsOf` 接受 `mediaPriceOf`，对**含媒体的 seq** 才调用一次并加到该事件 token 上；范围行渲染 `[+N images \| +M files]` |
| `src/host-tokens.ts` | `TokenMeterLike` 增加 `imageStructuralTokens` / `fileStructuralTokens`；`mediaPriceViaMeter(session, ctx)` 读宿主 meter 的路由结构价（只列含媒体的 seq，meter 缺失/抛错时返回空 Map，静默降级） |
| `src/nudge.ts` | `mediaSuffixOf` + `meterMediaPriceResolver(agent, session)`；`rangeTable` / `buildNudgeText` / `adaptKernelNudgeToSeq` / `renderNudgeFromTemplates` 贯穿 `mediaPriceOf` |
| `src/prompts.ts` | 范围表行模板新增 `{media}` 槽位（默认模板同步） |
| `src/tools.ts` | `acp_status` 在表面含媒体时补一行标尺说明：压力行是 provider 口径（含图片/文件的路由价），上面的分解是纯文本估算 —— 无媒体时保持内核报告原样 |

## 为什么价格来自 meter 而不是文本估算

没有文本估算器能算出图片的 token：`defaultCountTokens` 只认字符。宿主 token-meter 已经把媒体按**路由结构价**（`imageStructuralTokens` / `fileStructuralTokens`，由 provider adapter 声明的视觉价与附件元数据得出）单独记账，引擎直接读它，就不再需要猜。这是展示口径（nudge 百分比、范围表排序）；写入宿主事件的影子价格（`shadowedTokenCount`）仍然遵守规则 12 的宿主词汇 —— 三处写入点的口径未被本次改动触碰。

## 验证

- `npm run typecheck` 干净；`npm test` **324/324**（新增 `tests/media-visibility.test.ts` 6 个用例）。
- 变异验证（故意改回旧行为必须变红）：删掉 `extractText` 的占位分支 → 2 个用例红；把媒体价从 token 累加里去掉 → 1 个用例红（断言比较"同一区间 +1500 vs +0"的差值，最初的 `>= 1500` 写法在去掉价格时仍然通过，已被替换）；去掉 `acp_status` 的标尺说明 → 1 个用例红。
- 测试夹具教训：范围表会保护"最近 5 个 surface 节点 + 最后一条真实 user 消息"，4 个节点的会话**一个可压区间都没有**（静默产生 0 个范围），因此媒体夹具用 15 个节点、图片放在前段。

## 边界与未做的事

- 未知或形状不符的附件不生成占位符（不猜、不抛错）；`tool-result` 内嵌媒体与顶层媒体走同一条递归。
- 无媒体的会话不做任何额外测量（nudge 里 meter 最多测一次，`/acp status`、`decompress`、`search_context` 完全不碰 meter）。
- 逆投影（从占位符还原图片字节）不做：`decompress` 恢复的是原文事件（图片块本身还在日志里），占位符只影响文本面。
- 逐会话缓存媒体价（每次 nudge 一次 meter 测量）未做 —— 目前每次 nudge 一次测量，够用；如果将来出现大会话的测量开销，可在 `CompactionState` 之外按 snapshot 缓存。
