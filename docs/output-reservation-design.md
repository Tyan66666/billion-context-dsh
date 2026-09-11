# 输出预留扣减（window − defaultMaxTokens）

## 问题

插件里的所有用量计算都是「估算 token 数 ÷ 模型原始上下文窗口」
（`usage = tokenCount / window.limit`）。但每个提供商都会在窗口的**尾部**
预留适配器每次请求的输出上限（解析后的模型信息里的 `defaultMaxTokens` ——
调用方未显式指定 maxTokens 时生效的输出上限）。超出 `window − cap` 的输入
会被拒绝或在中途截断，所以原始窗口并不是会话可持续使用的预算。

## 为什么小窗口模型失真最严重

误差是 `cap / window`。96K 窗口 + 16K 上限时约 16.7%：旧的 85% 线（81.6K）
加上 16K 输出会完全撑爆窗口（97.6K > 96K）；95% 线（91.2K）也超了 11K。
窗口越小的模型，同样的绝对上限占窗口的比例越大（32K 窗口上 16K 上限就是
50%），所以小上下文模型失真最严重——它们的 nudge / truncate 线落在提供商
永远不会接受的区间之外。

## 修复（单点缝合）

`src/window.ts` 的 `probeModelWindow()` 只做**一次** `resolveModelInfo` 调用，
返回 `{ contextWindow, outputReservation }`（`detectContextWindow` 现在是它的
薄封装）。`src/index.ts` 的 `AcpCompactionEngine.windowFor()` 在唯一一处
`applyReservation()` 里扣减：

- **auto 路径** — 窗口与上限来自同一次探测；探测失败时保留原始 128K 兜底，
  同时**丢弃上限**（探测没给出任何信息）。
- **projection 路径** — 窗口来自实时投影（投影 schema 不携带上限）；上限来自
  同一个按路由缓存的模型探测。路由取会话最后一次 `request/context` 事件
  （`routeFor()`）。宿主在同一 step 的 `buildRequest` 里才 append 这条事件，所以
  切换模型后的**首次** `agent/pre-step` 仍读到上一路由——与投影窗口同源、同步
  滞后一次请求后自愈（同 acp-status-align-design.md 记录的那次滞后）；只有会话
  还没记录过任何路由时才回退到 `agent.options`。
- **显式 `modelContextLimit`** — 从不探测、从不扣减：操作者的值就是分母，
  到此为止。
- **`autoModelContextLimit: false` / 上限 ≥ 窗口（退化）** — 保持原始行为。

结果携带 `rawLimit` 与 `outputReserved`，因此 `/acp status` 显示
`context window: 79616 (raw 96000 − 16384 output reservation; auto)`，
而不是把算术藏起来。

## 继承

所有下游消费者都已经把 `window.limit` 当 `modelContextLimit` 接收（nudge
分层经 `agent/pre-step`、`compress` / `acp_status` 的 kernel 配置、truncate、
growth）——在缝合处扣减一次，所有站点一次性修正，无需逐点改动。

## 验证

`tests/window.test.ts`：单次探测形状（96000 + 16384 一次调用取回）、
未披露/失败/缺失的探测 → null、auto 路径扣减（96000 − 16384 = 79616，
带 `rawLimit`/`outputReserved`）、projection 路径扣减 + 上限缓存
（每条路由一次探测）、无上限 no-op、上限 ≥ 窗口的退化情形、显式值从不
扣减（也从不探测）。所有既有窗口测试保持原期望（显式值不探测；探测失败的
`deepEqual` 不变；`autoModelContextLimit: false` 不动）。
切换路由后上限跟随实时路由（`routeFor()`；宿主在同一 step 的 `buildRequest` 才
append，故切换后首次 pre-step 滞后一次请求、随后自愈），以及 `liveRoute()` 的
「全有或全无」守卫（缺一半／空串／null／未记录／宿主抛错一律返回 null 并整条
回退）。压缩事务写进 `compaction/summary` 的
`provider`/`model` 同样以实时路由为准：`tests/tools.test.ts`（`compress`）与
`tests/commands.test.ts`（`/acp compress`）各自钉住这两列。
