# billion-context-dsh — Documentation Index

[English](./README.md) · [简体中文](../README.md) · [项目主页](https://github.com/Tyan66666/billion-context-dsh)

> **⚠️ Beta** — this project (v0.2.22) and the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) are both in **public beta**: do not use in engineering / production environments.

Model-driven context management (Active Context Pruning / ACP) for the DeepSeek Harness, ported from [billion-context-pi](https://github.com/ranxianglei/billion-context-pi). The compression core ([acp-kernel](https://github.com/ranxianglei/acp-kernel)) is reused verbatim.

## 📚 Documents

| Document | What it covers |
|---|---|
| [Home (web)](index.md) | GitHub Pages landing page — intro, philosophy video, quick links |
| [Installation & verification](INSTALL.md) | Mount in a real DSH deployment; step-by-step verification checklist; rollback |
| [Porting feasibility analysis](dsh-porting-analysis.md) | Initial study: Pi ↔ DSH API mapping, the core difficulty (no in-memory message rewrite hook), three porting paths |
| [Porting verification report](dsh-porting-verification.md) | The verified evidence behind every claim, plus the **v0.1.1 long-session battle report** (6 bugs found and fixed in real use) |
| [Configurable prompts design](configurable-prompts-design.md) | Design review draft: per-stage prompt overrides (nudge / range table / system prompt / tool descriptions) via `config.prompts`, template + named placeholders, build-time validation |
| [Presets design](presets-design.md) | One-word nudge aggressiveness (`config.preset`): five tiers (preserve / relaxed / balanced / efficient / aggressive) resolved into the three nudge thresholds, precedence explicit value > preset > default, display-only in `/acp status`; composition-layer today, settings hot-swap rides on #75 |
| [Shadow-price host-vocabulary design](shadow-price-host-vocabulary-design.md) | Why `shadowedTokenCount` claims must speak the host token-meter's fixed-heuristic vocabulary (issue #54: CJK sessions bricked when priced with the CJK-aware `defaultCountTokens`; issue #103: image sessions bricked when priced with the route-repriced `node.tokens` — the claim reads `heuristicTokens ?? tokens`); meter-first pricing with an exact mirror fallback; L2 upstream direction |
| [Runtime settings integration design](settings-integration-design.md) | Phase-1 settings seam (issue #75): the six scalar knobs hot-editable via `~/.dsh/settings.yaml` / `/acp config`, layering (schema default → composition row → user section), base-filtering rationale, window-cache invalidation, kill switch, /acp config parse rules |
| [E2E host harness design](e2e-harness-design.md) | Why the host-integration regression suite (`scripts/e2e/`) assembles the real DSH agent loop in-process against a scripted fake LLM (issue #120); scenario schema, the honest-usage projection-anchor trap, the rc.6 peer-closure pin, phase-2 notes |
| [Injection governance design](injection-governance-design.md) | Why model-written summaries get a source frame written once at creation (B1), why unchanged-injection elision (B2) was dropped (host evidence: no visible-time re-injection; the stub would steal #93's newest-row pin; the whitelist matched ≤1 real frame kind), how verifiedReadings ride the rawOutput ledger yet stay readable (B3), and why nudge bodies stay slim (B6) |
| [Media visibility design](media-visibility-design.md) | Why image/file blocks must stay visible to the engine (issue #117): the deterministic placeholder projection, the host-meter media price, the range-row marker, the rejected alternatives, and the mutation-verified tests |

## 🗂 Source layout

```
src/
├── index.ts        # AcpCompactionEngine (CompactionEngine backend) + wiring
├── messages.ts     # M1: session events ↔ acp-kernel CoreMessage projection + summary source framing (frame-once-at-creation, idempotent net for legacy blocks) — rule 18
├── state.ts        # M2: per-session kernel state
├── region.ts       # M5: durable region transaction + log-rebuilt ledger + surface range solving + creation-time summary framing + verifiedReadings ledger/read face — rule 18
├── block-ledger.ts # tier/lineage + verifiedReadings encoded inside the rawOutput member, never top-level (issue #141; rule 18)
├── tools.ts        # M3: compress / decompress / search_context / acp_status (status rendered via kernel buildStatusReport) + verifiedReadings echo in compress results — rule 18
├── nudge.ts        # M4: advisory nudge (surface-computed range table) + slim-nudge guidance stripping — rule 18
├── system-prompt.ts# M4: one-time ACP guidance section
├── presets.ts      # named nudge-threshold tiers (config.preset): five levels resolved into the nudge*Pct knobs; explicit value > preset > default
├── config.ts       # kernel config assembly (thresholds + coreOverrides)
├── host-tokens.ts  # shadow-price pricing: host-vocabulary mirror + shadowedTokensViaMeter (meter preferred, mirror fallback) — rule 12
├── window.ts       # auto context-window detection (session projection first, LLM runtime probe fallback, default 128000) + output-reservation probe (defaultMaxTokens, subtracted in windowFor)
└── commands.ts     # M4: /acp slash command
```

## 📦 Releases

完整发布历史（每版的变更记录与致谢）见 [GitHub Releases](https://github.com/Tyan66666/billion-context-dsh/releases) —— 仓库文档不再维护历史镜像，避免与发布页不一致。

## 🔗 Quick links

- Repository: [github.com/Tyan66666/billion-context-dsh](https://github.com/Tyan66666/billion-context-dsh)
- npm: [billion-context-dsh](https://www.npmjs.com/package/billion-context-dsh)
- Upstream: [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) · [acp-kernel](https://github.com/ranxianglei/acp-kernel) · [opencode-acp](https://github.com/ranxianglei/opencode-acp) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
