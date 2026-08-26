# 注入行可压性分层设计（injection-row compressibility）

> 关联：AGENTS.md rule 3（范围表构成）/ rule 8（compress-pair stub）/ rule 11（UPSTREAM 追踪）；issue #71 v2。

## 1. 问题

nudge 的范围表（`buildCompressibleSeqRanges`，src/region.ts）历史上把 `source.kind === 'plugin'` 的行 `flush + continue`（不进任何可压范围），防止注入行污染真实段的 tool 占比。但这造成两个真实问题：

1. **元数据行「下不去」**：acp-index 目录行、nudge 回显、compress-pair stub 是引擎自己的小残影（150-300 tok/条），它们索引/回显的内容被压缩后就成了死重，但模型永远看不到它们可压——上下文里累积几百到几 K token 的死重。
2. **指令注入「漏网可压」**：AGENTS.md 全文注入（7.9K/条）的 `source.kind` 是 `'agent-instructions'`（变更重注入形态）或 `kind:'plugin' && plugin:'agent-instructions'`（基线形态），skill-catalog（1.3K/条）是 `kind:'skill-catalog'`——都不等于 `'plugin'`，所以它们被当普通 text 计入可压范围：模型压掉 AGENTS.md 后，宿主在文件 digest 变化前不会重注（按 digest 检测可见面），且压缩移除可见副本后宿主会立即重注（实测 20/43 条紧随 compact 块 7 个事件内出现）——「压指令 → 重注 → 再压」的循环让「注入越来越多」。

## 2. 分层分类：`classifySurfaceEvent`（src/messages.ts，单一实现）

所有消费点（范围扫描、保护尾、搜索文档集）共用同一函数：

| 分类 | 判别 | 处置 | 实例 |
|---|---|---|---|
| `metadata` | `kind==='plugin'` 且 `plugin ∈ {acp-index, acp-nudge, billion-context-dsh}` | **并入相邻真实段**（可压） | acp-index 目录行、nudge 回显、compress-pair stub |
| `checkpoint` | `plugin === 'compact'` | 排除（蒸馏是显式动作，规则 7） | 压缩摘要节点 |
| `instruction` | `kind==='agent-instructions'` / `'skill-catalog'`，或 `kind==='plugin' && plugin==='agent-instructions'`（基线形态，共享谓词 `isAgentInstructionsRow`）；外加宿主策略行（`@deepseek-ai/dsh-system-prompt`、`tool-jobs`、runtime-context 快照）；**任何未知名 `kind==='plugin'` 行** | 最新副本排除（不可压）；**重复旧副本 stale 可压**（v2.5）；其余排除 | AGENTS.md 注入两形态、技能目录、系统策略快照、job 通知 |
| `real` | 其余（真实 user/assistant/tool/result；含 subagent relay/notice） | 正常分段 | 对话与工具内容 |

**设计取舍**：`real = 其余` 的默认在 v2 中被推翻——未知名 plugin 行**保守落 instruction**（宁可多留一条不压，绝不误压；未来宿主新增注入形态不会静默漏进可压段）。宿主注入源契约：宿主新增注入 kind/plugin 名时必须同步此函数并补 fixture（见 §6 与 docs/dsh-porting-verification.md）。

**v2.5（AGENTS.md 重复副本 stale 可压）**：宿主按内容 digest 去重注入但**从不移除旧副本**——长会话累积重复的整份 AGENTS.md 行（实测本会话 10 条未遮蔽、86,450 tok 占表面 46.5%，仅 1 条是当前 digest）。宿主重注条件（deepseek-harness `packages/context/agent-instructions/src/index.ts:224-233` `syncInbox`）是 `alreadySupplied` = surface 上有与 `desired` 相同的 payload（`sameContextPayload` 逐字段 deepStrictEqual）——**只认当前 digest 的可见性**：压掉重复旧副本不触发重注；压掉最新副本才重注（循环）。因此 `newestInstructionSeqsOf(session)`（尾扫日志、按**源文件身份**分组——根注入带 `baselineIdentity`、worktree 注入归 worktree-sourced，src/region.ts）把**每个指令文件的最新注入** pin 进 `protectedSeqs`——多文件（root + worktree）各自保护最后注入。实测：只有「宿主当前引用的文件版本」对应的副本压了才重注（19 条中压 1 条 active 触发重注、压 9 条旧副本零重注）；宿主 git 回退文件时 desired 变旧版本、该副本已被压会重注一次（自愈，可接受）。stale（非最新）AGENTS.md 行按 §3 折叠/开段。

## 3. 范围表语义（`buildCompressibleSeqRanges`，src/region.ts）

- **按真实 user 消息分段**：一条新的 `user/message`（`classify==='real'`）闭合当前段、开启下一段——段粒度 ≈ 一个回合，与 v1 基线一致（v1 的断点本来就是每轮的 marker/nudge，v2 只是把这些断点从「排除」换成「并入」）。
- **metadata 折叠**：`metadata` 行并入**当前段**（它紧跟的回合）——tokens 计入段显示总量；`toolPct = round(toolCount / realCount × 100)`，分母剔除 metadata（`realCount = count - metadataCount`；`realCount === 0` 时 toolPct 取 0，防除零）。模型压一个已消费的真实段时，紧随其后的目录行/nudge 回显/stub **顺手带走**——零额外缓存代价（一段一次 replace）。
- **instruction / checkpoint 行 flush 断段**：遇到即闭合当前段，自身不进任何段。**v2.5 例外**：`isAgentInstructionsRow` 且不在 `protectedSeqs`（stale 重复副本）——归 metadata 同路径处理（见下）。
- **metadata / stale 折叠**：`metadata` 行并入**当前段**（它紧跟的回合）——tokens 计入段显示总量；`toolPct = round(toolCount / realCount × 100)`，分母剔除 metadata（`realCount = count - metadataCount`；`realCount === 0` 时 toolPct 取 0，防除零）。stale AGENTS.md 行同样折叠；**段未开（`cur === null`）时 stale 行允许开段**（前端重复副本场景——它们全在会话最前、与第一个真实段之间隔着最新副本必 flush，折叠语义够不到；单条 stale ~34K chars 远超 kernel 5000 门槛，无小段陷阱；oldest-first 排第一，天然最先压）。模型压一个已消费的真实段时，紧随其后的目录行/nudge 回显/stub/stale 副本**顺手带走**——零额外缓存代价（一段一次 replace）。
- **保护尾**：回扫判据是 `classify==='real'` 且非 relay/notice（`isRealUserTurn`）——合成行（含指令类）永远赢不了「最后真实用户消息」保护；这修复了 v1 现状 bug（skill-catalog 重发布尾随真实用户时抢走保护）。
- **最新 marker 保护**：`indexWatermarkOf(session)` 返回的 seq（最新 acp-index marker）额外 pin 进 `protectedSeqs`——「索引了未压缩内容」的目录行永不进可压段。残差窗口由 §4 的孤儿补编号兜底。

## 4. 并入安全性论证（为什么压掉 marker 不失联）

1. **可压段只含旧 marker**：最新 marker 紧跟最新真实用户消息、在 `preserveRecent` 末 5 节点保护尾内，且被 §3 的 pin 双保险——不会出现在可压段。
2. **压掉 marker 后水位不丢**：`indexWatermarkOf` 扫**日志**（append-only）而非表面——marker 进块后日志里仍在，水位 = 被压 marker 的 seq 不变（既有测试钉过「压缩吞 marker 后仅索引新节点」）。
3. **孤儿内容重新编号（根治）**：万一 marker 被压而其编号内容（位于 marker 之前、仍在表面）低于水位，`collectIndexEntries`（src/message-index.ts）的跳过判据是「该 seq 已被某块遮蔽（查 ledger shadowedSeqs）」而非 `seq <= watermark`——**孤儿化但仍可见的内容由下一 marker 重新编号**，已遮蔽内容天然跳过，无重复、无漏编号。这正是用户实测抱怨过的「用户消息没出现在目录里」的永久修复。

## 5. 搜索文档集排除

`buildSearchDocs`（src/tools.ts）对被遮蔽行的影子文档集从「只排除 `isIndexMarkerEvent`」扩为**排除全部 `metadata`/`instruction` 行**。原因：nudge 回显/目录行是 kitchen-sink 长文，内核对 user 角色加权 1.5×（hybrid = 0.7×BM25 + 0.3×fuzzy bigram），压掉后若留在文档集会结构性垄断 top-k（实测 nudge 残片 0.59 分 vs 真命中 0.60）；7.9K 的 AGENTS.md 注入一旦入文档集同样垄断。属 adapter 组装职责，不违规则 6/7。

## 6. 宿主注入源契约

分类器必须覆盖宿主当前全部注入源。实况枚举（父会话 52K 事件）：`plugin`×214（acp-index 81 / acp-nudge 29 / billion-context-dsh 25 / compact 68 / `@deepseek-ai/dsh-system-prompt` 8 / `tool-jobs` 2）、`agent-instructions`×43、`skill-catalog`×21、`subagent-settled`×13、`subagent-report`×8、`user`×95。**宿主新增注入 kind/plugin 名时，同步 `classifySurfaceEvent` 并补 fixture**（未知 plugin 保守不可压已兜底，但显式清单防止「已知策略行」漏判）。

## 7. 系统提示缓存知识（src/prompts.ts 默认 systemPromptTemplate）

`WHEN NOT TO COMPRESS` 段后追加**提供者前缀缓存知识**：压缩使被压位置之后所有消息位置偏移、该段之后缓存一次性失效——压尾部近无损；中部大块（如旧注入行）代价最高；引擎元数据与**旧版本指令副本**随真实段折叠压缩零额外代价（宿主只看当前指令版本是否可见——压旧副本不触发重注，压当前版本会）。措辞约束：不得泛化「注入可安全压」（**当前生效的指令**与技能目录/策略快照不可压）；不得把「压尾部」框成压缩目标（尾部是最新活动内容）；表述为「缓存失效一次性 vs 陈旧重复每请求成本」。属默认模板内容，自定义 `systemPromptTemplate` 的宿主不自动获得。

## 8. 测试清单（tests/region.test.ts、tests/message-index.test.ts、tests/prompts.test.ts）

- `classifySurfaceEvent` 表驱动单测：metadata 白名单三插件、instruction 四形态（hook / skill-catalog / 基线 agent-instructions / 宿主策略行）、checkpoint、real、**未知 plugin → instruction（fallthrough）**、非 user/message 事件 → real
- metadata 并入段：tokens 精确和（Σ defaultCountTokens）、toolPct 分母剔除（与去 metadata 孪生段一致）、count 含 metadata
- 分段：metadata 不打断当前段；checkpoint/instruction 仍断段；真实 user 闭合段（多回合 fixture 段数 ≈ 轮数）
- 保护尾：最后真实用户后跟 skill-catalog 重发布 → 保护落在真实消息
- 最新 marker 不进可压段（preserveRecent 内 + pin）；追加消息挤出保护尾后才并入
- 孤儿补编号：marker 被压但编号内容可见 → 下一 marker 重新编号、已遮蔽内容跳过
- 搜索排除扩展：nudge echo + 指令行影子不进文档集、真命中照常上榜（镜像既有 418 断言式）
- **v2.5**：前端 stale 副本开段（最新副本/skill-catalog 不进段）；per-payload pin（多源各保护最新、重复旧副本 stale）；中段 stale 折叠（tokens 计入、toolPct 分母剔除）；instruction 行不计入任一延迟计数器
- 缓存句：renderSystemPrompt 含缓存知识段

## 9. 与 v1 方案（独立成段 + [injection] 标注 + 聚合行）的关系

v1 让元数据独立成段并加 `[injection]` 标注、聚合行指引一次压完——被 kernel 5000 字符压缩门槛（`minCompressRange`，单次调用聚合）否决：目录行 600-1200 chars 单独压必失败（「看得到但压不掉」）。v2 的并入让元数据**搭车**真实段（真实段本身过门槛），不再需要标注/聚合行——模型压真实内容时自动带走。代价：元数据只能随真实段压（孤立的零散元数据留着，量小无害）；nudge 回显（~6.4K chars，唯一能单独过门槛的注入行）也必须搭车——这是有意的取舍，防被当作 bug 报。**v2.5** 把同一「搭车」逻辑扩展到 AGENTS.md 重复副本（宿主 digest 去重但旧副本不删）——唯一需要单独开段的场景是前端 stale 块（无相邻真实段，开段自压）。skill-catalog/策略快照维持全不可压（多源身份未解、单条收益小），列为 v2.6 候选项。
