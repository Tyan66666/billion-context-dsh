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

## 维护规则

1. 新开本地 workaround 时,必须同时在本表加一行,并让代码里带 `UPSTREAM:` 注释指向本行(规则 11)。
2. 每次 acp-kernel 升级(AGENTS.md §4b SOP)时,逐行核对「活跃追踪」表;上游已发布的,同 PR 内解除 workaround 并把状态改为 `resolved`。
3. 关闭对应 issue 时,在本表留下 `resolved` 行(不删),作为 porting-verification 的历史证据链。
