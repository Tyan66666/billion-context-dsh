# 跨 carrier 范围的切分设计（carrier span split design）

> **状态**：已实现（issue [#214](https://github.com/Tyan66666/billion-context-dsh/issues/214)，作者 @LDyty）。
> **背景**：acp-kernel 0.0.101 起，宿主通过 `CoreMessage.summaryOfBlockId` 声明 checkpoint 是存活块的载体，内核在 plain 范围里保留该载体可见。引擎侧的门禁此前是**硬拒**：plain T1 范围一旦跨过一个存活块的 checkpoint，整个调用被拒。

## 0. 结论先行（TL;DR）

- **新配置键 `carrierSpans`**（`'split' | 'reject'`，默认 `'split'`），仅 composition 行可用，不进 `/acp-prune config` 面（先例：`maxOverflowRetries` / `settingsEnabled`）。
- **行为变更**：默认从「整体硬拒」变为「按 carrier 切开、两侧分别折叠、carrier 保持可见」。旧行为用 `carrierSpans: 'reject'` 原样恢复，无需迁移。
- **不变量（两种策略都成立）**：plain 范围永远不会折掉存活的 carrier；蒸馏（`bN..bM`）仍是显式动作。

## 1. 问题：硬拒之后模型原样重试同一个 span

实测（2026-10-13，DSH 0.2.1-alpha.2 / v0.2.27 / kernel 0.0.101，一个长 CJK 会话）：**12 次 carrier 拒绝，其中 2 次是同一个 span 原样重试**——模型被拒后没有换目标，整轮效率明显下降。

根因是两个「可压范围」来源的语义不一致：

| 来源 | 在 carrier 处断开？ |
|---|---|
| nudge 范围表（`buildCompressibleSeqRanges`） | ✅ 在 checkpoint 处 flush segment，从不给出跨 carrier 的段 |
| `acp_status` 的 ranges 视图（kernel `buildStatusReport`） | ❌ `handleStatus` 必须先把 checkpoint 节点过滤掉再喂给内核（否则摘要文本会被 breakdown 双计——rule 9），而内核按数组相邻性分段：carrier 左右两侧在过滤后的数组里变得相邻，被合并成**一行跨 carrier 的范围** |

模型是从 `acp_status`（以及其 `mN` 引用回流进 `compress`）学会范围取名的——它照着 listing 取的跨度注定跨界、注定被拒；被拒后再看同一条 listing，自然再来一次同样的跨度。硬拒只是把「拿不到 token」换成了「反复撞墙」。

## 2. 为什么不直接修 listing（issue 建议 2）

让 `acp_status` 的 listing 也在 carrier 处断开在方向上是对的，但单独做不够、且做不快：

1. **rule 9 边界**：报告正文由 kernel `buildStatusReport` 生成，引擎只允许 append、不改写。引擎侧无法把内核已合并的行重新拆开而不重写内核文本；正确的修法在内核（感知 carrier 标记后在分段处断开），属上游改动，有发布时延。
2. **治标不治本**：即使 listing 对齐了，模型仍可以**自己命名**任意 seq（nudge 表之外的跨度、记忆里的旧边界）——跨界调用依然会发生，门禁本身必须能体面地处理它。

因此主修法是**让门禁变宽容**（split），listing 对齐降级为两条辅助措施：`acp_status` drilldown 追加一行 `Carrier boundaries:`（append-only，符合 rule 9），上游对齐留在 issue 线程跟踪（同一症状家族，不另立项）。

## 3. 设计

### 3.1 配置键

`carrierSpans: 'split' | 'reject'`，默认 `'split'`。`resolveAcpConfig` 构造期校验（未知值抛错并列出合法值，与 `preset` 拼错即报错同一约定），并把校验后的值写回快照（显式 `undefined` 不能穿透 spread 读成缺省）。不进 settings 六键面：它是「自动动作的形状」而非「压力阈值」，与 `maxOverflowRetries` 同类。

### 3.2 split 机制

1. **检测**：`liveCheckpointCarriersInSpan(session, shadowedSpan)`（src/region.ts）——活跃块的 compactionId → 落在 span 内的 checkpoint seq（`{seq, kernelBlockId}[]`）。
2. **切分**：`carrierSideSpans(shadowed, carriers)`——把位置切片（= surface 相邻性）切成若干最大连续非-carrier 段，surface 顺序返回，未再平衡（原始边）。
3. **有界再平衡**：`resolveSurfaceRange(session, start, end, { expandBounds })`——新增可选参数，只约束第二趟**向外扩展**的窗口（向内收缩不受影响，它只会往内走）。每侧的扩展被钉死在自己那段的索引窗口内。
   **为什么钉死是完备的**：一个 tool pair 不可能跨越一个已解析的平衡边（call/result 之间的切口不配对平衡，而已解析边必须是平衡切口），也不可能跨越一个 carrier（宿主只在平衡的步骤边界写 checkpoint，我们的事务只替换平衡 span）——所以任何合法的再平衡目标都落在段内；非法状态（如孤立的半对）在该侧干净失败并给出指引，而不是悄悄把 carrier 卷进来。
4. **落地**：
   - **compress 工具路径**（`handleCompress`）：各侧作为额外 range 条目进入同一批（ref key 去重对全批生效），`applyCompression` 之后逐块事务；每侧成为独立的 kernel block + 独立 durable 事务。
   - **`/acp-prune compress` 命令路径**：逐侧立即执行 plain T1 事务（不经内核，与该路径既有的单事务形态一致），每侧独立计价（`shadowedTokensViaMeter`）。
   - **部分失败隔离**：某一侧不可解（已压缩 / 无平衡切口）只记 advisory note，不毒化整批；零侧落地才回退到完整拒绝文案。
5. **报告**：结果里点名哪些 carrier seq 保持可见、建议之后用块 id 蒸馏；两侧的折叠各带模型自己给的那份摘要。

### 3.3 reject 策略（旧行为，note 升级）

`liveCarrierRejectionNote` 现在同时给出两个可执行出口：① 蒸馏调用（`compress({ content: [{ startSeq: "b1", endSeq: "bM", summary }] })`，多 carrier 取最后一个作 end 边）；② **精确的两侧切片**（`or compress the sides separately (seq A..B and C..D) as separate content entries, each with its own summary`）。旧版那句含糊的「cut the span around those seqs」正是重试循环的燃料——模型照它重试的仍是同一个跨界跨度。

### 3.4 acp_status 对齐

`scope: 'uncompressed'` drilldown 在有活跃 carrier 时追加一行（append-only）：

```
Carrier boundaries: seq 15 (b1) — a plain span crossing one is split around it; the carrier stays visible.
```

（reject 策略下措辞为「is rejected; cut around those seqs or distill with the block ids」。）listing 从此与门禁在语义上一致——模型至少知道哪里有界、越界会发生什么。

## 4. 不变量与取舍

- **不变量**：无论哪种策略，plain 范围都不折掉存活 carrier；guarded 行（当前指令行、最后真实 user turn，rule 16/#196）的优先级高于 split——它们命中时整段照旧拒绝。
- **取舍**：模型的一份摘要会在每个侧块里重复一份（创建时的语义冗余；T2/T3 蒸馏之后可以合并）。换来的是：不再有任何「注定被拒的合法请求」，carrier 的可见摘要也不会在跨段折叠中静默消失。
- **行为变更披露**：默认 `reject` → `split`（旧值→新值 + 原因见 §1）；无迁移成本；逃生开关 `carrierSpans: 'reject'`。

## 5. 验证

- `tests/carrier-split.test.ts`（8 例）：split 默认（2 侧块 + carrier 可见 + 结果点名保留 seq）、双 carrier（3 侧块）、显式 reject（0 块 + 可执行两侧切片文案）、guard 优先于 split、同批去重（跨界 span + 显式子 span）、`/acp-prune compress` 两策略、`acp_status` 边界行两策略、`resolveAcpConfig` 校验（默认/回环/显式 undefined/未知值抛错）。
- `tests/checkpoint-span.test.ts`：两条 reject 契约测试改为显式 `carrierSpans: 'reject'`（契约本身不变：resolver 永不交出 checkpoint ref、carrier 存活且带块 id）。
- issue #214 的实测数据（12 拒 / 2 原样重试）作为动机锚点。

## 6. 残留

- **上游**：acp-kernel 的 ranges 视图若能在 carrier 标记处断开（#335 同家族），listing 就彻底一致了——跟踪在 #214 线程内（同一症状家族，不另开 issue）。即使落地，split 默认仍然正确：模型自命名跨度的可能性永远存在，门禁的宽容处理是长期形态。
