# billion-context-dsh — Documentation

> **⚠️ Beta notice** — this project (v0.1.1) and the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) are both in **public beta**: do not use in engineering / production environments.

**Model-driven context management (Active Context Pruning / ACP) for the DeepSeek Harness.**

The model decides *when* and *what* to compress — not a hard limit. This project ports [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) (by [ranxianglei](https://github.com/ranxianglei), MIT) to DSH as a `CompactionEngine` backend; the compression core [acp-kernel](https://github.com/ranxianglei/acp-kernel) is reused verbatim.



## Video — ACP 原理与哲学

*视频原作者：[裘香莲](https://space.bilibili.com/)（B 站 UP 主），非本项目制作。*

<iframe src="//player.bilibili.com/player.html?isOutside=true&aid=117032389444915&bvid=BV1qAMR6MEA4&cid=40568295167&p=1" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true" style="width:100%;aspect-ratio:16/9;border:0"></iframe>

[在 B 站打开原视频](https://www.bilibili.com/video/BV1qAMR6MEA4/) — 主动上下文压缩插件 opencode-acp 与 billion-context-pi（本项目理念的源头）。

## Guides

| Document | What it covers |
|---|---|
| [Installation & verification](INSTALL.md) | How to mount the package in a real DSH deployment and verify it end-to-end (tools, nudge, compress loop, rollback) |
| [Porting feasibility analysis](dsh-porting-analysis.md) | Initial feasibility study: Pi ↔ DSH API mapping, the core difficulty (no in-memory message rewrite hook), three porting paths |
| [Porting verification report](dsh-porting-verification.md) | The verified evidence behind every claim: acp-kernel standalone runs, seam contracts, scope semantics, and the chosen path |

## Quick links

- **Repository**: [github.com/Tyan66666/billion-context-dsh](https://github.com/Tyan66666/billion-context-dsh)
- **npm**: [billion-context-dsh@0.1.0](https://www.npmjs.com/package/billion-context-dsh)
- **Release**: [v0.1.1](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.1)
- **Upstream**: [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) · [acp-kernel](https://github.com/ranxianglei/acp-kernel) · [opencode-acp](https://github.com/ranxianglei/opencode-acp) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
