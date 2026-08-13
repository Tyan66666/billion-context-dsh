# billion-context-dsh — Documentation

> **⚠️ Beta notice** — this project (v0.1.0) and the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) are both in **public beta**: do not use in engineering / production environments.

**Model-driven context management (Active Context Pruning / ACP) for the DeepSeek Harness.**

The model decides *when* and *what* to compress — not a hard limit. This project ports [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) (by [ranxianglei](https://github.com/ranxianglei), MIT) to DSH as a `CompactionEngine` backend; the compression core [acp-kernel](https://github.com/ranxianglei/acp-kernel) is reused verbatim.

## Guides

| Document | What it covers |
|---|---|
| [Installation & verification](INSTALL.md) | How to mount the package in a real DSH deployment and verify it end-to-end (tools, nudge, compress loop, rollback) |
| [Porting feasibility analysis](dsh-porting-analysis.md) | Initial feasibility study: Pi ↔ DSH API mapping, the core difficulty (no in-memory message rewrite hook), three porting paths |
| [Porting verification report](dsh-porting-verification.md) | The verified evidence behind every claim: acp-kernel standalone runs, seam contracts, scope semantics, and the chosen path |

## Quick links

- **Repository**: [github.com/Tyan66666/billion-context-dsh](https://github.com/Tyan66666/billion-context-dsh)
- **npm**: [billion-context-dsh@0.1.0](https://www.npmjs.com/package/billion-context-dsh)
- **Release**: [v0.1.0](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.0)
- **Upstream**: [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) · [acp-kernel](https://github.com/ranxianglei/acp-kernel) · [opencode-acp](https://github.com/ranxianglei/opencode-acp) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
