# Output-reservation subtraction (window − defaultMaxTokens)

## Problem

Every usage computation in the plugin divides the session's estimated tokens
by the model's RAW context window (`usage = tokenCount / window.limit`). But
providers reserve the adapter's per-request output cap (`defaultMaxTokens` on
the resolved model info — the output cap applied when callers omit one) at the
END of the window on every request. Input beyond `window − cap` is rejected or
truncated mid-answer, so the raw window is not the budget a session can
sustain.

## Why short windows were distorted the most

The error is `cap / window`. On a 96K window with a 16K cap that is ≈16.7%:
the old 85% line (81.6K) plus the 16K output overflowed the window entirely
(97.6K > 96K), and the 95% line (91.2K) overflowed by 11K. On a short-window
model the SAME absolute cap is a much larger fraction of the window (a 16K cap
on a 32K window is 50%), so short-context models were the most distorted —
their nudge/truncate lines sat far beyond what the provider would ever accept.

## Fix (single seam)

`probeModelWindow()` in `src/window.ts` makes ONE `resolveModelInfo` call and
returns `{ contextWindow, outputReservation }` (`detectContextWindow` is now a
thin wrapper around it). `AcpCompactionEngine.windowFor()` in `src/index.ts`
applies the subtraction in exactly one place, `applyReservation()`:

- **auto path** — window + cap come from the same probe; a failed probe keeps
  the raw 128K fallback AND drops the cap (the probe disclosed nothing).
- **projection path** — window from the live projection (the projection schema
  carries no cap); cap from the same cached model probe. After a mid-session
  model switch `agent.options` names the PREVIOUS route, so the cap is
  best-available, not the live route's.
- **explicit `modelContextLimit`** — never probed, never subtracted: the
  operator's value is the denominator, full stop.
- **`autoModelContextLimit: false` / cap ≥ window (degenerate)** — raw
  behavior preserved.

The result carries `rawLimit` and `outputReserved`, so `/acp status` shows
`context window: 79616 (raw 96000 − 16384 output reservation; auto)` instead
of hiding the arithmetic.

## Inheritance

Every downstream consumer already receives `window.limit` as
`modelContextLimit` (nudge tiers via `agent/pre-step`, the kernel config for
`compress` / `acp_status`, truncate, growth) — subtracting once at the seam
fixes all of them with no per-site changes.

## Verification

`tests/window.test.ts`: one-probe shape (96000 + 16384 in a single call),
undisclosed/failing/missing probes → nulls, auto-path subtraction
(96000 − 16384 = 79616 with `rawLimit`/`outputReserved`), projection-path
subtraction + cap caching (one probe per route), no-cap no-op, degenerate
cap ≥ window, explicit never subtracted (and never probed). All pre-existing
window tests keep their original expectations (explicit never probes;
probe-failed `deepEqual` unchanged; `autoModelContextLimit: false` untouched).
