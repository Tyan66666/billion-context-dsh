# 移植可行性分析：billion-context-pi → DeepSeek Harness

> **⚠️ 本文是初步可行性分析（未经验证）。所有论断的验证证据与最终可行路径见 [dsh-porting-verification.md](dsh-porting-verification.md)，以那份为准。**
>
> 结论先行：**可行，但核心机制需要适配。** 项目 90% 的能力（工具、命令、系统提示词、状态持久化、模型驱动的压缩语义）都能在 DSH 的组合式插件模型里找到直接对应物；唯一没有 1:1 对应的是 Pi 的 `context` 事件（每次 LLM 调用前在内存中改写消息数组）。这需要一条设计决策：改造成 DSH 的 durable-surface 模型，或在 DSH 核心加一个最小的请求构建钩子。

---

## 0. 术语警告

DSH 仓库里的 `packages/acp` 是 **Agent Client Protocol**（进程间自动化传输协议），与 billion-context-pi 的 ACP（**Active Context Pruning**，上下文压缩）同名不同义。移植时不要混淆：本项目对应 DSH 的 `compaction` 能力族（`packages/compaction/*`）与 `packages/core/agent-loop`。

## 1. 双方架构速览

### 1.1 billion-context-pi（Pi 侧）

- 入口 `src/index.ts` 挂钩 4 类 Pi 扩展点：
  - `pi.on('context')` — **核心**：每次 LLM 调用前，把即将发送的消息数组交给 acp-kernel 的 `processTurn`（8 阶段管线：assign refs → sync blocks → prune → filter → hide calls → recommend → nudge → emergency truncate），返回改写后的消息（剪掉被压缩范围、给消息打 `<acp tokens="..">mNNNNN</acp>` 引用标签、按需附加 nudge 提示），**会话日志本身不动**。
  - `pi.on('session_before_compact')` — 取消 Pi 内置自动压缩。
  - `pi.on('session_start'/'session_shutdown')` — 生命周期。
  - `pi.on('before_agent_start')` — 注入 ACP 系统提示词。
- 注册 4+ 工具：`compress`（模型写摘要替换范围）、`decompress`（把块恢复回上下文）、`search_context`（在压缩块内搜索）、`acp_status`（压缩统计）；外加 delegate 三件套（`acp_delegate`/`acp_delegate_wait`/`acp_delegate_cancel`）。
- 注册 `/acp` slash 命令；自动更新检查；状态持久化到 `~/.pi/agent/sessions/*.acp.json` 旁车文件。
- **acp-kernel 是纯内核**（"Framework-agnostic context-compression engine. Pure core: no host dependency"），tsup 构建时内联进 dist。这意味着压缩算法本身**可原样复用**，只需重写 Pi↔kernel 的适配层。

### 1.2 DeepSeek Harness（DSH 侧）

- 组合式 Cordis 架构，两层：
  - **Host 组合**（`~/.dsh/profiles/web/cordis.yml` ← `dsh-base` + `dsh-web-app` 两个 bundle）：注册表、沙箱/审批栈、持久化、模型路由、`ctx.tokenMeter`、`ctx.compaction`（seam）。
  - **Agent preset**（`apps/cli/config/agent-presets/standard/`，本会话即 `standard`）：一个会话贡献的工具、提示词段落、委派后端。**关键范式：凡是 Service 定义在 host 平面；一个会话的贡献放进 preset 的 `isolate` realm。**
- 会话模型：**append-only 事件日志**（`session.jsonl.zstd`，zstd 压缩 JSONL）是唯一事实源；模型请求消息是日志的 **surface 投影**（`session.deriveMessages()` 折叠出模型可见序列）。插件影响上下文的方式是 **durable 的 surface 变更**（`surfaceOp: {op:'replace'}` 遮蔽一段范围，原始事件仍留在日志中可回放），而不是内存改写。

## 2. DSH 当前怎么做上下文管理（本会话实况）

本会话 = web profile + `standard` preset。完整管线：

```
持久化（JSONL.zstd，请求前 checkpoint）
  → 上下文组装（systemPrompt.assemble：persona + 各插件 prompt sections
     + runtimeContext.project 注入 cwd/model/沙箱策略；agent-instructions ≤64KB）
  → token 测量（ctx.tokenMeter：4字符/token 启发式 + provider 真实 usage 锚定）
  → [agent/pre-step waterfall] 压力压缩
  → session.deriveMessages() 折叠 surface 为消息
  → [agent/request waterfall] 请求配置
  → ctx.llm.stream() 发送
  → [agent/request-error waterfall] context-overflow 恢复压缩
```

具体组件（`standard/agent.cordis.yml` + `dsh-base` host 行）：

| 组件 | 职责 | 配置 |
|---|---|---|
| `dsh-token-meter` | 每会话独立折叠测量；`contextPressure`/`projectedTokens`/`contextBreakdown` 投影 | 无配置，固定启发式 |
| `dsh-compaction-basic`（preset 的 isolate realm `compaction`） | `CompactionEngine` 后端：监听 `agent/pre-step`（pressure）与 `agent/request-error`（overflow）；measure → 超阈 → 修剪 → 选范围 → 一次性 LLM 摘要 → durable replace | 默认 thresholdRatio 0.8、retainRatio 0.16、maxTokens 8192、auto true |
| `dsh-compaction-tool-result-pruner` | 模型无关的工具结果修剪（头尾保留、中间截断） | thresholdChars 8192 / head 4096 / tail 1024 |
| `dsh-command-compact` | `/compact` 手动压缩 → `compactNow()`（idle 维护期执行） | — |
| `dsh-spill-policy` + `dsh-spill-local` | 超大内容（>50KB）落盘、上下文只留引用 | maxInlineBytes 50000 |
| `dsh-session-persistence-jsonl` + `dsh-session-checkpoint-policy` | 日志持久化 + 每次模型请求前 durability checkpoint | root `$DSH_HOME/sessions` |
| `dsh-agent-instructions` | workspace 上下文注入（系统提示词段落） | maxBytes 65536 |
| `dsh-session-query-sqlite` | 会话历史精确读取（全文搜索 opt-in，默认 `openAt: never`） | `:memory:` |

与 billion-context-pi 的本质差异（重要）：

- **Pi/ACP**：压缩是"**隐藏但保留**"——被压缩的消息变成可解压、可搜索的块；引用标签让模型能精确指定范围；nudge 让**模型自己决定**何时压什么。
- **DSH/compaction**：压缩是"**摘要并遮蔽**"——旧范围被一个 `<compacted-summary>` 结构化摘要节点替代；自动触发（80% 阈值）；无解压/搜索 API；原始事件留在日志里仅供回放。

## 3. 逐项映射

| billion-context-pi（Pi API） | DSH 对应物 | 难度 |
|---|---|---|
| `pi.on('context')` 内存改写消息 | **无直接对应**。`agent/pre-step`（waterfall）只能 reject 或注入 inbox 消息（会被 append 成 `user/message` 事件），`agent/request`（waterfall）明确"cannot mutate messages"，`session.deriveMessages()` 是纯投影无钩子 | 🔴 核心难点，见 §4 |
| `pi.on('session_before_compact')` 取消内置压缩 | 更干净：preset 组合里不挂 `compaction-basic` 即可（"What a preset chooses is whether its agent compacts at all"） | 🟢 零成本 |
| `pi.on('before_agent_start')` 系统提示词 | `dsh-system-prompt` persona / prompt sections（`dsh-persona`、各插件 section） | 🟢 直接对应 |
| `pi.registerTool(compress)` | `ctx.tools.register(ToolDefinition)`（`dsh-tools` registry） | 🟢 直接对应 |
| `pi.registerTool(decompress)` | 需自实现"反遮蔽"：把 checkpoint 节点 replace 回原文（原文仍在日志中，可回放恢复） | 🟡 设计取舍 |
| `pi.registerTool(search_context)` | 落地为：从日志重建统一文档集（块摘要 + 被遮蔽原文），交 acp-kernel `searchBlocks`（hybrid：BM25 词干化 + CJK bigram + 字符 n-gram 模糊）打分；**信任内核**——引擎不做无命中闸门/阈值等二级搜索策略，评分直接呈现给模型自行判断；消息命中回链最内层所属块。`ctx.sessionQuery` 全文索引（`openAt: 'first-search'`）留作二期可选项 | 🟢 直接复用内核（无 opt-in 依赖） |
| `pi.registerTool(acp_status)` | `ctx.tokenMeter` 投影（`contextPressure`/`contextBreakdown`） | 🟢 直接对应 |
| `pi.registerCommand(/acp)` | `ctx.commands`（`dsh-command-compact` 是现成参考） | 🟢 直接对应 |
| 状态持久化 `*.acp.json` 旁车文件 | 会话日志本身 durable；ACP 块状态可写成自定义日志事件（如 `acp/block`，回放友好，且自动获得 checkpoint）或 storage key | 🟢 更优 |
| delegate 三件套 | `subagents` registry + spawn/fork 后端 + `jobs` registry（delegate+wait+cancel 已有先例） | 🟢 已有现成物 |
| 自动更新（npm 检查） | 不适用：组合式发布，插件版本由部署层固定；没有自更新惯例 | 🟢 直接放弃 |
| acp-kernel 压缩内核 | **原样复用**（纯内核、无 host 依赖，可整体内联或作为依赖引入） | 🟢 零改动 |

## 4. 核心难点：`context` 事件的替代方案

Pi 的 ACP 把消息数组在内存中转换（剪枝 + 打 ref 标签 + 附加 nudge），日志不动。DSH 的哲学相反：**日志是唯一事实源，所有上下文变更必须 durable**。三条路径：

### 路径 A（推荐）：ACP 作为新的 `CompactionEngine` 后端

挂进现有 capability seam（"A tokenizer- or template-based backend is a sibling package implementing the same interface"）：

- 新包（如 `@deepseek-ai/dsh-compaction-acp`）实现 `CompactionEngine` 的 `compactIfNeeded`/`compactNow`/`compactRegion`，内部复用 acp-kernel 做范围选择与块管理。
- `compress` 工具 = `compactRegion(start, end)` 且摘要由**模型自己写**（不再需要二次 LLM 摘要调用，这正是 ACP 的卖点——比 DSH 现有自动摘要更省 token、保真度更高）。
- nudge：在 `agent/pre-step` 里把 ACP nudge 作为注入消息 append（与现有 `agent-inject` 机制一致）。
- 引用标签重设计：由于没有 in-memory 改写钩子，可以"**seq 即 ref**"（surface 节点有稳定 seq），nudge 消息携带可压缩范围表，模型用 seq 范围调用 `compress`。
- `decompress`：把 checkpoint 节点 replace 回原文（日志里还有原始事件，可重建）。
- 块状态：写成会话日志的自定义事件（`acp/block`），天然获得持久化 + 回放 + checkpoint。

优点：不动 DSH 核心；语义与现有 seam 完全兼容；preset 换一行配置即切换压缩后端。缺点：丢掉了"给历史消息打 `<acp>` 标签"的视觉/引用机制，需要接受 seq-as-ref 或 nudge 范围表。

### 路径 B：最小核心扩展 + 插件

给 `dsh-agent-loop` 增加一个请求构建期 waterfall 钩子（如 `agent/request-messages`：接收 `deriveMessages()` 的结果，可返回替换数组），插件即可实现与 Pi `context` 事件几乎一致的"内存改写"。

优点：机制最贴近原项目。缺点：要改核心包（`dsh-agent` 事件词汇表 + `agent-loop` 调用点 + 相关 invariant/测试），属于"产品级"改动而非纯插件；DSH 的 replay 设计里"改消息但不动日志"会让 usage/checkpoint 对账出现口径问题，需要小心设计（这正是 DSH 刻意不做内存改写的原因之一）。

### 路径 C：混合（务实折中）

durable 部分（压缩、块状态、搜索、状态）走路径 A；只把"易失注入"（ref 标签、nudge 展示）放在 pre-step 注入消息里。即：**接受 DSH 的 durable 模型，把 ACP 的"隐藏但保留"语义落地为"遮蔽但保留在日志 + 可解压"**，放弃在内存中给全部历史消息打标签的做法。

## 5. 推荐落地形态

1. **包形态**：新建一个压缩能力族叶子包（对齐 `packages/compaction/` 下现有结构，或独立 npm 包），实现 `CompactionEngine` 接口 + 注册 `compress`/`decompress`/`search_context`/`acp_status` 四个模型工具 + `/acp` 命令。
2. **组合接入**：host 组合加一行提供 `ctx.compaction`；preset 里在 `compaction` isolate realm 用 ACP 后端替换 `compaction-basic`（或新增一个 preset 变体）。这与 DSH 的 capability-seam 哲学完全一致。
3. **复用内核**：`acp-kernel` 直接作为依赖（或内联），只重写适配层（Pi 的 `ExtensionAPI`/`SessionEntry`/`AgentMessage` ↔ DSH 的 `Session` 事件日志/surface/`Message`）。
4. **状态与搜索**：ACP 块状态写成日志事件；`search_context` 基于 `ctx.sessionQuery`（需要把 `openAt` 从 `never` 改为 `first-search`）。
5. **可选核心扩展**：若确实要保留逐消息 ref 标签体验，再评估路径 B 的最小钩子（单独一个 PR，不阻塞主移植）。

## 6. 工作量与风险

| 项 | 量级 | 风险 |
|---|---|---|
| 消息/事件适配层（SessionEntry ↔ 事件日志、AgentMessage ↔ Message、工具结果投影） | 中 | 工具调用的多块结构（`toolCall` blocks、`#` 拆分重建）是 ACP 最繁琐的代码，需要重写 |
| `CompactionEngine` 后端 + durable replace | 中 | 必须遵守 seam 的 region 平衡规则（tool-call/result 配对）与 `compaction/start\|summary\|end` 事件契约 |
| 4 个模型工具 | 低 | `tools.register()` 直挂 |
| decompress / 反遮蔽 | 中 | DSH 无先例，需自己实现 replace-back |
| nudge 注入 + seq-as-ref 设计 | 低-中 | pre-step 注入现成，设计取舍为主 |
| 测试 | 中 | 复用 acp-kernel 45 个测试 + DSH 的 session/agent 测试工具 |

主要风险不是"能不能移植"，而是**语义妥协**：DSH 的架构会"说服"你把 ACP 从"内存改写 + 旁车状态"改造成"durable 遮蔽 + 日志状态"。若坚持像素级保留原机制（内存打标签、完全隐藏不改日志），就需要路径 B 的核心改动，且要说服 DSH 维护者接受一个与"日志即事实源"原则相悖的钩子。
