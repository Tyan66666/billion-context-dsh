# 记忆读回时机专项调研

> 调研日期：2026-08-08 | 上下文：Active Context Pruning (ACP) for DeepSeek Harness  
> 目标：研究"记忆什么时候被读回（注入/检索进对话上下文）"的业界方案

---

## 一、论文方向：读回时机

### 1.1 Generative Agents（Park et al., 2023）—— 每次行动前检索

- **论文**: [Generative Agents: Interactive Simulacra of Human Behavior](https://arxiv.org/abs/2304.03442) (UIST 2023)
- **检索时机**: **每次行动前（per-action retrieval）**。agent 在决定"下一步做什么"时，从 memory stream 中检索 top-k 相关记忆注入 prompt。
- **打分机制**: 三信号加权 ——
  - `recency`：指数衰减，当前时间与记忆时间戳的差
  - `importance`：LLM 给出的 1-10 重要性评分（在记忆写入时一次性评估）
  - `relevance`：query 与记忆的 cosine similarity（embedding）
  - 最终分数 = `α·recency + β·importance + γ·relevance`（α=1, β=1, γ=1 默认等权）
- **代码参考**: [retrieve.py](https://github.com/joonspk-research/generative_agents/blob/main/reverie/backend_server/persona/cognitive_modules/retrieve.py) — `run()` 函数在 observation/planning 时调用
- **关键设计**: retrieval 是 **reactive**（响应当前任务需要），不是 proactive（不会提前预加载）。每次 agent 需要做决策时触发一次检索。

### 1.2 MemGPT / Letta —— 分层常驻 + 按需检索

- **论文**: [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560) (2023)
- **产品**: [Letta](https://docs.letta.com/) (原 MemGPT)
- **三层记忆架构**:
  | 层级 | 内容 | 读回时机 |
  |------|------|---------|
  | **System Prompt** | 固定指令、persona | 会话开始全量注入（不可变） |
  | **Core Memory** (in-context blocks) | 用户信息、agent 自我认知、关键事实 | **始终常驻上下文**，agent 通过 `core_memory_replace` 工具自主编辑内容，但 blocks 始终在 context window 中 |
  | **Archival Memory** (out-of-context) | 长期知识、历史事实 | **模型自主工具调用检索**：agent 调用 `archival_memory_search(query)` 或 `archival_memory_insert(content)` 按需读写 |
  | **Recall Memory** | 对话历史 | agent 调用 `conversation_search(query)` 按需检索历史对话 |
- **读回决策**: 模型自己决定何时需要额外信息，通过 function calling 发起检索。系统 prompt 中明确指示：*"You respond directly to the user when your immediate context (core memory and files) contain all the information needed; otherwise, you proactively use your tools to search for the answer."*
- **来源**: [Letta context hierarchy docs](https://docs.letta.com/guides/core-concepts/memory/context-hierarchy/), [Letta archival memory docs](https://docs.letta.com/guides/core-concepts/memory/archival-memory/), [memgpt_v2_chat.py system prompt](https://github.com/letta-ai/letta/blob/main/letta/prompts/system_prompts/memgpt_v2_chat.py)

### 1.3 HippoRAG —— 查询时知识图谱检索

- **论文**: [HippoRAG: Neurobiologically Inspired Long-Term Memory for Large Language Models](https://arxiv.org/abs/2405.14831) (2024)
- **读回时机**: **查询时检索（on-demand retrieval）**，与标准 RAG 相同——用户查询到来时触发。
- **创新点**: 不是简单的向量检索，而是模拟海马体索引理论：构建知识图谱（KG），用 PersonalizedPageRank 从 query 中提取的 entities 出发在 KG 上漫游，检索最相关的 passages。
- **对比标准 RAG**: 标准 RAG 在查询时做 flat vector search；HippoRAG 在查询时做 graph-based retrieval。**检索时机相同（查询时），但检索机制更复杂。**
- **来源**: [HippoRAG HTML](https://arxiv.org/html/2405.14831v2), [AWS blog on HippoRAG](https://aws.amazon.com/blogs/machine-learning/hipporag-neurobiologically-inspired-rag-using-amazon-bedrock-amazon-neptune-and-personalized-pagerank)

### 1.4 ACM (Agentic Context Management) —— 模型自主调用 `query_memory`

- **论文**: [ACM: Agentic Context Management for Long Horizon Tasks](https://arxiv.org/abs/2607.23809) (2026-07)
- **核心设计**: 不依赖固定阈值触发压缩/检索，而是给模型两个工具：
  - `compress_context`：将当前上下文压缩到外部存储（agent 自主决定何时压缩）
  - `query_memory`：从外部记忆中检索相关信息（agent 自主决定何时检索）
- **读回时机**: **完全由模型自主决定**——模型判断当前上下文不足时，调用 `query_memory` 从外部记忆中拉取。
- **关键特点**: 
  - 可逆压缩——压缩的内容可以被完整检索回来
  - 不是 "阈值到了就压缩" 的被动策略，而是 agent 主动管理上下文
  - 作者认为这是比固定策略更优的方法
- **来源**: [ACM HTML](https://arxiv.org/html/2607.23809v1), [ACM abstract](https://arxiv.org/abs/2607.23809), [Codex KB 分析](https://codex.danielvaughan.com/2026/08/02/acm-agentic-context-management-long-horizon-tasks-codex-cli-compaction-external-memory-retrieval/)

### 1.5 Agentic Memory（AgeMem, ACL 2026）—— 学习何时管理记忆

- **论文**: [Agentic Memory: Learning Unified Long-Term and Short-Term Memory Management for LLM Agents](https://arxiv.org/abs/2601.01885) (ACL 2026)
- **核心**: 通过强化学习训练一个统一的记忆管理策略，同时决定 **写入** 和 **读回** 时机。
- **读回时机**: 不是固定的规则，而是学习到的策略——agent 学会在适当的时候检索长期记忆。
- **短期记忆**: 在上下文窗口内，类似 working memory
- **长期记忆**: 外部存储，通过学习到的策略检索
- **意义**: 首次将记忆管理（包括读回）作为可学习的策略，而非手工设计的规则。
- **来源**: [AgeMem arXiv](https://arxiv.org/abs/2601.01885), [ACL Anthology](https://aclanthology.org/2026.acl-long.981/), [GitHub y1y5/AgeMem](https://github.com/y1y5/AgeMem)

### 1.6 A-MEM (NeurIPS 2025) —— 自组织记忆的按需检索

- **论文**: [A-MEM: Agentic Memory for LLM Agents](https://arxiv.org/abs/2502.12110) (NeurIPS 2025)
- **核心**: 记忆条目（memory atoms）自主组织成链接网络，每条记忆自己决定与其他记忆的关联。
- **读回时机**: **按需检索**——当新信息到来时，检索相关记忆 atoms。检索用 embedding similarity + 链接关系。
- **关键点**: 检索效率在大规模下依然良好（minimal growth in retrieval time）。
- **来源**: [A-MEM arXiv](https://arxiv.org/abs/2502.12110), [GitHub agiresearch/A-mem](https://github.com/agiresearch/a-mem)

### 1.7 TraceRetain（2026）—— 选择性记忆保留

- **论文**: [TraceRetain: Selective Memory Retention for Long-Horizon LLM Agents](https://arxiv.org/abs/2606.29178) (2026-06)
- **核心问题**: 记忆污染（memory pollution）——不相关或过时的记忆被检索进来反而降低性能。
- **读回时机**: 研究了检索后 **过滤** 的重要性——不是"检索什么时机"，而是"检索回来后该保留什么"。
- **轻量框架**: 在检索后通过一个轻量过滤器判断哪些记忆值得注入上下文。
- **意义**: 读回时机不仅指"何时检索"，还包括"检索后是否真的注入"。
- **来源**: [TraceRetain arXiv](https://arxiv.org/abs/2606.29178)

### 1.8 专门研究"注入时机"的论文

#### Session Bootstrap Context Budgets（Zylos Research, 2026-07）
- **来源**: [Session Bootstrap Context Budgets](https://zylos.ai/research/2026-07-03-session-bootstrap-context-budgets/)
- **核心发现**: 每个长期运行的 agent 框架最终都收敛到相似的 session bootstrap 形态——启动时加载一组"bootstrap context"。
- **Bootstrap 构成**: persona/identity + project context + recent memory + retrieved knowledge
- **关键结论**: Bootstrap 不是全量注入所有记忆，而是有预算分配的分层加载。

#### Beyond the Context Window（arXiv:2603.04814, 2026-03）
- **来源**: [Beyond the Context Window: A Cost-Performance Analysis](https://arxiv.org/html/2603.04814)
- **核心**: 对比"事实库记忆"vs"长上下文直接塞入全历史"的性价比。发现基于记忆的方案在成本和性能上更优。

#### PACMS: Submodular Context Selection（arXiv:2606.20047）
- **来源**: [PACMS](https://arxiv.org/html/2606.20047)
- **核心**: 将上下文选择建模为子模优化问题——选择哪些记忆条目注入上下文以最大化任务性能。

#### Semantic Memory Injection（MindStudio, 2026-06）
- **来源**: [Semantic Memory Injection for AI Agents](https://www.mindstudio.ai/blog/semantic-memory-injection-frozen-snapshot-pattern)
- **分析**: Frozen snapshot pattern 的优缺点——上下文窗口填满快、token 成本高、过时历史可能污染。

---

## 二、产品/项目方向：读回时机

### 2.1 Claude Code Auto Memory —— 会话开始全量注入（有限制）

- **机制**: 
  - `CLAUDE.md`：**每次 turn 注入** system prompt（不只是会话开始，是每次请求）
  - `MEMORY.md`（auto memory）：同样 **每次 turn 注入** system prompt
  - 限制：只加载 MEMORY.md 的 **前 200 行**
  - 注入位置：system prompt 的 Block 4（dynamic content，在 DYNAMIC_BOUNDARY 之后）
- **Relevant Memories (tengu_moth_copse)**: 这是一个 feature gate，实验性功能——根据当前上下文 prefetch 相关记忆片段（而非全量注入），但尚未成为默认行为
- **来源**: [Claude Code memory docs](https://code.claude.com/docs/en/memory), [db0.ai 分析](https://db0.ai/blog/how-claude-code-memory-works), [ccmd.dev token 分析](https://ccmd.dev/t/claude-md-auto-memory-tokens), [GitHub issue #46644](https://github.com/anthropics/claude-code/issues/46644)
- **启示**: 全量注入简单但有 token 预算问题；200 行限制是一种粗略的预算控制。

### 2.2 Cline Memory Bank —— 会话开始强制全读

- **机制**: 6 个 markdown 文件，**"ALL files must be read at start of EVERY task"**
  - `projectBrief.md` — 项目概述
  - `productContext.md` — 产品上下文
  - `activeContext.md` — 当前活跃上下文
  - `systemPatterns.md` — 系统模式
  - `techContext.md` — 技术上下文
  - `progress.md` — 进度
- **来源**: [Cline Memory Bank docs](https://docs.cline.bot/best-practices/memory-bank), [prompts repo](https://github.com/cline/prompts/blob/main/.clinerules/memory-bank.md), [DeepWiki 分析](https://deepwiki.com/cline/prompts/3.1-memory-bank-system)
- **特点**: 最激进的全量注入——没有检索、没有过滤、没有预算。优势是零遗漏，劣势是 token 浪费。

### 2.3 mem0 —— 查询时检索，应用层注入

- **机制**: 
  - mem0 本身**不自动注入**——它是一个记忆存储/检索 API
  - 应用层在每轮对话前调用 `memory.search(query)` 获取相关记忆
  - 返回的记忆由应用层组装进 system prompt 或 user message
  - **推荐模式**: 在每轮对话的 user message 前注入检索到的记忆
- **来源**: [mem0 docs](https://docs.mem0.ai/core-concepts/how-it-works), [mem0 search docs](https://docs.mem0.ai/core-concepts/memory-operations/search), [GitHub issue #3736](https://github.com/mem0ai/mem0/issues/3736), [GitHub issue #4341](https://github.com/mem0ai/mem0/issues/4341)
- **特点**: 纯 API 设计，注入时机完全由调用者控制。灵活但需要集成者自己实现注入逻辑。

### 2.4 Letta —— Core Memory 常驻 + Archival/Recall 按需

- **Core Memory blocks**: 始终在上下文中，agent 通过工具编辑内容但 blocks 永远可见
- **Archival Memory**: agent 调用 `archival_memory_search` 按需检索
- **Recall Memory**: agent 调用 `conversation_search` 按需检索
- **来源**: [Letta context hierarchy](https://docs.letta.com/guides/core-concepts/memory/context-hierarchy/), [Letta agent memory blog](https://www.letta.com/blog/agent-memory/), [Letta memory blocks blog](https://www.letta.com/blog/memory-blocks/), [Letta community discussion](https://forum.letta.com/t/how-does-memory-work-in-letta/93)
- **关键**: 这是 **混合模式** 的典范——小常驻核心 + 大量按需检索。

### 2.5 dsh-memento (PerryLink) —— Frozen Snapshot 会话开始注入

- **来源**: [GitHub PerryLink/dsh-memento](https://github.com/PerryLink/dsh-memento), [plugin registry](https://deepseek1024.com/plugins/PerryLink/dsh-memento)
- **机制**: 
  - 提供 typed `ctx.memory` 服务，含 `add/replace/remove/query/seed/budgets` 方法
  - 写操作需要 approval gate
  - 会话开始时通过 frozen snapshot seed 注入记忆
  - 分层设计，有 token 预算控制
- **读回时机**: **会话开始预注入**（frozen snapshot pattern）

### 2.6 dsh-memory (Jesse-njx) —— Cited Memory with Tool-Based Retrieval

- **来源**: [GitHub Jesse-njx/dsh-memory](https://github.com/Jesse-njx/dsh-memory), [plugin registry](https://dsh-plugin.net/plugins/dsh-memory)
- **机制**: 
  - 基于 DSH 无损会话日志的 cited memory
  - 记忆是 distilled、human-auditable 的事实，带 citation 回溯到原始 source events
  - **读回时机**: 模型通过工具（类似 search_context）按需检索
  - 特点：记忆本身带引用链，可追溯

### 2.7 其他系统

#### Basic Memory (MCP)
- **来源**: [Basic Memory docs](https://docs.basicmemory.com/reference/mcp-tools-reference), [agent memory playbook](https://basicmemory.com/playbooks/agent-memory)
- **机制**: MCP 工具提供 `read_note`/`search`/`list` 等；agent 自主决定何时调用
- **读回时机**: **模型自主工具调用**——Basic Memory 不自动注入，agent 需要时主动搜索

#### MemOS (arXiv:2507.03724)
- **来源**: [MemOS arXiv](https://arxiv.org/abs/2507.03724), [GitHub MemTensor/MemOS](https://github.com/MemTensor/MemOS), [MemOS Context API](https://api.mymemoryos.com/docs/api/context)
- **机制**: Memory Operating System，统一 store/retrieve/manage
- **Context API**: 提供 `retrieve` 端点，根据 query 检索相关记忆，支持 token budget 限制
- **读回时机**: **查询时检索**，通过 Context API 传入当前 query + token budget，返回格式化记忆

#### LangMem (LangChain)
- **来源**: [LangMem tools reference](https://langchain-ai.github.io/langmem/reference/tools/), [memory tools guide](https://langchain-ai.github.io/langmem/guides/memory_tools/)
- **机制**: 提供 `manage_memory_tool`（写）和 `search_memory_tool`（读）
- **两种路径**: 
  - Hot path: agent 在对话中自主调用工具保存/检索（按需）
  - Background extraction: 后台异步提取记忆（不影响即时检索时机）
- **读回时机**: **模型自主工具调用**——agent 自己决定何时 `search_memory`

---

## 三、模式总结

### 3.1 读回时机的四种模式

| 模式 | 触发时机 | 典型实现 | 代表系统 |
|------|---------|---------|---------|
| **A. 会话开始预注入 (Session-start injection)** | 会话/任务启动时 | 读取固定文件 → 注入 system prompt | Claude Code (CLAUDE.md/MEMORY.md), Cline Memory Bank, dsh-memento |
| **B. 查询时按需检索 (On-demand query retrieval)** | 每次用户查询/agent 决策时 | embedding search / KG retrieval → 注入 | Generative Agents, HippoRAG, mem0, MemOS |
| **C. 模型自主工具调用 (Model-initiated tool call)** | 模型判断需要时 | agent 调用 search/retrieval 工具 | MemGPT/Letta (archival), ACM (query_memory), Basic Memory, LangMem |
| **D. 常驻固定块 (Persistent resident blocks)** | 始终在上下文中 | 作为 system prompt 的一部分永久存在 | Letta (Core Memory blocks), 系统 prompt 指令 |

### 3.2 各模式优缺点

| 模式 | 优点 | 缺点 | 适用场景 |
|------|-----|------|---------|
| **A. 预注入** | 零延迟、零遗漏、实现简单 | token 浪费严重（无关记忆也占用预算）、随记忆增长不可扩展 | 记忆量小（<200 行 / <2K tokens）、关键上下文必须全局可见 |
| **B. 查询时检索** | 高效利用 token 预算、随记忆量可扩展 | 依赖检索质量（可能遗漏）、有检索延迟、需要 embedding 基础设施 | 记忆量大、需要语义相关性匹配 |
| **C. 模型自主调用** | 最灵活、模型按需取用、与推理过程深度整合 | 增加工具调用开销、模型可能"忘记"检索、增加推理 token | 复杂任务、agent 需要自主决策 |
| **D. 常驻固定块** | 最可靠的"always-on"信息、零检索开销 | 挤压可用上下文空间、内容需要人工/agent 维护 | 最核心的身份/指令信息、小量关键事实 |

### 3.3 混合模式：小常驻 + 按需取回

**业界共识正在收敛到混合模式**，核心证据：

1. **Letta/MemGPT 的三层架构**是混合模式的教科书案例：
   - System prompt（固定，不可变）
   - Core Memory（常驻 blocks，agent 可编辑内容但始终在上下文中）
   - Archival + Recall（按需工具检索）
   - 来源: [Letta docs](https://docs.letta.com/guides/core-concepts/memory/context-hierarchy/)

2. **Zylos Research 的 Session Bootstrap 研究**（2026-07）发现：所有长期运行的 agent 框架都自然收敛到分层 bootstrap 形态——启动时加载一组核心 context，运行时按需检索补充。
   - 来源: [Zylos session bootstrap](https://zylos.ai/research/2026-07-03-session-bootstrap-context-budgets/)

3. **Claude Code 的实践**：CLAUDE.md（常驻）+ MEMORY.md（常驻前 200 行）+ Relevant Memories（实验性按需 prefetch）= 混合模式的渐进演化。
   - 来源: [Claude Code memory docs](https://code.claude.com/docs/en/memory)

4. **Beyond the Context Window 论文**（arXiv:2603.04814）的定量对比表明：纯长上下文方案在成本和性能上均劣于"小常驻 + 按需记忆库"方案。
   - 来源: [arXiv 2603.04814](https://arxiv.org/html/2603.04814)

5. **Semantic Memory Injection 研究**（MindStudio, 2026-06）分析了 frozen snapshot pattern 的固有局限：上下文填满快、token 成本高、过时信息污染。结论是需要结合 selective retrieval。
   - 来源: [MindStudio blog](https://www.mindstudio.ai/blog/semantic-memory-injection-frozen-snapshot-pattern)

### 3.4 记忆注入的上下文预算研究

| 研究/系统 | 发现 | 来源 |
|----------|------|------|
| **Claude Code** | MEMORY.md 限制前 200 行（约 ~3K tokens on real index） | [ccmd.dev](https://ccmd.dev/t/claude-md-auto-memory-tokens) |
| **Generative Agents** | 默认 top-k=30 条记忆注入 | [retrieve.py](https://github.com/joonspk-research/generative_agents/blob/main/reverie/backend_server/persona/cognitive_modules/retrieve.py) |
| **PACMS** | 子模优化建模上下文选择，证明存在"最优子集"——注入全部记忆不如选择性注入 | [arXiv 2606.20047](https://arxiv.org/html/2606.20047) |
| **Zylos Bootstrap** | 推荐分层预算：identity (~500 tokens) + project context (~1K) + retrieved memory (~2-4K) | [Zylos](https://zylos.ai/research/2026-07-03-session-bootstrap-context-budgets/) |
| **MemOS Context API** | 支持 `token_budget` 参数，调用者显式控制注入上限 | [MemOS Context API](https://api.mymemoryos.com/docs/api/context) |
| **AdaMem (arXiv:2606.21144)** | 学习"记什么"——个性化长期 agent 需要选择性记忆而非全量记忆 | [arXiv 2606.21144](https://arxiv.org/html/2606.21144v1) |

---

## 四、模式谱系表

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         记忆读回时机谱系                                         │
├──────────┬──────────────┬──────────────────┬──────────────────────────────────────┤
│  时机类型  │   触发方式     │    代表系统        │  优缺点                              │
├──────────┼──────────────┼──────────────────┼──────────────────────────────────────┤
│ 会话开始   │ 启动时自动     │ Claude Code      │ ✅ 零延迟、零遗漏                      │
│ 预注入    │ 全量注入       │ Cline Memory Bank│ ❌ token 浪费、不可扩展                 │
│          │              │ dsh-memento      │ 📦 适合: 小记忆集、关键全局上下文         │
├──────────┼──────────────┼──────────────────┼──────────────────────────────────────┤
│ 查询时    │ 每次 query    │ HippoRAG         │ ✅ 高效 token 使用                     │
│ 按需检索  │ 触发检索      │ mem0             │ ❌ 检索质量依赖、可能遗漏               │
│          │              │ MemOS            │ 📦 适合: 大记忆库、语义匹配场景          │
├──────────┼──────────────┼──────────────────┼──────────────────────────────────────┤
│ 模型自主  │ agent 调用    │ MemGPT/Letta     │ ✅ 最灵活、与推理深度整合               │
│ 工具调用  │ search 工具   │ ACM (query_mem)  │ ❌ 增加工具开销、可能遗忘               │
│          │              │ LangMem, BasicMem│ 📦 适合: 复杂自主任务                   │
├──────────┼──────────────┼──────────────────┼──────────────────────────────────────┤
│ 常驻固定块 │ 始终在上下文   │ Letta Core Mem   │ ✅ 最可靠、零检索开销                   │
│          │ 中不可移除    │ System Prompt    │ ❌ 挤压可用空间                        │
│          │              │                  │ 📦 适合: 核心身份/指令信息               │
├──────────┼──────────────┼──────────────────┼──────────────────────────────────────┤
│ 混合模式   │ 小常驻 + 按需 │ Letta (完整架构)  │ ✅ 兼顾可靠性与效率                     │
│ (主流趋势) │ 检索         │ Claude Code (演进)│ ❌ 实现复杂度高                        │
│          │              │ A-MEM            │ 📦 适合: 生产级长期 agent               │
└──────────┴──────────────┴──────────────────┴──────────────────────────────────────┘
```

---

## 五、对我们设计的启示（ACP / billion-context-dsh）

### 5.1 核心判断

**我们当前只做了"写"（memory_commit → fork 子对话提取 → 写入 markdown），还没做"读"。读回设计应该采用混合模式。**

### 5.2 推荐设计

#### Tier 1: 常驻注入（Session Bootstrap）
- **时机**: 会话开始时注入
- **内容**: 最核心的记忆摘要（项目偏好、用户习惯、关键决策）
- **预算**: 控制在 ~1-2K tokens（参考 Zylos bootstrap 和 Claude Code 的 200 行限制）
- **实现**: ACP 引擎在 `agent/pre-step` 首次触发时，从记忆库中加载 bootstrap 记忆注入 system prompt

#### Tier 2: 按需检索（On-demand via search_context）
- **时机**: 模型通过已有的 `search_context` 工具触发
- **内容**: 记忆库中相关条目（带 citation 回溯）
- **实现**: 让 `search_context` 同时搜索压缩块和记忆库，或新增一个 `recall_memory` 工具
- **关键**: 检索结果应带 confidence score，由模型判断是否注入

#### Tier 3: 可选的 Nudge-Triggered Recall
- **时机**: nudge 时，引擎检查当前上下文与记忆库的相关性，主动预取可能需要的记忆
- **灵感**: Generative Agents 的 recency × relevance 打分
- **实现**: nudge 时不只提示压缩，也提示"这里有一些相关的历史记忆：[摘要]，需要注入吗？"

### 5.3 设计原则

1. **不要全量注入**：记忆库会增长，全量注入不可扩展（Cline 的方式在记忆增长后不可行）
2. **保持 citation chain**：参考 dsh-memory，每条记忆应指向原始 session event（我们已有 log-rebuilt ledger，这是天然优势）
3. **给模型选择权**：参考 ACM 和 MemGPT，模型应能自主决定何时检索，而不是引擎强制注入
4. **token 预算要显式**：参考 MemOS 的 `token_budget` 参数，注入量应有上限
5. **利用 ACP 已有基础设施**：`search_context` 已经实现了 hybrid search，记忆库搜索可以复用这个通道

### 5.4 与 ACP 现有架构的契合点

| ACP 现有能力 | 记忆读回利用方式 |
|-------------|---------------|
| `search_context` 工具 | 扩展为同时搜索压缩块 + 记忆库 |
| Nudge 机制 | 在 nudge 中注入"相关记忆提示" |
| `acp_status` | 展示记忆库状态（大小、条目数） |
| 子对话 fork（写入端） | 已有；读回是镜像操作 |
| Session event log | 记忆 citation 的天然来源 |

### 5.5 不建议的方案

1. **不建议** 纯全量注入（Cline 方式）——记忆增长后 token 浪费严重
2. **不建议** 纯按需检索无 bootstrap——关键上下文可能被遗漏（模型不知道该检索什么）
3. **不建议** 引擎强制注入——应保留模型自主权（ACP 的核心哲学：model-driven, not policy-driven）
4. **不建议** 新增独立记忆检索服务——利用已有的 `search_context` 基础设施

---

## 六、参考文献

### 论文
1. Park et al. (2023). *Generative Agents: Interactive Simulacra of Human Behavior*. [arXiv:2304.03442](https://arxiv.org/abs/2304.03442)
2. Packer et al. (2023). *MemGPT: Towards LLMs as Operating Systems*. [arXiv:2310.08560](https://arxiv.org/abs/2310.08560)
3. Gutierrez et al. (2024). *HippoRAG: Neurobiologically Inspired Long-Term Memory for LLMs*. [arXiv:2405.14831](https://arxiv.org/abs/2405.14831)
4. (2026-07). *ACM: Agentic Context Management for Long Horizon Tasks*. [arXiv:2607.23809](https://arxiv.org/abs/2607.23809)
5. (2026-01). *Agentic Memory: Learning Unified Long-Term and Short-Term Memory Management*. [arXiv:2601.01885](https://arxiv.org/abs/2601.01885) (ACL 2026)
6. Xu et al. (2025). *A-MEM: Agentic Memory for LLM Agents*. [arXiv:2502.12110](https://arxiv.org/abs/2502.12110) (NeurIPS 2025)
7. (2026-06). *TraceRetain: Selective Memory Retention for Long-Horizon LLM Agents*. [arXiv:2606.29178](https://arxiv.org/abs/2606.29178)
8. (2026-03). *Beyond the Context Window: A Cost-Performance Analysis*. [arXiv:2603.04814](https://arxiv.org/html/2603.04814)
9. (2026-06). *PACMS: Submodular Context Selection*. [arXiv:2606.20047](https://arxiv.org/html/2606.20047)
10. (2025-07). *MemOS: A Memory OS for AI System*. [arXiv:2507.03724](https://arxiv.org/abs/2507.03724)
11. (2026-06). *AdaMem: Learning What to Remember*. [arXiv:2606.21144](https://arxiv.org/html/2606.21144v1)
12. de Jong et al. (2023). *Pre-computed memory or on-the-fly encoding?*. [PMLR](https://proceedings.mlr.press/v202/de-jong23a.html)

### 产品/项目
13. Claude Code Memory Docs. [code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory)
14. Claude Code MEMORY.md token analysis. [ccmd.dev](https://ccmd.dev/t/claude-md-auto-memory-tokens)
15. Cline Memory Bank. [docs.cline.bot/best-practices/memory-bank](https://docs.cline.bot/best-practices/memory-bank)
16. mem0. [docs.mem0.ai](https://docs.mem0.ai/core-concepts/how-it-works)
17. Letta. [docs.letta.com/guides/core-concepts/memory/context-hierarchy](https://docs.letta.com/guides/core-concepts/memory/context-hierarchy/)
18. dsh-memento. [github.com/PerryLink/dsh-memento](https://github.com/PerryLink/dsh-memento)
19. dsh-memory. [github.com/Jesse-njx/dsh-memory](https://github.com/Jesse-njx/dsh-memory)
20. Basic Memory. [basicmemory.com/playbooks/agent-memory](https://basicmemory.com/playbooks/agent-memory)
21. MemOS. [github.com/MemTensor/MemOS](https://github.com/MemTensor/MemOS)
22. LangMem. [langchain-ai.github.io/langmem](https://langchain-ai.github.io/langmem/guides/memory_tools/)
23. Zylos Session Bootstrap. [zylos.ai/research/2026-07-03-session-bootstrap-context-budgets](https://zylos.ai/research/2026-07-03-session-bootstrap-context-budgets/)
24. Semantic Memory Injection (MindStudio). [mindstudio.ai/blog](https://www.mindstudio.ai/blog/semantic-memory-injection-frozen-snapshot-pattern)
25. Generative Agents Code (retrieve.py). [GitHub joonspk-research/generative_agents](https://github.com/joonspk-research/generative_agents/blob/main/reverie/backend_server/persona/cognitive_modules/retrieve.py)
