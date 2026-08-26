# billion-context-dsh

[English](./README.en.md) | [中文](./README.md)

> **⚠️ Beta notice — not for production use**
> This project (**v0.2.13**) is a work-in-progress beta. The [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) itself is also in **public beta**. **Do not use either in engineering / production environments** — expect breaking changes and rough edges.

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

- **Model-driven** — the model writes the summary itself; there is no second LLM summarization call
- **Advisory, never imperative** — automatic policy only *nudges*; the model decides whether and when to compress
- **Durable & recoverable** — a compressed range becomes a checkpoint node, the originals stay in the append-only session log; `decompress` restores them, `search_context` finds information inside blocks
- **Long tasks hold steady** — every step builds on the results before it; key conclusions stay usable and compound, so very long tasks actually finish
- **Context stays lean** — every request rides on a small, distilled slice of context with only the key information; no bulk compression of large ranges, so details don't decay with it — and tokens stay low

This is the DeepSeek Harness port of [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) (the Pi coding-agent adapter): the compression core ([acp-kernel](https://github.com/ranxianglei/acp-kernel)) is reused verbatim, and the adapter layer was rewritten against DSH's durable-surface model — see [docs](https://github.com/Tyan66666/billion-context-dsh/tree/main/docs) for the verified mapping.

## Install

> 💡 **Want DeepSeek Harness to install it for you?** This repo itself runs on DSH: hand [docs/INSTALL.md](docs/INSTALL.md) to an agent in a session and it will read the guide, inspect your profile, wire the composition, and verify the mount. Two preconditions: ① the config lives under `~/.dsh`, so you approve one file-permission prompt; ② afterwards ask it to call `acp_status` as proof.

**Path A (recommended): one-command install via the DSH store / `dsh plugin` (bundle) — globally active right after install, zero configuration.**

Click install in DSH's plugin store, or run:

```bash
dsh plugin --profile web add billion-context-dsh
```

The command installs the package and automatically layers this package's bundle patch ([cordis.patch.yml](cordis.patch.yml)) into the profile's composition. The patch does two things:

- **Disables the host `compaction-basic`** — so two backends do not both register `ctx.compaction` in the same realm (modern DSH web bundles already ship this disable; the row is an idempotent safety net that holds on every supported DSH);
- **Mounts the ACP engine at the HOST plane** — the four model tools (`compress` / `decompress` / `search_context` / `acp_status`), the `/acp` command, the advisory nudge, and the ACP guidance section reach **EVERY mode** of the profile (standard / code / minimal / cordis / custom presets). Window auto-detection and the tools/command/nudge defaults are all on — **no manual configuration needed**.

Restart `dsh` afterwards (bundle layers are composed at startup), open a new session, and verify: ask the model to call `acp_status`, or run `/acp status`. Shipped presets (standard / code / cordis) keep their realm-local `compaction-basic` fallback (automatic pressure compression still runs there; the ACP tools and nudge coexist); minimal and presets without a compaction realm use this engine directly.

> **DSH version compatibility.** The package declares the peer range
> `^0.1.0-rc.6 || ^0.1.1-rc.1` for `@deepseek-ai/dsh-compaction`, covering both the
> `0.1.0-rc.x` and `0.1.1-rc.x` release lines (including the current DSH release;
> the seam's `src/` is unchanged from `0.1.0-rc.6` to `0.1.1-rc.2`, so the public
> API is identical). The range is two `||` clauses **on purpose**: npm
> (node-semver) only lets a prerelease version satisfy a range that carries a
> comparator on the SAME `[major, minor, patch]` tuple as the candidate, so a lone
> `^0.1.0-rc.6` can never match `0.1.1-rc.x` (issue #68) — older releases fail to
> install on DSH 0.1.1-rc.x; upgrade to a release containing this fix.

**Path B: plain `npm install` (package only — a composition row is required).**

```bash
npm install billion-context-dsh
```

This only installs the package into your project/global store; it does **not** touch any profile — add a composition row as shown below or the engine never mounts.

## Scope & customization

Two audiences: ① Path B (plain npm install) users, who must write a composition row; ② Path A users who want custom `config` (the bundle already ships sane defaults — override them with a SAME-ID row).

**Custom `config` (Path A bundle users).** Append a `compaction-acp` row with `config:` to your profile patch (e.g. `~/.dsh/profiles/web/cordis.patch.yml`) — the same-id row overrides the bundle's default row:

```yaml
- id: compaction-acp
  name: 'billion-context-dsh'
  config:
    modelContextLimit: 128000   # optional; omit to auto-detect the model's real window (fallback 128000)
```

**Global — host plane, every mode** (recommended). This is what Path A's bundle already does; plain-npm users add all of the following (bundle users skip the first two rows):

```yaml
# ACP as the global compaction backend: four model tools + `/acp` command +
# nudge + ACP guidance section for EVERY mode
# (standard / code / minimal / cordis / custom presets).
# Must also disable the host compaction-basic: two backends providing
# `ctx.compaction` in the same realm collide.
# (The bundle install already ships these two rows.)
- id: compaction-basic
  disabled: true

- insert:
    - id: compaction-acp
      name: 'billion-context-dsh'
      config:
        modelContextLimit: 128000   # optional; omit to auto-detect the model's real window (fallback 128000)
```

**(Optional) Custom prompt copy — `config.prompts`.** Every model-visible prompt (normal/emergency nudge opener, context breakdown, growth line, batch tip, tier line, range table, the ACP system-prompt section, the four tool descriptions) defaults to **acp-kernel's own `renderNudgeText`** — the efficiency note, context breakdown, compression rules, and batch tip all come from the kernel verbatim; only the range table is swapped for the surface-seq version (the kernel uses mNNNNN refs, and DSH has no `<acp>` tags; the seq range table likewise carries a `[tool X% | text Y%]` composition share and oldest-first ordering, matching the kernel's display semantics). Ranges are segmented by real user messages: the engine's own metadata rows (acp-index directory lines, nudge echoes, compress-pair stubs) **fold into the adjacent span** — compressing consumed content carries them away (their tokens count toward the displayed total, the `tool` share is computed over real messages only); **the currently-active instruction injections** (the newest full AGENTS.md text, the skill catalog, system-policy snapshots) and checkpoints are **never compressible** and never appear in the table — but **AGENTS.md copies superseded by a newer injection** fold into adjacent spans and get reclaimed (the host re-injects only when the CURRENT version is absent from the surface — compressing an old duplicate never triggers re-injection; in long sessions old copies can exceed 40% of the surface). Overriding any nudge slot switches to template rendering. Templates support named placeholders (e.g. `{pct}` and `{philosophy}` for nudges, `{surface}` for the range table) and are **validated at construction**: a misspelled placeholder fails engine startup (fail-fast) instead of leaking a literal `{pct}` into the model context:

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

**(Optional) Per-message numbering index — `config.messageIndex`.** pi numbers every message inline (`<acp>` ref tags); DSH's session log is a frozen projection and model-visible content may not be rewritten, so the numbering directory is written into the log itself as **durable plugin messages**: on the first pre-step of each turn, one line is appended to the end of that step's injected batch (index first, nudge after it),

```
[acp-index] 12·user「run the tests please」 13·asst「checking config…」 14·tool bash「ls」 15·result bash「file-a file-b」
```

numbering every surface node appended since the previous index message with its seq, kind, and a preview (truncated to a token budget, default 16 tokens; CJK counts 1 char/token). **Nodes above 512 tokens carry a `[N tok]` marker** (thousands render as `[1.5K tok]`) so the model can spot "prime compress targets" at a glance — absence only means "below threshold", never "empty", and the exact size stays one `acp_status` drilldown away. The directory is injected **once per turn** — the model's internal tool-continuation steps do not repeat it; **if an unusually long turn (one user message followed by dozens of tool rounds) lets unindexed *tool text* (tool-result content + tool-call arguments; the assistant's own prose is not tool output) pile past `maxDelayToolTokens` (default 8192 tokens), one directory line is re-injected mid-turn** so the model never loses seq↔content alignment inside the turn (conversation messages do not push this by default — `maxDelayTextTokens` defaults to `0`; hosts that want a long conversational turn to re-inject set it explicitly; short turns never cross the threshold — behavior is identical to once-per-turn); the user message that triggered the turn is numbered on the next turn (inherent order of an append-only log). The model can thereby map any seq back to the exact content it saw — the compressible-range table, `acp_status` drilldown rows, and `compress` boundaries all gain text anchors. After a compression the old index lines vanish together with the shadowed originals (locating becomes the block summary's job, and they are excluded from the `search_context` doc set), and later lines keep numbering from the newest live seq, so the id space stays continuous. On a cold start over an existing session, a backlog beyond `backlogLimit` collapses into one placeholder directory line (seq range only) instead of one message swallowing the whole backlog:

```yaml
      config:
        messageIndex:
          enabled: false       # default false (opt-in in early releases); true enables
          previewTokens: 16    # per-entry preview token budget (ellipsis included)
          backlogLimit: 100    # max entries per directory line; overflow emits a placeholder
          maxDelayToolTokens: 8192 # re-inject when unindexed TOOL output piles past this many tokens; 0 disables
          maxDelayTextTokens: 0    # conversation threshold: 0 = conversation never triggers (set explicitly if wanted)
```

Watermark advance, post-compression continuity, and the one-turn lag are covered in [docs/message-index-design.md](docs/message-index-design.md).

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
| per-message numbering (pi's inline `<acp>` tags) | durable `[acp-index]` plugin messages: one directory line appended once per turn (re-injected mid-turn when unindexed tool output crosses `maxDelayToolTokens`), numbering each new surface node with seq + kind + preview |
| nudge ("efficiency note — compress early and keep context lean") | injected at `agent/pre-step` by the kernel's pressure decision — efficiency note + context breakdown + compression rules, tone aligned with kernel/pi; never an order |
| `decompress` | read-only recovery of shadowed originals from the log |
| `search_context` | scores a unified doc set (block summaries + shadowed originals) rebuilt from the log via acp-kernel `searchBlocks` (hybrid: stemming + CJK bigrams + char n-gram fuzzy); hits link back to the owning block |
| `acp_status` | CONTEXT BREAKDOWN (tool/text/summaries shares of the visible total) + compressed-block ledger + nudge decision line + a `Checkpoint seqs` row mapping each ACTIVE block's kernel ref (`bN`) to its checkpoint summary seq — compressing a checkpoint seq distills that block (issue #60); no context-window rows; scope/view/tool/sort/limit drilldown supported |
| block state | in-memory kernel state + **log-rebuilt ledger** (no sidecar files) |
| tiered distillation (T2/T3) | re-compressing a block's summary node distills that block (tier 2); distilling a tier-2 block yields tier 3. Tier + kernel block ids are persisted to the log, so kernel state rehydrates from the log after a restart and stays distillable |
| compression accounting (shadow price) | `shadowedTokenCount` (what the host occupancy display deducts) is priced in the **host token-meter's vocabulary** (`ctx.tokenMeter.measure` preferred; exact mirror in `src/host-tokens.ts` as fallback) — never the plugin's internal CJK-aware estimate (that is display currency; mixing it into the host ledger can drive `messageTokens` negative and brick a CJK-heavy session, issue #54) |

The load-bearing compression guidance (tools, philosophy, summary rules, tier rules, **provider prefix-cache knowledge** — compressing shifts every later message's position and invalidates that span's suffix cache once: compressing the tail is nearly lossless, a large mid-context block (e.g. a superseded AGENTS.md copy) costs the most, engine metadata and stale instruction copies folding into a real span cost nothing extra) is registered as a one-time system-prompt section; each nudge carries a condensed version (efficiency note + philosophy + context breakdown + HOW_TO_COMPRESS_RULES + range table + batch tip). There is deliberately **no automatic summarization**: automatic policy only nudges the model (`compactIfNeeded` returns null).

## Video

A walkthrough of the ACP philosophy this project inherits — how active context compression keeps a session lean at ~200K tokens (opencode-acp & billion-context-pi). *Video credit: the original author, [裘香莲](https://space.bilibili.com/) on Bilibili — not ours.*

[![Watch on Bilibili](https://i1.hdslb.com/bfs/archive/083a77fede77502cbd6b2e206f8aadcc4dacc7ea.jpg)](https://www.bilibili.com/video/BV1qAMR6MEA4/)

## Model-facing tools

| Tool | What it does |
| --- | --- |
| `compress` | Replace a seq range with a dense summary you write (edges auto-balanced to tool-pair boundaries); re-compressing a block's summary node distills it (tier 2/3) |
| `decompress` | Restore a previously compressed block's original content (read-only); accepts the `bN` ref shown by acp_status or a compaction id |
| `search_context` | Search compressed block summaries and originals by keyword (acp-kernel hybrid retrieval: stemming + CJK bigrams + fuzzy); hits link back to the owning block |
| `acp_status` | CONTEXT BREAKDOWN (tool/text/summaries shares of the visible total) + compressed-block ledger + nudge decision line + a `Checkpoint seqs` row mapping each ACTIVE block's kernel ref (`bN`) to its checkpoint summary seq (the distill entry point, issue #60); no context-window rows. Drilldown supported: `scope:"compressed"` per block, `scope:"uncompressed"` + `view:"messages"`/`"ranges"` per message/range, with `tool` filter, `sort` order and `limit` cap. Drilldown row refs are kernel ids (mN) — feed them straight to `compress` as `startSeq`/`endSeq` (auto-mapped to the live surface seq); `Surface:` seqs work too |
| `/acp` | status / compress / decompress from the command bar; status also shows human-side window info (estimated context, window source, compressed-block ledger, and **nudge arbitration** — `nudge: idle/ACTIVE — reason` plus how many tokens remain until the next nudge, decided by the same kernel turn as the nudge path) |

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
| `autoModelContextLimit` | `true` | Probe the model's real window from the model API (`agent.ctx.llm.resolveModelInfo`); fall back to the default on failure, the `/acp` command shows the window source (the `acp_status` model tool carries no window info). A failed probe is surfaced in the host log and the `/acp` panel (`restart to re-probe`) — the failure is cached like a success, so fixing the gateway requires a restart or an explicit `modelContextLimit` before the probe retries |
| `nudgeMinContextLimitPct` | kernel default `0.45` | Nudge window lower bound (usage fraction) — validation only; the growth-driven trigger has no percentage floor — same default as billion-context-pi |
| `nudgeMaxContextLimitPct` | engine default `0.70` (kernel/pi default `0.75`) | Over-limit line: above this the nudge fires regardless of growth — deliberately below the host compaction-basic 80% auto-compaction line so the forced nudge fires first; an explicit value wins (a same-name key in `coreOverrides.nudge` outranks it — see below) |
| `nudgeEmergencyThresholdPct` | engine default `0.85` (kernel/pi default `0.95`) | Emergency nudge (bypasses the per-turn dedup) — lowered from `0.95`: at 95% the model has no room to act and the 80% auto-compaction line shadows it; an explicit value wins (a same-name key in `coreOverrides.nudge` outranks it — see below) |
| `coreOverrides` | — | Any other acp-kernel `Config` override (billion-context-pi's `coreOverrides` escape hatch). Merge order: kernel defaults → top-level pct knobs → `coreOverrides.nudge` lands last — same-name keys take its value |
| `autoTools` | `true` | Register the four model tools on `ctx.tools` |
| `autoCommand` | `true` | Register the `/acp` command on `ctx.commands` |
| `autoNudge` | `true` | Inject the nudge into `agent/pre-step` |
| `prompts` | — | (optional) Custom prompt copy: per-slot overrides for nudge / range table / system prompt / tool descriptions (template + named placeholders, validated at construction; see “Custom prompt copy” above and [docs/configurable-prompts-design.md](docs/configurable-prompts-design.md)) |
| `messageIndex` | `{ enabled: false, previewTokens: 16, backlogLimit: 100, maxDelayToolTokens: 8192, maxDelayTextTokens: 0 }` | Per-message numbering index (opt-in, disabled by default in early releases): a one-line `[acp-index]` directory message injected once per turn at pre-step, numbering new surface nodes with seq + kind + token-budgeted preview, so the model can map any seq back to what it saw; when unindexed **tool output** piles past `maxDelayToolTokens` inside a long turn the directory is re-injected mid-turn (`0` disables), and unindexed **conversation messages** piling past `maxDelayTextTokens` do the same (default `0` = conversation never triggers); a backlog beyond `backlogLimit` emits one placeholder line instead. `enabled: true` turns it on. See [docs/message-index-design.md](docs/message-index-design.md) |

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
├── message-index.ts# M6: acp-index per-message numbering directory (log watermark + token-budgeted previews + mid-turn token-delay re-injection)
├── config.ts       # kernel config assembly (thresholds + coreOverrides)
├── window.ts       # auto context-window detection (LLM runtime probe, fallback 128000)
└── commands.ts     # M4: /acp slash command
```

## License

MIT
