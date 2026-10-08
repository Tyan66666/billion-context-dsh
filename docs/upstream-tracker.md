# Upstream 追踪表

本仓库依赖上游 [acp-kernel](https://github.com/ranxianglei/acp-kernel) 与 DeepSeek Harness。
按 AGENTS.md 规则 11,上游缺陷一律走「上游 issue + PR → 升级 pin → 解除本地 workaround」,
任何本地 workaround 必须在此表登记,上游修复合入发布后**必须删除**。

状态含义:

- `waiting-upstream` — 已在上游提 issue/PR,等待合入或发布
- `merged-released` — 上游已发布包含修复的版本
- `resolved` — 本仓库已 bump pin 并解除 workaround,本行仅留档

## 活跃追踪

| 本仓库 Issue | 上游 Issue/PR | 本地 workaround 位置 | 状态 | 备注 |
|---|---|---|---|---|
| [#38](https://github.com/Tyan66666/billion-context-dsh/issues/38) | [acp-kernel#207](https://github.com/ranxianglei/acp-kernel/issues/207)(CLOSED 2026-09-07) → PR [#209](https://github.com/ranxianglei/acp-kernel/pull/209)(按数组邻接分段,替代 ref 算术;v0.0.59 发布) | —(自算逻辑已删除) | resolved | 本 PR(#122)把 pin 由 `0.0.29` 升到 `0.0.63`,`buildCompressibleSeqRanges` 只保留 ref→seq 翻译 + 宿主守卫,几何回归 kernel `compressibleRanges`(AGENTS.md 规则 3/11);回归钉 `tests/kernel-range-source.test.ts`,证据见 docs/dsh-porting-verification.md 修复 10 |
| [#46](https://github.com/Tyan66666/billion-context-dsh/issues/46) | [acp-kernel#93](https://github.com/ranxianglei/acp-kernel/issues/93) → PR [acp-kernel#123](https://github.com/ranxianglei/acp-kernel/pull/123)(`reverse` + `offset`,基于 v0.0.38,7 条回归测试,444 tests 全绿) | — | **upstream-declined**(PR #123 **CLOSED,未合并**) | `/acp-prune status` 查看消息记录只显示最早一段;**2026-10-08 复核更正**:PR #123 的实际状态是 `CLOSED`(`mergedAt = null`,2026-06-11 关闭),本表此前写的「已核实 open,未合并」与 issue #46 里那条「已合并 ✅」都不成立;内核 0.0.101 的 `StatusReportOptions` 里也确实没有 `reverse` / `offset`。本 issue 保持 open,等上游重新接单(重提时附本 issue 的复现步骤)。 |
| [#159](https://github.com/Tyan66666/billion-context-dsh/pull/159)(#155 review follow-up,**已合并 2026-09-20**) | [acp-kernel#335](https://github.com/ranxianglei/acp-kernel/issues/335)(2026-09-20 开,`applyCompression` 的 `isSummaryMessageId` 只认内核私有 `acp_summary_*` 前缀,宿主携带的 checkpoint 被 plain range 当普通消息折叠) | —(无 workaround;`tests/checkpoint-span.test.ts` 现钉「硬拒 + carrier 保留」) | **resolved**(0.0.101) | 跨 checkpoint span 的两侧实测:walk 侧永不递回未点名的 checkpoint ref(穷举验证,永久不变量);plain range 侧在 checkpoint 离开宿主保护窗口后确实把它折进新块(eff 含 checkpoint id、parent 记录旧块、tier 仍报 1,内容仍可从 log 取回)。**已解除**:上游 #335 → PR [#338](https://github.com/ranxianglei/acp-kernel/pull/338)(MERGED 2026-09-20)在 0.0.101 发布,但修法是**宿主契约**——内核读宿主声明的 `CoreMessage.summaryOfBlockId`,所以本仓 bump pin 时同时做了两半:投影给每个 checkpoint 节点挂上 kernel block id(`kernelBlockIdByCompactionId` → `projectEvent`)、跨 live carrier 的 plain T1 范围硬拒(`liveCheckpointCarriersInSpan` + `liveCarrierRejectionNote`,compress 工具与 `/acp-prune compress` 都拦);断言已改写,文件头的 `UPSTREAM:` 标记已删除 |
| [#187](https://github.com/Tyan66666/billion-context-dsh/issues/187) | [acp-kernel#483](https://github.com/ranxianglei/acp-kernel/issues/483)(2026-09-30 开,请求把 `REF_WIDTH` 从 5 位放宽到 7 位;背景:#176 的空闲槽复用因「ref 复用会让摘要里的旧 tag 静默指向另一条消息」被 #191 回退,#191 确立「ref 编号会话内永不复用」不变量并明写正解是放宽位宽) | —(无本地 workaround;重启 dsh 同样不能恢复,见备注) | **resolved**(0.0.101 实测 `MAX_INDEX` 99999 → 9999999) | 长会话(约 3.65 万步、日志 200MB+、139,159 条消息级事件 / 可见面仅 ≈49,951 条)整轮失败:`ref capacity exhausted: cannot allocate beyond m99999`(内核 `refs.ts` `MAX_INDEX = 99999`,`processTurn` 的 `assign-refs` 节点抛出——在任何压缩决策之前,宿主与用户都无法自救)。撞的是**累计**引用表而非当前上下文,升内核不解决:0.0.29 / 本仓库 pin 0.0.63(`dist/index.js` 同常量同报错)/ npm 最新 0.0.98 三版全部命中。⚠️ **重启不能恢复**(2026-09-30 reporter 更正):本插件每轮把**整条日志**(不只可见面)喂给内核(`allLogMessages`,src/messages.ts:315),而内核流水线第一个节点是 `assign-refs`——先给全量日志编号再谈压缩;重启后第一轮就要为整条日志重新编号,日志已超约 10 万条时当场再次撞限;压缩同样救不回(`compress` 走同一路径)。可用办法只有:①禁用 `compaction-acp` 换回宿主 `compaction-basic`;②换新会话。内核 **0.0.101 已发布、本仓已 bump pin**:两版 `dist/index.js` 常量实测 `99999` → `9999999`,本行改 `resolved`;README.md / README.en.md 的对应条目已从「已知问题」改写为「已修复(v0.2.27 起,升级即不再撞限、旧会话无需重建)」——诊断内容保留,因为 ≤ v0.2.26 的用户仍需要它 |

## 未解除的门(升级内核时逐条执行)

表格里的 `waiting-upstream` 行如果同时锁了本地断言/注释,解除条件写在这里。每道门必须在同一个 PR 内走完四步:上游修复发布 → bump pin(§4b SOP 第 1–3 步)→ 解除本地锁定 → 本表状态改 `resolved`。

- [x] **acp-kernel#335**(本仓库 PR [#159](https://github.com/Tyan66666/billion-context-dsh/pull/159) 已合并)——**已解除(0.0.101)**,四步流水记:
  1. ✅ bump pin 到 **0.0.101**(§4b SOP 第 1–3 步已走完,含全量测试与 build);
  2. ✅ `tests/checkpoint-span.test.ts` 不再钉「折叠」:两条改为断言「硬拒 + carrier 留在 surface + 投影标记 == `blockRegistry` 的 kernelBlockId」(旧代码会红) ;
  3. ✅ 该文件头部的 `UPSTREAM:` 标记已删除;
  4. ✅ 上表 #159 行改为 `resolved`。
  > 上游修法是**宿主契约**(内核读 `CoreMessage.summaryOfBlockId`,plain 范围保留该 carrier 并警告,`bN..bM` 边界仍折),所以解除时不只是翻断言:必须同时声明投影标记与硬拒跨 carrier 的 plain T1 范围(单次 `surfaceOp` 会把它一同隐藏),否则变成「内核保留了、事务又把它藏了」。

> #46(acp-kernel#93 → PR #123)不需要门:它没有本地 workaround。**2026-10-08 更正**:其上游 PR 实际是 `CLOSED`(`mergedAt = null`),所以不存在「上游发布后 bump 即可」——本 issue 保持 open,等上游重新接单。

> #187(acp-kernel#483)不需要门:没有本地 workaround。**已解除**:0.0.101 放宽了位宽(实测 `MAX_INDEX` 99999 → 9999999),本仓已 bump pin,本表该行改 `resolved`;README.md / README.en.md 的对应条目已从「已知问题」改写为「已修复(v0.2.27 起)」。

## 维护规则

1. 新开本地 workaround 时,必须同时在本表加一行,并让代码里带 `UPSTREAM:` 注释指向本行(规则 11)。
2. 每次 acp-kernel 升级(AGENTS.md §4b SOP)时,逐行核对「活跃追踪」表;上游已发布的,同 PR 内解除 workaround 并把状态改为 `resolved`。
3. 关闭对应 issue 时,在本表留下 `resolved` 行(不删),作为 porting-verification 的历史证据链。
