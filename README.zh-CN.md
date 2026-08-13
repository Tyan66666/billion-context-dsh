# billion-context-dsh

[English](./README.md) | [中文](./README.zh-CN.md)

**One billion, not one million（十亿，而非百万）。** 面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 [Active Context Pruning（ACP，主动上下文裁剪）](https://github.com/ranxianglei/acp-kernel)——以 `CompactionEngine` 后端形式提供的模型驱动上下文管理。

由**模型自己决定何时压缩、压缩什么**——而不是一个硬性上限。长对话保持精简，关键细节（路径、决策、错误信息）以高保真摘要保留，且可搜索、可解压。

这是 [billion-context-pi](https://github.com/ranxianglei/billion-context-pi)（Pi 编码代理适配器）在 DSH 上的移植。压缩内核（`acp-kernel`）原样复用；适配层针对 DSH 的 durable-surface（持久化表面）模型重写——验证过的映射关系见 [docs/dsh-porting-verification.md](docs/dsh-porting-verification.md)。

## 上游项目与致谢

本项目是一个**移植/派生项目**，站在以下上游工作的肩膀上——全部为 MIT 许可。**衷心感谢** [ranxianglei](https://github.com/ranxianglei) 和 DeepSeek Harness 团队创建并开源这些项目：

| 上游项目 | 作者 | 角色 |
|---|---|---|
| **[billion-context-pi](https://github.com/ranxianglei/billion-context-pi)** | [ranxianglei](https://github.com/ranxianglei) | 本项目移植的 Pi 编码代理适配器；适配器设计、工具语义与本项目默认配置的来源 |
| **[acp-kernel](https://github.com/ranxianglei/acp-kernel)** | [ranxianglei](https://github.com/ranxianglei) | 框架无关的上下文压缩引擎——**原样复用**（refs、blocks、tiers、nudge 决策、search、status） |
| **[opencode-acp](https://github.com/ranxianglei/opencode-acp)** | [ranxianglei](https://github.com/ranxianglei) | ACP（"模型决定何时压缩、压缩什么"）设计的源头 |
| **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** | DeepSeek AI | 本项目所扩展的宿主平台（compaction 能力接缝、agent preset、持久化会话日志） |

本项目原样复用 `acp-kernel` 的压缩内核与 `billion-context-pi` 的默认行为；DSH 适配层（会话事件投影、持久化表面事务、模型工具、nudge、配置）为本仓库原创。上游版权与许可归其各自作者所有；本项目的许可条款见 [LICENSE](LICENSE)。

## 工作原理

DSH 的每个模型请求都派生自其 append-only 会话日志（*surface*）。ACP 语义直接映射到这一模型：

| ACP 概念 | DSH 实现 |
|---|---|
| `compress` 工具遮蔽一段范围 | 持久化 `surfaceOp: { op: 'replace' }`——模型书写的摘要成为 checkpoint 节点；原文保留在日志中 |
| refs（`m00001` 标签） | 表面 seq，由 nudge 的可压缩范围表携带 |
| nudge（"你也许该压缩了"） | 由内核的压力决策在 `agent/pre-step` 注入 |
| `decompress` | 从日志只读恢复被遮蔽的原文 |
| `search_context` | 对从日志重建的块摘要与原文打分 |
| `acp_status` | 块账本与上下文压力 |
| 块状态 | 内存内核状态 + **日志重建账本**（无旁车文件） |

刻意**不做自动摘要**：自动策略只 nudge 模型（`compactIfNeeded` 返回 null）。这正是 ACP 的成本优势——模型书写一份紧凑摘要，而不是为第二次 LLM 摘要调用付费。

## 安装 / 挂载

本包是即插即用的压缩后端。在宿主组合（或 agent preset 的 compaction realm）中添加一行：

```yaml
# 宿主组合（例如 profile 的 cordis.patch.yml）
- insert:
    - id: compaction-billion-context
      name: 'billion-context-dsh'
      config:
        modelContextLimit: 128000   # 默认；压力窗口
```

要为某个 agent 替换 `dsh-compaction-basic`，改为挂载在 preset 的 `compaction` isolate realm 中：

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
  config:
    - id: compaction-acp
      name: 'billion-context-dsh'
      config:
        modelContextLimit: 128000
```

当宿主上下文提供 `ctx.tools` / `ctx.commands` 时，引擎还会注册：

- `compress` — 用你书写的紧凑摘要替换范围
- `decompress` — 恢复某块的原始内容（只读）
- `search_context` — 在压缩块内查找信息
- `acp_status` — 块账本与压力
- `/acp` — 从命令栏执行 status / compress / decompress

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `modelContextLimit` | `128000` | 用于内核压力决策的上下文窗口 |
| `nudgeMinContextLimitPct` | 内核默认 `0.45` | Nudge 窗口下界（用量占比）——与 billion-context-pi 相同的默认值 |
| `nudgeMaxContextLimitPct` | 内核默认 `0.75` | 过限线：超过此值则无论增长与否都触发 nudge |
| `nudgeEmergencyThresholdPct` | 内核默认 `0.95` | 紧急 nudge（绕过每轮去重） |
| `coreOverrides` | — | 任何其他 acp-kernel `Config` 覆盖（billion-context-pi 的 `coreOverrides` 逃生口） |
| `autoTools` | `true` | 在 `ctx.tools` 注册四个模型工具 |
| `autoCommand` | `true` | 在 `ctx.commands` 注册 `/acp` 命令 |
| `autoNudge` | `true` | 当内核建议时向 `agent/pre-step` 注入 nudge |

## 开发

```bash
npm install
npm run typecheck   # 严格 TS
npm test            # node --import tsx --test tests/*.test.ts
npm run build       # tsup 打包（内联 acp-kernel）+ .d.ts
```

`dist/index.js` 自包含，仅外链 `@deepseek-ai/*` 接缝包（由宿主部署提供）。

## 架构

```
src/
├── index.ts      # AcpCompactionEngine（CompactionEngine 后端）+ 接线
├── messages.ts   # M1: 会话事件 ↔ acp-kernel CoreMessage 投影
├── state.ts      # M2: 每会话内核状态
├── region.ts     # M5: 持久化区域事务 + 日志重建块账本
├── tools.ts      # M3: compress / decompress / search_context / acp_status
├── nudge.ts      # M4: 内核压力决策 → 注入的建议式 nudge 消息
├── system-prompt.ts # M4: ACP 指引系统提示段（一次性，不进 nudge）
└── commands.ts   # M4: /acp 斜杠命令
```

## License

MIT
