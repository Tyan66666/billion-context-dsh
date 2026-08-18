# billion-context-dsh — Documentation Index

[English](./README.md) · [简体中文](../README.md) · [项目主页](https://github.com/Tyan66666/billion-context-dsh)

> **⚠️ Beta** — this project (v0.2.2) and the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) are both in **public beta**: do not use in engineering / production environments.

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
├── tools.ts        # M3: compress / decompress / search_context / acp_status (status rendered via kernel buildStatusReport)
├── nudge.ts        # M4: advisory nudge (surface-computed range table)
├── system-prompt.ts# M4: one-time ACP guidance section
├── config.ts       # kernel config assembly (thresholds + coreOverrides)
├── window.ts       # auto context-window detection (LLM runtime probe, fallback 128000)
└── commands.ts     # M4: /acp slash command
```

## 📦 Releases

- [v0.2.3](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.2.3) — (feat) align the model tool `acp_status` with upstream billion-context-pi: it now renders through the kernel's `buildStatusReport` — CONTEXT BREAKDOWN (tool/text/summaries token shares of the visible total, no window semantics), COMPRESSED BLOCKS ledger, and the kernel nudge decision line — and drops the engine-side `estimated context` / `context window` rows (window info stays in the human `/acp` command); checkpoint summary nodes are excluded from the breakdown so summaries are never double-counted; `surfaceSummary` reports the span as min..max (a compaction replace lands the checkpoint node first, which previously read "seqs 15..12"); (feat) `decompress` accepts the kernel block ref `bN` that acp_status shows (dual id space: exact `bN` first, compaction-id prefix fallback; `/acp decompress` too) so the block rows are directly usable by the model; (fix) prompt copy makes the split explicit — compress boundaries are SURFACE SEQS, not the `bN` refs (which are for decompress); + (fix) tool/result projection backfills `toolName`/`toolCallId` from an assistant tool-call index (`buildToolCallIndex`, keyed by the shared `toolCallIdOfResultEvent`) — real DSH tool-result events carry no `message.toolName` (identity lives in `message.source.callId` / the nested `tool-result` block), so previously every tool output landed in an empty-named bucket and `acp_status` rendered `Top tools:  (62%)` with a `tool:""` kernel Tip; the extractor is now a single shared implementation with `region.ts`'s call/result pairing; + 10 regression tests (100 tests pass, no regression)
- [v0.2.2](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.2.2) — (fix) hide compress call/result after landing and prune orphan tool messages (#21) — fixes #18 (the nudge compressible-range table collapsed to ~28 tokens): deferred (reentry-safe) compress call/result hiding, single-call hide guard, full in-flight call protection (`openToolCallIds`), broken-pair self-healing for legacy deadlocked sessions, batch compression resilience (a kernel-rejected range no longer poisons the batch), unconditional `agent/pre-step` orphan stripping; 90 tests pass (6 new regressions); live-verified on DSH web (no 400 after compress; real nudge range table)
- [v0.2.1](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.2.1) — (feat) align nudge and system-prompt copy with acp-kernel/billion-context-pi (#14): default nudges now render through the kernel's `renderNudgeText` — efficiency-note frame ("not an overflow warning"), context breakdown, HOW_TO_COMPRESS_RULES, tier rules (TIER2/3), and batch tip — with only the ref-ID segments adapted to the surface-seq range table; the emergency tier says "compress now"; the system prompt gains WHEN TO COMPRESS / WHEN NOT TO COMPRESS lists and kernel rule placeholders; `config.prompts` overrides keep the template path (custom copy wins); + 3 regression tests (80 tests pass, no regression)
- [v0.2.0](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.2.0) — (feat) ship a `dsh.bundle` manifest: the package is now installable with `dsh plugin --profile web add billion-context-dsh` (the patch auto-inserts the composition row), which also unlocks listing in the awesome-dsh-plugin registry and the dsh-market plugin store; (chore) add npm keywords for search discoverability; docs: bundle install method in README (zh/en) and INSTALL.md 方式 C; 77 tests pass (no regression)
- [v0.1.9](https://github.com/Tyan66666/billion-context-dsh/releases/tag/v0.1.9) — (feat) configurable per-stage prompts via `config.prompts` (nudge frames/range table/system prompt/tool descriptions as validated templates; fail-fast on unknown placeholders), (chore) bump acp-kernel 0.0.23 → 0.0.24 (inline-dependency upgrade), docs: update acp-kernel version reference in AGENTS.md; 77 tests pass (no regression)
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
