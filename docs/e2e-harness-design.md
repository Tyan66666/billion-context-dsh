# 端到端宿主回归测试（scripts/e2e/）

来源: issue #120（dsh 缺端到端/模拟宿主回归测试，pi 有完整 harness）。拍板: 方案 B（进程内宿主组装），2026-09-07。

## 问题

纯单元测试（`tests/*.test.ts`）把宿主模拟在接缝层: `tests/helpers.ts` 手工构造游离 `Session.create` 并手动 append 事件。它无法覆盖跨轮、依赖真实宿主事件流的正确性——agent 循环里 `agent/pre-step` 的 nudge 注入节奏、compress/decompress 与宿主 `tool_calls`/tool 响应的严格配对（严格 provider 会拒绝不合法配对）、durable 压缩事务落事件顺序等。这些正是 v0.1.1 长会话里真实发生过的缺陷类别（issue #43/#54/#60/#108 等）。

## 方案（拍板: B）

**B — 进程内真实宿主组装**（已落地）: `scripts/e2e/harness.mjs` 按宿主自身 e2e 的组装配方（deepseek-harness 仓库 `apps/cli/tests/profiles/headless/tests/harness.ts`）在进程内组装完整 `Context`: cordis `Context` → `SessionProjectionRegistry` → `mountAgentLoopTestDependencies`（persona 系统提示词）→ `AgentLoop` → DeepSeek 适配器（旧线以 cordis 插件 `LlmDeepSeek` 挂载、OpenAI SSE 方言；≥0.2.0 线该模块不再是插件，harness 直接构造 `DeepSeekAdapter` + `ctx.llm.registerAdapter(['deepseek-official'], adapter)`、Anthropic Messages SSE 方言；按 `typeof LlmDeepSeek.apply === 'function'` 特性探测分路，指向假 LLM）→ `TokenMeter` → 本引擎（`AcpCompactionEngine`，替代宿自带的 `compaction-basic` 后端——同一注册路径，验证打包产物 `dist/index.js` 而非 `src/`）→ `JsonlSessionPersistence`（issue #183 第二段：每次运行一个全新临时根目录，会话真正落盘；宿主 agent-loop 自行接管写入，runner 在场景收尾时 flush）。对话驱动 `agentLoop.create` + `followup(createUserMessage)` + 等待 `agent/status` 为 idle；`scripts/e2e/run-e2e.mjs` 对 `agent.session.events` 持久化事件日志与假 LLM 捕获的请求体做断言。

**A — pi 风格 CLI 子进程 + Dockerfile.e2e + 解析 session.jsonl.zstd**（未取）: 进程级保度更高，但需要维护独立假 LLM 进程、zst 日志解析、每 scenario 独立 HOME，且 CLI/profile 组合层是宿主领地（宿主自带 e2e 覆盖它）。本仓的契约面是 CompactionEngine 接缝——B 直接打接缝。A 的保留价值见「二期」。

取舍理由: 宿主官方 e2e 同形态（compaction.e2e.ts 断 compaction 事件配对/replace 节点/最终回答，与此处断集一致）；进程内运行快速、确定、事件对象直接可读；CI 复用现有 npm ci→build→test 流水，无需 Docker 层。

## 关键设计约束（踩过的陷阱，必须保留）

1. **假 LLM 必须报 honest usage** — 引擎 nudge 的用量读优先 `sessionProjections.contextPressure.projectedTokens`（rule 2），该投影以**提供商回报的 prompt size** 为锚（`dsh-token-meter` README: `projectedTokens = pressureTokens + 面移动`）。假服务报 `prompt_tokens: 3` 时引擎测得 ~12 token，nudge 节奏测试永远盲（首轮症状: nudge-rhythm 全绿但无注入）。`fake-llm.mjs` 报 `prompt_tokens = ceil(JSON.stringify(messages).length/4) + ceil(JSON.stringify(tools ?? []).length/4)`（宿主 flat-4 词汇，rule 12 同源），完成 token 按文本长度/4。**注意这是长度近似，不是宿主估计器的复刻**：对节奏测试足够（要求只是「用量随历史增长」），但 nudge 触发百分比与真实会话不同——断言只钉「何时注入/不注入」，不钉具体百分比。
2. **假服务响应模板用占位符，渲染时注入真实 seq** — scenario 里 compress 参数写 `{{U1}}`/`{{A1}}`（首 user/首 assistant 消息的 seq），`fake-llm.mjs` 在响应时刻从 harness 传入的 live `seqs` 对象渲染。scenario JSON 不钉宿主 seq 布局常量。
3. **假服务脚本 FIFO 逐请求** — `responses` 与请求 1:1（一个 turn 可能多请求: nudge 注入后仍同请求；tool 调用后宿主再请求即消费下一个条目）。
4. **依赖钉** — harness 拉宿主 agent-loop 栈; `@deepseek-ai/*` prerelease peer 不在 lockfile 时 npm 解析到最新 prerelease（rc.8）级联 ERESOLVE（issue #68 同类）。闭包全部显式 devDep 钉当前基线（随基线迁移重推：0.1.0-rc.6 → 0.1.5 线 → 现 0.2.0-rc.2，20 个新增，`dsh-token-meter` exact）。验证程序: 注册表 BFS（deps+peers 闭包，钉线版本存在性）→ package.json 写入 → `npm install` → lockfile 纯度检查（全部 `@deepseek-ai/*` 在当前基线（现 0.2.0 线），cordis/schemastery/cosmokit 稳定线例外——cordis 传递依赖）。
5. **e2e 跑打包产物** — `harness.mjs` import `../../dist/index.js`（用户安装同文件）; `test:e2e` 必须在 `npm run build` 后（`.github/workflows/e2e.yml` 顺序保证）。
6. **事件字段路径** — 载荷在 `event.data.*`（`type`/`seq`/`surfaceOp` 顶层）: `compaction/summary` → `data.shadowedSeqs/shadowedTokenCount`; `user/message` 的 replace 节点 → `event.surfaceOp.op === 'replace'`（append 是字符串 `'append'`，replace 是对象）; `tool/result` → `data.message.content[].{type:'tool-result'}`（rule 5 真实形状）。
7. **配对断言打在线协议层** — 日志里 `tool/call` 与 `tool/result` 中间插 compaction 事件（start/summary/replace/end/prune），相邻性断言假失败; 正确断集: 最终线请求 `messages` 里每个 `role:'tool'` 前紧跟 `role:'assistant'`（provider 视角的 400 风险）。
8. **挂死兜底（修「跑不完」，不只「跑完不退出」）** — 三层防护: ① `harness.mjs` `waitForIdle` 用 `Promise.race` 给每轮 60s 超时（timer `unref()`，不拖事件循环），agent 永不 idle 时带清晰报错失败而非挂死; ② `e2e.yml` job 级 `timeout-minutes: 10`（套件本身 ~3s，10 分钟宽裕，兜住任何「跑不完」回归，否则烧 Actions 默认 6 小时）; ③ runner 成功/失败路径都显式 `process.exit`，假服务 `close()`+`closeAllConnections()` 释放句柄。占位符笔误（`{{U9}}`）在 `render` 直接 throw，不当场炸就绕进引擎错误链。
9. **fixture 必须越过内核的 nudge 收益下限（acp-kernel 0.0.63 起）** — 内核 `decideNudge` 在压力下要求「最大待压缩范围 ≥ `minPressureBenefitTokens`」（默认 `max(5000, round(window * 0.01))`，`node_modules/acp-kernel/dist/index.js:2687`），且 `pendingByTier` 丢掉小于 `config.compress.minCompressRange`（默认 5000 chars，`dist/index.js:324`）的范围；fixture 太小时内核**静默抑制**（`shouldInject=false`，理由串 "usage X% but max pending N < min benefit M tokens — suppressed: rewriting below the benefit floor reclaims almost nothing while usage stays high"），于是所有「nudge 注入过」类断言整片变红而引擎不报任何错。本仓实测：window 2000 时下限 5016 tokens，原 fixture（`count: 110`，最大范围 2554 tokens）被抑制；warm filler 放大到 `count: 250`（~15.5K chars/轮）后 EMERGENCY 注入恢复、e2e 全绿。0.0.63 另新增 `firstSightMassReady` 首见门（`lastNudgeShownTokens === 0 && baseline === 0 && usage >= minContextLimitPct && max(t1Eff, t2Pen, t3Pen) >= nudgeGrowthTokens`）——两者都是内核决策，引擎不绕开（rule 7）：调 fixture，不改引擎。

## Scenario 与断集（6 套）

| scenario | 配置 | 断集 |
|---|---|---|
| basic-compress | window 2000（系统提示词单占 > 窗口 → EMERGENCY）; 3 轮 warm filler（每轮 `count: 250`，~15.5K chars/轮 —— **必须越过内核 nudge 收益下限，见约束 9**）+ compress `{{U1}}..{{A1}}` + 续回答 | compaction start/end 配对; summary 遮蔽 U1; `shadowedTokenCount ≥ 0`（rule 12 折叠非负）; durable replace 节点落; 线协议严格配对; nudge ≥1; end 后继续; **投影: compress 后线请求含 summary、原文已消失**（durable surface 端到端本质）; **nudge 范围表: 表头 oldest first、行带 `[tool X% | text Y%]` 份额、seq 升序**（rule 3） |
| nudge-rhythm | window 24000; 5 轮小历史 + 2 轮大历史（~16K chars） | 小历史时无注入; 大历史后注入（观测: 仅最后请求——投影锚滞后一轮）; 不每轮注入（rule: advisory 节奏）; **nudge 范围表: 表头 oldest first、行带 `[tool X% | text Y%]` 份额、seq 升序**（rule 3） |
| compress-then-decompress | basic 基础上 + `decompress {"blockId":"b1"}` 轮 | basic 全断 + decompress 结果含原始文本（日志重建路径）; compress 结果报 tier; decompress 不新增 compaction 事件 |
| acp-status | window 2000; 3 轮 warm filler + compress 轮 + `acp_status {}` 轮 | 报告存在; 含 `CONTEXT BREAKDOWN` / `COMPRESSED BLOCKS`（kernel `buildStatusReport`，rule 9 非手搓）; 块 `b1` 行 + `Checkpoint seqs` 行（蒸馏入口，issue #60 P2）; `Surface:` seq 锚; `Nudge:` 决策行; **不含 `estimated context`/`context window`**（窗口语义属人侧 `/acp-prune`，rule 9） |
| overflow-recovery | window 2000; 3 轮 warm filler（`count: 250`）+ `Please reply briefly.`；第 4 个脚本回复是 `{"kind":"error"}`（HTTP 400 + DeepSeek 的 "maximum context length" 文案，`dsh-llm-deepseek` 归一化为 `CONTEXT_WINDOW_EXCEEDED`），第 5 个是成功 text | 脚本超窗以失败请求抵达 loop（`errorIdx ≥ 0`）; **loop 重试且重试请求成功**（`requests[errorIdx+1].kind === 'text'`）; 紧急压缩 start/end 配对; `compaction/summary` 文本含 `context-overflow emergency compaction`（引擎 marker，非模型摘要）; block topic 含 `context-overflow recovery`; durable replace 节点落地; 恢复后对话继续 |
| jsonl-compress | window 32000; 3 轮 warm filler（pruning×100 / ledger×40 / regions×40）+ compress 轮（`{{U1}}..{{A1}}`）+ 一轮普通续答 | live 断言: start/end 配对; summary 遮蔽 U1; durable replace 落; 线协议严格配对; end 后继续; **投影: framed summary 节点在场（frame 前缀只出现在真 summary 节点上，回显参数带不了它）+ 被遮蔽原文已消失**; JSONL 文件断言: stored start/end 配对; summary 遮蔽 U1..A1; rawOutput 带 `$dshAcpBlockLedger` marker; checkpoint 行 = producer-owned `compact-checkpoint`（+string compactionId）且其 `surfaceOp` **恰好三个键** `{op:'replace',startSeq,endSeq}`; end 后有 assistant 轮 |

注：compress 轮排在第 4 轮不是笔误——内核 recent-zone 保护「最后 5 条消息 + 最近一次真实 user 轮」，前 3 轮 filler 是让 U1/A1 逃出保护区的最小铺垫（与 basic-compress 同形），压缩场景里 model-initiated compress 能合法落盘的最早时机。

## Durable 行准入网（issue #183：两段均已落地）

上面的 e2e harness 跑在**内存态 store** 上——persistence writer（`dsh-session-persistence-jsonl`）从不在回路里，于是只在 durable 编码/admission 阶段才暴露的 bug 能全绿穿过整个套件（#163：退役 wrapper 形状被 0.1.7 V4 writer 整批拒收；#181：混合解析下 dsh-compaction 独立落到产出被拒 checkpoint wrapper 的版本）。准入网分两段：

**第一段（已落地，`tests/durable-admission.test.ts`）**：在当前 0.2.0-rc.2 基线上，用 detached `Session` 驱动引擎的**真实** durable writer（`runCompactionTransaction` / `hideCompressToolPair` + 镜像 src/nudge.ts 的 nudge echo），再把全部行过一遍**真实发布的 JSONL 插件完整 round-trip**生产压缩模式即 zstd 帧，由 node:zlib 的原生 zstd API 完成，无需额外 native addon）：create→append→flush→读回→逐行 deep-equal。三个牙齿来源：

**Node 底线**：上述 zstd API 自 Node 22.15 才存在，而发布的 codec 以静态 import 引用它——在更老的 Node 上模块加载即在 link 阶段失败（CI 曾因此在 Node 20 上整文件红掉）。因此本文件用动态 import 引入 codec：无 zstd 的 Node 上两条 round-trip 测试带原因跳过，不依赖 codec 的形状不变量测试照常运行；`ci.yml` 的测试运行时随之从 Node 20 升到 22（与早已跑 22 的 `e2e.yml` 对齐；包自身支持底线 `engines >= 20` 不变，变的只是测试运行时）。

- **admission 在主写路径，读路径同样 fail-closed**——0.2.0 的写路径在 `encodeEvent` 里就跑 `assertV4RowAdmission`（实测：把 `tool/result` 写成退役的 user-role + 嵌套 `tool-result` 形状，append 直接报 `format v4 tool/result at seq N requires a tool-role message`），所以这份 fixture 是写路径逼着改对的关系规则：`turn/start` + `step/start` 开步、`tool/call` 把已广告的调用标为 started、结果是带 `message.toolCallId` 的一等 tool-role 消息。读回再走 dsh-session stored-event validation + `validateStoredEvents`。负向对照钉住：assistant 缺 producer-owned source → `format v4 message requires a producer-owned source kind`；tool result 的 `toolCallId` 与 `source.callId` 不符 → `requires toolCallId matching its tool source`；seq 缺口 → `append seq mismatch`。
- **成员 allow-list 的严格性在冻结 v0 reader**（`tests/block-ledger.test.ts` 钉住：`compaction/summary` 多一个顶层成员即抛），V4 admission 管的是行形状与关系规则——两道门互不替代，所以负向对照分别打在各自的门上。
- **#163 形状不变量**：引擎自产元数据行（nudge echo / prune tombstone）永不回退到退役 `{ kind:'plugin', plugin }` wrapper 形状——那是 V4 writer（`@deepseek-ai/dsh-session-format-v3-to-v4`，拒 `kind === 'plugin'`）的拒收点之一（0.1.7 与 0.2.0 线同源校验器）；checkpoint 行豁免（其形状由宿主 `compactCheckpointSource()` 生成、版本自适应，各线各自正确）。

依赖侧：按 §4 流程（registry BFS + lockfile purity 校验）新增 11 个显式 devDep（persistence 栈 + format closure + utility siblings），原始 PR 钉在 0.1.5 线，并入基线迁移时按 §4 重推到当前 0.2.0-rc.2 基线；clean reinstall 后零 ERESOLVE 警告，且此前已解析的全部 `@deepseek-ai/*` 包版本逐一不变（baseline stability 验证过）。

**第二段（已落地）**：harness 现在给**每个**场景挂 `JsonlSessionPersistence`（`@deepseek-ai/dsh-session-persistence-jsonl`，同线显式 devDep；每次运行一个全新临时根——复用旧根会让 loop RESUME 旧会话），宿主 agent-loop 自行接管写入（`session/event` live 路由、dispose 时 final drain），runner 在场景收尾 `ctx.sessionPersistence.flush()` 后，用**全新只读句柄**解码每个场景的落盘文件（≈ 重启后重载会话），对全部场景断言：恰好一个日志文件；released codec 解码通过 fail-closed 校验；stored 行与 live 事件日志逐行一致（lossless round-trip）；`foldSurface` replay 出的 surface 与 live surface `[seq,type]` 序列一致（**#181 重启签名**——行形状被 reader 拒收时此断言变红）；零退役 `{kind:'plugin',plugin}` wrapper 行（#163 形状回归 → writer 在 flush 时以 `format v4 message requires a producer-owned source kind` 拒收）。新场景 `jsonl-compress` 另对落盘文件断言完整事务（start/end 配对、summary 遮蔽 U1..A1、rawOutput 带 `$dshAcpBlockLedger` marker）、checkpoint 行 = producer-owned `compact-checkpoint`（+string compactionId）、其 `surfaceOp` **恰好三个键** `{op:'replace',startSeq,endSeq}`（多一个键两个校验器都拒）、end 后有 assistant 轮。变异验证见验证日志（tombstone 回退 wrapper → 全部 4 个含 compress 场景 flush failed；`encodeAcpBlockLedger` 置空 → marker 断言红）。若还要在 0.1.x 基线上再跑一遍，须按 §4 重推该线的完整 transitive peer closure 钉——把 0.1.x 包混进当前 0.2.0 基线会违反 §4「Do not mix lines」。

## 二期（未实现，记录取舍）

- **宿主官方 `@deepseek-ai/dsh-llm-mock-server` 替换 fake-llm.mjs**: 未取——官方服务全局 `toolName/toolArguments`（每实例单工具形状）无法按轮出 compress→decompress 双形状; 行为词汇含故障注入（断流/429/畸形 JSON）价值二期加（需上游 per-turn 参数化或本地 fork）。
- **Dockerfile.e2e + matrix（ubuntu+windows）**: 环境钉价值，二期。
- **CLI/profile 组合层 + `session.jsonl.zstd` 回放**: 宿主领地，上游 e2e 覆盖; 跨版本回放二期。
- **错误注入行为**（断流重试/429 退避）: 二期。

## 验证（2026-09-07, Node v22.23.2）

`node scripts/e2e/run-e2e.mjs` → 41/41 PASS `e2e PASS`（~2.5s，进程干净退出——runner 显式 `process.exit`，假服务 `close()`+`closeAllConnections()`）。关键观测: basic 5 请求（nudge 在请求 4,5 EMERGENCY; 遮蔽 4518 host-token; prune 隐藏 compress 对; compress 后线请求含 summary、原文消失）; rhythm 7 请求（nudge 仅请求 7）; decompress 7 请求（b1 结果含 'Note 0: the pruning section'，无新 compaction 事件）; acp-status 7 请求（报告含 kernel 段头、`b1`+`Checkpoint seqs`、`Surface:` 锚，不含窗口语义行）。`npm run test:e2e` 同绿。
- **2026-09-11（wire 级前缀检查，#111/#126）**: `npm run test:e2e` → **54/54 PASS**。新增检查断言的是**假 LLM 收到的请求体原文**——provider 唯一能用来做缓存键的东西——而不是内部投影：原始 envelope（`"messages"` 之前的字节，含 key 顺序与空白）逐字稳定、`tools` 数组逐字稳定、leading message 在请求 2 之后逐字稳定（请求 1 可能早于一次性 ACP 指引注入）、无 compaction 的场景全程 append-only（前一次请求的消息列表必须是后一次请求的逐字前缀）。变异验证：改第 2 个请求 body 的尾部 + `messages[1]` → append-only 检查 FAIL（`request #2 message 1`）；改原始 body 开头 + leading 消息 → envelope 与 leading 检查在 4 个场景全部 FAIL。
- **2026-09-12（acp-kernel 0.0.63 升级，issue #122）**: `npm run test:e2e` → **4 场景全绿（`e2e PASS`）**。basic-compress / compress-then-decompress 的 warm filler 由 `count: 110` 放大到 `250`（`scripts/e2e/scenarios/*.json`）以越过内核 nudge 收益下限（约束 9）；nudge-rhythm / acp-status 不受影响。
- **2026-09-24（第 5 个场景：上下文超窗自动恢复，PR #153 采用）**: `npm run test:e2e` → **5 场景 65/65 PASS（`e2e PASS`）**。新增 `overflow-recovery`：window 2000 + 3 轮 warm filler（`count: 250`），第 4 个脚本回复返回 HTTP 400 的 "maximum context length"（`dsh-llm-deepseek` 归一化为 `CONTEXT_WINDOW_EXCEEDED`）→ 引擎紧急压缩一次（marker 摘要 + durable replace，`starts=1 ends=1`）→ **宿主重试该请求并成功**（`requests: text,text,text,error,text`；重试请求的线级 body 里原文已消失、marker 已出现）；断集见上表。原 4 场景断集不变。
- **2026-09-28（durable 行准入网，issue #183 第一段）**: `npm test` → **384/384 PASS**（新增 3 条 admission 测试：round-trip 字节一致 / 三条负向对照 / #163 形状不变量），typecheck 绿。纯测试基建，无引擎行为变更。**测试运行时变更**：`ci.yml` Node 20 → 22（发布的 JSONL codec 静态 import node:zlib zstd API，Node < 22.15 加载即失败；与 `e2e.yml` 对齐；`engines >= 20` 支持底线不变）。
- **2026-10-01（DSH 0.2.0 线适配 + 双基线验证，issue #190）**: `npm run test:e2e` → **5 场景全绿（`e2e PASS`）**，且同一 harness 在 0.1.5-rc.2 基线上亦全绿（双基线验证）。harness 适配：dsh-llm-deepseek 0.2.0 不再导出 cordis 插件面（无 `apply`），改为直接构造 `DeepSeekAdapter`（`resolveAdapterOptions` 解析连接、静态 auth header、no-op extensions）并 `ctx.llm.registerAdapter(['deepseek-official'], adapter)`；旧线保持原插件挂载路径。fake-llm.mjs 按基线输出两种 SSE 方言：OpenAI `chat/completions`（旧线原生）或 Anthropic Messages（新线适配器要求：message_start/content_block_*/message_delta/message_stop 严格顺序帧，无 `[DONE]`；错误体沿用 "maximum context length" 文案，两线的 `isContextWindowExceededError` 均命中 → `CONTEXT_WINDOW_EXCEEDED`）。run-e2e.mjs 的 leading-message 检查更名为「首次 surface 改写前逐字节稳定」（Anthropic 方言下 `messages[0]` 是首条 user 消息，压缩后会合法变化；OpenAI 方言下 `messages[0]` 恒为 system）。nudge-rhythm 场景窗口 24000→20000：纯校准（0.2.0 投影计价下 pre-step 峰值 63%<70% 永不触发；20000 使请求 7 落在 OVER-LIMIT 带），引擎阈值未动，双基线均绿。
- **2026-10-08（并入 0.2.0 基线，issue #183 第一段）**: 基线迁移后本文件的两条 round-trip 测试需重建 fixture——0.2.0 的写路径 admission 逼着补上 `step/start`、`tool/call`，并把结果改为一等 tool-role 消息（详上「三个牙齿来源」）。`npm test` → **400 条 / 389 过 / 0 败 / 11 跳过**，typecheck 绿、build 绿；三条负向对照的期望文案随之改为 v4 admission 的实测报错（见上）。纯测试基建，无引擎行为变更。
- **2026-10-08（durable 行准入网，issue #183 第二段）**: `npm run test:e2e` → **6 场景 110/110 PASS（`e2e PASS`）**；`npm test` → **415 条 / 404 过 / 0 败 / 11 跳过**，typecheck 绿、build 绿（dist 与提交产物字节一致）。harness 挂 `JsonlSessionPersistence`（每次运行全新临时根——复用旧根会让 loop RESUME 老会话），宿主 agent-loop 自行接管写入，runner 收尾 flush 后用全新只读句柄解码每个场景的落盘文件：lossless round-trip、replay surface 一致（#181 重启签名）、零退役 wrapper 行；新场景 `jsonl-compress`（断集见上表）。变异验证：tombstone source 回退退役 wrapper 形状 → 全部 4 个含 compress 场景 `session-persistence-jsonl flush failed`（同线 writer 拒收文案 `format v4 message requires a producer-owned source kind`，即 #163 签名）；`encodeAcpBlockLedger` 置空 → jsonl-compress 的 rawOutput marker 断言红（overflow-recovery 的 topic 标签断言连带红——恢复 topic 骑在 ledger payload 上）。纯测试基建，无引擎行为变更。
