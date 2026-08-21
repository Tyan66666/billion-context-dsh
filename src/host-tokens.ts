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
 * meter's own per-node prices (`ctx.tokenMeter.measure(session).nodes` —
 * exact by construction, follows host estimator changes automatically, the
 * same path the host's own `compaction-basic` uses) and falls back to an
 * exact mirror of the host's estimator when the meter is unreachable.
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'

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
    const event = session.events[seq]
    if (event !== undefined) total += hostPriceEvent(event)
  }
  return total
}

/** The slice of the live meter's measurement the engine may price from. */
interface TokenMeterLike {
  measure(session: Session): { nodes: ReadonlyArray<{ seq: number; tokens: number }> }
}

/**
 * Claim price for `seqs` in the host's vocabulary. Prefers the live meter's
 * own per-node prices when `ctx.tokenMeter` is reachable and covers every
 * shadowed seq (exact by construction, follows host estimator changes); ANY
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
      const bySeq = new Map(meter.measure(session).nodes.map((node) => [node.seq, node.tokens]))
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
