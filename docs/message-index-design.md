# 每消息编号索引（acp-index）设计 — v1

> 对应 issue #71。模块：`src/message-index.ts`（M6），接线在 `src/index.ts` 的 `agent/pre-step` 监听。

## 1. 要解决的问题

模型拿到的压缩引用是 **seq 范围**（nudge 可压缩范围表的 `{start,end,count,tokens,toolPct}` 行、`acp_status` 钻取的内核 mN 行、compress 结果回显的真实边界），但这些 id 与具体内容之间的绑定很弱：

- 范围表每行只有统计三元组，没有文本；模型无法判断「1..96 当中哪些需要压缩、哪些不需要」。
- `acp_status` drilldown 每行只有 `(mN, tokens, tool)`，没有内容预览。
- 压缩结果回显只有边界 seq。

上游 billion-context-pi 的答案是**内联 `<acp>` 标签**：每条消息前挂编号，模型永远能把 id 对回看过的原文。本设计把同一能力移植到 DSH 的架构约束下——不是改范围表（那是被否决的方向，见 §3），而是给**每条消息**一个可对位的编号目录。

## 2. 宿主约束（三堵墙，均已验证）

DSH 无法走 pi 的内联标签路线，因为模型可见内容只有一个合法写入通道——会话日志本身：

1. **投影冻结**：`Session.deriveMessages()` 是纯投影且输出 deep-frozen（dsh-session `lib/types/index.d.ts:256`，注释原文 "consumers still cannot mutate the log"）——没有请求期注记缝。
2. **pre-step 只能追加**：插件返回 `{kind:'enter', messages}` 只能向收件箱追加新消息，不能注记已有消息（@deepseek-ai/dsh-agent `lib/types/runtime-types.d.ts:228`，pre-step 契约）。
3. **明令禁止改写**：`agent/request` 瀑布规定 "Model-visible content must use logged channels"（@deepseek-ai/dsh-agent `lib/types/runtime-types.d.ts:246`）；唯一写入路径是 `session.append` 持久事件（append 时 deepFreeze，dsh-session `lib/index.js:1157`）。

结论：编号必须作为**持久化日志事件**存在。这就是「本地账本」路线（**路线 B**）：引擎在 adapter 层把编号写成自己的持久化插件 user 消息——账本归本仓库所有，格式与节奏由 `src/message-index.ts` 定义。与之相对的路线 A（向 acp-kernel 提议内核级装饰钩子）被用户否决暂不走（见 §3）。用户拍板：「行吧，那就只走路线 B 吧。」

## 3. 已否决的替代方案

- **范围表文本锚点**（issue #71 初版：每行加首条/末条/最大成员预览）：用户否决——未压缩过的会话 nudge 表本来就整段可见，「给他再加一个开头结尾有什么用呢？我们的理念其实是……模型得知道这个东西（逐条哪些要压哪些不压）」「我觉得这样的设计越来越偏离内核了……得想一些方法去实现派上面的设计，给每个消息前面加一个编号」。技术 blocker：锚点须取 `resolveSurfaceRange` 之后（它会内移/外扩扫描期边界）。该方向已在 issue #71 正文记录为 blocker 后废弃。
- **上游提案（路线 A）**：向 acp-kernel 提议装饰钩子。用户决定暂不走上游，只做本地落盘账本。

## 4. 设计

### 4.1 数据形状

每次 pre-step 追加**一条**插件 user 消息，单行列出上一条索引之后新出现的每个 surface 节点：

```
[acp-index] 12·user「帮我跑下测试」 13·asst「先看配置…」 14·tool bash「ls」 15·result bash「file-a file-b」
```

- 标签：`user` / `asst` / `tool <name>` / `result <name>`。真实 `tool/result` 事件不带工具名（AGENTS.md 规则 10），名字经 `buildToolCallIndex` + `toolCallIdOfResultEvent` 从 assistant tool-call 索引回填——与投影共用同一实现（`src/messages.ts`）。回填不到名字时降级为中性 `tool` / `result`；无法识别的事件类型一律标 `note`，不向模型泄漏原始 event.type。
- 无文本节点保留裸条目（`16·tool`），不丢 seq。
- `source:{kind:'plugin', plugin:'acp-index', form:'catalog'}`——dsh-llm 的 `MessageSourceMap.plugin` 支持 `ContextFormed` 扩展，声明 `catalog` 后宿主 UI 可将目录行识别为目录类消息（折叠渲染等）；谓词 `isIndexMarkerEvent` 在 `src/messages.ts`（从 region.ts 私有副本上移为单一实现）。

### 4.2 水位：marker 自身 seq

`indexWatermarkOf(session)` 从**日志尾**回扫找最近的 acp-index marker，其自身 seq 即水位。「待索引」= surface 上 `seq > 水位` 的节点。两个要点：

- **无需解析头部**：marker 追加在它所索引的全部内容之后，所以 marker seq 天然大于它索引过的一切。
- **回扫日志而非表面**：压缩会把旧表面节点替换成 checkpoint 节点；若扫表面找 marker，压缩吞掉 marker 后水位会退回 0，导致已遮蔽内容被重新索引（其 seq 在新表面上已无法解析）。扫日志则水位恒定有效。测试覆盖：真实压缩吞掉 marker 后仅索引新节点。

### 4.3 压缩后的连续性

- 旧索引行是普通可见消息，随被遮蔽原文一起进入块摘要——定位职责交给摘要，与 pi 的标签消失进摘要同理。
- 新行从最新 live seq 继续编号：**id 空间跨压缩保持连续**（seq 是追加式日志索引，永不复用）。
- checkpoint 节点与 marker 自身被索引器跳过（`isCheckpointNode` / `isIndexMarkerEvent`），摘要节点不会出现在目录里。

### 4.4 预览：token 预算截断（规则 1）

- `flattenPreview`：控制字符 → 空格、引号族（`「」"'‘’`）→ `'`、全角间隔号 `·` → `,`——弯引号会破坏引号对位、`·` 会伪造条目定界符，两者都必须映射走；再折叠空白串。
- `truncateToTokenBudget(text, maxTokens)`：先按 ~`maxTokens*4` 字符粗剪短路（`defaultCountTokens` 下 L 字符 ≥ L/4 token，粗剪不可能丢掉预算内的内容，避免对超大单节点做全文二分），再二分找「预算 −1 token 内最长前缀」补 `…`；二分切点落在代理对高半区时回退一位，不产生 U+FFFD。**按 token 不按字符**——CJK 是 1 字/token，按字符截断会让中文预览实际花费 4× 预算。非有限或 <1 的预算返回空串。
- 默认 `previewTokens: 16`（含省略号）；配置值钳制 ≥0（floor），修正时 `console.warn`。
- **大头标记**：预览是 token 预算截断的——一条 8000 token 的工具转储和一句短注记渲染后一样长，模型看不出「谁是回收重点」。条目按 `defaultCountTokens` 估算文本 token 数，≥512 时附 `[N tok]` 后缀（≥1000 显示为 `[X.XK tok]`），把大小信号补回来。**未标注的唯一含义是「低于阈值」**：条目仍带预览文本（有预览 ≠ 空内容，也不会被读成零 token），精确大小随时可经 `acp_status` 钻取（`mN, tokens`）。阈值是常量（`LARGE_ENTRY_MIN_TOKENS = 512`），不重复 drilldown 的全量精确表。

### 4.5 稳态无上限，积压占位降级

稳态批次刻意不设条目数上限：丢条目 = 该 seq 在目录里永久失联。成本实测 ≈27 tokens/条目（seq·label·预览开销），一批新节点通常个位数到十位数。

真正的风险是**水位停旧**——冷启动接入存量会话、或长期关闭后重新开启时，一条消息要吞下全部积压：按 27 tok/条，2000 节点 ≈ 55K tokens（128K 窗口的 43%），数千节点直接越过 provider 上限；且 marker 已持久化，模型连压缩自救的入口都没有（巨行每步复现）。守卫：待索引条目超过 `backlogLimit`（默认 100 ≈ 2.7K tokens）时改发**单行占位 marker**：

```
[acp-index] 12..4300 — 4289 earlier messages already exist, listed by seq only (inspect via acp_status, compress to archive)
```

占位行自身就是合法 acp-index marker，其 seq 成为新水位——下一回合起恢复正常逐条编号；被跳过的 seq 仍可经 acp_status 钻取与压缩摘要定位。

### 4.6 接线（src/index.ts pre-step）

```
stripOrphans → await next() → reject 直通
→ 目录行门控：payload.messages.length > 0（本步从收件箱认领了输入）才构建索引消息   ← per-turn 节奏
→ extras = [索引消息?, nudge?]        ← 索引在前（参考数据），nudge 在后（行动请求）
→ 无 extras 返回原 decision
→ 否则 {kind:'enter', messages:[...decision.messages, ...extras]}   ← 共用一次 enter
```

- **per-turn 门控**：dsh-agent-loop 的每个工具续步都会过 pre-step，但只有认领了收件箱输入的 step 才发目录行——模型内部工具循环不注入（否则短消息会话 token 通胀 30–60%）。回合内工具步骤的新消息由下一回合首条目录补编。空批唤醒轮同样静默。nudge 不受此门控影响。
- 共用同一次 enter 决策：收件箱批次只替换一次；pre-step 先于本步任何工具调用运行，持久追加位置安全（绝不会插进 tool-call/result 之间），与 nudge 多年使用的信封相同。
- **保护尾与统计的通用判据**：`buildCompressibleSeqRanges` 的保护尾回扫和范围统计用 `isPluginAuthoredEvent`（`event.data.source?.kind === 'plugin'`）跳过**一切**插件 authored 行（索引 marker、nudge、pair-hide 替换消息；checkpoint 单独处理）——只跳 marker 不够，插件行排在真实用户消息之后，会把最新人类指令顶出 preserveRecent 窗口、并稀释范围表的 toolPct 统计（src/region.ts:780/:798）。面向未来：宿主以后新增任何插件消息自动被同一判据覆盖。
- **增量工具名索引**：回填用的 tool-call 索引按会话增量维护（模块级 `WeakMap<Session, {scannedUpTo, index}>`，日志只追加单调），pre-step 不做全量重扫；检测到日志缩短（新 Session 复用 id 等防御场景）时重建。

### 4.7 计入原则：压力照算，搜索排除

索引行是普通可见 token，**压力记账照算**（占用率真实反映模型所见）。唯一例外是 `search_context` 的文档集**排除目录行**（src/tools.ts `buildSearchDocs` 过滤 `isIndexMarkerEvent`——adapter 组装文档集的职责，不动内核算法，不违 AGENTS.md 规则 6/7）。原因：目录行是 kitchen-sink 长文，而内核对 user 角色加权 1.5×（hybrid = 0.7×BM25 + 0.3×fuzzy bigram），被遮蔽后仍留在文档集里的 marker 会结构性垄断 top-k——实测查询 "error" 时 8 条 marker 以 1.500 分占满前五名、真命中（tool 文本含 ERROR）反而落榜。设计初版「命中一行 `[acp-index]` 本身就是定位器、是特性」的前提在内核加权现实下不成立，故收紧。可见（未被遮蔽）的目录行不受影响：它们本来就是当轮的参考数据。

## 5. 已知语义边界

- **滞后一轮**：触发本轮的用户消息在 pre-step 时还未入日志，所以本轮注入的索引不含它；它的编号在下一轮补上。**per-turn 节奏放大了这一点**：回合内工具续步产生的新消息同样等到下一回合首条目录才入册。两者同源——追加式日志的固有顺序，非缺陷。
- **re-enable 空洞**：`enabled:false` 期间积累的消息没有逐条编号；重新开启后的第一批若超过 `backlogLimit` 会以占位行一次性翻页（§4.5），占位行成为水位后恢复正常逐条编号。空洞内的 seq 靠 acp_status 钻取与压缩摘要定位。
- **配置合并**：`resolveMessageIndexConfig` 逐键取默认并钳制非法值（宿主写 `{messageIndex:{enabled:false}}` 不会因浅合并丢掉其余键的默认值；非法 `previewTokens`/`backlogLimit` 回退默认并 `console.warn`）。
- **关闭即完全静默**：`enabled:false` 时不追加任何索引消息（连空行也没有）；开启但无新节点时同样返回 null 不产空行。

## 6. 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `config.messageIndex.enabled` | `false` | 是否在 pre-step 注入编号目录（每回合一次）；早期版本默认关闭（opt-in），手工开启 |
| `config.messageIndex.previewTokens` | `16` | 单条预览的 `defaultCountTokens` 预算（含省略号）；非有限数→默认并 warn，有限则 floor 且 ≥0 |
| `config.messageIndex.backlogLimit` | `100` | 单条目录消息的最大条目数；超过改发占位 marker（§4.5）；非有限或 <1 → 默认并 warn |

## 7. 测试

`tests/message-index.test.ts`（13 用例全绿）：标签与预览/裸条目形状；CJK+ASCII token 预算、引号压平映射与预算边界（0 关闭 / 恰好 / 截断 / 代理对）；水位推进不重索引与多 marker 稳态（尾扫取最新）；checkpoint/自身标记跳过 + disabled + 部分配置默认保留与钳制；真实压缩吞掉 marker 后仅索引新节点；60 节点单消息不变量；backlog 占位降级与恢复；退化标签（裸 tool/result/note）与 form:'catalog' 声明；preserveRecent:0 下保护尾跳过插件行判别；search_context 排除被遮蔽 marker 行且真命中照常上榜；**大头 `[N tok]` 标记**（K 缩写、阈值恰好、CJK 计 token、子阈值与空文本不标）。另更新 `tests/prompts.test.ts` 用例 14（engine-level）：payload 补齐真实 PreStepPayload 形状（含认领的 `messages`），断言 enter 决策含 2 条 extras 且**索引先于 nudge**（顺序契约的引擎级守护）。

## 8. 重评门（upstream re-evaluation gates）

本设计是 adapter 层职责（AGENTS.md 设计决定 7：adapter-layer work is not a workaround），不是 `UPSTREAM:` 标注的临时变通。但以下任一条件成立时应重评：

1. **宿主提供请求期改写钩子**（decorated projection / 允许注记 deriveMessages 输出）：内联 `<acp>` 标签方案重新可行且更优（零持久 token 成本），应迁移并废弃本模块。
2. **acp-kernel 提供 per-message ref 目录能力**（如 pi 标签的内核版）：评估切换到内核实现，保持行为对齐。
3. **dsh-session 放宽投影冻结**：同 1。

在此之前，若发现本设计缺陷（如预览误导、水位错位），在本仓库内修——缺陷属于我们的账本格式，不属于内核。
