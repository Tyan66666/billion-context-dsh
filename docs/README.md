# billion-context-dsh — Documentation Index

[English](./README.md) · [简体中文](../README.md) · [项目主页](https://github.com/Tyan66666/billion-context-dsh)

> **⚠️ Beta** — this project (v0.2.0) and the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) are both in **public beta**: do not use in engineering / production environments.

Model-driven context management (Active Context Pruning / ACP) for the DeepSeek Harness, ported from [billion-context-pi](https://github.com/ranxianglei/billion-context-pi). The compression core ([acp-kernel](https://github.com/ranxianglei/acp-kernel)) is reused verbatim.

## 📚 Documents

| Document | What it covers |
|---|---|
| [Home (web)](index.md) | GitHub Pages landing page — intro, philosophy video, quick links |
| [Installation & verification](INSTALL.md) | Mount in a real DSH deployment; step-by-step verification checklist; rollback |
| [Porting feasibility analysis](dsh-porting-analysis.md) | Initial study: Pi ↔ DSH API mapping, the core difficulty (no in-memory message rewrite hook), three porting paths |
| [Porting verification report](dsh-porting-verification.md) | The verified evidence behind every claim, plus the **v0.1.1 long-session battle report** (6 bugs found and fixed in real use) |
| [Configurable prompts design](configurable-prompts-design.md) | Design review draft: per-stage prompt overrides (nudge / range table / system prompt / tool descriptions) via `config.prompts`, template + named placeholders, build-time validation |

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

- [v0.2.0](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.2.0) — (feat) ship a `dsh.bundle` manifest: the package is now installable with `dsh plugin --profile web add billion-context-dsh` (the patch auto-inserts the composition row), which also unlocks listing in the awesome-dsh-plugin registry and the dsh-market plugin store; (chore) add npm keywords for search discoverability; docs: bundle install method in README (zh/en) and INSTALL.md 方式 C; 77 tests pass (no regression)
- [v0.1.9](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.9) — (chore) bump acp-kernel 0.0.23 → 0.0.24 (inline-dependency upgrade); docs: update acp-kernel version reference in AGENTS.md; 62 tests pass (no regression)
- [v0.1.8](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.8) — (fix) system prompt section cold-start retry: the ACP guidance section is now registered even when the `systemPrompt` service activates after the engine — matches the same retry pattern used by tools and commands; (fix) nudge context pressure now reads from `sessionProjections.contextPressure.projectedTokens` (matches the UI context-occupancy display; includes fixed overhead) instead of `tokenMeter.measure(session).surfaceTokens`; docs: INSTALL.md 2a notes that disabling compaction-basic is redundant on dsh 0.1.0-rc.6+; + 3 regression tests (62 tests)
- [v0.1.7](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.7) — (fix) compress no longer fails with *seq not in the current surface* when the model reuses stale refs (old nudge tables / earlier compress results): shadowed edges are remapped to the still-live content of the requested span, a fully shadowed span is reported as *already compressed* with the covering block ids, block checkpoint nodes are never folded on a stale reference (distillation stays explicit), and invented/other-session seqs still fail with acp_status guidance; guidance updated in the system prompt, nudge range table and compress tool description, + 6 regression tests (60 tests)
- [v0.1.6](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.6) — (feat) auto-detect the model context window from the LLM runtime (`agent.ctx.llm.resolveModelInfo`; explicit `modelContextLimit` wins, falls back to the default), (feat) engine nudge thresholds lowered to 0.70/0.85 (forced nudge before the host 80% compaction line; explicit values win), docs: clarify nudge trigger semantics — growth path has no percentage floor, + 3 regression tests (54 tests)
- [v0.1.5](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.5) — (feat) tier-2/3 block distillation: compressing a block's summary node distills it into a higher tier (T1→T2→T3), with recursive decompress, log rehydration of kernel blocks (restart-safe), tier-aware nudge/status, + 8 regression tests (42 tests)
- [v0.1.4](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.4) — (feat) guide the model toward multi-segment batch compression: the nudge range table, system prompt, and the compress tool description now point at batching multiple disjoint ranges in one call (each entry its own block), + regression test (34 tests)
- [v0.1.3](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.3) — compress / resolveSurfaceRange errors now point the model at `acp_status` for the current surface (sparse-node guidance)
- [v0.1.2](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.2) — fix: compress failed with *no assigned ref* when a range edge landed on a multi-tool-call assistant message (balanced plain-ref boundaries, 32 tests)
- [v0.1.1](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.1) — 6 fixes from long-session testing (ledger tokens, CJK-aware estimation, lone tool-result expansion, surface-based range table, …)
- [v0.1.0](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.0) — initial release

## 🔗 Quick links

- Repository: [github.com/Tyan66666/billion-context-dsh](https://github.com/Tyan66666/billion-context-dsh)
- npm: [billion-context-dsh](https://www.npmjs.com/package/billion-context-dsh)
- Upstream: [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) · [acp-kernel](https://github.com/ranxianglei/acp-kernel) · [opencode-acp](https://github.com/ranxianglei/opencode-acp) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
