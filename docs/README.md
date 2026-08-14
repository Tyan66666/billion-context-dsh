# billion-context-dsh — Documentation Index

[English](./README.md) · [简体中文](../README.zh-CN.md) · [项目主页](https://github.com/Tyan66666/billion-context-dsh)

> **⚠️ Beta** — this project (v0.1.1) and the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) are both in **public beta**: do not use in engineering / production environments.

Model-driven context management (Active Context Pruning / ACP) for the DeepSeek Harness, ported from [billion-context-pi](https://github.com/ranxianglei/billion-context-pi). The compression core ([acp-kernel](https://github.com/ranxianglei/acp-kernel)) is reused verbatim.

## 📚 Documents

| Document | What it covers |
|---|---|
| [Home (web)](index.md) | GitHub Pages landing page — intro, philosophy video, quick links |
| [Installation & verification](INSTALL.md) | Mount in a real DSH deployment; step-by-step verification checklist; rollback |
| [Porting feasibility analysis](dsh-porting-analysis.md) | Initial study: Pi ↔ DSH API mapping, the core difficulty (no in-memory message rewrite hook), three porting paths |
| [Porting verification report](dsh-porting-verification.md) | The verified evidence behind every claim, plus the **v0.1.1 long-session battle report** (6 bugs found and fixed in real use) |

## 🗂 Source layout

```
src/
├── index.ts        # AcpCompactionEngine (CompactionEngine backend) + wiring
├── messages.ts     # M1: session events ↔ acp-kernel CoreMessage projection
├── state.ts        # M2: per-session kernel state
├── region.ts       # M5: durable region transaction + log-rebuilt ledger + surface range solving
├── tools.ts        # M3: compress / decompress / search_context / acp_status
├── nudge.ts        # M4: advisory nudge (surface-computed range table)
├── system-prompt.ts# M4: one-time ACP guidance section
├── config.ts       # kernel config assembly (thresholds + coreOverrides)
└── commands.ts     # M4: /acp slash command
```

## 📦 Releases

- [v0.1.1](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.1) — 6 fixes from long-session testing (ledger tokens, CJK-aware estimation, lone tool-result expansion, surface-based range table, …)
- [v0.1.0](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.0) — initial release

## 🔗 Quick links

- Repository: [github.com/Tyan66666/billion-context-dsh](https://github.com/Tyan66666/billion-context-dsh)
- npm: [billion-context-dsh](https://www.npmjs.com/package/billion-context-dsh)
- Upstream: [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) · [acp-kernel](https://github.com/ranxianglei/acp-kernel) · [opencode-acp](https://github.com/ranxianglei/opencode-acp) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
