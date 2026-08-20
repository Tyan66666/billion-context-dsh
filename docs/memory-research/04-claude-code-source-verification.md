# Claude Code 记忆机制源码核实(Claude Code Memory — Source-Verified)

> **核实时间**:2026-08 | **来源**:[liuup/claude-code-analysis](https://github.com/liuup/claude-code-analysis)(Claude Code 反编译镜像,`/tmp/claude-code-analysis` 已随重启消失,本文件为提炼结论)
> **用途**:billion-context-dsh 跨会话记忆设计的生产实践背书(见 `docs/cross-session-memory-design.md` §5.2)

## 1. 记忆写入(extractMemories)

- **触发**:每次完整 query loop 结束(模型产出最终回复、无更多工具调用时),经 `handleStopHooks`(`stopHooks.ts`)。
- **实现**:`runForkedAgent`——主对话的完美 fork,共享父 prompt cache(零重算),fire-and-forget 不阻塞。
- **互斥**:主 agent 本 turn 已写过记忆则跳过提取。
- **提取 fork 权限**:只允许只读工具(FileRead/Grep/Glob/只读 Bash)+ FileEdit/FileWrite **仅限** auto-memory 目录;`Bash rm` 被禁。
- **存储路径**:`~/.claude/projects/<sanitized-git-root>/memory/`。
- **4 类 taxonomy**:`user`(偏好)/`feedback`(纠正确认)/`project`(上下文决策)/`reference`(外部指针)。
- **negative constraints(防膨胀)**:显式禁止保存 code patterns、git history、debugging plans、已在 CLAUDE.md 的内容、临时任务状态。
- **金句提示**:即使确认要保存,也追问"其中什么令人惊讶或不显然?"——非显然部分才值得存。
- **团队记忆**:HTTP 同步 + secret 扫描(写前与 push 时)+ `pushSuppressedReason` gate 防认证失败无限重试。

## 2. 记忆读取(双层)

### 2.1 MEMORY.md 常驻 system prompt

- `findRelevantMemories.ts:31` 注释原文:"Excludes MEMORY.md (already loaded in system prompt)"——MEMORY.md 已在 system prompt 中,选择器排除它。
- 索引格式 = 一句话/条:`formatMemoryManifest` → `- [type] filename (timestamp): description`。
- **上限**:`MAX_MEMORY_FILES = 200`(memoryScan.ts:21,**记忆文件数上限**,非 MEMORY.md 行数——注意与子代理报告"前 200 行"表述的区别,后者可能指 docs 层的注入截断)。

### 2.2 relevant_memories 异步 prefetch(默认关闭)

- `startRelevantMemoryPrefetch`(attachments.ts:2361):
  - **总开关**:`getFeatureValue_CACHED_MAY_BE_STALE('tengu_moth_copse', false)`——**feature gate,默认 OFF**(实验功能,非默认行为;首次核实时误判"源码未见该 gate",子代理报告正确,特此修正记录)。
  - **语义 gate**:单字 prompt(无空格 `/\s/`)跳过——没有上下文可提取关键词。
  - **频率**:每 user turn 一次(query.ts:301 注释:"Fired once per user turn — the prompt is invariant across loop iterations, so per-iteration firing would ask sideQuery the same question N times");async 非阻塞,`using` 绑定生命周期随 turn 销毁。
  - **选择器**:Sonnet sideQuery(`SELECT_MEMORIES_SYSTEM_PROMPT` + JSON schema `output_format`,max_tokens 256)——从记忆文件清单选**最多 5 个**("Be selective and discerning",只选确信有用的;不确定就不选;最近使用的工具文档不选,但 warnings/gotchas 选)。
  - **节流**:会话累计 `MAX_SESSION_BYTES = 60KB`(attachments.ts:288)超限停止 surfacing。
  - **单文件截断**:`MAX_MEMORY_BYTES = 4096` + 行数限制,截断时提示 "Use the FILE_READ_TOOL_NAME tool to view the complete file"。
  - **去重**:`alreadySurfaced`(选过的路径不再选,5-slot 预算花新候选)+ `readFileState`(模型已读文件不再塞)。
  - **@-mention 隔离**:提及 agent 时只搜该 agent 的记忆目录,否则搜 auto-memory 目录。
  - **compact 重置**:compact 后 old attachments 从 transcript 消失 → re-surfacing valid again(注释原文)。

## 3. 7 层记忆架构

CLAUDE.md(人写) → Auto Memory(AI 写)→ Background Extract → Session Memory(单会话,`~/.claude/projects/<slug>/<sessionId>/session-memory/summary.md`)→ Agent Memory → Relevant Memories(prefetch)→ Auto Dream(空闲整合)。

## 4. 对本项目的启示

1. **"常驻索引 + 自主取回"是生产实践**(MEMORY.md 常驻 + FileRead 取全文)——我们选 Claude 路线(索引常驻 + 全文按需),比 Letta(内容常驻)token 更省。
2. **prefetch 默认关**——记忆读回未优化前不自动灌入,支持我们"常驻索引 + 自主取回"的简化设计(不学 prefetch 自动注入)。
3. **negative constraints 与正向触发并重**——memory_commit 提示词必须写"何时不要调用"(待定项 T1)。
4. **硬预算防膨胀**——文件数 200 / 会话 60KB / 单文件 4096B,支持我们配置项草案(sessionBudgetBytes)。
5. **fork 提取的权限最小化**——提取对话只允许只读 + 记忆目录写入,`Bash rm` 禁用;我们的一次性 LLM 调用同理应只写记忆库。
6. **extractMemories 每次 turn 结束时无条件提取** vs 我们的**决策门控**(只在 memory_commit 表态时)——我们的更省(Claude 是事件驱动,我们是模型自决)。
