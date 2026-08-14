# billion-context-dsh — Development Specification

> **This document is the highest-priority specification. All developers (including AI Agents) MUST comply.**

## 1. Project Overview

**billion-context-dsh** is Active Context Pruning (ACP) for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — model-driven context management delivered as a `CompactionEngine` backend. It is a **port/derivation** of [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) (by ranxianglei, MIT); the compression core [acp-kernel](https://github.com/ranxianglei/acp-kernel) is reused verbatim.

The model decides *when* and *what* to compress — not a hard limit. Automatic policy never summarizes by itself: it only nudges.

### Tech Stack

| Category | Technology |
|---|---|
| Language | TypeScript (strict, ESM, `.ts` import suffixes) |
| Build | tsup (bundles, **inlines acp-kernel**; `@deepseek-ai/*` stays external) |
| Test | Node.js built-in: `node --import tsx --test tests/*.test.ts` |
| Runtime Deps | `acp-kernel` (inlined at build); peer: `@deepseek-ai/dsh-compaction`, `@deepseek-ai/cordis` |
| Host | DeepSeek Harness (composition row `name: 'billion-context-dsh'`) |

## 2. Architecture — module map

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

Design decisions (see docs/dsh-porting-verification.md for the full evidence):

1. **Durable surface model** — DSH has NO in-memory message rewrite hook (`llm/stream` is read-only, `deriveMessages` is a pure projection). All compression is a durable `surfaceOp: { op: 'replace' }`; originals stay in the append-only log (decompress/search rebuild from the log).
2. **Seq is the ref** — no `<acp>` tags; the nudge's range table carries surface seqs.
3. **No automatic summarization** — `compactIfNeeded` returns null; nudges are advisory, never imperative ("the choice and timing are yours").
4. **Model-driven summaries** — the model writes the summary via `compress`; no second LLM summarization call.
5. **`acp-kernel` pinned to an exact version** (e.g. `"acp-kernel": "0.0.23"`, NEVER `^`). It is inlined by tsup; a caret range breaks reproducibility.

## 3. Hard-won rules (from v0.1.1 long-session battle)

These are NOT style preferences — each cost a live-session bug:

1. **Token estimation MUST use `defaultCountTokens`** (CJK-aware: 1 char/token for CJK, 4 chars/token otherwise) — NEVER `estimateTokensFast` (flat 4 chars/token). This is the billion-context-pi algorithm.
2. **Nudge usage MUST use `tokenMeter.measure(session).surfaceTokens`** — NEVER `.totalTokens` (request+response pressure; observed 230% vs ~20% real). Displayed percentage is capped at 100.
3. **Nudge range table MUST be computed from the surface** (`buildCompressibleSeqRanges`), NOT from kernel `compressibleRanges` — the kernel ref map drifts after surface replacements in long sessions, hiding large tool results and producing `end < start` ranges.
4. **Range solving is shrink-then-expand** — `resolveSurfaceRange` shrinks edges inward to balanced cuts; if that collapses (a lone tool message), it EXPANDS outward to the smallest balanced tool-call/result pair. A model compressing a single "consumed tool output" is the norm, not the error.
5. **Test fixtures MUST mirror real DSH structures** — a real tool-result block is `{ type: 'tool-result', toolCallId, content: ContentBlock[] }` (nested), NOT `{ callId, output }`. `extractText` recurses into nested `content`. A wrong fixture silently passes while production breaks (this exact mismatch hid the seq-without-ref bug).
6. **Ledger is log-rebuilt** — `rebuildBlockLedger` reads `compaction/summary` events; a `shadowedTokenCount: 0` entry is BACKFILLED from the shadowed originals in the log (legacy blocks must still report real reclaimed tokens).

## 4. Development standards

```bash
npm install
npm run typecheck   # strict TS, --noEmit
npm test            # node --import tsx --test tests/*.test.ts
npm run build       # tsup (inlines acp-kernel) + tsc --emitDeclarationOnly
```

- **No `as any`**, **No `@ts-ignore`**, No `require` in tests (ESM; use static imports).
- Add a regression test for every bug fix (see tests/ for the battle-report tests: CJK estimation, stale-range filtering, lone tool expansion, legacy backfill).
- Keep `@deepseek-ai/*` devDeps on the **0.1.0-rc.6 line** (aligned with `@deepseek-ai/dsh-compaction` peer). Do not mix rc lines.

## 4b. acp-kernel upgrade policy (the kernel WILL move on)

`acp-kernel` is pinned **exactly** (e.g. `0.0.23`, never `^`) because tsup inlines it — a caret range makes the resolved version drift when the lockfile regenerates, breaking reproducible builds. But pinning is **not** freezing: upgrades are a controlled, manual process.

**When to check:** on any feature work, or monthly — `npm view acp-kernel version`.

**Upgrade SOP (each step gates the next):**

1. `npm view acp-kernel versions` — pick the target. Read its changelog / git diff for breaking changes.
2. Watch these hot spots (kernel changes here have bit us before):
   - `defaultCountTokens` / tokenizer behavior (CJK estimation, `createBpeTokenizer`) — tests/assert 100 CJK = 100 tokens
   - `CompressionState` shape (`messageRefs`, blocks) — `state.ts`, `region.ts` read it structurally
   - ref assignment / `compressibleRanges` — we deliberately self-compute the range table, so drift here is absorbed, but confirm
   - `CoreMessage` / `NudgeDecision` types — `messages.ts`, `nudge.ts`
3. Bump the exact version in `package.json`, run `npm install` (refreshes lock), then `npm run typecheck && npm test && npm run build`.
4. **The test suite is the safety net**: 28 tests cover the battle-hardened behaviors (CJK estimation, lone-tool expansion, surface range table, ledger backfill, ref-tag projection). Any kernel behavior change that breaks one of those turns red here — do NOT release on red.
5. Optionally enable new kernel features deliberately (e.g. `createBpeTokenizer()` behind a config flag) — never adopt silently.
6. Release per the workflow below (bump own version, publish, `gh release create`).

If a kernel major version breaks the seam contracts, treat it as a porting task: re-verify against docs/dsh-porting-verification.md before shipping.

## 5. Release workflow

Pre-flight (ALL must pass): `npm run typecheck && npm test && npm run build`.

1. Bump version: `npm version <patch|minor|major> --no-git-tag-version` (bug fixes → patch).
2. Update the `vX.Y.Z` references in `README.md`, `README.en.md`, `docs/README.md`, `docs/index.md` (Beta notice + Release links).
3. `npm publish`.
4. Commit `release vX.Y.Z` (package.json + package-lock.json + docs), push.
5. `gh release create vX.Y.Z` with notes listing fixes + live verification data.
6. GitHub Pages rebuilds automatically (workflow `pages.yml`).

> PR merges are **human-only**. The Agent MUST NEVER merge any PR.

## 6. Upstream & attribution

- Always credit upstream in README/docs: **billion-context-pi**, **acp-kernel**, **opencode-acp** (ranxianglei, MIT) and **DeepSeek Harness** (DeepSeek AI).
- Do not change kernel default behavior without an explicit reason — defaults intentionally match billion-context-pi (nudge window 45%–75%, emergency 95%, `defaultCountTokens`).
- Keep the Beta notice prominent (project and host are both public beta; not for production).
