# 跨会话记忆调研资料(Memory Research)

> 本目录存放跨会话长期记忆(P1-4)的设计调研原始资料,供 `docs/cross-session-memory-design.md` 追溯。
> 调研日期:2026-08 | 状态:已随设计文档定稿归档

| 文件 | 内容 | 来源 |
|---|---|---|
| [01-autonomous-memory-papers.md](01-autonomous-memory-papers.md) | 论文向 17 篇:自主记忆保存机制(触发六分类/Ebbinghaus 衰减/检索共识) | 子代理调研,arXiv 实测 |
| [02-autonomous-memory-implementations.md](02-autonomous-memory-implementations.md) | 实现向 8 产品:保存时机/工具描述原文/检索格式/会话边界(5 工程模式) | 子代理调研,产品源码/文档 |
| [03-memory-readback-timing.md](03-memory-readback-timing.md) | 读回时机 25 源:四模式谱系(预注入/按需/自主/常驻)+ 混合收敛证据 + 预算研究 | 子代理调研,论文+产品 |
| [04-claude-code-source-verification.md](04-claude-code-source-verification.md) | Claude Code 记忆机制源码核实(写入/双层读取/7 层架构/启示)——`/tmp/claude-code-analysis` 重启即失,此为提炼存档 | 本地源码核实 |

## 与本目录相关的设计决策摘要

- **写入**:nudge 时机 → `memory_commit(type, note)` 表态 → 引擎**一次性 LLM 调用**提取 → 写记忆库(带 citation)→ 主对话继续压缩。
- **读回**:延迟读回,两个时机——常驻索引(每次 turn)+ 自主取回(`memory_recall` 取全文)。Claude Code 生产实践背书。
- **选择/衰减**:`score = importance + min(days/30,5) + uniform(0,.5)`——打破富者愈富,与 Ebbinghaus 保质期同一套字段。
- **用户侧**:仅 `/acp memory list`;导入导出 = 自然语言,模型自主。
- 完整细节见 `docs/cross-session-memory-design.md`(头部含 3 个待定项)。
