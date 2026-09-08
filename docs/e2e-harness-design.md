# 端到端宿主回归测试（scripts/e2e/）

来源: issue #120（dsh 缺端到端/模拟宿主回归测试，pi 有完整 harness）。拍板: 方案 B（进程内宿主组装），2026-09-07。

## 问题

纯单元测试（`tests/*.test.ts`）把宿主模拟在接缝层: `tests/helpers.ts` 手工构造游离 `Session.create` 并手动 append 事件。它无法覆盖跨轮、依赖真实宿主事件流的正确性——agent 循环里 `agent/pre-step` 的 nudge 注入节奏、compress/decompress 与宿主 `tool_calls`/tool 响应的严格配对（严格 provider 会拒绝不合法配对）、durable 压缩事务落事件顺序等。这些正是 v0.1.1 长会话里真实发生过的缺陷类别（issue #43/#54/#60/#108 等）。

## 方案（拍板: B）

**B — 进程内真实宿主组装**（已落地）: `scripts/e2e/harness.mjs` 按宿主自身 e2e 的组装配方（deepseek-harness 仓库 `apps/cli/tests/profiles/headless/tests/harness.ts`）在进程内组装完整 `Context`: cordis `Context` → `SessionProjectionRegistry` → `mountAgentLoopTestDependencies`（persona 系统提示词）→ `AgentLoop` → `LlmDeepSeek`（DeepSeek 适配器，指向假 LLM）→ `TokenMeter` → 本引擎（`AcpCompactionEngine`，替代宿自带的 `compaction-basic` 后端——同一注册路径，验证打包产物 `dist/index.js` 而非 `src/`）。对话驱动 `agentLoop.create` + `followup(createUserMessage)` + 等待 `agent/status` 为 idle；`scripts/e2e/run-e2e.mjs` 对 `agent.session.events` 持久化事件日志与假 LLM 捕获的请求体做断言。

**A — pi 风格 CLI 子进程 + Dockerfile.e2e + 解析 session.jsonl.zstd**（未取）: 进程级保度更高，但需要维护独立假 LLM 进程、zst 日志解析、每 scenario 独立 HOME，且 CLI/profile 组合层是宿主领地（宿主自带 e2e 覆盖它）。本仓的契约面是 CompactionEngine 接缝——B 直接打接缝。A 的保留价值见「二期」。

取舍理由: 宿主官方 e2e 同形态（compaction.e2e.ts 断 compaction 事件配对/replace 节点/最终回答，与此处断集一致）；进程内运行快速、确定、事件对象直接可读；CI 复用现有 npm ci→build→test 流水，无需 Docker 层。

## 关键设计约束（踩过的陷阱，必须保留）

1. **假 LLM 必须报 honest usage** — 引擎 nudge 的用量读优先 `sessionProjections.contextPressure.projectedTokens`（rule 2），该投影以**提供商回报的 prompt size** 为锚（`dsh-token-meter` README: `projectedTokens = pressureTokens + 面移动`）。假服务报 `prompt_tokens: 3` 时引擎测得 ~12 token，nudge 节奏测试永远盲（首轮症状: nudge-rhythm 全绿但无注入）。`fake-llm.mjs` 报 `prompt_tokens = ceil(JSON.stringify(messages).length/4) + ceil(JSON.stringify(tools ?? []).length/4)`（宿主 flat-4 词汇，rule 12 同源），完成 token 按文本长度/4。**注意这是长度近似，不是宿主估计器的复刻**：对节奏测试足够（要求只是「用量随历史增长」），但 nudge 触发百分比与真实会话不同——断言只钉「何时注入/不注入」，不钉具体百分比。
2. **假服务响应模板用占位符，渲染时注入真实 seq** — scenario 里 compress 参数写 `{{U1}}`/`{{A1}}`（首 user/首 assistant 消息的 seq），`fake-llm.mjs` 在响应时刻从 harness 传入的 live `seqs` 对象渲染。scenario JSON 不钉宿主 seq 布局常量。
3. **假服务脚本 FIFO 逐请求** — `responses` 与请求 1:1（一个 turn 可能多请求: nudge 注入后仍同请求；tool 调用后宿主再请求即消费下一个条目）。
4. **依赖钉** — harness 拉宿主 agent-loop 栈; `@deepseek-ai/*` prerelease peer 不在 lockfile 时 npm 解析到最新 prerelease（rc.8）级联 ERESOLVE（issue #68 同类）。闭包全部显式 devDep 钉 `0.1.0-rc.6`（18 新增 + `dsh-token-meter` caret→exact）。验证程序: 注册表 BFS（deps+peers 闭包，钉线版本存在性）→ package.json 写入 → `npm install` → lockfile 纯度检查（全部 `@deepseek-ai/*` 在 rc.6 线，cordis/schemastery/cosmokit 稳定线例外——cordis 传递依赖）。
5. **e2e 跑打包产物** — `harness.mjs` import `../../dist/index.js`（用户安装同文件）; `test:e2e` 必须在 `npm run build` 后（`.github/workflows/e2e.yml` 顺序保证）。
6. **事件字段路径** — 载荷在 `event.data.*`（`type`/`seq`/`surfaceOp` 顶层）: `compaction/summary` → `data.shadowedSeqs/shadowedTokenCount`; `user/message` 的 replace 节点 → `event.surfaceOp.op === 'replace'`（append 是字符串 `'append'`，replace 是对象）; `tool/result` → `data.message.content[].{type:'tool-result'}`（rule 5 真实形状）。
7. **配对断言打在线协议层** — 日志里 `tool/call` 与 `tool/result` 中间插 compaction 事件（start/summary/replace/end/prune），相邻性断言假失败; 正确断集: 最终线请求 `messages` 里每个 `role:'tool'` 前紧跟 `role:'assistant'`（provider 视角的 400 风险）。
8. **挂死兜底（修「跑不完」，不只「跑完不退出」）** — 三层防护: ① `harness.mjs` `waitForIdle` 用 `Promise.race` 给每轮 60s 超时（timer `unref()`，不拖事件循环），agent 永不 idle 时带清晰报错失败而非挂死; ② `e2e.yml` job 级 `timeout-minutes: 10`（套件本身 ~3s，10 分钟宽裕，兜住任何「跑不完」回归，否则烧 Actions 默认 6 小时）; ③ runner 成功/失败路径都显式 `process.exit`，假服务 `close()`+`closeAllConnections()` 释放句柄。占位符笔误（`{{U9}}`）在 `render` 直接 throw，不当场炸就绕进引擎错误链。

## Scenario 与断集（4 套，41 项）

| scenario | 配置 | 断集 |
|---|---|---|
| basic-compress | window 2000（系统提示词单占 > 窗口 → EMERGENCY）; 3 轮 warm filler（~6.8K chars each）+ compress `{{U1}}..{{A1}}` + 续回答 | compaction start/end 配对; summary 遮蔽 U1; `shadowedTokenCount ≥ 0`（rule 12 折叠非负）; durable replace 节点落; 线协议严格配对; nudge ≥1; end 后继续; **投影: compress 后线请求含 summary、原文已消失**（durable surface 端到端本质）; **nudge 范围表: 表头 oldest first、行带 `[tool X% | text Y%]` 份额、seq 升序**（rule 3） |
| nudge-rhythm | window 24000; 5 轮小历史 + 2 轮大历史（~16K chars） | 小历史时无注入; 大历史后注入（观测: 仅最后请求——投影锚滞后一轮）; 不每轮注入（rule: advisory 节奏）; **nudge 范围表: 表头 oldest first、行带 `[tool X% | text Y%]` 份额、seq 升序**（rule 3） |
| compress-then-decompress | basic 基础上 + `decompress {"blockId":"b1"}` 轮 | basic 全断 + decompress 结果含原始文本（日志重建路径）; compress 结果报 tier; decompress 不新增 compaction 事件 |
| acp-status | window 2000; 3 轮 warm filler + compress 轮 + `acp_status {}` 轮 | 报告存在; 含 `CONTEXT BREAKDOWN` / `COMPRESSED BLOCKS`（kernel `buildStatusReport`，rule 9 非手搓）; 块 `b1` 行 + `Checkpoint seqs` 行（蒸馏入口，issue #60 P2）; `Surface:` seq 锚; `Nudge:` 决策行; **不含 `estimated context`/`context window`**（窗口语义属人侧 `/acp`，rule 9） |

## 二期（未实现，记录取舍）

- **宿主官方 `@deepseek-ai/dsh-llm-mock-server` 替换 fake-llm.mjs**: 未取——官方服务全局 `toolName/toolArguments`（每实例单工具形状）无法按轮出 compress→decompress 双形状; 行为词汇含故障注入（断流/429/畸形 JSON）价值二期加（需上游 per-turn 参数化或本地 fork）。
- **Dockerfile.e2e + matrix（ubuntu+windows）**: 环境钉价值，二期。
- **CLI/profile 组合层 + `session.jsonl.zstd` 回放**: 宿主领地，上游 e2e 覆盖; 跨版本回放二期。
- **错误注入行为**（断流重试/429 退避）: 二期。

## 验证（2026-09-07, Node v22.23.2）

`node scripts/e2e/run-e2e.mjs` → 41/41 PASS `e2e PASS`（~2.5s，进程干净退出——runner 显式 `process.exit`，假服务 `close()`+`closeAllConnections()`）。关键观测: basic 5 请求（nudge 在请求 4,5 EMERGENCY; 遮蔽 4518 host-token; prune 隐藏 compress 对; compress 后线请求含 summary、原文消失）; rhythm 7 请求（nudge 仅请求 7）; decompress 7 请求（b1 结果含 'Note 0: the pruning section'，无新 compaction 事件）; acp-status 7 请求（报告含 kernel 段头、`b1`+`Checkpoint seqs`、`Surface:` 锚，不含窗口语义行）。`npm run test:e2e` 同绿。
