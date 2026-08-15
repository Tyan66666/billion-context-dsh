# billion-context-dsh

[English](./README.en.md) | [中文](./README.md)

> **⚠️ Beta notice — not for production use**
> This project (**v0.1.9**) is a work-in-progress beta. The [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) itself is also in **public beta**. **Do not use either in engineering / production environments** — expect breaking changes and rough edges.

<p align="center">
<strong>Built with gratitude on top of these projects</strong> — please give them a ⭐:
<br />
<a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> ·
<a href="https://github.com/ranxianglei/billion-context-pi">billion-context-pi</a> ·
<a href="https://github.com/ranxianglei/acp-kernel">acp-kernel</a> ·
<a href="https://github.com/ranxianglei/opencode-acp">opencode-acp</a>
</p>

<p align="center">
<strong>Billion-Context</strong> for <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>
<br />
The model decides <em>when</em> and <em>what</em> to compress — not a hard limit.
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

## Why?

When conversations get long, the model runs out of context. Most tools hard-truncate — silently dropping earlier messages. **billion-context-dsh** gives the model a `compress` tool: the LLM decides **when** and **what** to compress into high-fidelity summaries, preserving critical details (file paths, decisions, error strings) while reclaiming context space.

Unlike DSH's built-in auto-compaction (which replaces a range with an automatically generated summary), billion-context-dsh:

- **Model-driven** — the model writes the summary itself; there is no second LLM summarization call (the ACP cost win)
- **Advisory, never imperative** — automatic policy only *nudges*; the model decides whether and when to compress
- **Durable & recoverable** — a compressed range becomes a checkpoint node, the originals stay in the append-only session log; `decompress` restores them, `search_context` finds information inside blocks
- **Seq-based refs** — no message tags; surface seqs are carried by the nudge's range table, with auto-balanced range edges and `#callId` tolerance

This is the DeepSeek Harness port of [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) (the Pi coding-agent adapter): the compression core ([acp-kernel](https://github.com/ranxianglei/acp-kernel)) is reused verbatim, and the adapter layer was rewritten against DSH's durable-surface model — see [docs](https://github.com/Tyan66666/billion-context-dsh/tree/main/docs) for the verified mapping.

## Install

> 💡 **Want DeepSeek Harness to install it for you?** This repo itself runs on DSH: hand [docs/INSTALL.md](docs/INSTALL.md) to an agent in a session and it will read the guide, inspect your profile, wire the composition, and verify the mount. Two preconditions: ① the config lives under `~/.dsh`, so you approve one file-permission prompt; ② afterwards ask it to call `acp_status` as proof.

```bash
npm install billion-context-dsh
```

That's it. Then add a composition row where a compaction backend is expected — two scopes, pick by how wide you want it:

**Global — host plane, every mode** (recommended). In your profile patch (e.g. `~/.dsh/profiles/web/cordis.patch.yml`), add:

```yaml
# ACP as the global compaction backend: four model tools + `/acp` command +
# nudge + ACP guidance section for EVERY mode
# (standard / code / minimal / cordis / custom presets).
# Must also disable the host compaction-basic: two backends providing
# `ctx.compaction` in the same realm collide.
- id: compaction-basic
  disabled: true

- insert:
    - id: compaction-acp
      name: 'billion-context-dsh'
      config:
        modelContextLimit: 128000   # optional; omit to auto-detect the model's real window (fallback 128000)
```

**(Optional) Custom prompt copy — `config.prompts`.** Every model-visible prompt (normal/emergency nudge opener, context breakdown, growth line, batch tip, tier line, range table, the ACP system-prompt section, the four tool descriptions) defaults to **acp-kernel's own `renderNudgeText`** — the efficiency note, context breakdown, compression rules, and batch tip all come from the kernel verbatim; only the range table is swapped for the surface-seq version (the kernel uses mNNNNN refs, and DSH has no `<acp>` tags). Overriding any nudge slot switches to template rendering. Templates support named placeholders (e.g. `{pct}` and `{philosophy}` for nudges, `{surface}` for the range table) and are **validated at construction**: a misspelled placeholder fails engine startup (fail-fast) instead of leaking a literal `{pct}` into the model context:

```yaml
      config:
        modelContextLimit: 128000
        prompts:
          nudge:
            normal: 'This is an efficiency nudge to compress early and keep context lean.'  # custom nudge opener
          tools:
            acpStatus: 'Report the ACP block ledger: compressed blocks, reclaimed tokens, and current context pressure.'  # custom tool description
```

See [docs/configurable-prompts-design.md](docs/configurable-prompts-design.md) for the full slot list, per-slot placeholders, and the empty-string/`null` semantics. Deployments that omit `prompts` use the kernel rendering directly (aligned with kernel/pi; see design doc v6).

**Per-mode — an agent preset's `compaction` realm.** First *disable (or delete) the realm's existing `dsh-compaction-basic` row*, then mount this engine — two backends cannot coexist in the same realm:

```yaml
# First disable the realm's default backend (or just delete this row)
- id: compaction-basic
  disabled: true

# Then mount this engine
- id: compaction-acp
  name: 'billion-context-dsh'
  config:
    modelContextLimit: 128000   # optional; omit to auto-detect the model's real window (fallback 128000)
```

> **One context manager per agent.** Two backends providing `ctx.compaction` collide — never run both in the same realm. Full install & verification guide: [docs/INSTALL.md](docs/INSTALL.md).

## How it works

DSH derives every model request from its append-only session log (the *surface*). ACP semantics map onto that model directly:

| ACP concept | DSH implementation |
|---|---|
| `compress` tool shadows a range | durable `surfaceOp: { op: 'replace' }` — the model-written summary becomes a checkpoint node; the originals stay in the log |
| refs (`m00001` tags) | surface seqs, carried by the nudge's compressible-range table |
| nudge ("efficiency note — compress early and keep context lean") | injected at `agent/pre-step` by the kernel's pressure decision — efficiency note + context breakdown + compression rules, tone aligned with kernel/pi; never an order |
| `decompress` | read-only recovery of shadowed originals from the log |
| `search_context` | scores block summaries + originals rebuilt from the log |
| `acp_status` | block ledger + context pressure |
| block state | in-memory kernel state + **log-rebuilt ledger** (no sidecar files) |
| tiered distillation (T2/T3) | re-compressing a block's summary node distills that block (tier 2); distilling a tier-2 block yields tier 3. Tier + kernel block ids are persisted to the log, so kernel state rehydrates from the log after a restart and stays distillable |

The load-bearing compression guidance (tools, philosophy, summary rules, tier rules) is registered as a one-time system-prompt section; each nudge carries a condensed version (efficiency note + philosophy + context breakdown + HOW_TO_COMPRESS_RULES + range table + batch tip). There is deliberately **no automatic summarization**: automatic policy only nudges the model (`compactIfNeeded` returns null).

## Video

A walkthrough of the ACP philosophy this project inherits — how active context compression keeps a session lean at ~200K tokens (opencode-acp & billion-context-pi). *Video credit: the original author, [裘香莲](https://space.bilibili.com/) on Bilibili — not ours.*

[![Watch on Bilibili](https://i1.hdslb.com/bfs/archive/083a77fede77502cbd6b2e206f8aadcc4dacc7ea.jpg)](https://www.bilibili.com/video/BV1qAMR6MEA4/)

## Model-facing tools

| Tool | What it does |
| --- | --- |
| `compress` | Replace a seq range with a dense summary you write (edges auto-balanced to tool-pair boundaries); re-compressing a block's summary node distills it (tier 2/3) |
| `decompress` | Restore a previously compressed block's original content (read-only) |
| `search_context` | Search compressed block summaries and originals by keyword |
| `acp_status` | Context usage, compressed blocks, compressible ranges |
| `/acp` | status / compress / decompress from the command bar |

## Upstream & credits

This project is a **port/derivation** and stands on the shoulders of the following upstream work — all MIT licensed. **Thank you** to [ranxianglei](https://github.com/ranxianglei) and the DeepSeek Harness team for building these projects and making them open source:

| Upstream | Author | Role |
|---|---|---|
| **[billion-context-pi](https://github.com/ranxianglei/billion-context-pi)** | [ranxianglei](https://github.com/ranxianglei) | The Pi coding-agent adapter this project ports to DeepSeek Harness; source of the adapter design, tool semantics, and this project's default configuration |
| **[acp-kernel](https://github.com/ranxianglei/acp-kernel)** | [ranxianglei](https://github.com/ranxianglei) | Framework-agnostic context-compression engine — reused **verbatim** (refs, blocks, tiers, nudge decisions, search, status) |
| **[opencode-acp](https://github.com/ranxianglei/opencode-acp)** | [ranxianglei](https://github.com/ranxianglei) | Origin of the ACP ("model decides when and what to compress") design |
| **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** | DeepSeek AI | The host platform this project extends (compaction capability seam, agent presets, durable session log) |

This project reuses `acp-kernel`'s compression core and `billion-context-pi`'s default behavior unchanged; the DSH adapter layer (session-event projection, durable surface transaction, model tools, nudge, config) is original work in this repository. Upstream copyright and licenses remain with their respective authors; see [LICENSE](LICENSE) for this project's terms.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `modelContextLimit` | auto-detected (fallback `128000`) | Context window used for the kernel's pressure decisions; an explicit value wins and skips the probe |
| `autoModelContextLimit` | `true` | Probe the model's real window from the model API (`agent.ctx.llm.resolveModelInfo`); fall back to the default on failure, `acp_status` shows the window source |
| `nudgeMinContextLimitPct` | kernel default `0.45` | Nudge window lower bound (usage fraction) — validation only; the growth-driven trigger has no percentage floor — same default as billion-context-pi |
| `nudgeMaxContextLimitPct` | engine default `0.70` (kernel/pi default `0.75`) | Over-limit line: above this the nudge fires regardless of growth — deliberately below the host compaction-basic 80% auto-compaction line so the forced nudge fires first; an explicit value wins |
| `nudgeEmergencyThresholdPct` | engine default `0.85` (kernel/pi default `0.95`) | Emergency nudge (bypasses the per-turn dedup) — lowered from `0.95`: at 95% the model has no room to act and the 80% auto-compaction line shadows it; an explicit value wins |
| `coreOverrides` | — | Any other acp-kernel `Config` override (billion-context-pi's `coreOverrides` escape hatch) |
| `autoTools` | `true` | Register the four model tools on `ctx.tools` |
| `autoCommand` | `true` | Register the `/acp` command on `ctx.commands` |
| `autoNudge` | `true` | Inject the nudge into `agent/pre-step` |
| `prompts` | — | (optional) Custom prompt copy: per-slot overrides for nudge / range table / system prompt / tool descriptions (template + named placeholders, validated at construction; see “Custom prompt copy” above and [docs/configurable-prompts-design.md](docs/configurable-prompts-design.md)) |

## Development

```bash
npm install
npm run typecheck   # strict TS
npm test            # node --import tsx --test tests/*.test.ts
npm run build       # tsup bundle (inlines acp-kernel) + .d.ts
```

`dist/index.js` is self-contained except for the `@deepseek-ai/*` seam packages, which the hosting deployment provides.

## Architecture

```
src/
├── index.ts        # AcpCompactionEngine (CompactionEngine backend) + wiring
├── messages.ts     # M1: session events ↔ acp-kernel CoreMessage projection
├── state.ts        # M2: per-session kernel state
├── region.ts       # M5: durable region transaction + log-rebuilt block ledger
├── tools.ts        # M3: compress / decompress / search_context / acp_status
├── nudge.ts        # M4: kernel pressure decision → injected advisory nudge
├── system-prompt.ts# M4: one-time ACP guidance section (keeps nudges short)
├── config.ts       # kernel config assembly (thresholds + coreOverrides)
├── window.ts       # auto context-window detection (LLM runtime probe, fallback 128000)
└── commands.ts     # M4: /acp slash command
```

## License

MIT
