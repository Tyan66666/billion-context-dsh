# billion-context-dsh

> **⚠️ Beta notice** — this project (v0.2.18) and the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) are both in **public beta**: do not use in engineering / production environments.

**Model-driven context management (Active Context Pruning / ACP) for the DeepSeek Harness.** The model decides *when* and *what* to compress — not a hard limit. Ported from [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) (by [ranxianglei](https://github.com/ranxianglei), MIT); the compression core [acp-kernel](https://github.com/ranxianglei/acp-kernel) is reused verbatim.

## 📚 Documentation

**[→ Documentation Index](README.md)** — installation guide, porting analysis, verification report (incl. the v0.1.1 long-session battle report), and video production guide.

## 🎬 Video — ACP 原理与哲学

*视频原作者：[裘香莲](https://space.bilibili.com/)（B 站 UP 主），非本项目制作。*

<iframe src="//player.bilibili.com/player.html?isOutside=true&aid=117032389444915&bvid=BV1qAMR6MEA4&cid=40568295167&p=1" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true" style="width:100%;aspect-ratio:16/9;border:0"></iframe>

[在 B 站打开原视频](https://www.bilibili.com/video/BV1qAMR6MEA4/) — 主动上下文压缩插件 opencode-acp 与 billion-context-pi（本项目理念的源头）。

## 🔗 Quick links

- **Repository**: [github.com/Tyan66666/billion-context-dsh](https://github.com/Tyan66666/billion-context-dsh)
- **npm**: [billion-context-dsh@0.2.18](https://www.npmjs.com/package/billion-context-dsh)
- **Releases**: [v0.2.18](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.2.18) · [v0.2.17](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.2.17) · [v0.2.16](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.2.16) · [v0.2.15](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.2.15) · [v0.2.14](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.2.14) · [v0.2.13](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.2.13) · [v0.2.12](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.2.12) · [v0.2.11](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.2.11) · [v0.2.10](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.2.10) · [v0.2.8](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.2.8) · [v0.2.7](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.2.7) · [v0.2.5](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.2.5) · [v0.2.4](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.2.4) · [v0.2.3](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.2.3) · [v0.2.2](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.2.2) · [v0.2.1](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.2.1) · [v0.2.0](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.2.0) · [v0.1.9](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.9) · [v0.1.8](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.8) · [v0.1.7](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.7) · [v0.1.6](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.6) · [v0.1.5](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.5) · [v0.1.4](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.4) · [v0.1.3](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.3) · [v0.1.2](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.2) · [v0.1.1](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.1) · [v0.1.0](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.0)
- **Upstream**: [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) · [acp-kernel](https://github.com/ranxianglei/acp-kernel) · [opencode-acp](https://github.com/ranxianglei/opencode-acp) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
