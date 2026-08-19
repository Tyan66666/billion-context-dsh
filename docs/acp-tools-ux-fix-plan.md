# issue #31 修复方案：工具 UX —— mN→seq 适配 + nudge 措辞（审阅修正版）

> 状态：**已通过子代理审阅**（608d5ad3，机制 C1–C11 核对无误；BLOCKER-B1 + MAJOR-M1..M4 已修正）
> 关联：issue #31、issue #32 F 节；依据 AGENTS.md rule 9 "mN→seq adaptation … is the agreed direction"
> 实施分支：`fix/acp-tools-ux-mn-seq`（worktree `worktrees/fix-acp-tools-ux-mn-seq`，基于 main `bae887d`）

## 一、问题回顾（issue #31 三问题 + 实测复现）

长会话实测中模型为挑选压缩目标连续发起 4 次 acp_status（3 次 drilldown），2 次纯冗余：

1. **nudge 措辞 "suggestions only" 暗示范围不可靠** → 模型自行核对边界 → 做 drilldown。
2. **drilldown 返回 mN 内核引用，无法被 compress 消费** → 模型拿一列 mN 无处可用。
3. **缺少"语义/位置目标 → seq"映射** → 模型 sort:"time" 逐条试错 + 人脑换算。

实测复现（2026-08-19）：两次 drilldown 均只返回 mN，无法定位"压掉持久性验证 bash 输出"段；被迫 bash 解压会话日志（zstd）才拿到 seq。三问题实锤。

归属裁定（issue #32 F 节）：三问题均属本项目（src/prompts.ts + src/tools.ts）；kernel mN 命名是其合法内部设计，不改 kernel。

## 二、修复方案（审阅修正版）

### A. nudge 措辞（问题 1）

`src/prompts.ts:203` `rangeTable.title`：

```diff
- title: 'Compressible ranges (suggestions only — compress any consumed span; refs are surface seqs):',
+ title: 'Compressible ranges ({count}, oldest first; exact surface seqs — usable as-is):',
```

保留 kernel 原文标题格式 `Compressible ranges (N, oldest first):`（`nudge-text.ts:120`），只追加最小 seq 方言说明（"exact surface seqs — usable as-is"）；footer 的 stale 提醒保留（"精确≠不过期"：边界可直接用，但会随 surface 移动过期）。

### B. compress 接受 mN（问题 2+3 核心）

**机制**（审阅 C1/C2/C3 确认）：drilldown 行 `mNNNNN` = `state.messageRefs` 的 ref；`byRef[mN]` = CoreMessage.id；投影 `CoreMessage.id = String(event.seq)`（`messages.ts:122/130/138/163`，多工具助手为 `` `${seq}#${callId}` ``，`:147`）。故 `mN --byRef--> id --split('#')[0]--> seq`。

**⚠️ BLOCKER-B1 修正（审阅指出）**：mN 反查**必须用 `turn.state.messageRefs`（processTurn 之后），不能用存储态**（`tools.ts:195` 的 `env.store.stateFor`）。
原因：acp_status 的 turn 从不持久化（`tools.ts:611-613`），drilldown 展示的 mN（含自上次 nudge/compress 后新到消息的 ref）不在存储态里。若按存储态反查 → 核心场景（drilldown 定位自定义目标）报"mN not found" → 模型重跑 acp_status → 同一 mN（ref 分配确定性，审阅 C5）→ 再次失败 → **死循环**。
正确做法：compress turn 自身的 `processTurn`（`:207`）从同一存储基态确定性重分配同一组 mN → 传 **`turn.state.messageRefs.byRef`**（与 `:209` 的 `byRaw` 同一对象）。

**改动点** `src/tools.ts`：

1. `handleCompress`：processTurn 后（`:207-209` 区域）拿 `turn.state.messageRefs`；range 解析循环（`:236-237`）加 mN 解析辅助函数（签名带 `byRef`）：

```ts
/**
 * Resolve a compress boundary arg to a surface seq. Accepts:
 *  - a bare surface seq (number, "295", "295#call_00_x" — existing parseSeq);
 *  - a drilldown mN ref ("m00306" / "m306") — mapped via the CURRENT turn's
 *    messageRefs.byRef (CoreMessage.id = seq or "seq#callId" → split on "#").
 *    Unknown mN (never assigned on the current surface) fails with guidance;
 *    a valid mN whose span was already compressed falls through to the
 *    existing recover-stale / already-compressed semantics (rule 7).
 */
```

2. mN 匹配器健壮性（MINOR-3 采纳）：对齐 kernel `REF_PATTERN = /^m0*(\d{1,5})$/i`（`refs.ts:6`，容忍 `m306`、大小写不敏感），容忍尾部 `#callId`（与 parseSeq `#` 处理对称）；防御 byRef 反查结果非 `数字`/`数字#...` 形态 → 明确报错而非 `Number('abc')` NaN 静默。
3. 未知 mN 报错文案：`billion-context-dsh: mN "m00306" not found on the current surface — re-run acp_status for fresh refs (the surface may have moved)`。
4. `handleStatus` Note 行（`:641-643`）+ 代码注释（`:637-640`）同步更新：

```diff
- Note: drilldown rows are kernel refs (mN) for size awareness — compress uses the Surface: seqs above, never mN.
+ Note: drilldown rows are kernel refs (mN) — feed them straight to compress (auto-mapped to the live surface seq); an unknown mN fails with guidance.
```

（MINOR-1："stale mN fails"→"unknown mN fails"——stale 但有效的 mN 不失败，走 rule 7。）

### C. 工具描述同步（四处 "never mN" 全清）

- `src/prompts.ts:209`（compress 描述）：补 mN 支持句。
- `src/prompts.ts:212`（acpStatus 描述）：末句改为 mN 可直喂 compress。
- **`src/prompts.ts:240`（systemPromptTemplate 的 acp_status 条目，MAJOR-M1）**：`drilldown rows are kernel ids (mN) for size awareness — compress uses seqs, never mN.` → 改为 mN 也可用（auto-mapped）。
- `src/tools.ts:637-640` 注释同步（MINOR-5）。

### D. AGENTS.md rule 9 + §4b 更新

- rule 9（line 59）：`MUST NOT be fed to compress` / `size awareness only` 语义 → `compress ACCEPTS them`（handleCompress 经 `turn.state.messageRefs.byRef` 映射；未知 mN 报错引导；span 已压缩复用 rule 7）；保留 "engine never rewrites kernel report text"。
- §4b 测试清单行（line 107）：`acp_status drilldown passthrough + mN/seq separation` 补一笔 `compress accepts mN`（MINOR-6）。

### E. 测试

1. `tests/prompts.test.ts` 快照：line 157（range-table title）、line 172（acp_status 描述）、compress 描述、systemPromptTemplate 相关断言。
2. **`tests/tools.test.ts:474-486`（MAJOR-M2）**：Note 行断言 + 测试名更新（现断言旧文案必红）。
3. **新增 mN 测试（MAJOR-M3 生产形态——必须能抓住 B1）**：
   - `toolOf(env,'acp_status')` 执行一次（**不持久化**，与生产一致）→ 从输出正则提取 mN → 用该 mN 调 compress → 断言块落库。若实现错误地查存储态，`stateFor` 返回空 ref map（makeEnv store 全新）→ mN 查不到 → 测试红 → 抓住 B1。
   - **多工具助手消息 mN**（审阅建议补测）：`${seq}#${callId}` 分支。
   - **mN 指向已压缩消息**：rule 7 复用（already-compressed advisory 而非报错）。
   - **mN/seq 混合边界**：startSeq 用 mN、endSeq 用 seq。
   - **未知 mN 失败**：`m99999` → 报错含 guidance。
4. 回归：现有数字/字符串 seq 测试不动（parseSeq 兼容保护）。

### F. 文档同步

- **`README.md:153`、`README.en.md:152`、`docs/INSTALL.md:135`（MAJOR-M4）**：工具表 acp_status 行 "mN 仅供体量感知——压缩始终用 seq" → 同步为 mN 可直喂 compress。
- `docs/acp-status-align-design.md`：§9 P2-3 处置段（~line 294）更新；D4 决策表（:244）加 `[SUPERSEDED by issue #31]` 标记（MINOR-7，可选）。
- issue #31 状态更新（实施后）。

### G. 范围表增强（追加实施，与 pi 对齐——760b679）

mN 修复完成后，按「与 pi 语义对齐」讨论追加两项范围表改进（用户决策：两者都改）：

1. **tool/text 组成占比**：范围行带 `[tool {toolPct}% | text {textPct}%]`——`toolPct` 按**消息数占比**（kernel `isToolMessage` parity：`contentType === 'tool-call' | 'tool-result'`；事件层 = `event.type === 'tool/result'` 或 assistant 含 `tool-call` block）。给模型直接的压缩安全信号：tool 占比高 = 主要是工具输出 = 已消费候选（对应 rule 4 "压缩单个已消费 tool 输出是常态"）。
2. **排序 size 降序 → oldest-first**：`buildCompressibleSeqRanges` 返回改为 `sort((a, b) => a.start - b.start)`。理由（用户提出，采纳）：范围表顺序跨 turn 稳定（最老段不随新消息移动），模型可按序消化无需每次重排（认知缓存命中），与 kernel `oldest first` 列表及宿主压缩节奏一致；size 降序每次排名随新消息抖动，还把模型引向"当前最大段"（往往是刚产生、还在用的输出）。
3. **顺带修复 `slice(-0)` 陷阱**：`preserveRecent: 0` 时 `nodes.slice(-0) === slice(0)` 会保护全部节点——原"不保护"语义失效（region.test.ts 既有调用只 doesNotThrow 未暴露）。加 `if (preserve > 0)` 守卫。

落点：`src/region.ts`（`SeqCompressibleRange.toolPct` + `isToolEvent` + 排序）、`src/nudge.ts`（renderTemplate 传 `toolPct`/`textPct`）、`src/prompts.ts`（rangeTable.line 模板加 `[tool {toolPct}% | text {textPct}%]`）、`tests/region.test.ts`（新增 toolPct 0/67 + oldest-first 断言）、`tests/prompts.test.ts`（快照 `[tool 0% | text 100%]`）。测试 112/112。

## 三、设计决策（审阅确认）

| 决策 | 理由 |
|---|---|
| 选"compress 接受 mN"而非"drilldown 行带 seq" | 不解析/改写 kernel 报告（rule 9）；避免复现 `collectVisible` 耦合；改动集中 handleCompress；rule 9 已定方向（C6/C8） |
| mN 反查用 turn.state.messageRefs | BLOCKER-B1：acp_status turn 不持久化；compress turn 确定性重分配同一 mN（C5） |
| stale 复用 rule 7 | mN→id 恒定；span 已 shadowed 走 recoverStaleRange / AlreadyCompressedRangeError（C4）；仅从未分配的 mN 是新失败路径 |
| 不动 kernel | issue #32 F 节归属裁定（C9 确认 /acp 命令也不涉及） |
| 保留 stale footer | "精确≠不过期"（MINOR-4 已论证，风险可控） |

## 四、风险与边界（审阅确认项）

- C1 byRef 链成立（assignRefs `refs.ts:79` 写 byRef[ref]=id；drilldown ref 来自 byRaw[id]，键空间一致）
- C2 id 生成与 split('#') 同构 parseSeq
- C3 checkpoint 不进 drilldown（引擎 isCheckpointEvent 过滤，`tools.ts:616-619`）→ 无 mN→checkpoint 错位；`blockRefForSummarySeq` 只对 checkpoint 返回 bN，mN 普通消息 seq 不误触发 tier 2/3
- C5 mN 跨 turn 确定性重分配（refs 只增不减、first-wins）
- C7 compress schema 已是 number|string，无需改
- C9 /acp 命令纯 seq，无需改

## 五、验收清单

- [x] typecheck / test / build 全绿（112/112，含 mN 生产形态 + toolPct + oldest-first）
- [x] 四处 "never mN"（prompts:209/212/240 + tools.ts 注释）全清；Note 行新文案
- [x] README/README.en/INSTALL 工具表同步
- [x] AGENTS.md rule 9 + §4b 更新
- [x] 真实 dsh：drilldown 拿 mN → compress(mN) 成功（stale advisory + unknown mN guidance 实测）；nudge 措辞不再诱导 drilldown；范围表带 [tool X% | text Y%] + oldest-first（重启后 nudge 实测）
