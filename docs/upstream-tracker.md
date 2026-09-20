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
| [#46](https://github.com/Tyan66666/billion-context-dsh/issues/46) | [acp-kernel#93](https://github.com/ranxianglei/acp-kernel/issues/93) → PR [acp-kernel#123](https://github.com/ranxianglei/acp-kernel/pull/123)(`reverse` + `offset`,基于 v0.0.38,7 条回归测试,444 tests 全绿) | — | waiting-upstream(PR #123 已核实 **open,未合并**) | `/acp status` 查看消息记录只显示最早一段;PR 合并发布、本仓库 bump 内核后关闭 |
| [#159](https://github.com/Tyan66666/billion-context-dsh/pull/159)(#155 review follow-up,**已合并 2026-09-20**) | [acp-kernel#335](https://github.com/ranxianglei/acp-kernel/issues/335)(2026-09-20 开,`applyCompression` 的 `isSummaryMessageId` 只认内核私有 `acp_summary_*` 前缀,宿主携带的 checkpoint 被 plain range 当普通消息折叠) | —(无 workaround;`tests/checkpoint-span.test.ts` 以 characterization 锁定当前行为) | waiting-upstream | 跨 checkpoint span 的两侧实测:walk 侧永不递回未点名的 checkpoint ref(穷举验证,永久不变量);plain range 侧在 checkpoint 离开宿主保护窗口后确实把它折进新块(eff 含 checkpoint id、parent 记录旧块、tier 仍报 1,内容仍可从 log 取回)。**解除条件见下方「未解除的门」** |

## 未解除的门(升级内核时逐条执行)

表格里的 `waiting-upstream` 行如果同时锁了本地断言/注释,解除条件写在这里。每道门必须在同一个 PR 内走完四步:上游修复发布 → bump pin(§4b SOP 第 1–3 步)→ 解除本地锁定 → 本表状态改 `resolved`。

- [ ] **acp-kernel#335**(本仓库 PR [#159](https://github.com/Tyan66666/billion-context-dsh/pull/159) 已合并)—— `applyCompression` 的 `isSummaryMessageId` 只认内核私有 `acp_summary_*` 前缀,所以宿主携带的 checkpoint 被两端都不是 block ref 的 plain range 当普通消息折叠:
  1. bump pin 到含修复的版本;
  2. 翻转 `tests/checkpoint-span.test.ts` 第 2 条断言 `a PLAIN range folds the checkpoint like any other message (characterization)` —— 改判「不折叠」,`parentBlockIds` / `tier` 两条一致性断言保留;
  3. 删除该文件头部的 `UPSTREAM:` 标记(它还在,就说明这道门没关);
  4. 把上表 #159 行状态改为 `resolved`,备注写清「上游 #335 于 vX.Y.Z 发布,断言已翻转」。

> #46(acp-kernel#93 → PR #123)不需要门:它没有本地 workaround,上游发布后 bump pin 即可,本表那一行改 `resolved`。

## 维护规则

1. 新开本地 workaround 时,必须同时在本表加一行,并让代码里带 `UPSTREAM:` 注释指向本行(规则 11)。
2. 每次 acp-kernel 升级(AGENTS.md §4b SOP)时,逐行核对「活跃追踪」表;上游已发布的,同 PR 内解除 workaround 并把状态改为 `resolved`。
3. 关闭对应 issue 时,在本表留下 `resolved` 行(不删),作为 porting-verification 的历史证据链。
