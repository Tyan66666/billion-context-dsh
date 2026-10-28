# 退化输出守卫设计（degenerationGuard design）

> **状态**：已实现（PR #231）。
> **来源**：issue #212（用户现场报告三种退化形态）+ PR #231。
> **背景**：长会话里模型会退化成两类：单字符/符号串连击失控，或「卡死收尾」——thinking 继续、可见正文为空、不再调用工具，靠回放自己的退化尾巴每轮自我再触发。billion-context-pi 有 `degenerationGuard`（纯函数折叠出站文本），本移植此前没有。

## 0. 结论先行（TL;DR）

- **检测在 `agent/pre-step`、先于出站请求构建**；`fold` 模式下通过现成的 `hideSurfaceSeqs`（prune 路径）把退化节点**持久遮蔽**——当轮即从出站视图消失，原文留在 append-only 日志，`decompress` / `search_context` 可恢复。
- **两个检测器**，各对应一类现场形态：run-length（单 codepoint 连击 ≥ `minRun`，默认 200）抓符号失控；structural（有 reasoning ＋ 可见正文空 ＋ 无 tool-call，连续 ≥ `foldMinConsecutiveRounds` 轮，默认 2）抓尾部续写卡死。
- **三态 `mode: off / observe / fold`，默认 `observe`**——只记 warn、零表面风险；`fold` 是一步配置翻转。未知 mode 字符串一律降级为 `observe`，绝不落到 fold。
- **恢复提示是固定文案，绝不内嵌重复样本**——回放引用会重新播种同一个吸引子（#212 的防传染约定）。
- **只管下一轮起的视图，管不住正在生成的流**——生成侧熔断是上游的另一半（A 半，已落在 ranxianglei/billion-context#3260 / PR #3289），不在本插件位置做。

## 1. 为什么不能照搬 pi 的做法

pi 的 guard 是**出站 assistant 文本的纯内存改写**——pi 自己拥有出站消息组装。DSH 的 CompactionEngine 位置拿不到这个能力：`dsh-agent-loop` 从持久化表面投影出站视图（`session.deriveMessages()`）并在 `llm.stream` 前 deep-freeze，中间没有任何插件可挂的改写钩子（设计决策 1「无 in-memory message rewrite hook」）。所以本守卫不重写历史 assistant 块，而是**在下一步之前把退化节点从持久化表面上拿掉**——对出站视图的效果等价（吸引子不再随请求回放），且走的是引擎已有的 durable 机制。

另一个接缝事实：DSH 的 assistant 回合带一等公民 `reasoning` 块，而投影层 `extractText` 故意丢弃它（纯 thinking 回合投影为空）。因此**检测读原始事件内容**（reasoning + 可见 text），不走投影后的消息列表。

## 2. 检测器与门槛

| 检测器 | 抓什么 | 触发条件 | 误报面 |
|---|---|---|---|
| run-length | 单字符/符号连击失控 | 最近 ≤6 个 assistant 回合中，任一**无 tool-call** 回合的 text/reasoning 出现单 codepoint 连击 ≥ `minRun`（默认 200，下限 8） | ≈0（200 连击不可能是健康内容），不加额外门 |
| structural | 尾部续写卡死 | 从最新回合往回走，连续 ≥ `foldMinConsecutiveRounds`（默认 2）轮都满足：有 reasoning ＋ 可见正文为空 ＋ 无 tool-call；配置了 `selfAbortPhrases` 时还要求其中一轮的 reasoning 含该短语 | 真实存在（正常长思考也可能瞬时空正文）→ 靠连续轮数门压住，短语门可选收紧 |

边界常量：`DETECTION_WINDOW = 6`（最多回看 6 个 assistant 回合）、`MAX_FOLD_NODES_PER_STEP = 4`（单次自动折叠的爆炸半径上限）。

## 3. 模式与默认值

- **`observe`（默认）**：命中只记一条 warn（含 kind 与 seqs），不改表面。误报的代价是一行日志。
- **`fold`**：每个合规节点单独走一次 `hideSurfaceSeqs(session, [seq], DEGENERATION_RECOVERY_NOTE)`；单个节点失败（如 seq 已离开表面）不中断其余节点。
- **为什么默认不是 `fold`**：#212 的校准数据来自用户导出件，缺 reasoning 层，structural 判据的**误报率无法从现有数据测出**。在误报面未知的情况下默认自动改表面 = 引入未知爆炸半径；`observe` 先攒误报证据，`fold` 一步切换。这是相对 #212 讨论中「默认开」的有意收紧，已在 PR 正文按行为变更规则披露。
- **未知 mode 值降级为 `observe`**（而不是抛错或落 fold）：配置来自 YAML，一个字符的笔误不该静默开启自动折叠，也不该阻断会话启动。

## 4. 安全不变量

1. **只折无 tool-call 的 assistant 节点**——折掉带调用的节点会孤儿化其结果，严格 provider 直接 400。
2. **恢复提示固定文案、不含样本**（describeChar-not-the-run 约定 + #212 §五防传染要求）。
3. **活性过滤**：durable 日志永久保留所有原文，检测必须限定在**当前表面仍可见**的节点上——已被本守卫折叠或被压缩吸收的节点不得重复触发（observe 下会每步重记日志，fold 下会反复重试被 reader 门禁拒绝的 prune）。structural 行走遇到非活动回合时**断链**而非跳过：一轮被折掉并投递恢复提示后，集必须在新活动回合上再次连续成立才行动——给提示一整轮的生效机会。
4. **写前校验**：`hideSurfaceSeqs` 内部先过 `isExactSurfaceSpan`（rule 20），不可能输入以干净零写入报错结束，不留死事务。
5. **可逆**：原文经 `decompress` / `search_context` 全程可达；折叠只是表面视图动作。
6. **pre-step 追加合法性**：与既有 `stripOrphanedSurfaceToolMessages`（同在 pre-step 写 durable prune）同一上下文，e2e 套件（wire 级字节稳定断言）覆盖。

## 5. 配置

组合行专用键 `config.degenerationGuard`（不进 `/acp-prune config` 六键面，同 `maxOverflowRetries` 先例——自动表面动作的开关不经运行时设置层热切）：

```yaml
config:
  degenerationGuard:
    mode: observe            # off | observe（默认） | fold
    minRun: 200              # run-length 阈值（下限 8，非法值回默认 200）
    foldMinConsecutiveRounds: 2   # structural 连续轮数门（下限 2）
    selfAbortPhrases: []     # 可选：非空时 structural 额外要求 reasoning 含其一
```

## 6. 本守卫治不了的一半

「正在生成时停不下来」（流持续出数据、分钟级失控）只能由**输出侧熔断**根治——那是宿主 LLM/adapter 层的能力（DSH Discussion #3946 的源码级排查结论），插件层的下一轮动作管不住正在跑的流。该半已在上游统一版落地：ranxianglei/billion-context#3260 / PR #3289。本守卫与其互补：上游止住流，这里清掉回放吸引子。
