# 跨会话长期记忆设计(Cross-Session Memory Design)— v1

> **状态**:设计讨论稿 v1(2026-08,经三轮调研 + 多轮用户设计讨论定稿)。
> **待定项(今日不细究,实现前补齐)**:
> - **T1** `memory_commit` 的 negative constraints 措辞——"何时**不要**调用"的提示词(对齐 Claude Code 显式 negative list:code patterns、git history、debugging plans、已在 CLAUDE.md 的内容、临时任务状态)。当前仅定"正向触发点"(type 枚举 + 何时该用),negative 部分实现时补。
> - **T2** `memory_commit` 工具返回话术(现状:引擎返回"后台已总结写入",精确文案实现时定)。
> - **T3** 索引条目格式的精确 schema(frontmatter 字段名、目录结构)实现时定。
>
> **设计依据**(三轮调研,归档于 `docs/memory-research/`):
> - 论文向 17 篇:`docs/memory-research/01-autonomous-memory-papers.md`(ACM/AgentFold/C^AT/Generative Agents/MemoryBank/FadeMem/Agentic Memory 等)
> - 实现向 8 产品:`docs/memory-research/02-autonomous-memory-implementations.md`(Claude Code/Cline/mem0/Letta/LangMem/DSH 生态/MemOS/Basic Memory)
> - 读回时机 25 源:`docs/memory-research/03-memory-readback-timing.md`(四模式谱系 + 混合收敛证据)
> - Claude Code 源码核实:`docs/memory-research/04-claude-code-source-verification.md`(liuup 镜像提炼存档)

## 1. 背景与目标

billion-context-dsh 目前是**会话内**上下文管理:模型通过 compress 把旧内容折叠成 tier-1 摘要块,可蒸馏(tier-2/3)、可 decompress/search 找回——但**会话结束即失忆**(对比 mem0/Letta/Zep/CLAUDE.md/AGENTS.md 的文件记忆)。这是项目最大缺口(调研报告 §三 缺点 #1/#8)。

目标:增加**跨会话长期记忆**——模型在 nudge 时机表态"这段值得记住",引擎 fork 提取写入**人类可读 markdown 记忆库**,新会话经**常驻索引 + 自主取回**使用。

设计约束:
1. **算法进 kernel、集成留宿主**(决策 7/规则 11 镜像)——凡"算法/数据结构/格式/文案"性质进 acp-kernel(upstream),凡"DSH 工具面/LLM 运行时/文件系统/seq 方言/提示词注入"留宿主;实现顺序 **kernel 先行,宿主后随**(见 §6A);
2. **模型自决**——写入/取回都由模型决策(决策 3 精神),引擎只提供接缝与时机提示;
3. **人类可读可编辑**——记忆库是 markdown 文件,用户可直接看/改/删(外部纠错通道);
4. **可回溯**——每条记忆带 citation(会话+seq),延续 append-only + decompress 哲学;
5. **不违反决策 3 的"无自动摘要"**——提取写记忆库,不碰主对话、不压缩任何内容(见 §6 相容性)。

## 2. 总体架构:写 → 存 → 读 闭环

```
┌─ 写入(nudge 时机)───────────────────────────────┐
│ nudge 触发 → 模型回顾 → memory_commit(type, note)   │
│   → 引擎一次性 LLM 调用(同模型同文本+"提取记忆,重点:X")│
│   → 提取结果写记忆库(带 citation)→ 返回"后台已写入"    │
│   → 主对话继续压缩                                 │
└──────────────────────────────────────────────┘
              ↓
┌─ 存储 ────────────────────────────────────────┐
│ 记忆库 = 人类可读 markdown 目录(工作区 .acp-memory/) │
│ 每条 = 标题 + 正文(精炼态) + type + importance(1-10)  │
│      + created + last_read + citation(会话+seq)      │
└──────────────────────────────────────────────┘
              ↓
┌─ 读回(两个时机)───────────────────────────────┐
│ ① 常驻索引:一句话/条+类型+上次读取,每次 turn 在        │
│ ② 自主取回:模型见相关条目 → memory_recall 取全文       │
└──────────────────────────────────────────────┘
              ↓
┌─ 衰减(与选择同机制)───────────────────────────┐
│ score = importance + min(days/30,5) + uniform(0,.5) │
│ 被读降权、久未读加权 → 冷记忆权重回升等机会             │
└──────────────────────────────────────────────┘
```

## 3. 写入路径(模型自决:nudge 表态 + fork 提取)

### 3.0 核心认知:压缩块本身就是长期记忆候选

每次 compress 生成的 tier-1 块(b1)摘要本身就是适合长期存储的内容——记忆沉淀复用压缩产物,不是另起炉灶的独立系统。**但沉淀决策始终是模型自决,不搞引擎自动归档**(决策 3:无自动策略)——模型判断"某个压缩块 b1 的摘要值得沉淀"或"这段对话有值得记住的内容"时,走 nudge 表态路径(见下)。

### 3.1 三工具权限分离(用户定稿)

| 工具 | 谁可见 | 干什么 |
|---|---|---|
| `memory_commit(type, note)` | **主对话** | 表态"这段值得记"(type 枚举 + note 聚焦提示);不写内容 |
| `memory_recall(query)` | **主对话** | 读回:检索记忆库取全文(见 §5) |
| `memory_write(content)` | **仅 fork 会话** | 真正写记忆库;**主对话物理上无写权限** |

主对话只有"请求写"的能力、没有"写"的能力——写记忆库只能通过 fork 会话的 memory_write 完成,权限天然隔离(fork = 带 memory_write 工具定义的一次性 LLM 调用,宿主把工具输出落库)。

### 3.2 `memory_commit` 工具(主对话侧,纯意图表达)

- **语义**:nudge 时模型觉得有值得跨会话保留的内容 → 调用本工具**表态**(不写内容,写内容由 fork 完成)。
- **参数**:
  - `type`:必选,封闭枚举 `decision|lesson|fact|user-preference|reference`(对齐 Claude Code 4 类 taxonomy 思想,扩展为 5 类);
  - `note`:可选,一句话聚焦提示(如"关于 session.append 可重入的教训"),帮助提取定向。
- **negative constraints(待定 T1)**:提示词需写"何时**不要**调用"(代码模式、临时任务状态、已在会话内的内容)——实现时补。

### 3.3 一次性 LLM 调用(引擎侧,fork 会话)

**用户决策**:DSH 用**一次性 LLM 调用**即可,不需要真正的子对话/fork 会话。

- 引擎收到 `memory_commit` → 发起一次独立 LLM 调用(fork):
  - 输入 = 当前完整对话文本(与主对话 surface 一致)+ 插入指令"提取目前需要的记忆,重点:{note}"(同模型,prefix cache 可命中);
  - 工具面 = 仅暴露 `memory_write`(写记忆库)+ 只读工具;
  - 输出 = 模型调用 `memory_write(content)`,宿主把提炼结果(精炼态、自包含陈述句)落库;
- **一次性**:无会话状态、无归档/删除需求、不占常驻资源(对比 Claude Code runForkedAgent 是完整 fork 会话——我们对齐其缓存命中的好处,但免除会话生命周期管理);
- **fire-and-forget**:不阻塞主对话;返回"后台已写入"(话术待定 T2)。

### 3.4 记忆条目格式

```
标题(一行,自包含)
---
正文:精炼态陈述(结论/决策/教训,不含上下文指代)
---
frontmatter:
  type: decision | lesson | fact | user-preference | reference
  importance: 1-10(memory_commit 表态时模型顺带评)
  created: ISO 时间
  last_read: ISO 时间(读回时更新)
  citation: { session: <id>, seq: <表态时刻 seq> }
```

- 记忆条目 = **tier-3 蒸馏块等价物**(Agentic Memory arXiv:2601.01885 明示 tier-1/2/3 蒸馏等价 short→long 迁移,tier-3 即天然长期记忆条目)——不造新格式,复用分层蒸馏思想;
- 正文只存**精炼态**(不存原文)——检索天然只返回精炼摘要,避免"搜到最糙的原始段落"。

## 4. 存储

- **位置**:工作区 `.acp-memory/` 目录(或 `~/.dsh/memories`,配置可切换);
- **形态**:人类可读 markdown(排除纯"记忆会话"形态——人必须可读可编辑 = 外部纠错通道);
- **保质期**:Ebbinghaus 强度(MemoryBank arXiv:2305.10250 记忆强度指数衰减、被检索刷新;FadeMem arXiv:2601.18642 增加信息冗余度覆盖因素)——**不是定死日期**,由 `importance + last_read` 驱动;
- **覆盖(upsert)**:同主题写 UPDATE 而非新增;靠提示词引导"写前先检索已有记忆"(工具层去重需语义相似度=embedding,故选模型自觉 + 工具支持覆盖)。

## 5. 读回路径

### 5.1 决策:延迟读回 + 两个时机(砍掉多层)

**用户决策**:定稿不需要多层设计——Claude 就两个时机,参考 Claude:
1. **常驻索引**(时机①):记忆库索引(一句话/条 + 类型 + 上次读取时间)注入 system prompt,每次 turn 都在(对齐 MEMORY.md 常驻);
2. **自主取回**(时机②):模型看到索引中相关条目 → 自调 `memory_recall` 取全文。

**不采用**(砍掉):
- ~~显式写回~~——memory_commit 后不立即展示写入了什么(延迟读回,省上下文);
- ~~每次用户消息自动 prefetch~~——无自动灌入(用户质疑"每次用户消息都发?"→ 确认不);注:Claude Code 的 relevant_memories prefetch 是 feature gate `tengu_moth_copse` 默认关闭的实验功能,非默认行为;
- ~~nudge 预取 Tier 3~~——多层设计砍掉,对齐 Claude 两时机。

### 5.2 先例:Claude Code = "常驻索引 + 自主取回"生产实践(源码核实)

- 常驻索引:MEMORY.md 常驻 system prompt(`findRelevantMemories.ts:31` "Excludes MEMORY.md (already loaded in system prompt)"),格式 = 一句话/条(`formatMemoryManifest`:`- [type] filename (timestamp): description`);
- 自主取回全文:每条记忆独立 .md 文件,模型需要细节时自调 FileRead 读全文(`attachments.ts:2306` "Use the FILE_READ_TOOL_NAME tool to view the complete file");
- **Letta 同构变体**:Core Memory blocks 常驻(内容本体)+ Archival 自主 `archival_memory_search`。区别:Claude 常驻索引、Letta 常驻内容。**我们选 Claude 路线**(索引常驻 + 全文按需):token 更省,且与"记忆库 = 人类可读 markdown 文件"天然匹配;
- **结论**:非发明,两大主流系统独立收敛的同一形态;我们增量 = `memory_recall` 工具面 + 索引带 last-read 字段 + 一次性 LLM 调用写入。

### 5.3 `memory_recall` 工具

- **语义**:从记忆库检索相关条目全文(与 `search_context` 分开:search_context 管会话内压缩块,memory_recall 管跨会话记忆库);
- **参数**:query(必选)、limit(可选,默认 5);
- **返回**:匹配条目(标题 + 正文精炼态 + type + citation + importance),带 citation 回溯。

### 5.4 常驻索引选择机制:importance + 反新鲜度 + 随机

**问题**:纯频率/强度优先 → 富者愈富正反馈锁定(被读 → 频率升 → 优先被读 → 更被读);无搜索工具兜底时冷门记忆被挤出即消失。

**机制**(字段全部记忆库自带,不依赖 sideQuery/embedding):
```
score = importance + min(days_since_last_read / 30, 5) + uniform(0, 0.5)
```
- `importance`(1-10):memory_commit 表态时模型顺带评分(Generative Agents 做法,写入时一次性评估);
- `anti-recency`:"上次被读时间"越久远优先级越高——刚读过的降权让位(正反馈变负反馈);
- `random jitter`:加权抽样而非确定性 top-k,随机性打破"永远同一批"锁定;
- **top-N = 5**(对齐 Claude 5-slot);**会话节流** = 累计 surfacing 上限(对齐 MAX_SESSION_BYTES 60KB,超限停止注入);**去重** = 本会话已注入路径不再注入(对齐 alreadySurfaced);
- **与保质期合并**:遗忘曲线反过来用——"被读降权 + 久未读加权",不被读的记忆不是消失而是权重回升等机会;可见性调度与保质期同一套字段(importance + last-read),一个机制两用。

### 5.5 读回的记忆在 compress 中是否折叠 = 模型自决(Q3)

注入时向模型标注"这是以往的一条长期记忆";是否保留由模型自行判断——当前上下文有用就留在 surface(compress 时自然不选),没用就允许折叠(记忆库有原文,需要时再召回)。**不需要"记忆 attachment 永不压缩"特殊标记**——与决策 3(压缩范围模型自决)自洽,与 Claude Code compact-重置-surfacing 哲学一致(compact 后 old attachments 消失,re-surfacing valid again)。

## 6A. Kernel 归属划分(用户决策:算法进 kernel,先改 kernel 再改宿主)

**判断原则**:凡有"算法/数据结构/格式/文案"性质 → 进 acp-kernel(upstream issue + PR);凡有"DSH 工具面/LLM 运行时/文件系统/seq 方言/提示词注入"性质 → 留宿主。**实现顺序:kernel 先行,宿主后随**——kernel 发布新能力后,宿主改为调 kernel API(对齐 §4b 升级 SOP + 规则 11)。

### A 类:进 kernel(本次就提 upstream)

| 设计成分 | 归属理由 |
|---|---|
| **score 选择机制**(importance + anti-recency + random) | 纯选择/排序算法——与 kernel 现有 `recommend` T1 门槛、`mergeRangesToThreshold` 同类,kernel 领域 |
| **Ebbinghaus 衰减/保质期/遗忘** | 纯算法——报告 P2-7 已标"时间维度/遗忘 = kernel 层变更走 upstream" |
| **记忆条目数据模型**(= tier-3 蒸馏块等价物) | 记忆形态就是 kernel 分层蒸馏产物——kernel 拥有 tier/蒸馏/块结构,宿主不另造格式 |
| **memory_recall 检索算法** | kernel 已有 `searchBlocks` hybrid(MRR 0.898)——扩展它搜记忆库是 kernel 的事(报告 P1-5 语义检索走 upstream 同方向) |
| **记忆库数据结构**(若复用 blocks/refs 概念) | 块/ref 管理是 kernel 拥有的 |
| **nudge 记忆提示文案**("有稳定结论→memory_commit") | 规则 9:kernel owns the prompt/format——nudge 文案属 kernel `renderNudgeText`(或经 config.prompts 模板层覆盖,那是宿主 wiring) |
| **三工具接口语义**(commit/recall/write 的 schema 与可见性:write 仅 fork) | 工具接口语义是 kernel 拥有的定义,宿主只做 DSH 工具面注册 |

### B 类:留宿主(billion-context-dsh)

| 设计成分 | 归属理由 |
|---|---|
| **memory_commit / memory_recall / memory_write 工具注册** | DSH 工具面是宿主 wiring(决策 7);memory_write 注册到 fork 会话的工具面(仅 fork 可见) |
| **一次性 LLM 调用(fork)实现** | 宿主 LLM 运行时能力;fork 带 memory_write 工具定义 |
| **memory_write 落库** | 宿主把 fork 的 memory_write 工具输出写入 markdown 记忆库 |
| **markdown 文件存储 + citation(会话+seq)** | seq 方言是宿主的(决策 7);文件系统是宿主 |
| **常驻索引注入 system prompt** | system-prompt.ts 是宿主 wiring |
| **/acp memory list** | 宿主命令 |
| **触发时机接线**(nudge hook → memory_commit) | 引擎 wiring |

### 实施顺序

1. **Phase K(kernel 先行)**:向 acp-kernel 提 upstream issue(记忆能力面设计)+ PR——score 选择、Ebbinghaus 衰减、记忆条目数据模型、memory_recall 检索扩展、nudge 记忆提示文案;
2. **Phase H(宿主后随)**:kernel 发布后,billion-context-dsh bump kernel(§4b SOP)+ 实现宿主侧 B 类(工具注册、LLM 调用提取、markdown 存储、索引注入、/acp memory list、时机接线),全部调 kernel API。

## 6. 与 AGENTS.md 决策的相容性检查

| 决策/规则 | 相容性 |
|---|---|
| 决策 3 无自动摘要 | ✅ 提取写记忆库、不碰主对话、不压缩任何内容;compactIfNeeded 仍返回 null |
| 决策 6 搜索信任 kernel | ✅ memory_recall 检索算法进 kernel(扩展 searchBlocks);宿主只注册工具面 |
| 决策 7 信任 kernel 一切能力 | ✅ 算法类全部进 kernel(§6A A 类);宿主只拥有 DSH 集成(§6A B 类:工具面/LLM/文件/方言/注入) |
| 规则 11 缺陷走 upstream | ✅ 本设计所有算法都在 kernel 侧实现,宿主无 patch;若 kernel 记忆检索有 bug,上游修 |
| 规则 9 acp_status 渲染 | ✅ 不动 buildStatusReport;nudge 记忆提示文案属 kernel renderNudgeText(或 config.prompts 覆盖);/acp memory list 是宿主命令 |

## 7. 用户侧接口

### 7.1 `/acp memory list`(唯一专用命令)

**用户决策**:导入导出不需要专门命令——用户直接对模型说"把这段存进记忆"/"导入这个文件",模型自然用 memory_commit/读文件处理;人类侧只需一个查看命令。

- 列出全部记忆条目:`#id [type] 标题 (importance N, created, last_read)`——不带正文(正文用 memory_recall 或直接打开文件);
- 用途:用户看"现在库里有什么",识别过时/错误条目,决定手动改/删。

### 7.2 自然语言即接口

- "把这段写进长期记忆" → 模型 memory_commit(自动路径);
- "导入这个文件到记忆库" → 模型读文件 → 写入;
- "删除那条关于 X 的记忆" → 模型操作记忆库文件。

## 8. 配置项(草案)

| 配置 | 默认 | 说明 |
|---|---|---|
| `memory.enabled` | false | 总开关(对齐 Claude prefetch 默认关——未优化前不干扰) |
| `memory.dir` | `.acp-memory/` | 记忆库目录 |
| `memory.bootstrapTokens` | ~1-2K | 常驻索引预算(Zylos bootstrap 参考:identity ~500 + project ~1K + retrieved ~2-4K) |
| `memory.topN` | 5 | 索引 top-N |
| `memory.sessionBudgetBytes` | 60KB | 会话 surfacing 累计上限(对齐 MAX_SESSION_BYTES) |
| `memory.weights` | α=1, β=1/30, γ=0.5 | score 公式权重(α·importance + β·min(days,30) + γ·rand) |

## 9. 模块映射(实现时)

**Phase K(kernel,upstream acp-kernel)**:

| kernel 模块 | 职责 |
|---|---|
| `memory.ts`(新) | 记忆条目数据模型、score 选择、Ebbinghaus 衰减(§6A A 类) |
| `search.ts` 扩展 | memory_recall 检索(复用 searchBlocks hybrid 基础设施) |
| `nudge-text.ts` 扩展 | nudge 记忆提示文案("有稳定结论→memory_commit") |

**Phase H(宿主,billion-context-dsh,调 kernel API)**:

| 模块 | 职责 | 参照 |
|---|---|---|
| `src/memory.ts`(新) | 记忆库文件读写、索引构建(调 kernel memory API)、citation 记录 | dsh-memory 的 citation、dsh-memento 的 budget |
| `src/tools.ts` 扩展 | `memory_commit` / `memory_recall` 工具注册 | 现有四工具模式 |
| `src/nudge.ts` 扩展 | nudge 记忆引导接线(两段式:①有稳定结论→memory_commit ②已消费内容→compress) | 现有 buildNudgeText |
| `src/system-prompt.ts` 扩展 | 常驻索引注入(对齐 MEMORY.md) | 现有系统提示词 |
| `src/commands.ts` 扩展 | `/acp memory list` | 现有 /acp 命令 |
| 一次性 LLM 调用 | 宿主接缝(DSH 侧实现) | Claude Code runForkedAgent 思想,但无会话 |

## 10. 测试计划(实现时)

**Phase K(kernel 侧测试,上游)**:
1. score 公式:importance 主权重、反新鲜度 30 天封顶、随机 ±0.5、top-N=5;
2. Ebbinghaus 衰减:强度衰减、被读降权、久未读加权;
3. 记忆条目数据模型:类型校验、frontmatter schema;
4. memory_recall 检索:按 query 返回精炼态条目(复用 searchBlocks 测试设施)。

**Phase H(宿主侧测试)**:
5. memory_commit 工具 schema 校验(必选 type 枚举、可选 note);
6. 一次性 LLM 调用:输入 = 完整对话 + 指令,输出写入记忆库(带 citation);
7. 常驻索引:注入内容 = 一句话/条 + 类型 + last_read;预算内;
8. memory_recall 工具:转发 kernel 检索结果;
9. /acp memory list:列出全部条目;
10. 折叠自决:注入的记忆在 compress 中可被折叠、可重新 surfacing;
11. 回归:现有 152 tests 全绿(新功能不动现有行为)。
