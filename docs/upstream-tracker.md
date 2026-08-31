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
| [#38](https://github.com/Tyan66666/billion-context-dsh/issues/38) | acp-kernel ref-map drift(待补上游号) | `buildCompressibleSeqRanges`(自算 range 表,`UPSTREAM:` 注释) | waiting-upstream | kernel ref map 在 surface replace 后漂移:`compressibleRanges` 乱序(end<start)、大工具结果丢 ref。每次 kernel bump 都要复查:上游修了就删 workaround,回到 kernel `compressibleRanges`(AGENTS.md 规则 3/11) |
| [#46](https://github.com/Tyan66666/billion-context-dsh/issues/46) | `/acp status` reverse/offset(待补上游号) | — | waiting-upstream | `/acp status` 查看消息记录只显示最早一段;等上游 reverse/offset 修复后关闭 |

## 维护规则

1. 新开本地 workaround 时,必须同时在本表加一行,并让代码里带 `UPSTREAM:` 注释指向本行(规则 11)。
2. 每次 acp-kernel 升级(AGENTS.md §4b SOP)时,逐行核对「活跃追踪」表;上游已发布的,同 PR 内解除 workaround 并把状态改为 `resolved`。
3. 关闭对应 issue 时,在本表留下 `resolved` 行(不删),作为 porting-verification 的历史证据链。
