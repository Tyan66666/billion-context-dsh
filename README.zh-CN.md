# billion-context-dsh

[English](./README.md) | [中文](./README.zh-CN.md)

> **⚠️ 测试版声明——请勿用于生产环境**
> 本项目（**v0.1.0**）仍处于开发中的测试版。[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 本身也处于**公开测试版**阶段。**请勿将两者用于工程化 / 生产环境**——预期会有破坏性变更与粗糙之处。

<p align="center">
<strong>衷心感谢以下项目——请给它们一个 ⭐：</strong>
<br />
<a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> ·
<a href="https://github.com/ranxianglei/billion-context-pi">billion-context-pi</a> ·
<a href="https://github.com/ranxianglei/acp-kernel">acp-kernel</a> ·
<a href="https://github.com/ranxianglei/opencode-acp">opencode-acp</a>
</p>

<p align="center">
<strong>Billion-Context</strong> for <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>
<br />
由模型决定<em>何时</em>压缩、<em>压缩什么</em>——而不是一个硬性上限。
</p>

---

<p align="center">
<a href="https://www.npmjs.com/package/billion-context-dsh"><img src="https://img.shields.io/npm/v/billion-context-dsh.svg?style=flat-square" alt="npm"></a>
<a href="https://github.com/Tyan66666/billion-context-dsh/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/billion-context-dsh.svg?style=flat-square" alt="license"></a>
<a href="https://github.com/Tyan66666/billion-context-dsh"><img src="https://img.shields.io/badge/GitHub-Tyan66666%2Fbillion--context--dsh-181717?style=flat-square&logo=github" alt="GitHub"></a>
<a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/topic-dsh--plugin-blue?style=flat-square" alt="dsh-plugin"></a>
</p>

<p align="center">
<code>npm install billion-context-dsh</code>
</p>

---

## 为什么？

当对话变长，模型会耗尽上下文。多数工具直接硬截断——悄悄丢弃早期消息。**billion-context-dsh** 给模型一个 `compress` 工具：由 LLM 决定**何时**、**压缩什么**，写成高保真摘要，保留关键细节（文件路径、决策、错误信息）的同时回收上下文空间。

与 DSH 内置的自动压缩（用自动生成的摘要替换一段范围）不同，billion-context-dsh：

- **模型驱动** —— 摘要由模型自己书写，没有第二次 LLM 摘要调用（ACP 的成本优势）
- **只建议、不强令** —— 自动策略只 *nudge*（提醒），是否压缩、何时压缩由模型决定
- **持久且可恢复** —— 压缩范围成为 checkpoint 节点，原文保留在 append-only 会话日志中；`decompress` 可恢复，`search_context` 可在块内查找
- **基于 seq 引用** —— 不需要消息标签；surface seq 由 nudge 的范围表携带，范围边界自动平衡、容忍 `#callId` 片段

这是 [billion-context-pi](https://github.com/ranxianglei/billion-context-pi)（Pi 编码代理适配器）在 DeepSeek Harness 上的移植：压缩内核（[acp-kernel](https://github.com/ranxianglei/acp-kernel)）原样复用，适配层针对 DSH 的 durable-surface 模型重写——经过验证的映射关系见 [docs](https://github.com/Tyan66666/billion-context-dsh/tree/main/docs)。

## 安装

```bash
npm install billion-context-dsh
```

就这样。在需要压缩后端的位置加一行组合配置（宿主组合或 agent preset 的 `compaction` realm）：

```yaml
- id: compaction-billion-context
  name: 'billion-context-dsh'
  config:
    modelContextLimit: 128000   # 默认；压力窗口
```

> **每个 agent 只留一个上下文管理器。** preset 的 `compaction` isolate realm 应该用本引擎*替换* `dsh-compaction-basic`——两个后端同时 provide `ctx.compaction` 会冲突（完整文档见 [docs](https://github.com/Tyan66666/billion-context-dsh/tree/main/docs)）。

## 工作原理

DSH 的每个模型请求都派生自其 append-only 会话日志（*surface*）。ACP 语义直接映射到这一模型：

| ACP 概念 | DSH 实现 |
|---|---|
| `compress` 工具遮蔽一段范围 | 持久化 `surfaceOp: { op: 'replace' }`——模型书写的摘要成为 checkpoint 节点；原文保留在日志中 |
| refs（`m00001` 标签） | surface seq，由 nudge 的可压缩范围表携带 |
| nudge（"考虑压缩一下"） | 由内核的压力决策在 `agent/pre-step` 注入——简短建议，绝非命令 |
| `decompress` | 从日志只读恢复被遮蔽的原文 |
| `search_context` | 对从日志重建的块摘要与原文打分 |
| `acp_status` | 块账本与上下文压力 |
| 块状态 | 内存内核状态 + **日志重建账本**（无旁车文件） |

承载性的压缩指引（工具、哲学、摘要规则）注册为一次性系统提示段，因此 nudge 保持简短。刻意**不做自动摘要**：自动策略只 nudge 模型（`compactIfNeeded` 返回 null）。

## 视频讲解

本项目继承的 ACP 哲学讲解——主动上下文压缩如何在约 20 万 token 内保持会话精简（opencode-acp 与 billion-context-pi）。*视频原作者：[裘香莲](https://space.bilibili.com/)（B 站 UP 主），非本项目制作。*

[![在 B 站观看](https://i1.hdslb.com/bfs/archive/083a77fede77502cbd6b2e206f8aadcc4dacc7ea.jpg)](https://www.bilibili.com/video/BV1qAMR6MEA4/)

## 模型工具

| 工具 | 作用 |
| --- | --- |
| `compress` | 用你书写的紧凑摘要替换 seq 范围（边界自动平衡到 tool-call/result 配对点） |
| `decompress` | 恢复已压缩块的原始内容（只读） |
| `search_context` | 按关键词搜索压缩块摘要与原文 |
| `acp_status` | 上下文占用、压缩块、可压缩范围 |
| `/acp` | 从命令栏执行 status / compress / decompress |

## 上游项目与致谢

本项目是一个**移植/派生项目**，站在以下上游工作的肩膀上——全部为 MIT 许可。**衷心感谢** [ranxianglei](https://github.com/ranxianglei) 和 DeepSeek Harness 团队创建并开源这些项目：

| 上游项目 | 作者 | 角色 |
|---|---|---|
| **[billion-context-pi](https://github.com/ranxianglei/billion-context-pi)** | [ranxianglei](https://github.com/ranxianglei) | 本项目移植的 Pi 编码代理适配器；适配器设计、工具语义与本项目默认配置的来源 |
| **[acp-kernel](https://github.com/ranxianglei/acp-kernel)** | [ranxianglei](https://github.com/ranxianglei) | 框架无关的上下文压缩引擎——**原样复用**（refs、blocks、tiers、nudge 决策、search、status） |
| **[opencode-acp](https://github.com/ranxianglei/opencode-acp)** | [ranxianglei](https://github.com/ranxianglei) | ACP（"模型决定何时压缩、压缩什么"）设计的源头 |
| **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** | DeepSeek AI | 本项目所扩展的宿主平台（compaction 能力接缝、agent preset、持久化会话日志） |

本项目原样复用 `acp-kernel` 的压缩内核与 `billion-context-pi` 的默认行为；DSH 适配层（会话事件投影、持久化表面事务、模型工具、nudge、配置）为本仓库原创。上游版权与许可归其各自作者所有；本项目的许可条款见 [LICENSE](LICENSE)。

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
├── index.ts        # AcpCompactionEngine（CompactionEngine 后端）+ 接线
├── messages.ts     # M1: 会话事件 ↔ acp-kernel CoreMessage 投影
├── state.ts        # M2: 每会话内核状态
├── region.ts       # M5: 持久化区域事务 + 日志重建块账本
├── tools.ts        # M3: compress / decompress / search_context / acp_status
├── nudge.ts        # M4: 内核压力决策 → 注入的建议式 nudge
├── system-prompt.ts# M4: 一次性 ACP 指引段（让 nudge 保持简短）
├── config.ts       # 内核配置组装（阈值 + coreOverrides）
└── commands.ts     # M4: /acp 斜杠命令
```

## License

MIT
