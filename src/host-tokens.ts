/**
 * Host-vocabulary token pricing for the durable shadow-price protocol.
 *
 * The host token-meter prices every appended message with a fixed flat-4
 * heuristic (`estimateContent` / `estimateMessage` in `dsh-token-meter`) and
 * the producer contract requires every `compaction/summary`/`compaction/prune`
 * `shadowedTokenCount` claim to be derived from the SAME estimator. Writing
 * claims with the engine's CJK-aware `defaultCountTokens` overdraws the meter
 * on CJK-heavy sessions and permanently bricks them (live session
 * `session-3aa366c3`, issue #54; AGENTS.md rule 12 — `defaultCountTokens` is
 * display currency, NEVER event currency).
 *
 * This module prices claims in the host's vocabulary: it prefers the live
 * meter's own per-node FIXED-HEURISTIC prices (`ctx.tokenMeter.measure(session)`
 * nodes' `heuristicTokens` — the same basis the projection ledger accumulates
 * appends with, so the claim is exact by construction) and falls back to an
 * exact mirror of the host's estimator when the meter is unreachable.
 *
 * Two vocabularies share the meter's node since DSH 0.1.2: `tokens` carries
 * the measured route's request pressure (image occurrences re-priced with the
 * route's declared visual tokens) while `heuristicTokens` keeps the fixed
 * flat-4 heuristic the ledger prices appends with. The claim MUST read
 * `heuristicTokens`: a routed `tokens` claim overstates the replaced range
 * against its own ledger accumulation and folds `messageTokens` negative —
 * the same session-bricking schema rejection as #54, through the image-route
 * channel (issue #103). Older hosts (0.1.0/0.1.1 lines) expose a single
 * `tokens` field that IS the fixed heuristic, so the fallback reads it.
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import { eventAtOf } from './session-events.ts'

/** Fixed text-density heuristic used by the host meter until exact tokenization. */
const CHARS_PER_TOKEN = 4
/** Per-block structural overhead for JSON framing and type tags. */
const BLOCK_OVERHEAD = 4
/** Role-field framing overhead added to every priced message. */
const ROLE_OVERHEAD = 4

/** The host's model-visible content block union (structural, mirror-side only). */
export type HostBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; name: string; arguments: string }
  | { type: 'tool-result'; toolCallId: string; content: HostContent }
  | { type?: string } & Record<string, unknown>

/** A content block list, or a bare string (`tool-result` content may be either). */
export type HostContent = readonly HostBlock[] | string

function blockType(block: unknown): string | undefined {
  if (typeof block !== 'object' || block === null) return undefined
  const type = (block as { type?: unknown }).type
  return typeof type === 'string' ? type : undefined
}

/**
 * Exact mirror of the host's `estimateContent`
 * (`@deepseek-ai/dsh-token-meter/lib/types/estimate.js`): text/reasoning
 * `ceil(len/4)+4`, tool-call `ceil(name/4)+ceil(arguments/4)+4`, tool-result
 * recursive over its content, unknown blocks `4+ceil(JSON.stringify/4)` over
 * the ORIGINAL block object. A string content is iterated as an iterable, so
 * every CHARACTER falls to the default branch (`4+ceil(JSON.stringify(char)/4)`
 * — 5 tokens for any single unescaped character).
 */
export function estimateHostContent(blocks: HostContent): number {
  if (typeof blocks === 'string') {
    let tokens = 0
    for (const char of blocks) {
      tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(char).length / CHARS_PER_TOKEN)
    }
    return tokens
  }
  let tokens = 0
  for (const block of blocks) {
    switch (blockType(block)) {
      case 'text':
      case 'reasoning': {
        tokens += Math.ceil((block as { text: string }).text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      }
      case 'tool-call': {
        const call = block as { name: string; arguments: string }
        tokens += Math.ceil(call.name.length / CHARS_PER_TOKEN)
          + Math.ceil(call.arguments.length / CHARS_PER_TOKEN)
          + BLOCK_OVERHEAD
        break
      }
      case 'tool-result': {
        tokens += estimateHostContent((block as { content: HostContent }).content) + BLOCK_OVERHEAD
        break
      }
      default:
        tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
    }
  }
  return tokens
}

/** Exact mirror of the host's `estimateMessage` (content + role framing). */
export function estimateHostMessage(message: { content: HostContent }): number {
  return estimateHostContent(message.content) + ROLE_OVERHEAD
}

/**
 * Host price of ONE session event under the mirror: project it through the
 * host's `deriveEventMessage` (null for non-surface events and empty-content
 * assistant messages) and price the derived message; null derives to 0.
 */
export function hostPriceEvent(event: SessionEvent): number {
  const message = deriveEventMessage(event)
  return message === null ? 0 : estimateHostMessage(message as { content: HostContent })
}

/** Mirror price of a set of surface seqs (the fallback claim computation). */
export function shadowedHostTokens(session: Session, seqs: readonly number[]): number {
  let total = 0
  for (const seq of seqs) {
    const event = eventAtOf(session, seq)
    if (event !== undefined) total += hostPriceEvent(event)
  }
  return total
}

/** The slice of the live meter's measurement the engine may price from. */
interface TokenMeterLike {
  measure(session: Session): {
    nodes: ReadonlyArray<{ seq: number; tokens: number; heuristicTokens?: number }>
  }
}

/**
 * Claim price for `seqs` in the host's vocabulary. Prefers the live meter's
 * own per-node FIXED-HEURISTIC prices when `ctx.tokenMeter` is reachable and
 * covers every shadowed seq (exact by construction — the ledger's
 * `foldSurfaceProjection` accumulates appends with the same fixed heuristic,
 * so the claim and the ledger stay in agreement; follows host estimator
 * changes automatically). `node.heuristicTokens` is that basis since DSH 0.1.2;
 * `node.tokens` there is the measured route's REQUEST pressure (image
 * occurrences carry the route's visual price via `priceSurface`) and MUST NOT
 * be claimed — reading it overstates the claim and folds the host projection
 * negative on image-containing ranges (issue #103, the image-route channel of
 * the #54 brick). Older meters expose a single `tokens` field that IS the
 * fixed heuristic, so `heuristicTokens ?? tokens` covers both shapes. ANY
 * failure — meter absent, `measure` throwing (e.g. a step-less log), or a seq
 * missing from the measurement — falls back to the exact mirror. Never returns
 * a `defaultCountTokens` price (rule 12).
 */
export function shadowedTokensViaMeter(
  session: Session,
  seqs: readonly number[],
  ctx?: { get?(name: string): unknown } | null,
): number {
  try {
    const meter = ctx?.get?.('tokenMeter') as TokenMeterLike | undefined
    if (meter?.measure !== undefined) {
      const bySeq = new Map(meter.measure(session).nodes.map((node) => [node.seq, node.heuristicTokens ?? node.tokens]))
      let total = 0
      let missing = false
      for (const seq of seqs) {
        const tokens = bySeq.get(seq)
        if (tokens === undefined) {
          missing = true
          break
        }
        total += tokens
      }
      if (!missing) return total
    }
  } catch {
    // Fall through to the mirror — the mirror IS the host vocabulary.
  }
  return shadowedHostTokens(session, seqs)
}
