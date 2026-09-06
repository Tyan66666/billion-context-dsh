/**
 * Local tool-pairing balance checks over the session surface.
 *
 * UPSTREAM: `@deepseek-ai/dsh-compaction@0.1.2-rc.1` reads the REMOVED
 * `session.events` API in its balance cache — `extendCache` does
 * `const events = session.events` and `eventForSeq` does `events[seq]`, so on
 * every dsh 0.1.2 host the official `toolPairingBalancedBefore/After` helpers
 * throw `TypeError: Cannot read properties of undefined (reading '<seq>')`.
 * The host's API docs require compaction backends to use these helpers for
 * edge checks, and the host's own `dsh-compaction-basic` calls them too, so
 * ALL compaction on a 0.1.2-rc.1 host crashes (reproduced offline and pinned
 * in issue #124; tracked in docs/dsh-porting-verification.md).
 *
 * This module mirrors the host's algorithm line for line (per-session cache
 * keyed by `surface.replaceGeneration`, the `cutBalanced` fold, identical
 * error messages) with ONE deliberate difference: events are read through the
 * cross-version accessor `eventAtOf` (src/session-events.ts), which works on
 * both the 0.1.0/0.1.1 lines (`events[seq]`) and 0.1.2+ (`eventAt(seq)`).
 * DELETE this module and switch `src/region.ts` back to
 * `@deepseek-ai/dsh-compaction`'s helpers the moment the host fix ships.
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { eventAtOf } from './session-events.ts'

interface BalanceCache {
  /** The surface generation this cache was folded against. */
  generation: number | undefined
  /** `cutBalanced[i]` — whether the cut just before surface position `i` is balanced. */
  cutBalanced: boolean[]
  /** surface seq → its position in `cutBalanced`. */
  indexBySeq: Map<number, number>
  /** Tool calls opened but not yet answered while folding. */
  inProgressToolCalls: number
}

const balanceCacheBySession = new WeakMap<object, BalanceCache>()

/** How one surface event changes the in-progress tool-call count. */
function eventDelta(event: SessionEvent): number {
  if (event.type === 'tool/result') return -1
  if (event.type === 'assistant/message') {
    const content = (event.data as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) return 0
    let calls = 0
    for (const block of content) {
      if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'tool-call') calls += 1
    }
    return calls
  }
  return 0
}

/** Read and validate the event named by a surface sequence. */
function eventForSeq(session: Session, seq: number): SessionEvent {
  const event = eventAtOf(session, seq)
  if (event === undefined || event.seq !== seq) {
    throw new Error(`tool-pairing balance: surface seq ${seq} has no matching session event (corrupt surface)`)
  }
  return event
}

/** Fold surface sequences not yet in the cache into its balance state. */
function extendCache(session: Session, cache: BalanceCache, seqs: readonly number[]): BalanceCache {
  const processed = cache.cutBalanced.length - 1
  const tail = seqs.slice(processed)
  const pendingCuts: boolean[] = []
  let inProgressToolCalls = cache.inProgressToolCalls
  for (const seq of tail) {
    inProgressToolCalls += eventDelta(eventForSeq(session, seq))
    if (inProgressToolCalls < 0) {
      throw new Error(`tool-pairing balance: tool/result at surface seq ${seq} has no matching tool-call (corrupt surface)`)
    }
    pendingCuts.push(inProgressToolCalls === 0)
  }
  tail.forEach((seq, offset) => cache.indexBySeq.set(seq, processed + offset))
  cache.cutBalanced = cache.cutBalanced.concat(pendingCuts)
  cache.inProgressToolCalls = inProgressToolCalls
  return cache
}

/** Return balance state synchronized with the current session surface. */
function balanceCache(session: Session): BalanceCache {
  const seqs = session.surface.nodes
  const generation = (session.surface as { replaceGeneration?: number | undefined }).replaceGeneration
  const cached = balanceCacheBySession.get(session)
  if (cached === undefined || cached.generation !== generation || cached.cutBalanced.length - 1 > seqs.length) {
    const rebuilt = extendCache(session, {
      generation,
      cutBalanced: [true],
      indexBySeq: new Map(),
      inProgressToolCalls: 0,
    }, seqs)
    balanceCacheBySession.set(session, rebuilt)
    return rebuilt
  }
  if (cached.cutBalanced.length - 1 < seqs.length) return extendCache(session, cached, seqs)
  return cached
}

/** Balance of the cut at a sequence's position plus offset, rejecting seqs outside current membership. */
function cutBalance(cache: BalanceCache, seq: number, offset: number): boolean {
  const index = cache.indexBySeq.get(seq)
  const balanced = index === undefined ? undefined : cache.cutBalanced[index + offset]
  if (balanced === undefined) throw new Error(`tool-pairing balance: surface seq ${seq} not found`)
  return balanced
}

/**
 * Whether the cut immediately before a current surface sequence is tool-pairing balanced.
 * @param session - session whose surface is checked.
 * @param seq - event sequence whose leading cut is checked.
 * @returns true when no unanswered tool call crosses the cut.
 */
export function toolPairingBalancedBefore(session: Session, seq: number): boolean {
  return cutBalance(balanceCache(session), seq, 0)
}

/**
 * Whether the cut immediately after a current surface sequence is tool-pairing balanced.
 * @param session - session whose surface is checked.
 * @param seq - event sequence whose trailing cut is checked.
 * @returns true when no unanswered tool call crosses the cut.
 */
export function toolPairingBalancedAfter(session: Session, seq: number): boolean {
  return cutBalance(balanceCache(session), seq, 1)
}
