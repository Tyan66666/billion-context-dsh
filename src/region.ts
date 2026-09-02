/**
 * M5 — durable region transaction and the log-rebuilt block ledger.
 *
 * Modeled on `dsh-compaction-basic/src/region.ts` (which is package-internal
 * and not exported by the seam): validate the surface range and tool-call/result
 * pairing, take the durable `compaction/start` lock, record `compaction/summary`
 * as the shadow price, land the `user/message` surface replacement carrying the
 * summary under `compactCheckpointSource`, and release the lock with
 * `compaction/end`. The original events stay in the append-only log, so
 * decompress/search/status can rebuild everything from the log.
 * @module billion-context-dsh/region
 */

import { randomUUID } from 'node:crypto'
import type { Session, SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import {
  CompactionId,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import { createAssistantMessage, createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { defaultCountTokens } from 'acp-kernel'
import { extractEventText, extractText, toolCallIdOfResultEvent } from './messages.ts'
import { hostPriceEvent } from './host-tokens.ts'
import { eventAtOf, sessionEventsOf } from './session-events.ts'

/** One durable ACP block as rebuilt from the session log. */
export interface AcpBlockLedgerEntry {
  /** The compaction transaction id (stable block identity). */
  readonly blockId: string
  readonly summary: string
  /** The block's short label (kernel `CompressionBlock.topic`), when the compress request carried one. */
  readonly topic?: string
  readonly shadowedSeqs: readonly number[]
  readonly shadowedTokenCount: number
  readonly start: number
  readonly end: number
  /** Compression tier: 1 (message range), 2 (distills tier-1 blocks), 3 (distills tier-2 blocks). Legacy blocks default to 1. */
  readonly tier: 1 | 2 | 3
  /** Compaction ids of the blocks this block distilled (parents). Empty for tier-1 blocks. */
  readonly parentBlockIds: readonly string[]
  /** The acp-kernel block id (`bN`) created for this transaction — absent for legacy blocks (synthesised by order). */
  readonly kernelBlockId?: string
  /** The surface seq of this block's checkpoint summary node (derived from the log; null when the node is gone). */
  readonly summarySeq?: number
  /** The kernel block's raw direct/effective message ids at creation (recorded since the tier feature; absent for legacy). */
  readonly directMessageIds?: readonly string[]
  readonly effectiveMessageIds?: readonly string[]
  /** Unix epoch ms of the compaction/summary event. */
  readonly createdAt: number
}

/** The open turn number, or null when the log ends between turns. */
export function findOpenTurn(events: readonly SessionEvent[]): number | null {
  let open: number | null = null
  for (const event of events) {
    if (event.type === 'turn/start') open = event.data.turn
    else if (event.type === 'turn/end' && event.data.turn === open) open = null
  }
  return open
}

/** Reject a second concurrent compaction for the same session. */
export function assertNoActiveCompaction(events: readonly SessionEvent[]): void {
  let active = false
  for (const event of events) {
    if (event.type === 'compaction/start') active = true
    else if (event.type === 'compaction/end') active = false
  }
  if (active) {
    throw new Error('billion-context-dsh: another compaction is already active for this session')
  }
}

/**
 * Whether the surface node at `seq` projects to CoreMessage(s) whose ref key
 * is the bare seq — user messages, tool results, and text-only or SINGLE
 * tool-call assistant messages all do. Multi-tool-call assistant messages
 * project to `${seq}#${callId}` ids (projectEvent) and therefore carry NO
 * bare-`${seq}` ref, so compress's byRaw lookup can never resolve them as
 * range edges. resolveSurfaceRange treats such edges as unbalanced and shifts
 * them to the nearest clean cut.
 */
function hasPlainRef(session: Session, seq: number): boolean {
  const event = eventAtOf(session, seq)
  if (event === undefined) return false
  switch (event.type) {
    case 'user/message':
    case 'tool/result':
      return extractEventText(event).trim().length > 0
    case 'assistant/message': {
      const content = (event.data as { message?: { content?: unknown } }).message?.content
      const calls = Array.isArray(content)
        ? content.filter(
            (block) => block !== null && typeof block === 'object' && (block as { type?: string }).type === 'tool-call',
          )
        : []
      if (calls.length > 1) return false
      // One tool-call: projectEvent emits a bare-seq CoreMessage unconditionally.
      // Zero: only when the text is non-empty.
      return calls.length === 1 || extractEventText(event).trim().length > 0
    }
    default:
      return false
  }
}

/**
 * A requested range whose EVERY live message was already shadowed by one or
 * more blocks. The compress tool catches this and reports the range as already
 * compressed (with the covering block ids) instead of folding block summary
 * nodes as plain messages or erroring out. Distillation stays an explicit act:
 * target a LIVE checkpoint seq directly to distill (tier 2/3).
 */
export class AlreadyCompressedRangeError extends Error {
  constructor(
    readonly start: number,
    readonly end: number,
    readonly coveringBlockIds: readonly string[],
  ) {
    super(
      `billion-context-dsh: seq ${start}..${end} already compressed — `
      + 'no live content remains in that span',
    )
    this.name = 'AlreadyCompressedRangeError'
  }
}

type StaleRangeRecovery =
  | { kind: 'ok'; start: number; end: number }
  | { kind: 'already-compressed'; coveringBlockIds: string[] }
  | { kind: 'unresolvable'; failedEdge: number }

/**
 * Rebuild a requested range whose edges are no longer on the current surface.
 * The dominant cause is staleness: the seqs came from an older nudge table or
 * a previous compress result, and an earlier compression SHADOWED them (they
 * stay in the append-only log, but are gone from the surface). The recovery:
 *
 *  1. An edge that does not exist in the log at all (invented, or from another
 *     session) is unresolvable — there is no way to guess what it meant.
 *  2. The still-LIVE surface nodes inside the requested span, in VALUE order
 *     (the surface can be locally non-monotonic after replacements, so value
 *     order is the only coherent span). If there are none, the whole span was
 *     already compressed → 'already-compressed' with the covering block ids.
 *  3. Otherwise the range snaps to the first..last live PLAIN node in the
 *     span. Block checkpoint nodes are deliberately excluded: distilling a
 *     block on a STALE reference would silently change block structure the
 *     model never intended to touch — distillation requires targeting a live
 *     checkpoint seq directly.
 */
function recoverStaleRange(session: Session, start: number, end: number): StaleRangeRecovery {
  if (eventAtOf(session, start) === undefined || eventAtOf(session, end) === undefined) {
    const failedEdge = eventAtOf(session, start) === undefined ? start : end
    return { kind: 'unresolvable', failedEdge }
  }
  const liveInside = session.surface.nodes
    .filter((seq) => seq >= start && seq <= end)
    .sort((a, b) => a - b)
  const plain = liveInside.filter((seq) => !isCheckpointNode(eventAtOf(session, seq)!))
  if (plain.length === 0) {
    const coveringBlockIds = rebuildBlockLedger(sessionEventsOf(session))
      .filter((entry) => entry.shadowedSeqs.some((seq) => seq >= start && seq <= end))
      .map((entry) => entry.blockId)
    return { kind: 'already-compressed', coveringBlockIds }
  }
  return { kind: 'ok', start: plain[0]!, end: plain[plain.length - 1]! }
}

export interface ResolvedSurfaceRange {
  readonly start: number
  readonly end: number
  /**
   * True when the requested edges were not on the current surface and were
   * remapped to the still-live content of the requested span (an earlier
   * compression shadowed them). Callers surface this so the model sees what
   * was actually compressed instead of silently shadowing a different span.
   */
  readonly recovered?: boolean
}

/**
 * Validate one inclusive surface span and adjust its edges to a
 * tool-pairing-balanced range whose boundaries carry a bare-seq ref. Reversed
 * ranges throw. An edge that sits inside a tool-call/result pair — or on a
 * multi-tool-call assistant message that has no bare-seq ref — is first nudged
 * inward to the nearest clean cut; if that collapses the range (e.g. the model
 * asked for a SINGLE tool result, which can never be balanced alone), the
 * range EXPANDS outward to the enclosing clean pair instead — a lone tool
 * message is almost always a "consumed output" the model genuinely wants to
 * compress. The returned range is what a caller should actually shadow.
 *
 * Missing edges are NOT an immediate error: the seqs were probably shadowed by
 * an earlier compression (stale nudge table / old compress result). The span
 * is rebuilt from its still-live remainder via recoverStaleRange — a fully
 * shadowed span throws AlreadyCompressedRangeError, a genuinely unknown edge
 * throws the not-in-surface guidance error. The returned range is what a
 * caller should actually shadow.
 */
export function resolveSurfaceRange(
  session: Session,
  start: number,
  end: number,
): ResolvedSurfaceRange {
  const nodes = session.surface.nodes
  if (start > end) {
    throw new Error(`billion-context-dsh: reversed range ${start}..${end}`)
  }
  let requestedStartIdx = nodes.indexOf(start)
  let requestedEndIdx = nodes.indexOf(end)
  let recovered = false
  if (requestedStartIdx < 0 || requestedEndIdx < 0) {
    const stale = recoverStaleRange(session, start, end)
    if (stale.kind === 'unresolvable') {
      throw new Error(
        `billion-context-dsh: seq ${start}..${end} not in the current surface — `
        + `edge seq ${stale.failedEdge} is not in this session's log. `
        + 'Surface seqs are sparse message nodes (only user/message, assistant/message, '
        + 'tool/result events); consult acp_status for the current surface range',
      )
    }
    if (stale.kind === 'already-compressed') {
      throw new AlreadyCompressedRangeError(start, end, stale.coveringBlockIds)
    }
    start = stale.start
    end = stale.end
    recovered = true
    requestedStartIdx = nodes.indexOf(start)
    requestedEndIdx = nodes.indexOf(end)
    if (requestedStartIdx < 0 || requestedEndIdx < 0) {
      // Unreachable in practice (recovery returns live nodes), but never let
      // a negative index reach the balancing passes.
      throw new Error(
        `billion-context-dsh: seq ${start}..${end} not in the current surface — `
        + 'consult acp_status for the current surface range',
      )
    }
  }
  if (requestedStartIdx > requestedEndIdx) {
    throw new Error(`billion-context-dsh: reversed range ${start}..${end}`)
  }
  // Belt-and-braces: the surface can be locally out of order after surface
  // replacements, so index order alone does not guarantee value order.
  if (start > end) {
    throw new Error(`billion-context-dsh: reversed range ${start}..${end}`)
  }
  // A boundary must be BOTH tool-pairing-balanced AND carry a bare-seq ref.
  const cleanBefore = (index: number): boolean =>
    toolPairingBalancedBefore(session, nodes[index]!) && hasPlainRef(session, nodes[index]!)
  const cleanAfter = (index: number): boolean =>
    toolPairingBalancedAfter(session, nodes[index]!) && hasPlainRef(session, nodes[index]!)
  let startIdx = requestedStartIdx
  let endIdx = requestedEndIdx
  // First pass: nudge inward to the nearest clean cuts.
  while (startIdx <= endIdx && !cleanBefore(startIdx)) {
    startIdx += 1
  }
  while (endIdx >= startIdx && !cleanAfter(endIdx)) {
    endIdx -= 1
  }
  if (startIdx <= endIdx && nodes[startIdx]! <= nodes[endIdx]!) {
    return recovered
      ? { start: nodes[startIdx]!, end: nodes[endIdx]!, recovered: true }
      : { start: nodes[startIdx]!, end: nodes[endIdx]! }
  }
  // A recovered span NEVER expands across block checkpoints: the model's
  // requested edges were stale, so growing the span into block territory could
  // fold content it never intended to touch. If the live remainder cannot be
  // balanced by shrinking alone, give up with guidance instead.
  if (recovered) {
    throw new Error(
      `billion-context-dsh: no tool-pairing-balanced live remainder around seq ${start}..${end} — `
      + 'narrow the range or consult acp_status for the current surface',
    )
  }
  // Second pass: the inward pass collapsed (a lone tool message) — expand
  // outward from the REQUESTED span to the smallest clean enclosing pair.
  startIdx = requestedStartIdx
  endIdx = requestedEndIdx
  while (startIdx > 0 && !cleanBefore(startIdx)) {
    startIdx -= 1
  }
  while (endIdx < nodes.length - 1 && !cleanAfter(endIdx)) {
    endIdx += 1
  }
  // Value order guard: the surface is locally non-monotonic after replacements
  // (a checkpoint seq inserted ahead of older residual nodes), so index order
  // alone is not enough — never return a span whose end seq is numerically
  // BEFORE its start seq. The caller (nudge / compress) skips such a span.
  if (cleanBefore(startIdx) && cleanAfter(endIdx) && nodes[startIdx]! <= nodes[endIdx]!) {
    return { start: nodes[startIdx]!, end: nodes[endIdx]! }
  }
  throw new Error(
    `billion-context-dsh: no tool-pairing-balanced range around seq ${start}..${end} — `
    + 'narrow the range or consult acp_status for the current surface',
  )
}

/** The surface seqs shadowed by the inclusive positional span. */
export function shadowedSeqsOf(session: Session, start: number, end: number): number[] {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(start)
  const endIdx = nodes.indexOf(end)
  return nodes.slice(startIdx, endIdx + 1)
}

export interface CompactionTransactionInput {
  readonly start: number
  readonly end: number
  readonly shadowedSeqs: readonly number[]
  readonly summary: ContentBlock[]
  readonly shadowedTokenCount: number
  readonly provider: string
  readonly model: string
  /** Short block label (kernel `CompressionBlock.topic`) — persisted so a restarted engine rehydrates it. */
  readonly topic?: string
  /** Compression tier of this block (default 1). */
  readonly tier?: 1 | 2 | 3
  /** The acp-kernel block id (`bN`) created by the kernel for this transaction. */
  readonly kernelBlockId?: string
  /** Compaction ids of the blocks distilled into this one. */
  readonly parentBlockIds?: readonly string[]
  /** The kernel block's direct/effective message ids (raw CoreMessage ids) — recorded for faithful rehydration. */
  readonly directMessageIds?: readonly string[]
  readonly effectiveMessageIds?: readonly string[]
}

/**
 * ACP tier extension fields carried on `compaction/summary` events. The
 * upstream dsh-compaction event type does not know them, so reads and writes
 * go through this precise intersection (never `any`).
 */
export interface AcpCompactionSummaryFields {
  /** Compression tier (1/2/3) — 1 = message range, 2 = distills tier-1, 3 = distills tier-2. */
  readonly tier?: 1 | 2 | 3
  /** Short block label (kernel `CompressionBlock.topic`) — the acp_status block title. */
  readonly topic?: string
  /** The acp-kernel block id (`bN`) created for this transaction. */
  readonly kernelBlockId?: string
  /** Durable compaction ids of the blocks distilled into this one. */
  readonly parentBlockIds?: readonly string[]
  /**
   * The kernel block's direct message ids (raw CoreMessage ids) at creation —
   * recorded so a restarted engine rehydrates the SAME coverage (a tier-2
   * block's coverage is its parents' originals, not the checkpoint node).
   */
  readonly directMessageIds?: readonly string[]
  /** The kernel block's effective message ids (raw CoreMessage ids) at creation. */
  readonly effectiveMessageIds?: readonly string[]
}

type CompactionSummaryData = SessionEventMap['compaction/summary']

/** Read a `compaction/summary` event's data including the ACP tier extension fields. */
export function readCompactionSummary(event: SessionEvent): CompactionSummaryData & AcpCompactionSummaryFields {
  return event.data as CompactionSummaryData & AcpCompactionSummaryFields
}

/**
 * Run one durable compression transaction. Throws on invalid state; on success
 * the four events are in the log and the surface has one summary node.
 */
export function runCompactionTransaction(
  session: Session,
  input: CompactionTransactionInput,
): { compactionId: string; seqs: number[] } {
  assertNoActiveCompaction(sessionEventsOf(session))
  const turn = findOpenTurn(sessionEventsOf(session))
  const compactionId = CompactionId(randomUUID())
  const seqs: number[] = []

  seqs.push(session.append('compaction/start', { compactionId, turn }).seq)
  seqs.push(session.append('compaction/summary', {
    compactionId,
    summary: input.summary,
    shadowedRange: { start: input.start, end: input.end },
    shadowedSeqs: [...input.shadowedSeqs],
    shadowedTokenCount: input.shadowedTokenCount,
    provider: input.provider,
    model: input.model,
    tier: input.tier ?? 1,
    ...(input.kernelBlockId === undefined ? {} : { kernelBlockId: input.kernelBlockId }),
    ...(input.topic === undefined ? {} : { topic: input.topic }),
    ...(input.parentBlockIds === undefined || input.parentBlockIds.length === 0
      ? {}
      : { parentBlockIds: [...input.parentBlockIds] }),
    ...(input.directMessageIds === undefined ? {} : { directMessageIds: [...input.directMessageIds] }),
    ...(input.effectiveMessageIds === undefined ? {} : { effectiveMessageIds: [...input.effectiveMessageIds] }),
  } as CompactionSummaryData & AcpCompactionSummaryFields).seq)

  const message = createUserMessage({
    content: input.summary,
    source: compactCheckpointSource(compactionId),
  })
  seqs.push(session.append('user/message', message, {
    surfaceOp: { op: 'replace', start: input.start, end: input.end },
    sourceEventSeqs: [...input.shadowedSeqs],
  }).seq)

  seqs.push(session.append('compaction/end', { compactionId, turn }).seq)
  return { compactionId, seqs }
}

/** The seq of a compaction's checkpoint summary node in the log (visible or shadowed). */
function summarySeqOfCompaction(events: readonly SessionEvent[], compactionId: string): number | null {
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const source = (event.data as { source?: { plugin?: string; compactionId?: string } }).source
    if (source?.plugin === 'compact' && source.compactionId === compactionId) return event.seq
  }
  return null
}

/** Rebuild the block ledger from the durable log (no kernel state needed). */
export function rebuildBlockLedger(events: readonly SessionEvent[]): AcpBlockLedgerEntry[] {
  const ledger: AcpBlockLedgerEntry[] = []
  for (const event of events) {
    if (event.type !== 'compaction/summary') continue
    const data = readCompactionSummary(event)
    // Blocks written before the token-accounting fix carry shadowedTokenCount
    // 0; backfill from the shadowed originals still in the log so acp_status
    // reports real reclaimed tokens.
    let shadowedTokenCount = data.shadowedTokenCount
    if (shadowedTokenCount === 0) {
      shadowedTokenCount = 0
      for (const seq of data.shadowedSeqs) {
        const original = events[seq]
        if (original !== undefined) shadowedTokenCount += defaultCountTokens(extractEventText(original))
      }
    }
    const tier = data.tier === 2 || data.tier === 3 ? data.tier : 1
    const parentBlockIds: string[] = Array.isArray(data.parentBlockIds) ? [...data.parentBlockIds] : []
    const directMessageIds: string[] | undefined = Array.isArray(data.directMessageIds) ? [...data.directMessageIds] : undefined
    const effectiveMessageIds: string[] | undefined = Array.isArray(data.effectiveMessageIds) ? [...data.effectiveMessageIds] : undefined
    const summarySeq = summarySeqOfCompaction(events, data.compactionId)
    ledger.push({
      blockId: data.compactionId,
      summary: extractText(data.summary),
      ...(typeof data.topic === 'string' ? { topic: data.topic } : {}),
      shadowedSeqs: [...data.shadowedSeqs],
      shadowedTokenCount,
      start: data.shadowedRange.start,
      end: data.shadowedRange.end,
      tier,
      parentBlockIds,
      ...(typeof data.kernelBlockId === 'string' ? { kernelBlockId: data.kernelBlockId } : {}),
      ...(summarySeq === null ? {} : { summarySeq }),
      ...(directMessageIds === undefined ? {} : { directMessageIds }),
      ...(effectiveMessageIds === undefined ? {} : { effectiveMessageIds }),
      createdAt: event.time,
    })
  }
  return ledger
}

/** One self-computed compressible span of the current surface. */
export interface SeqCompressibleRange {
  readonly start: number
  readonly end: number
  readonly count: number
  readonly tokens: number
  /** Share of messages that are tool messages (tool-call or tool-result), 0-100 — kernel `toolPct` parity. */
  readonly toolPct: number
}

/** Whether a surface message event is a tool message (tool-call or tool-result) — kernel `isToolMessage` parity. */
function isToolEvent(event: SessionEvent): boolean {
  if (event.type === 'tool/result') return true
  if (event.type !== 'assistant/message') return false
  const content = (event.data as { message?: { content?: unknown } }).message?.content
  return Array.isArray(content) && content.some((block) => (block as { type?: unknown })?.type === 'tool-call')
}

/** Whether a surface user message is a compaction checkpoint node (already compressed). */
function isCheckpointNode(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  const source = (event.data as { source?: { plugin?: string } }).source
  return source?.plugin === 'compact'
}

/** Tool-call ids carried by one assistant surface message. */
function toolCallIdsOfEvent(event: SessionEvent): string[] {
  if (event.type !== 'assistant/message') return []
  const content = (event.data as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return []
  const ids: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as { type?: unknown; id?: unknown }
    if (b.type === 'tool-call' && typeof b.id === 'string') ids.push(b.id)
  }
  return ids
}

/**
 * Provider/model to stamp on a synthetic empty assistant pruning node.
 */
function assistantProviderModel(event: SessionEvent): { provider: string; model: string } {
  if (event.type === 'assistant/message') {
    const message = (event.data as { message?: { source?: { provider?: unknown; model?: unknown } } }).message
    return {
      provider: typeof message?.source?.provider === 'string' ? message.source.provider : 'billion-context-dsh',
      model: typeof message?.source?.model === 'string' ? message.source.model : 'surface-prune',
    }
  }
  return { provider: 'billion-context-dsh', model: 'surface-prune' }
}

/**
 * Durable model-free prune: append `compaction/prune` as the shadow price, then
 * replace the given surface seqs with either a user message carrying `text`
 * (used for compress call/result hiding, so the model still sees the tool
 * outcome) or an EMPTY assistant message (used for orphan cleanup, which DSH
 * derives to nothing). The originals remain in the append-only log.
 */
function hideSurfaceSeqs(
  session: Session,
  seqs: readonly number[],
  provider: string,
  model: string,
  text?: string,
  priceEvent: (event: SessionEvent) => number = hostPriceEvent,
): void {
  if (seqs.length === 0) return
  const start = seqs[0]!
  const end = seqs[seqs.length - 1]!
  let shadowedTokenCount = 0
  for (const seq of seqs) {
    const event = eventAtOf(session, seq)
    // The prune claim MUST speak the host's token vocabulary (rule 12): the
    // default `hostPriceEvent` is the exact mirror of the host estimator.
    // NEVER defaultCountTokens — that overdraws the meter on CJK (#54).
    if (event !== undefined) shadowedTokenCount += priceEvent(event)
  }
  session.append('compaction/prune', {
    shadowedRange: { start, end },
    shadowedSeqs: [...seqs],
    shadowedTokenCount,
  })
  if (text !== undefined) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'billion-context-dsh' },
    }), {
      surfaceOp: { op: 'replace', start, end },
      sourceEventSeqs: [...seqs],
    })
    return
  }
  session.append('assistant/message', {
    turn: findOpenTurn(sessionEventsOf(session)) ?? 0,
    step: 0,
    message: createAssistantMessage({ content: [], source: { provider, model } }),
  }, {
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: [...seqs],
  })
}

/**
 * Hide one successful `compress` tool's call/result pair after its tool/result
 * has been logged. The durable compaction summary is inserted BEFORE the
 * current tool result (the compress tool runs mid-turn), so leaving the pair on
 * the surface would produce `assistant(tool_calls) → user(summary) →
 * tool(result)` — rejected by strict providers. Replacing both nodes with a
 * plain user message (the result text) removes the pair from the derived
 * surface without touching the compaction block.
 */
export function hideCompressToolPair(session: Session, callId: string, resultSeq?: number): boolean {
  let callSeq: number | null = null
  const events = sessionEventsOf(session)
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    if (toolCallIdsOfEvent(event).includes(callId)) {
      callSeq = event.seq
      break
    }
  }
  if (callSeq === null) return false
  // Only hide a node that carries EXACTLY the compress call. Hiding a
  // multi-call node replaces the whole assistant message, which would orphan
  // the sibling calls' results (their call ids vanish with the node).
  const callNodeIds = toolCallIdsOfEvent(events[callSeq]!)
  if (callNodeIds.length !== 1 || callNodeIds[0] !== callId) return false
  let resolvedResultSeq = resultSeq ?? null
  if (resolvedResultSeq === null) {
    for (const event of events) {
      if (event.type === 'tool/result' && toolCallIdOfResultEvent(event) === callId) {
        resolvedResultSeq = event.seq
        break
      }
    }
  }
  if (resolvedResultSeq === null) return false
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(callSeq)
  const endIdx = nodes.indexOf(resolvedResultSeq)
  // Only hide an actually adjacent pair; never shadow unrelated messages that
  // happen to sit between a stale call and result.
  if (startIdx < 0 || endIdx < 0 || endIdx - startIdx !== 1) return false
  const { provider, model } = assistantProviderModel(events[callSeq]!)
  const resultEvent = events[resolvedResultSeq]
  const resultText = resultEvent === undefined ? '' : extractEventText(resultEvent)
  hideSurfaceSeqs(session, [callSeq, resolvedResultSeq], provider, model, resultText.trim().length > 0 ? resultText : undefined)
  return true
}

/**
 * Surface-level orphan cleanup: hide tool/result nodes with no matching call,
 * assistant tool-call nodes whose calls all lack results, and "broken pairs"
 * whose result is NOT adjacent to the call node on the surface (a
 * non-tool/result node — typically the compaction summary a buggy older
 * version inserted between a compress call and its result — sits between
 * them). A single orphan result corrupts the whole tool-pairing balance cache
 * (every range resolve throws), orphan calls fragment large ranges into tiny
 * uncompressed fragments, and a broken pair cannot serialize for strict
 * providers — the mechanisms behind issue #18's "only ~28 tokens visible".
 * Uses the same durable prune protocol as `hideSurfaceSeqs`, so the removed
 * nodes stay recoverable from the append-only log.
 */
export function stripOrphanedSurfaceToolMessages(
  session: Session,
  inFlightCallIds: ReadonlySet<string> = new Set(),
): number {
  const nodes = session.surface.nodes
  const callIdsBySeq = new Map<number, string[]>()
  // callId -> surface position of the assistant node carrying it, for calls
  // whose result has not been decided yet.
  const open = new Map<string, { seq: number; index: number }>()
  const orphanResultSeqs: number[] = []
  // result seq -> call node seq, for pairs whose result landed but is not
  // adjacent to the call node on the surface.
  const brokenResults = new Map<number, number>()
  for (let index = 0; index < nodes.length; index += 1) {
    const seq = nodes[index]!
    const event = eventAtOf(session, seq)
    if (event === undefined) continue
    if (event.type === 'assistant/message') {
      const ids = toolCallIdsOfEvent(event)
      if (ids.length === 0) continue
      callIdsBySeq.set(seq, ids)
      for (const id of ids) {
        if (!open.has(id)) open.set(id, { seq, index })
      }
    } else if (event.type === 'tool/result') {
      const id = toolCallIdOfResultEvent(event)
      if (id === null) continue
      const call = open.get(id)
      if (call === undefined) {
        orphanResultSeqs.push(seq)
        continue
      }
      // A pair is healthy only when every node between the call and this
      // result is a tool/result of the SAME call node (multi-call messages).
      // Any other node in between makes the pair unserializable for strict
      // providers: prune both ends.
      const callNodeIds = callIdsBySeq.get(call.seq)
      let adjacent = false
      if (callNodeIds !== undefined) {
        adjacent = true
        for (let mid = call.index + 1; mid < index; mid += 1) {
          const midEvent = eventAtOf(session, nodes[mid]!)
          if (midEvent === undefined || midEvent.type !== 'tool/result') {
            adjacent = false
            break
          }
          const midId = toolCallIdOfResultEvent(midEvent)
          if (midId === null || !callNodeIds.includes(midId)) {
            adjacent = false
            break
          }
        }
      }
      open.delete(id)
      if (!adjacent) brokenResults.set(seq, call.seq)
    }
  }
  // call node seq -> ids of that node whose result is broken (non-adjacent).
  const brokenIdsByCallSeq = new Map<number, string[]>()
  for (const [resultSeq, callSeq] of brokenResults) {
    const id = toolCallIdOfResultEvent(eventAtOf(session, resultSeq)!)
    if (id !== null) {
      const list = brokenIdsByCallSeq.get(callSeq) ?? []
      list.push(id)
      brokenIdsByCallSeq.set(callSeq, list)
    }
  }
  const hiddenSet = new Set<number>(orphanResultSeqs)
  for (const resultSeq of brokenResults.keys()) hiddenSet.add(resultSeq)
  for (const [callSeq, ids] of callIdsBySeq) {
    const brokenIds = brokenIdsByCallSeq.get(callSeq)
    // Only hide an assistant node when NONE of its calls are usable: every id
    // must lack a result (open) or have a broken result. A mixed node (some
    // healthy results) must stay so its valid results are not orphaned by
    // hiding the call — and a node carrying an in-flight call can never be
    // pruned, or the pending result lands orphaned.
    const allUnpaired = !ids.some((candidate) => inFlightCallIds.has(candidate))
      && ids.every((candidate) => open.has(candidate) || brokenIds?.includes(candidate) === true)
    if (allUnpaired) hiddenSet.add(callSeq)
  }
  const hidden = [...hiddenSet].sort((a, b) => a - b)
  let count = 0
  for (const seq of hidden) {
    const event = eventAtOf(session, seq)
    if (event === undefined) continue
    const { provider, model } = assistantProviderModel(event)
    hideSurfaceSeqs(session, [seq], provider, model)
    count += 1
  }
  return count
}

/**
 * All tool-call ids currently visible on the surface with no matching
 * tool/result yet — the in-flight calls of the current step. Sibling tools
 * called in the same assistant message as `compress` are in-flight too, so
 * `handleCompress` must protect the whole set (not just its own call id) or
 * the sibling call would be pruned as an orphan and its result would land
 * orphaned (HTTP 400 until the next cleanup).
 */
export function openToolCallIds(session: Session): Set<string> {
  const open = new Set<string>()
  for (const seq of session.surface.nodes) {
    const event = eventAtOf(session, seq)
    if (event === undefined) continue
    if (event.type === 'assistant/message') {
      for (const id of toolCallIdsOfEvent(event)) open.add(id)
    } else if (event.type === 'tool/result') {
      const id = toolCallIdOfResultEvent(event)
      if (id !== null) open.delete(id)
    }
  }
  return open
}

/**
 * Schedule `hideCompressToolPair` on the microtask queue. `session.append`
 * is NOT reentrant: running it synchronously inside a `session/event`
 * listener (while the outer append is still publishing) throws "session
 * append cannot reenter while another append is being published" on live,
 * store-attached sessions, and the dispatcher silently swallows the error —
 * so a synchronous hide is a silent no-op in production. A microtask drains
 * after the current append fully publishes and before the agent loop resumes,
 * so the pair is hidden before the next request is built.
 */
export function deferCompressPairHide(
  session: Session,
  callId: string,
  resultSeq: number,
  onError?: (error: unknown) => void,
): void {
  queueMicrotask(() => {
    try {
      hideCompressToolPair(session, callId, resultSeq)
    } catch (error) {
      onError?.(error)
    }
  })
}

/**
 * Compute compressible spans directly from the surface — independent of the
 * kernel's ref map, which can drift after surface replacements in long
 * sessions and hide large tool results from the nudge range table. Skips the
 * recent protected tail, the last user message, and compaction checkpoints;
 * edges are then balanced through resolveSurfaceRange. Ranges are ordered
 * oldest-first (stable across turns — matches the kernel's `oldest first`).
 * UPSTREAM: this self-computation is a labeled workaround for kernel
 * ref-map drift after surface replacements (AGENTS.md rule 11) — drop it and
 * use kernel compressibleRanges once the drift is fixed upstream.
 */
export function buildCompressibleSeqRanges(
  session: Session,
  opts: { preserveRecent?: number } = {},
): SeqCompressibleRange[] {
  // Orphan tool messages corrupt the pairing balance cache and fragment every
  // large span. Prune them before scanning so the range table reflects the
  // actually compressible surface (issue #18).
  stripOrphanedSurfaceToolMessages(session)
  const nodes = session.surface.nodes
  const preserve = opts.preserveRecent ?? 5
  const protectedSeqs = new Set<number>()
  // `nodes.slice(-preserve)` would protect EVERYTHING when preserve is 0
  // (`slice(-0) === slice(0)`) — guard so 0 means "no recent protection".
  if (preserve > 0) {
    for (const seq of nodes.slice(-preserve)) protectedSeqs.add(seq)
  }
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = eventAtOf(session, nodes[index]!)
    if (event?.type === 'user/message' && !isCheckpointNode(event)) {
      protectedSeqs.add(nodes[index]!)
      break
    }
  }
  const raw: Array<{ start: number; end: number; count: number; tokens: number; toolCount: number }> = []
  let cur: { start: number; end: number; count: number; tokens: number; toolCount: number } | null = null
  const flush = (): void => {
    if (cur !== null) raw.push(cur)
    cur = null
  }
  for (const seq of nodes) {
    const event = eventAtOf(session, seq)
    if (event === undefined || protectedSeqs.has(seq) || isCheckpointNode(event)) {
      flush()
      continue
    }
    // Surface nodes can be locally out of order after surface replacements in
    // long sessions; a node with a SMALLER seq than the running segment would
    // produce a reversed range (e.g. 110295..106762). Break the segment so
    // ranges always stay start <= end.
    if (cur !== null && seq < cur.start) {
      flush()
      cur = null
    }
    const tokens = defaultCountTokens(extractEventText(event))
    const isTool = isToolEvent(event)
    if (cur === null) {
      cur = { start: seq, end: seq, count: 1, tokens, toolCount: isTool ? 1 : 0 }
    } else {
      cur = { start: cur.start, end: seq, count: cur.count + 1, tokens: cur.tokens + tokens, toolCount: cur.toolCount + (isTool ? 1 : 0) }
    }
  }
  flush()
  const out: SeqCompressibleRange[] = []
  for (const range of raw) {
    try {
      const { start, end } = resolveSurfaceRange(session, range.start, range.end)
      const count = range.count
      out.push({
        start,
        end,
        count,
        tokens: range.tokens,
        toolPct: count > 0 ? Math.round((range.toolCount / count) * 100) : 0,
      })
    } catch {
      // Cannot be balanced into a compressible span — skip.
    }
  }
  // Oldest-first: the order is stable across turns (the oldest ranges do not
  // move as new messages land), so the model can consume ranges front-to-back
  // without re-ranking each nudge — matching the kernel's `oldest first` list
  // and the host's own front-to-back compression rhythm.
  return out.sort((a, b) => a.start - b.start)
}

/**
 * A compact human-readable description of the current surface for the model:
 * node count plus the first/last message seqs. Surface seqs are sparse (the
 * event log interleaves non-message events and expanded delta batches), so a
 * model that never saw the nudge range table — e.g. low-pressure sessions
 * where no nudge fires — cannot guess its own seq space. acp_status and the
 * nudge's range table both surface this so compress edges can be located
 * without blind probing.
 */
export function surfaceSummary(session: Session): string {
  const nodes = session.surface.nodes
  if (nodes.length === 0) return 'empty'
  // Surface nodes are NOT guaranteed to be ordered: a compaction replace lands
  // the checkpoint node first, so [15, 6, 7, …]. Report the span as min..max
  // rather than first..last, which would read "seqs 15..12" after a compress.
  let first = nodes[0]!
  let last = nodes[0]!
  for (const seq of nodes) {
    if (seq < first) first = seq
    if (seq > last) last = seq
  }
  return `${nodes.length} nodes, seqs ${first}..${last}`
}

/** One block as seen by the tier machinery: durable id ↔ kernel ref (`bN`). */
export interface AcpBlockRegistryEntry {
  /** The durable compaction id. */
  readonly blockId: string
  /** The acp-kernel block ref (`bN`); synthesised by log order for legacy blocks. */
  readonly kernelBlockId: string
  readonly tier: 1 | 2 | 3
  /** The surface seq of this block's checkpoint summary node (null when gone). */
  readonly summarySeq: number | null
  /** True until a LATER block distills this one. Only active blocks are distillable. */
  readonly active: boolean
  readonly parentBlockIds: readonly string[]
}

/**
 * Rebuild the compactionId ↔ kernel-block-ref registry from the durable log.
 * Legacy blocks (pre-tier, no recorded `kernelBlockId`) are synthesised as
 * `b1`, `b2`, … in log order; recorded ids are kept as-is. A block is active
 * until a later block lists it as a parent.
 */
export function blockRegistry(session: Session): AcpBlockRegistryEntry[] {
  const ledger = rebuildBlockLedger(sessionEventsOf(session))
  const kernelIdOf = new Map<string, string>()
  const raw: AcpBlockRegistryEntry[] = []
  let next = 1
  for (const entry of ledger) {
    let kernelBlockId: string
    if (entry.kernelBlockId !== undefined && /^b\d+$/.test(entry.kernelBlockId)) {
      kernelBlockId = entry.kernelBlockId
      const num = Number(kernelBlockId.slice(1))
      if (Number.isInteger(num)) next = Math.max(next, num + 1)
    } else {
      kernelBlockId = `b${next}`
      next += 1
    }
    kernelIdOf.set(entry.blockId, kernelBlockId)
    raw.push({
      blockId: entry.blockId,
      kernelBlockId,
      tier: entry.tier,
      summarySeq: entry.summarySeq ?? null,
      active: true,
      parentBlockIds: [...entry.parentBlockIds],
    })
  }
  const consumed = new Set<string>()
  for (const entry of raw) {
    for (const parent of entry.parentBlockIds) consumed.add(parent)
  }
  return raw.map((entry) => ({
    ...entry,
    active: !consumed.has(entry.blockId),
  }))
}

/**
 * The kernel block ref (`bN`) for a surface seq, when that seq is the
 * checkpoint summary node of a block — the edge the model must use to
 * distill (T2/T3). Active blocks distill; a stale (already-distilled) node
 * still maps to its `bN` so the kernel reports "already compressed" instead
 * of silently folding the summary as a plain message. Returns null for
 * anything else (plain messages, non-checkpoint nodes).
 */
export function blockRefForSummarySeq(session: Session, seq: number): string | null {
  const event = eventAtOf(session, seq)
  if (event?.type !== 'user/message') return null
  const source = (event.data as { source?: { plugin?: string; compactionId?: string } }).source
  if (source?.plugin !== 'compact' || source.compactionId === undefined) return null
  const entry = blockRegistry(session).find((r) => r.blockId === source.compactionId)
  if (entry === undefined) return null
  return entry.kernelBlockId
}

/** The durable compaction ids distilled by the given kernel block refs (`bN`). */
export function compactionIdsOfKernelBlocks(session: Session, kernelBlockIds: readonly string[]): string[] {
  if (kernelBlockIds.length === 0) return []
  const byKernel = new Map(blockRegistry(session).map((r) => [r.kernelBlockId, r.blockId]))
  return kernelBlockIds
    .map((id) => byKernel.get(id))
    .filter((id): id is string => id !== undefined)
}

/**
 * Resolve a kernel block ref (`bN`) — as shown by the model tool `acp_status`
 * (kernel `buildStatusReport` renders `block.blockId`) — to the durable
 * compaction id the decompress/search tools accept. Returns null when `bN` is
 * not an exact registry key (unknown ref). Only matches the canonical `bN`
 * form (`/^b\d+$/`); anything else is not a kernel ref and returns null so the
 * caller falls back to its compaction-id prefix match.
 */
export function blockIdOfKernelRef(session: Session, kernelRef: string): string | null {
  if (!/^b\d+$/.test(kernelRef)) return null
  const entry = blockRegistry(session).find((r) => r.kernelBlockId === kernelRef)
  return entry?.blockId ?? null
}

/** The checkpoint summary seq of an ACTIVE kernel block (`bN`), or null. */
export function summarySeqOfKernelBlock(session: Session, kernelBlockId: string): number | null {
  const entry = blockRegistry(session).find((r) => r.kernelBlockId === kernelBlockId)
  return entry?.active ? entry.summarySeq : null
}

/** The durable block whose checkpoint node sits at `seq` (or null). */
function checkpointBlockIdOf(events: readonly SessionEvent[], seq: number): string | null {
  const event = events[seq]
  if (event?.type !== 'user/message') return null
  const source = (event.data as { source?: { plugin?: string; compactionId?: string } }).source
  if (source?.plugin !== 'compact' || source.compactionId === undefined) return null
  return source.compactionId
}

/**
 * The shadowed seqs of a block, recursing into distilled parent blocks: a
 * tier-2 block shadows its parent's checkpoint node, so recovering its
 * originals requires expanding that node into the parent block's own shadowed
 * seqs. Cycle-safe (a block can never be its own ancestor).
 */
export function expandShadowedSeqs(session: Session, blockId: string): number[] {
  const ledger = rebuildBlockLedger(sessionEventsOf(session))
  const byId = new Map(ledger.map((entry) => [entry.blockId, entry]))
  const root = byId.get(blockId)
  if (root === undefined) return []
  const out: number[] = []
  const seen = new Set<string>()
  const visit = (entry: AcpBlockLedgerEntry): void => {
    if (seen.has(entry.blockId)) return
    seen.add(entry.blockId)
    for (const seq of entry.shadowedSeqs) {
      const childId = checkpointBlockIdOf(sessionEventsOf(session), seq)
      const child = childId === null ? undefined : byId.get(childId)
      if (child !== undefined) visit(child)
      else out.push(seq)
    }
  }
  visit(root)
  return out
}
