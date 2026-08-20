# 自主记忆保存机制专项调研

> 为 Active Context Pruning (ACP) 项目的"跨会话长期记忆"功能设计提供文献支撑  
> 调研日期: 2026-07  
> 核心问题: 模型什么时候、凭什么决定"这段值得存进长期记忆"？

---

## 一、训练内化型 —— 模型学会"何时压缩/保存"

### 1.1 ACM: Agentic Context Management for Long Horizon Tasks

| 字段 | 内容 |
|---|---|
| **来源** | arXiv:2607.23809 · [HTML](https://arxiv.org/html/2607.23809v1) · [GitHub](https://github.com/lixiaochuan2020/agentic-context-management) |
| **核心机制** | 为模型配备两个显式工具：`manage_context`（压缩/删除/重写上下文条目）和 `query_memory`（检索历史上下文），通过 post-training 示范数据（expert trajectories）让模型内化"何时调用"的决策 |
| **触发条件** | **不是启发式规则，而是训练内化的隐式判断**。示范轨迹中模型在以下场景被训练调用 manage_context：(1) context 即将溢出窗口；(2) 某个子任务完成后其细节不再需要；(3) 累积的冗余信息开始干扰推理质量。具体判断完全由模型内部状态驱动 |
| **与 ACP 的异同** | **高度相似**：都是模型自决、通过显式工具调用来压缩。**关键区别**：ACM 的工具能力更强（可删除、重写、重组），且通过 SFT 把决策策略内化到模型权重中；ACP 目前依赖 prompt guidance（nudge）而非训练内化 |
| **启示** | 如果要让压缩决策更稳定可靠，最直接的路径是 post-training：收集"什么时候该压缩"的示范数据，用 SFT 让模型内化触发策略，而不是纯靠 prompt 工程 |

### 1.2 AgentFold: Long-Horizon Web Agents with Proactive Context Folding

| 字段 | 内容 |
|---|---|
| **来源** | arXiv:2510.24699 · [HTML](https://arxiv.org/html/2510.24699v1) · [OpenReview (ICLR 2026)](https://openreview.net/forum?id=IuZoTgsUws) |
| **核心机制** | 每一步 agent 执行后，生成一条 **folding instruction**（折叠指令），将已完成的步骤压缩为精炼摘要。通过 SFT（无需 continual pre-training 或 RL）训练模型学会在每一步主动生成折叠指令 |
| **触发条件** | **结构性边界（structural boundary）**——每一步执行完毕就是一个自然的折叠点。模型被训练在每个 step boundary 主动 fold，而非等待 context 压力信号。这是一种"**事件驱动**"而非"**阈值驱动**"的策略 |
| **与 ACP 的异同** | **共同点**：模型自决压缩。**关键区别**：AgentFold 是步级事件驱动（每步必 fold），ACP 是渐进式压力驱动（nudge 触发，非每步必压缩）。AgentFold 更激进，可能丢失未来需要的中间状态 |
| **启示** | "步边界"是一个非常可靠的触发信号——agent 每完成一个子步骤，上一步的细节大概率不再需要。可以考虑在 ACP 中引入"任务完成"事件作为辅助触发，而不完全依赖 token 压力 |

### 1.3 Context as a Tool (C^AT): Context Management for Long-Horizon SWE-Agents

| 字段 | 内容 |
|---|---|
| **来源** | arXiv:2512.22087 · [HTML](https://arxiv.org/html/2512.22087v1) · [HuggingFace](https://huggingface.co/papers/2512.22087) |
| **核心机制** | 将"上下文管理"本身建模为一种工具操作。通过 **condensor position generation**（压缩位置生成）识别三个信号来决定何时插入压缩操作：(1) **context expansion**（上下文膨胀速率）；(2) **structural boundary**（结构性边界——任务切换、阶段转换）；(3) **error-correction**（纠错信号——模型开始重复或犯错时） |
| **触发条件** | **三信号融合**：上下文大小增长 + 结构边界 + 错误修正信号。不是单一阈值，而是多信号综合判断 |
| **与 ACP 的异同** | **最接近 ACP 现有设计**——都是将压缩建模为工具操作、由模型自主决定。C^AT 的三信号框架比 ACP 的纯 pressure nudge 更丰富（ACP 只用 token 利用率一个信号）。C^AT 的 condensor position 生成类似于 ACP 的 compress range 选择 |
| **启示** | **最值得借鉴的框架**。ACP 可以引入"错误修正信号"（模型开始重复前面已纠正的内容时触发压缩）和"结构边界信号"（任务切换检测），而不只依赖 token 利用率 |

### 1.4 Self-Compacting Language Model Agents (SelfCompact)

| 字段 | 内容 |
|---|---|
| **来源** | arXiv:2606.23525 · [HTML](https://arxiv.org/abs/2606.23525v1) · [GitHub](https://github.com/tianjianl/selfcompact) |
| **核心机制** | 脚手架方案（scaffolding），让模型自主决定最优的 **compaction timing**（压缩时机）和 **method**（压缩方法）。模型可以自行判断何时上下文中的 stale content 开始锚定（anchor）后续生成质量 |
| **触发条件** | 模型自主判断。核心发现：长 trace 中的 stale 内容会 **锚定（anchor）后续推理**，导致质量退化——这本身就是最强的触发信号。当模型"感觉"到自己的推理被历史内容干扰时，就是压缩的最佳时机 |
| **与 ACP 的异同** | 几乎完全相同的哲学——模型自决压缩。SelfCompact 更聚焦于"stale content 检测"，ACP 更聚焦于"context 利用率管理"。两者可以互补 |
| **启示** | "stale content 锚定效应"是一个可检测的信号：如果模型的输出开始重复或引用已被修正的信息，说明旧内容在干扰——这是一个比 token 利用率更语义化的触发信号 |

### 1.5 Active Context Compression (Focus)

| 字段 | 内容 |
|---|---|
| **来源** | arXiv:2601.07190 · [HTML](https://arxiv.org/html/2601.07190v1) |
| **核心机制** | 名为 "Focus" 的自主上下文压缩系统，针对 SWE 任务中的 "Context Bloat"。模型自主决定何时压缩已完成的子任务上下文 |
| **触发条件** | 子任务完成 + context 接近溢出双信号 |
| **与 ACP 的异同** | 高度相似，都是模型自决 + 工具调用压缩。Focus 更聚焦 SWE 场景 |
| **启示** | SWE 场景验证了"子任务完成"作为触发信号的有效性——代码任务有天然的结构性边界（文件修改完成、测试通过等） |

### 1.6 SWE-MeM: Learning Adaptive Memory Management for Long-Horizon Coding Agents

| 字段 | 内容 |
|---|---|
| **来源** | arXiv:2606.28434 · [HTML](https://arxiv.org/html/2606.28434v1) |
| **核心机制** | 针对长时程编码 agent 的自适应记忆管理，学习何时将交互历史存入外部记忆、何时从外部记忆检索 |
| **触发条件** | 学习得到的策略——通过训练数据学习"哪些信息值得保存到外部记忆" |
| **与 ACP 的异同** | SWE-MeM 有明确的"保存到外部记忆"操作（跨会话持久化），ACP 目前只有会话内压缩。这是 ACP 向跨会话记忆扩展的直接参考 |
| **启示** | 编码场景的记忆保存可以和代码语义绑定——"这段修改了哪个模块"比"这段有多少 token"更有意义 |

---

## 二、启发式信号型 —— 用规则/信号决定重要性

### 2.1 Generative Agents (Park et al.)

| 字段 | 内容 |
|---|---|
| **来源** | arXiv:2304.03442 · [HTML](https://arxiv.org/abs/2304.03442) · [ACM UIST 2023](https://dl.acm.org/doi/fullHtml/10.1145/3586183.3606763) · [AgentPatterns 深度解读](https://agentpatterns.ai/agent-design/generative-agents-memory-stream/) |
| **核心机制** | **Memory Stream**（记忆流）+ **三信号检索** + **Reflection**（反思）。所有观察都存入 memory stream，检索时按三个信号加权打分：(1) **Recency**（时效性，指数衰减）；(2) **Importance**（重要性，1-10 分，由 LLM 评估）；(3) **Relevance**（相关性，与当前 query 的 embedding 相似度）。当累积了足够多的近期记忆后，触发 **reflection**——让 LLM 生成高层抽象洞察 |
| **触发条件** | **保存时机**：所有观察无条件保存到 memory stream。**反思时机**：当最近记忆条目数超过阈值（如 150 条），自动生成"reflection question"并总结高层洞察。**重要性评分**由 LLM 在保存时实时评估 |
| **与 ACP 的异同** | **根本区别**：Generative Agents 保存一切、靠检索过滤；ACP 压缩后丢弃原文。**共同点**：都依赖 LLM 判断"重要性"。Generative Agents 的 reflection 机制类似于 ACP 的 tier-2/3 蒸馏——都是在摘要之上再生成更高层抽象 |
| **启示** | (1) "重要性评分"可以作为跨会话记忆保存的门控——只有 importance ≥ 阈值的摘要才写入长期记忆。(2) Reflection 机制可以直接复用：当 tier-1 块累积到一定数量，自动生成"这个会话的关键决策和模式是什么"的反思式 tier-2 摘要 |

### 2.2 MemPO: Self-Memory Policy Optimization for Long-Horizon Agents

| 字段 | 内容 |
|---|---|
| **来源** | arXiv:2603.00680 · [ACL Findings 2026](https://aclanthology.org/2026.findings-acl.1166/) · [GitHub](https://github.com/TheNewBeeKing/MemPO) |
| **核心机制** | 通过 **RL 优化** 让模型学习最优的记忆管理策略。模型学会决定：(1) 什么信息值得保存到长期记忆；(2) 什么时候从长期记忆中检索。奖励信号来自下游任务性能 |
| **触发条件** | **学习得到的策略**，不是规则。模型通过 RL 训练内化了"保存到长期记忆的时机"——当保存某条信息能提升后续任务表现时，模型学会保存它 |
| **与 ACP 的异同** | MemPO 用 RL 优化记忆策略，ACP 用 prompt 引导。MemPO 的"什么值得保存"是通过奖励信号端到端学习的，ACP 目前靠模型的通用判断能力 |
| **启示** | 如果要系统性优化"何时保存到长期记忆"，RL 是比 SFT 更灵活的路径——因为"保存时机是否正确"的反馈只有在后续使用该记忆时才能评估（延迟奖励），这正是 RL 擅长的 |

### 2.3 Meta-Cognitive Memory Policy Optimization

| 字段 | 内容 |
|---|---|
| **来源** | arXiv:2605.30159 · [HTML](https://arxiv.org/html/2605.30159v1) |
| **核心机制** | 引入"元认知"层——模型不仅决定保存什么，还**反思自己的记忆管理策略是否有效**。通过递归式摘要（recursive summarization）将交互轨迹压缩为记忆条目，元认知层评估哪些摘要质量好、哪些丢失了关键信息 |
| **触发条件** | 递归摘要 + 元认知反思：模型生成摘要后，再评估这个摘要是否保留了足够信息来支持后续决策 |
| **与 ACP 的异同** | ACP 的 tier-2/3 蒸馏本质上也是递归摘要，但缺少"元认知评估"——即压缩后没有回头检查"这个摘要是否足够好"。这可以作为 ACP 压缩质量的反馈信号 |
| **启示** | **压缩质量自评**：在 ACP 中加入一步"压缩后评估"——压缩完成后，模型检查摘要是否保留了当前任务所需的关键信息，如果不满足则补充或重新压缩。这是"模型自决"的第二层保障 |

### 2.4 Agentic Memory: Learning Unified Long-Term and Short-Term Memory Management

| 字段 | 内容 |
|---|---|
| **来源** | arXiv:2601.01885 · [ACL 2026](https://aclanthology.org/2026.acl-long.981/) · [PDF](https://aclanthology.org/2026.acl-long.981.pdf) |
| **核心机制** | 统一的长短期记忆管理框架。模型同时管理 working memory（当前上下文）、short-term memory（近期摘要）、long-term memory（持久化存储），学习在三者之间迁移信息 |
| **触发条件** | 学习得到的策略——通过训练数据学习什么信息应该从 working memory 升级到 short-term、再从 short-term 升级到 long-term |
| **与 ACP 的异同** | 与 ACP 的 tier-1/2/3 分层高度对应。ACP 的 tier-1 摘要 → tier-2 蒸馏 → tier-3 超浓缩 等价于 short-term → long-term 的迁移。区别在于 ACP 缺少"跨会话的 long-term memory"层 |
| **启示** | ACP 的三层蒸馏架构可以自然扩展为跨会话记忆：tier-3（超浓缩）是天然的"长期记忆条目"——足够精炼、可以跨会话持久化存储 |

---

## 三、遗忘与淘汰型 —— 决定"忘掉什么"

### 3.1 MemoryBank: Enhancing LLMs with Long-Term Memory

| 字段 | 内容 |
|---|---|
| **来源** | arXiv:2305.10250 · [AAAI 2024](https://ojs.aaai.org/index.php/AAAI/article/view/29946) · [GitHub](https://github.com/zhongwanjun/MemoryBank-SiliconFriend) |
| **核心机制** | 基于 **Ebbinghaus 遗忘曲线** 的记忆衰减模型。每条记忆有一个"记忆强度"，随时间自然衰减；每次被检索/引用时强度更新（刷新）。强度低于阈值的记忆被"遗忘"（归档或删除） |
| **触发条件** | **被动衰减 + 主动刷新**：(1) 保存时初始强度 = f(重要性, 情感色彩)；(2) 随时间指数衰减；(3) 被检索时强度回升；(4) 强度 < 阈值 → 遗忘 |
| **与 ACP 的异同** | ACP 没有遗忘机制——压缩后的块永久存在（除非手动 decompress + 重新压缩）。MemoryBank 的衰减模型可以直接用于 ACP 的长期记忆层：长期不被检索/不被引用的记忆自动降权 |
| **启示** | **直接可用**：为跨会话记忆条目添加"记忆强度"字段，用 Ebbinghaus 曲线管理衰减，被检索时刷新。阈值以下的记忆自动降级为更浓缩的形式或标记为可清理 |

### 3.2 FadeMem: Biologically-Inspired Forgetting for Efficient Agent Memory

| 字段 | 内容 |
|---|---|
| **来源** | arXiv:2601.18642 · [HTML](https://arxiv.org/html/2601.18642v1) · [HuggingFace](https://huggingface.co/papers/2601.18642) |
| **核心机制** | 受生物学遗忘机制启发的 **选择性遗忘** 系统。不是简单的 Ebbinghaus 衰减，而是多因素遗忘决策：(1) 时间衰减；(2) 访问频率；(3) 与当前任务的相关性；(4) 信息冗余度（与其他记忆的重叠程度） |
| **触发条件** | 四因素综合评分低于阈值时触发遗忘。**信息冗余度** 是独特贡献——如果一条记忆的大部分信息已经被更新、更相关的记忆覆盖，则标记为可遗忘 |
| **与 ACP 的异同** | ACP 的蒸馏（tier-2/3）本质上就是一种"压缩式遗忘"——保留精华、丢弃细节。FadeMem 的冗余度检测可以用于 ACP：当多个 tier-1 块包含重叠信息时，合并它们并标记冗余块为可清理 |
| **启示** | **冗余度检测**是关键——跨会话记忆中，如果新信息完全覆盖了旧信息，旧记忆应该被更新或丢弃，而不是无限累积。这比单纯的"时间衰减"更智能 |

---

## 四、记忆触发器的专门研究

### 4.1 SelfMem: Self-Optimizing Memory for AI Agents

| 字段 | 内容 |
|---|---|
| **来源** | arXiv:2607.03726 · [HTML](https://arxiv.org/html/2607.03726v1) · [HuggingFace](https://huggingface.co/papers/2607.03726) |
| **核心机制** | 专门研究 agent 的 **自优化记忆系统**。核心问题：当前 agent 虽然支持长上下文和工具使用，但缺乏对"什么信息值得记忆"的系统性优化。SelfMem 提出了一个记忆优化框架，让 agent 从自己的经验中学习记忆策略 |
| **触发条件** | **自优化循环**：agent 执行任务 → 评估记忆使用情况（哪些记忆被用了、哪些没被用、哪些缺失导致了错误）→ 更新记忆策略 → 下次执行时应用新策略 |
| **与 ACP 的异同** | SelfMem 关注的是"什么值得记"的优化，ACP 关注的是"什么时候压缩"。两者互补——SelfMem 的策略可以告诉 ACP "这段内容值得保存到长期记忆"，ACP 的策略告诉 SelfMem "什么时候触发保存" |
| **启示** | **记忆使用回溯分析**：定期回顾"哪些压缩/保存决策是正确的"（通过后续是否检索/使用来判断），用这个信号优化触发策略。这是"模型自决"的元优化层 |

### 4.2 Sleep-time Compute (Letta)

| 字段 | 内容 |
|---|---|
| **来源** | arXiv:2504.13171 · [Letta 博客](https://www.letta.com/blog/sleep-time-compute/) · [GitHub](https://github.com/letta-ai/sleep-time-compute) |
| **核心机制** | 在 agent **不与用户交互的空闲时段**（sleep-time），预先处理和重组记忆。核心洞察：很多记忆整理工作不需要在推理时做，可以在空闲时预先完成——就像人类在睡眠时巩固记忆 |
| **触发条件** | **空闲时段触发**：agent 没有待处理的用户请求时，自动进入 sleep-time 模式，执行：(1) 整理近期交互为结构化记忆；(2) 生成跨会话的摘要和索引；(3) 更新记忆的相关性评分 |
| **与 ACP 的异同** | ACP 的压缩发生在推理时（online），sleep-time 的记忆整理发生在空闲时（offline）。两者可以结合：推理时做紧急压缩（tier-1），空闲时做深度整理（tier-2/3 蒸馏 + 跨会话持久化） |
| **启示** | **最实用的工程模式**：推理时只做轻量压缩（保证响应速度），复杂记忆整理延迟到空闲时做。ACP 可以在 session idle 时自动执行 tier-2/3 蒸馏和跨会话记忆写入，不占用用户等待时间 |

### 4.3 MemGPT / Letta 的 Memory Hierarchy

| 字段 | 内容 |
|---|---|
| **来源** | [Letta Context Hierarchy 文档](https://docs.letta.com/guides/core-concepts/memory/context-hierarchy/) · [Archival Memory 文档](https://docs.letta.com/guides/core-concepts/memory/archival-memory/) · [Context Constitution](https://www.letta.com/constitution/) |
| **核心机制** | 三层记忆架构：(1) **Core Memory**（核心记忆）：始终在 context window 中，存放关键 persona 和用户信息，agent 可直接读写；(2) **Archival Memory**（归档记忆）：语义搜索数据库，agent 通过工具存取，存放长期知识和历史事实；(3) **Recall Memory**（回忆记忆）：完整的对话历史，可按时间/关键词检索 |
| **触发条件** | **agent 主动调用工具**：当 agent 认为某条信息是长期有价值但当前不需要的，调用 archival_memory_save 写入归档；当需要某条历史信息但不在 context 中时，调用 archival_memory_search 检索。判断完全由模型自主做出 |
| **与 ACP 的异同** | Letta 的 archival_memory_save 是最接近"跨会话长期记忆"的成熟实现。**关键区别**：Letta 让 agent 直接调用工具保存/检索，不需要"压缩"——原始内容直接存入归档；ACP 通过分层压缩产生精炼摘要。**互补**：ACP 的 tier-3 摘要是天然的 archival memory 条目 |
| **启示** | **最成熟的工程参考**。ACP 可以复用 Letta 的模式：将 tier-3 摘要作为 archival memory 条目，通过 embedding 索引，检索时返回精炼摘要。agent 在 compress 时自动判断"这个摘要值得跨会话保存"，调用长期记忆工具 |

---

## 五、检索返回什么 —— 精炼摘要 vs 原文

### 5.1 GraphRAG 的分层检索

| 字段 | 内容 |
|---|---|
| **来源** | [Microsoft Research](https://www.microsoft.com/en-us/research/publication/from-local-to-global-a-graph-rag-approach-to-query-focused-summarization/) · [GitHub](https://github.com/microsoft/graphrag) · [文档](https://microsoft.github.io/graphrag/) |
| **核心机制** | **层级式检索**：底层是原始文本 chunks，中层是实体/关系提取，顶层是 **community summaries**（社区摘要）。Global search 查询返回的是顶层 community summaries，而非原始 chunks；Local search 返回相关实体的原始上下文 |
| **检索返回** | **分层返回**：全局性问题 → 返回 community summaries（精炼摘要）；局部性问题 → 返回相关 chunks（近原文）。摘要层是预计算的，不随查询变化 |
| **与 ACP 的异同** | GraphRAG 的 community summaries ≈ ACP 的 tier-2/3 摘要。**区别**：GraphRAG 的分层是预计算的、基于图结构的；ACP 的分层是运行时模型驱动的。但检索策略可以直接借鉴：全局性查询返回高层摘要，局部性查询返回低层详细内容 |
| **启示** | **分层检索策略**：跨会话记忆的检索应该根据查询类型返回不同层级的摘要——"这个项目的整体决策是什么"返回 tier-3，"那次 bug 的具体细节是什么"返回 tier-1 甚至 decompress 到原文 |

### 5.2 MemGPT / Letta 的 External Context 分层

| 字段 | 内容 |
|---|---|
| **来源** | [Letta Context Hierarchy](https://docs.letta.com/guides/core-concepts/memory/context-hierarchy/) |
| **核心机制** | Core Memory（始终在 context 中）→ Recall Memory（可检索的完整历史）→ Archival Memory（语义搜索的长期存储）。每一层的信息粒度不同：Core 是最精炼的关键事实，Archival 可以是完整文档 |
| **检索返回** | Core Memory → 直接可见（最精炼）；Recall Memory → 按时间/关键词返回原始对话；Archival Memory → 语义搜索返回存入时的原文 |
| **与 ACP 的异同** | Letta 的 Archival Memory 返回的是存入时的原文（精炼但不是原始对话），ACP 的 tier-3 也是存入时的超浓缩摘要。两者在"存入精炼、返回精炼"上一致 |
| **启示** | **返回精炼摘要而非原文**是更好的默认策略——因为存入长期记忆的内容已经过筛选和压缩，检索时返回精炼摘要既节省 context 空间，又保证信息密度。只有当摘要不够用时，才 decompress 到原文 |

### 5.3 SelfComp 的检索设计

| 字段 | 内容 |
|---|---|
| **来源** | [GitHub: tianjianl/selfcompact](https://github.com/tianjianl/selfcompact) |
| **核心机制** | 压缩后的内容以摘要形式存入外部记忆。检索时返回摘要，模型决定是否需要更多细节 |
| **检索返回** | **默认返回摘要**，模型可以请求"展开"（类似 ACP 的 decompress）获取更多细节 |

---

## 六、设计启示小结

### 6.1 可靠的触发方式分类

| 触发类型 | 机制 | 代表论文 | 可靠性 | 工程成本 |
|---|---|---|---|---|
| **① Token 压力触发** | context 利用率超过阈值 | ACP 现有设计、ACM | ⭐⭐⭐ 中等（可靠但晚——等到压力高时可能已经丢失了早期信息的最佳压缩时机） | ⭐ 极低（已实现） |
| **② 结构边界触发** | 子任务完成、步切换、阶段转换 | AgentFold、C^AT、Focus、SWE-MeM | ⭐⭐⭐⭐ 高（有明确的事件信号） | ⭐⭐ 低（需要事件检测，如 tool call 完成、任务状态变化） |
| **③ 语义退化触发** | 模型开始重复/犯错/推理质量下降 | C^AT (error-correction)、SelfCompact (stale anchor) | ⭐⭐⭐⭐ 高（直接反映问题） | ⭐⭐⭐⭐ 高（需要检测"推理质量下降"——可以通过自评或对比实现） |
| **④ 训练内化触发** | 通过 SFT/RL 训练模型内化"何时保存"的策略 | ACM、AgentFold、MemPO、Agentic Memory | ⭐⭐⭐⭐⭐ 最高（策略端到端优化） | ⭐⭐⭐⭐⭐ 最高（需要收集训练数据、训练模型） |
| **⑤ 空闲时整理** | agent 空闲时自动整理记忆 | Sleep-time Compute、Letta | ⭐⭐⭐⭐ 高（不占用推理时间） | ⭐⭐ 低（调度机制即可） |
| **⑥ Ebbinghaus 衰减** | 记忆强度随时间衰减，被使用时刷新 | MemoryBank、FadeMem | ⭐⭐⭐ 中等（对长期记忆淘汰有效，对保存时机无效） | ⭐⭐ 低（简单的数学模型） |

### 6.2 对 ACP 项目的具体建议

1. **短期（纯工程，无训练）**：
   - 引入**结构边界信号**：当检测到"子任务完成"（如 tool call 返回成功、任务状态变化）时，附加 nudge 提示"这是一个好的压缩点"
   - 引入 **sleep-time 整理**：session idle 时自动执行 tier-2/3 蒸馏 + 跨会话记忆写入
   - 跨会话记忆存储 tier-3 摘要，用 embedding 索引，检索返回精炼摘要
   - 为长期记忆条目添加 Ebbinghaus 衰减强度，低强度记忆自动降级或清理

2. **中期（轻量训练）**：
   - 收集"好的压缩时机"的示范数据（从现有会话中提取：何时压缩、压缩了什么、后续是否需要 decompress），用 SFT 让模型内化触发策略
   - 引入**压缩质量自评**：压缩后模型检查摘要是否保留了关键信息（参考 Meta-Cognitive Memory Policy）

3. **长期（端到端优化）**：
   - 用 RL 优化记忆策略（参考 MemPO）：奖励信号 = 下游任务性能 + context 利用率效率
   - 实现 SelfMem 的自优化循环：回溯分析"哪些压缩决策是正确的"，持续改进触发策略

### 6.3 检索策略建议

| 查询类型 | 返回层级 | 理由 |
|---|---|---|
| "这个项目的整体架构是什么" | tier-3 超浓缩摘要 | 全局性问题不需要细节 |
| "上次 bug 的 root cause 是什么" | tier-2 蒸馏摘要 | 需要决策和结论，不需要过程 |
| "那段代码的具体实现细节" | tier-1 摘要 → decompress 到原文 | 局部性问题需要精确内容 |
| 不确定需要什么 | 语义搜索返回 tier-2/3 摘要 + 相关性评分 | 让模型自行判断是否需要更多细节 |

---

## 参考文献索引

| # | 论文 | arXiv / URL | 分类 |
|---|---|---|---|
| 1 | ACM: Agentic Context Management | [2607.23809](https://arxiv.org/abs/2607.23809) | 训练内化 |
| 2 | AgentFold | [2510.24699](https://arxiv.org/abs/2510.24699) | 训练内化 |
| 3 | Context as a Tool (C^AT) | [2512.22087](https://arxiv.org/abs/2512.22087) | 训练内化 |
| 4 | SelfCompact | [2606.23525](https://arxiv.org/abs/2606.23525) | 训练内化 |
| 5 | Active Context Compression (Focus) | [2601.07190](https://arxiv.org/abs/2601.07190) | 训练内化 |
| 6 | SWE-MeM | [2606.28434](https://arxiv.org/abs/2606.28434) | 训练内化 |
| 7 | Generative Agents | [2304.03442](https://arxiv.org/abs/2304.03442) | 启发式信号 |
| 8 | MemPO | [2603.00680](https://arxiv.org/abs/2603.00680) | 启发式信号(训练) |
| 9 | Meta-Cognitive Memory Policy | [2605.30159](https://arxiv.org/abs/2605.30159) | 启发式信号 |
| 10 | Agentic Memory | [2601.01885](https://arxiv.org/abs/2601.01885) | 启发式信号(训练) |
| 11 | MemoryBank | [2305.10250](https://arxiv.org/abs/2305.10250) | 遗忘曲线 |
| 12 | FadeMem | [2601.18642](https://arxiv.org/abs/2601.18642) | 遗忘曲线 |
| 13 | SelfMem | [2607.03726](https://arxiv.org/abs/2607.03726) | 记忆触发器 |
| 14 | Sleep-time Compute (Letta) | [2504.13171](https://arxiv.org/abs/2504.13171) | 记忆触发器 |
| 15 | MemGPT / Letta | [docs.letta.com](https://docs.letta.com/guides/core-concepts/memory/context-hierarchy/) | 架构参考 |
| 16 | GraphRAG | [microsoft.github.io/graphrag](https://microsoft.github.io/graphrag/) | 检索策略 |
| 17 | LangChain Autonomous Compression | [langchain.com/blog](https://www.langchain.com/blog/autonomous-context-compression) | 工程参考 |
