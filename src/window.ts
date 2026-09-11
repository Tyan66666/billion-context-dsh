/**
 * Auto context-window detection — resolve the model's real context window
 * from the host LLM runtime instead of trusting a hardcoded config default,
 * plus the adapter's per-request output cap (the output reservation subtracted
 * from it so pressure decisions run against the SUSTAINABLE input budget, not
 * the raw window).
 *
 * `agent.ctx.llm` (the cordis `LlmRuntime` service) exposes
 * `resolveModelInfo(provider, model)` →
 * `{ context: { contextWindow }, defaultMaxTokens }` — the exact-route
 * capacity the adapter learned from the provider API (pi-ai reads
 * `context_window`/`context_length` during discovery) plus the output cap it
 * applies when callers omit one. Probing is a standalone capability query —
 * no request is sent.
 * @module billion-context-dsh/window
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

/** Fallback window when auto-detection is unavailable. Same default as acp-kernel's `defaultConfig`. */
export const DEFAULT_CONTEXT_WINDOW = 128000

/** The effective context window plus where it came from. */
export interface AcpWindow {
  /** Effective context window in tokens. */
  readonly limit: number
  /** Where the limit came from. */
  readonly source: 'explicit' | 'auto' | 'projection' | 'default'
  /**
   * Route the window was resolved for. 'auto' reports the probed route;
   * 'projection' returns also set it, from the session's LIVE route (its last
   * `request/context` event) — NOT `agent.options`, which is a stale snapshot
   * after a mid-session model switch; `agent.options` is the fallback only
   * before the session has recorded any route. (Inert today: windowSourceLabel
   * never reads these fields for the projection source.)
   */
  readonly provider?: string
  readonly model?: string
  /**
   * True only when auto-detection was ATTEMPTED and failed (the probe threw or
   * the model API disclosed no window), so the fallback limit is in use. Not
   * set for explicit config, a successful probe, or disabled auto-detection —
   * those must not look like a failure (issue #63: a misconfigured gateway
   * silently fell back to 128K and produced false emergency nudges).
   */
  readonly probeFailed?: boolean
  /**
   * The model's TOTAL context window in tokens, before the output reservation
   * was subtracted. Set only when `outputReserved` is set:
   * `limit = rawLimit - outputReserved`.
   */
  readonly rawLimit?: number
  /**
   * The adapter's per-request output cap (`defaultMaxTokens`) in tokens,
   * subtracted from `rawLimit` to yield `limit` — the output reservation the
   * provider guarantees at the end of the window on every request. Set only
   * when the host discloses it and it is smaller than the raw window.
   */
  readonly outputReserved?: number
}

/** Human label for an AcpWindow's source (used by /acp status). */
export function windowSourceLabel(window: AcpWindow): string {
  if (window.source === 'explicit') return 'configured'
  if (window.source === 'projection') {
    return `session projection current route (auto-refreshes on model switch)`
  }
  if (window.source === 'auto') {
    return `auto-detected from ${window.provider ?? '?'}/${window.model ?? '?'}`
  }
  if (window.probeFailed === true) return 'default (auto-detection failed — see /acp config)'
  return 'default (auto-detection unavailable)'
}

/** The minimal LlmRuntime surface the probe needs (structural — no as any). */
interface LlmProbe {
  resolveModelInfo?: (
    provider: string,
    model: string,
    signal?: AbortSignal,
  ) => Promise<{ context?: { contextWindow?: number }; defaultMaxTokens?: number }>
}

/** The minimal sessionProjections surface the projection source needs. */
interface ProjectionProbe {
  snapshot?: (session: unknown) => {
    values?: { contextPressure?: { contextWindow?: number } }
  }
}

/**
 * Read the live context window from the host session projection
 * (`contextPressure.contextWindow` — the newest recorded route capacity).
 * This tracks the session's CURRENT route: after a mid-session model switch
 * `agent.options.provider/model` stays a stale snapshot, so probing THAT route
 * yields the previous model's window (a 1M-window session read as ~96K →
 * false EMERGENCY nudges at 300%+ usage). The projection is refreshed by the
 * host on every request, so it follows the real model without any config.
 * Returns null when the host exposes no projection or disclosed no window.
 */
export function projectedContextWindow(agent: Agent): number | null {
  const projections = agent.ctx?.get?.('sessionProjections') as ProjectionProbe | undefined
  const window = projections?.snapshot?.(agent.session)?.values?.contextPressure?.contextWindow
  if (typeof window === 'number' && Number.isInteger(window) && window > 0) return window
  return null
}

/**
 * Read the LIVE model route from the session's last `request/context` event.
 * After a mid-session model switch `agent.options` is a stale snapshot (it
 * names the PREVIOUS route), so the per-route output cap must be resolved
 * against this live route instead — otherwise the cap lags one switch behind
 * (a 32K cap from a just-left model subtracted from the new model's window).
 * Returns null before the session has recorded any route, so callers fall
 * back to `agent.options`. Never throws, like `probeModelWindow`: the caller
 * runs inside `agent/pre-step`, which has no surrounding try.
 */
export function liveRoute(agent: Agent): { provider: string; model: string } | null {
  let rc: { provider?: unknown; model?: unknown } | null | undefined
  try {
    rc = agent.session.requestContext()
  } catch {
    return null
  }
  // `null` as well as `undefined`: the pinned host's fold is typed
  // `RequestContext | undefined`, but this function's contract is that it never
  // throws for the caller (it runs inside `agent/pre-step`, which has no
  // surrounding try), so an empty shape of either kind must degrade instead of
  // throwing on the destructure below.
  if (rc === undefined || rc === null) return null
  const { provider, model } = rc
  // All-or-nothing: a half-valid route (a live model next to a fallback
  // provider) would key the per-route cap cache on a mixed route, so both
  // halves must be non-empty strings or the caller falls back whole.
  if (typeof provider !== 'string' || provider === '') return null
  if (typeof model !== 'string' || model === '') return null
  return { provider, model }
}

/**
 * The route the per-route output cap and the compression provenance must be
 * resolved against, in ONE place: the session's live `request/context` route,
 * falling back to `agent.options` only before the session has recorded any
 * route. `windowFor` (src/index.ts), the `compress` tool (src/tools.ts) and
 * `/acp compress` (src/commands.ts) all need this exact pair; three hand-copied
 * copies is precisely how a stale-route bug gets fixed in one call site and
 * left behind in the others.
 */
export function routeFor(agent: Agent): { provider: string; model: string } {
  const live = liveRoute(agent)
  return {
    provider: live?.provider ?? agent.options.provider ?? '',
    model: live?.model ?? agent.options.model ?? '',
  }
}

/** The model window plus the adapter's per-request output cap, in one probe. */
export interface ModelWindowProbe {
  /** The model's total context window in tokens, when disclosed. */
  readonly contextWindow: number | null
  /** The adapter's per-request output cap (`defaultMaxTokens`), when disclosed. */
  readonly outputReservation: number | null
}

/**
 * Probe the model's real context window AND the adapter's per-request output
 * cap in a single `resolveModelInfo` call. The cap is the output reservation
 * the provider guarantees at the end of the window on every request —
 * pressure decisions must run against the SUSTAINABLE input budget (window
 * minus cap), not the raw window: a 96K window with a 16K cap carries at
 * most 80K of input, so the raw denominator understates usage by cap/window
 * (≈17% there — and far worse on short-window models, where the same cap is
 * a quarter or more of the window). Returns nulls — never throws — when the
 * host provides no llm service, discloses nothing, or the probe throws;
 * callers keep the raw-window behavior in those cases.
 */
export async function probeModelWindow(
  agent: Agent,
  provider: string,
  model: string,
): Promise<ModelWindowProbe> {
  const llm = agent.ctx?.get?.('llm') as LlmProbe | undefined
  if (llm?.resolveModelInfo === undefined) return { contextWindow: null, outputReservation: null }
  try {
    const info = await llm.resolveModelInfo(provider, model)
    const window = info?.context?.contextWindow
    const cap = info?.defaultMaxTokens
    return {
      contextWindow: typeof window === 'number' && Number.isInteger(window) && window > 0 ? window : null,
      outputReservation: typeof cap === 'number' && Number.isInteger(cap) && cap > 0 ? cap : null,
    }
  } catch {
    return { contextWindow: null, outputReservation: null }
  }
}

/**
 * Probe the model's real context window. Returns null when the host provides
 * no llm service, the adapter discloses no window, or the probe throws —
 * callers fall back to DEFAULT_CONTEXT_WINDOW. Never throws.
 */
export async function detectContextWindow(
  agent: Agent,
  provider: string,
  model: string,
): Promise<number | null> {
  return (await probeModelWindow(agent, provider, model)).contextWindow
}
