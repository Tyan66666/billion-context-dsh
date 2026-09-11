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
// toolPairingBalanced* come from the host package: the published seam reads
// only eventAt / surface.replaceGeneration, present on every supported
// session version. The issue #124 local-mirror workaround is gone (see
// docs/dsh-porting-verification.md); tests/tool-pairing-host.test.ts guards it.
import { CompactionId, compactCheckpointSource, toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { defaultCountTokens } from 'acp-kernel'
import {
  classifySurfaceEvent,
  extractEventText,
  extractText,
  isAgentInstructionsRow,
  isCheckpointNode,
  isRealUserTurn,
  toolCallIdOfResultEvent,
  withSummaryFramePrefix,
} from './messages.ts'
import { hostPriceEvent } from './host-tokens.ts'
import { eventAtOf, sessionEventsOf } from './session-events.ts'
import { decodeAcpBlockLedger, encodeAcpBlockLedger, type AcpBlockLedgerPayload } from './block-ledger.ts'

/**
 * A surface sequence number as the INSTALLED `dsh-session` sees it. Since the
 * 0.1.5 baseline dsh-session brands these as `SessionSeq` (a branded
 * `number`). Deriving the element type from `Session['surface']` avoids
 * naming the brand directly; `as SurfaceSeq` is the single admission point —
 * a plain `number` produced by a caller (model ref, ledger field) is admitted
 * as a surface seq only at the exact write/index site the session brands.
 */
type SurfaceSeq = Session['surface']['nodes'][number]

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
  /** B3: acceptance readings that were already green before compression (absent when the compress call carried none). */
  readonly verifiedReadings?: readonly string[]
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

/**
 * Reject a second concurrent compaction for the same session.
 *
 * Compaction is synchronous and a session is single-writer, so a
 * `compaction/start` with NO matching `compaction/end` in the durable log can
 * only be a stale leftover from a prior run that died mid-write (a hard kill,
 * not a caught throw — every caught throw is paired with a compensating
 * `compaction/end` in runCompactionTransaction). Such a leftover must NOT
 * permanently block every later compress call: this treats it as stale,
 * surfaces it once, and lets a new compaction proceed. The old "already
 * active" throw only fired when a genuine concurrent compaction existed,
 * which the synchronous single-writer premise makes impossible.
 */
export function assertNoActiveCompaction(events: readonly SessionEvent[]): void {
  let active = false
  for (const event of events) {
    if (event.type === 'compaction/start') active = true
    else if (event.type === 'compaction/end') active = false
  }
  if (active) {
    console.warn('billion-context-dsh: clearing stale compaction flag — found a compaction/start with no matching compaction/end')
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
 *     checkpoint seq directly. Host system-prompt nodes (`system/message`)
 *     are excluded too — protected fixed overhead, not compressible content.
 */
function recoverStaleRange(session: Session, start: number, end: number): StaleRangeRecovery {
  if (eventAtOf(session, start) === undefined || eventAtOf(session, end) === undefined) {
    const failedEdge = eventAtOf(session, start) === undefined ? start : end
    return { kind: 'unresolvable', failedEdge }
  }
  const liveInside = session.surface.nodes
    .filter((seq) => seq >= start && seq <= end)
    .sort((a, b) => a - b)
  const plain = liveInside.filter((seq) => {
    const event = eventAtOf(session, seq)!
    return !isCheckpointNode(event) && !isSystemNode(event)
  })
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
  let requestedStartIdx = nodes.indexOf(start as SurfaceSeq)
  let requestedEndIdx = nodes.indexOf(end as SurfaceSeq)
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
    requestedStartIdx = nodes.indexOf(start as SurfaceSeq)
    requestedEndIdx = nodes.indexOf(end as SurfaceSeq)
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
  // A boundary must be BOTH tool-pairing-balanced AND carry a bare-seq ref,
  // and never a host system prompt. The system check is explicit, not
  // incidental: `hasPlainRef` happens to return false for `system/message`,
  // but riding that default would silently invert if the projection ever
  // learns to emit a bare-seq ref for system nodes.
  const cleanBefore = (index: number): boolean => {
    const event = eventAtOf(session, nodes[index]!)
    return event !== undefined
      && !isSystemNode(event)
      && toolPairingBalancedBefore(session, nodes[index]!)
      && hasPlainRef(session, nodes[index]!)
  }
  const cleanAfter = (index: number): boolean => {
    const event = eventAtOf(session, nodes[index]!)
    return event !== undefined
      && !isSystemNode(event)
      && toolPairingBalancedAfter(session, nodes[index]!)
      && hasPlainRef(session, nodes[index]!)
  }
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
  const startIdx = nodes.indexOf(start as SurfaceSeq)
  const endIdx = nodes.indexOf(end as SurfaceSeq)
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
  /** B3：压缩前已绿的验收读数（结构化，压缩后仍可读）。 */
  readonly verifiedReadings?: readonly string[]
}

type CompactionSummaryData = SessionEventMap['compaction/summary']

/**
 * Read a `compaction/summary` event's data. The six ACP tier/lineage fields are
 * no longer top-level members (issue #141): post-fix writers carry them in the
 * admitted optional `rawOutput` member (decode via {@link decodeAcpBlockLedger}),
 * while logs written by pre-fix engines still carry them as top-level members —
 * so the returned type also intersects with {@link AcpBlockLedgerPayload}, letting
 * readers fall back to the legacy shape. Never `any`.
 */
export function readCompactionSummary(event: SessionEvent): CompactionSummaryData & AcpBlockLedgerPayload {
  return event.data as CompactionSummaryData & AcpBlockLedgerPayload
}

/**
 * B3: read the structured verified readings a compress call recorded for this
 * block (acceptance checks that were already green before the range was
 * shadowed — e.g. "t0-fastpath 8/8"). Post-fix writers carry them inside the
 * admitted `rawOutput` member (AcpBlockLedgerPayload); legacy writers put them
 * top-level. Absent in either shape → empty array; never throws.
 */
export function verifiedReadingsOf(event: SessionEvent): string[] {
  const data = readCompactionSummary(event)
  const list = decodeAcpBlockLedger(data.rawOutput).verifiedReadings ?? data.verifiedReadings
  return Array.isArray(list) ? list.map(String) : []
}

/**
 * B1：给摘要块数组的第一个文本块加标源前缀（幂等——已带前缀不重复加）。
 * 只动文本块，工具/图片块原样保留。
 */
export function prefixSummaryBlocks(blocks: readonly ContentBlock[]): ContentBlock[] {
  let done = false
  return blocks.map((block) => {
    if (done || block.type !== 'text') return block
    done = true
    const textBlock = block as { type: 'text'; text: string }
    return { ...textBlock, text: withSummaryFramePrefix(textBlock.text) } as ContentBlock
  })
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

  // Fail fast on an unresolvable range BEFORE writing any durable event. If we
  // let the host's surfaceOp replace throw below, we would first have recorded
  // compaction/start and compaction/summary and then leave a dangling start
  // (poisoning every later compress call) plus an orphan summary in the ledger.
  // Validating the edges up front keeps a bad range a clean, zero-write no-op.
  if (input.start > input.end) {
    throw new Error(`billion-context-dsh: reversed range ${input.start}..${input.end}`)
  }
  if (eventAtOf(session, input.start) === undefined || eventAtOf(session, input.end) === undefined) {
    const failedEdge = eventAtOf(session, input.start) === undefined ? input.start : input.end
    throw new Error(
      `billion-context-dsh: seq ${input.start}..${input.end} not in the current surface — `
      + `edge seq ${failedEdge} is not in this session's log. `
      + 'Surface seqs are sparse message nodes (only user/message, assistant/message, '
      + 'tool/result events); consult acp_status for the current surface range',
    )
  }

  try {
    seqs.push(session.append('compaction/start', { compactionId, turn }).seq)
    // The six tier/lineage fields ride in the admitted optional `rawOutput`
    // member (namespaced JSON via encodeAcpBlockLedger), NOT as top-level
    // members: the frozen released-v0 reader rejects any non-admitted member and
    // would brick the log on host upgrade (issue #141). See src/block-ledger.ts.
    const ledgerPayload: AcpBlockLedgerPayload = {
      tier: input.tier ?? 1,
      ...(input.kernelBlockId === undefined ? {} : { kernelBlockId: input.kernelBlockId }),
      ...(input.topic === undefined ? {} : { topic: input.topic }),
      ...(input.parentBlockIds === undefined || input.parentBlockIds.length === 0
        ? {}
        : { parentBlockIds: [...input.parentBlockIds] }),
      ...(input.directMessageIds === undefined ? {} : { directMessageIds: [...input.directMessageIds] }),
      ...(input.effectiveMessageIds === undefined ? {} : { effectiveMessageIds: [...input.effectiveMessageIds] }),
      ...(input.verifiedReadings === undefined || input.verifiedReadings.length === 0
        ? {}
        : { verifiedReadings: [...input.verifiedReadings] }),
    }
    // B1: frame the model-written summary ONCE at creation and write the SAME framed
    // blocks to both the durable compaction/summary event and the checkpoint node
    // below — log readers (search, acp_status, ledger) must never see different text
    // than what the model sees in context (review item: prefix/raw mismatch).
    const framedSummary = prefixSummaryBlocks(input.summary)
    seqs.push(session.append('compaction/summary', {
      compactionId,
      summary: framedSummary,
      shadowedRange: { start: input.start, end: input.end },
      shadowedSeqs: [...input.shadowedSeqs],
      shadowedTokenCount: input.shadowedTokenCount,
      provider: input.provider,
      model: input.model,
      rawOutput: encodeAcpBlockLedger(ledgerPayload),
    } as CompactionSummaryData).seq)

    // The checkpoint node carries the SAME framed blocks as the compaction/summary
    // event (see above); projection-time framing in messages.ts stays as an
    // idempotent safety net for legacy blocks written before this feature.
    const message = createUserMessage({
      content: framedSummary,
      source: compactCheckpointSource(compactionId),
    })
    // The replace op MUST use the 0.1.5 field names: dsh-session's validator
    // accepts exactly { op, startSeq, endSeq } (exactly three keys) and rejects
    // the pre-0.1.5 { op, start, end } dialect with "invalid replace surfaceOp"
    // (issue #136). Both validators force exactly-three-keys, so a single
    // dialect is the only option — hence the peer floor at 0.1.5-alpha.1.
    seqs.push(session.append('user/message', message, {
      surfaceOp: { op: 'replace', startSeq: input.start as SurfaceSeq, endSeq: input.end as SurfaceSeq },
      sourceEventSeqs: [...input.shadowedSeqs] as SurfaceSeq[],
    }).seq)

    seqs.push(session.append('compaction/end', { compactionId, turn }).seq)
  } catch (error) {
    // Backstop: if any append AFTER compaction/start throws (the host rejects
    // the surfaceOp replace for a reason we did not pre-validate, the summary
    // serialization fails, …), write a compensating compaction/end so the
    // durable log never holds a dangling start that would block every later
    // compress call. A leftover compaction/summary with no applied replace is
    // surfaced as an orphan ledger block, which is preferable to a hard
    // permanent block.
    try {
      session.append('compaction/end', { compactionId, turn })
    } catch (compensateError) {
      // The durable log may now hold a dangling compaction/start; the next
      // assertNoActiveCompaction call heals it. Never mask the original error.
      console.warn('billion-context-dsh: failed to write a compensating compaction/end', compensateError)
    }
    throw error
  }
  return { compactionId, seqs }
}

/**
 * One pass over the log: compactionId → seq of its checkpoint summary node
 * (first checkpoint wins, matching the old per-block linear scan). Replaces
 * the B full-log scans per rebuild that made the ledger O(B·N) (issue #133:
 * (B+1) rebuilds per search × B scans × N events ≈ 5.8B iterations at
 * B=190, N=160K).
 */
function summarySeqIndex(events: readonly SessionEvent[]): Map<string, number> {
  const index = new Map<string, number>()
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const source = (event.data as { source?: { plugin?: string; compactionId?: string } }).source
    const compactionId = source?.plugin === 'compact' ? source.compactionId : undefined
    if (compactionId !== undefined && !index.has(compactionId)) index.set(compactionId, event.seq)
  }
  return index
}

// Memoized on the append-only snapshot array (stable until the next append,
// see sessionEventsOf): identity+length never goes stale; avoids the (B+1)
// full rebuilds per search (#109/#133).
const blockLedgerCache = new WeakMap<readonly SessionEvent[], { len: number; ledger: AcpBlockLedgerEntry[] }>()

/** Rebuild the block ledger from the durable log (no kernel state needed). */
export function rebuildBlockLedger(events: readonly SessionEvent[]): AcpBlockLedgerEntry[] {
  const cached = blockLedgerCache.get(events)
  if (cached !== undefined && cached.len === events.length) return cached.ledger
  const summarySeqs = summarySeqIndex(events)
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
    // Block-ledger fields: prefer the rawOutput-embedded payload (post-fix
    // writers + normalizer-recovered files); fall back to the legacy top-level
    // members written by pre-fix engines onto v3 logs (which are not bricked) so
    // in-flight sessions keep their tier/lineage across the upgrade.
    // decodeAcpBlockLedger never throws and returns {} when no valid payload is present.
    const embedded = decodeAcpBlockLedger(data.rawOutput)
    const tier: 1 | 2 | 3 = embedded.tier ?? (data.tier === 2 || data.tier === 3 ? data.tier : 1)
    const parentBlockIds: string[] = embedded.parentBlockIds
      ? [...embedded.parentBlockIds]
      : (Array.isArray(data.parentBlockIds) ? [...data.parentBlockIds] : [])
    const directMessageIds: string[] | undefined = embedded.directMessageIds
      ? [...embedded.directMessageIds]
      : (Array.isArray(data.directMessageIds) ? [...data.directMessageIds] : undefined)
    const effectiveMessageIds: string[] | undefined = embedded.effectiveMessageIds
      ? [...embedded.effectiveMessageIds]
      : (Array.isArray(data.effectiveMessageIds) ? [...data.effectiveMessageIds] : undefined)
    const topic: string | undefined = embedded.topic ?? (typeof data.topic === 'string' ? data.topic : undefined)
    const kernelBlockId: string | undefined = embedded.kernelBlockId
      ?? (typeof data.kernelBlockId === 'string' ? data.kernelBlockId : undefined)
    const verifiedReadings: string[] | undefined = embedded.verifiedReadings
      ? [...embedded.verifiedReadings]
      : (Array.isArray(data.verifiedReadings) ? [...data.verifiedReadings] : undefined)
    const summarySeq = summarySeqs.get(data.compactionId) ?? null
    ledger.push({
      blockId: data.compactionId,
      summary: extractText(data.summary),
      ...(topic === undefined ? {} : { topic }),
      shadowedSeqs: [...data.shadowedSeqs],
      shadowedTokenCount,
      start: data.shadowedRange.start,
      end: data.shadowedRange.end,
      tier,
      parentBlockIds,
      ...(kernelBlockId === undefined ? {} : { kernelBlockId }),
      ...(summarySeq === null ? {} : { summarySeq }),
      ...(directMessageIds === undefined ? {} : { directMessageIds }),
      ...(effectiveMessageIds === undefined ? {} : { effectiveMessageIds }),
      ...(verifiedReadings === undefined ? {} : { verifiedReadings }),
      createdAt: event.time,
    })
  }
  blockLedgerCache.set(events, { len: events.length, ledger })
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

// `isCheckpointNode` now lives in src/messages.ts (imported above) so the range
// scanner, the protected-tail scan and `classifySurfaceEvent` cannot drift
// apart. A local `isPruneTombstone` was dropped for the same reason: the prune
// tombstone is written with `source: { kind: 'plugin', plugin:
// 'billion-context-dsh' }` (see `hideSurfaceSeqs`), which `classifySurfaceEvent`
// files under `metadata`, so `isRealUserTurn` already refuses it tail protection.

/**
 * Whether a surface node is a host-owned system prompt (`system/message`, new
 * in dsh-session 0.1.5). The host protects it — replacing node 0 throws
 * ("node 0 holds the system prompt …"), and its content is fixed overhead, not
 * conversation — so it must never be offered as compressible nor count as
 * still-live content when a stale range snaps back.
 */
function isSystemNode(event: SessionEvent): boolean {
  return event.type === 'system/message'
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
 * Durable model-free prune: append `compaction/prune` as the shadow price,
 * then replace the given surface seqs with a user message. dsh-session 0.1.5+
 * allows only user/message (and system/message) replacements to cite source
 * events — assistant/message FORBIDS `sourceEventSeqs` because it embeds its
 * own provider stream — so there is no invisible replacement node anymore:
 * every hidden span becomes a user message. Callers with meaningful text pass
 * it (compress call/result hiding keeps the tool outcome visible to the
 * model); callers without get the fixed prune note. The originals remain in
 * the append-only log.
 */
export const PRUNE_NOTE = '(removed by context management)'

function hideSurfaceSeqs(
  session: Session,
  seqs: readonly number[],
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
    shadowedRange: { start: start as SurfaceSeq, end: end as SurfaceSeq },
    shadowedSeqs: [...seqs] as SurfaceSeq[],
    shadowedTokenCount,
  })
  const body = text !== undefined && text.trim().length > 0 ? text : PRUNE_NOTE
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: body }],
    source: { kind: 'plugin', plugin: 'billion-context-dsh' },
  }), {
    surfaceOp: { op: 'replace', startSeq: start as SurfaceSeq, endSeq: end as SurfaceSeq },
    sourceEventSeqs: [...seqs] as SurfaceSeq[],
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
  const startIdx = nodes.indexOf(callSeq as SurfaceSeq)
  const endIdx = nodes.indexOf(resolvedResultSeq as SurfaceSeq)
  // Only hide an actually adjacent pair; never shadow unrelated messages that
  // happen to sit between a stale call and result.
  if (startIdx < 0 || endIdx < 0 || endIdx - startIdx !== 1) return false
  const resultEvent = events[resolvedResultSeq]
  const resultText = resultEvent === undefined ? '' : extractEventText(resultEvent)
  hideSurfaceSeqs(session, [callSeq, resolvedResultSeq], resultText)
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
    if (eventAtOf(session, seq) === undefined) continue
    hideSurfaceSeqs(session, [seq])
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
 * Newest AGENTS.md instruction row per scope (source file). The host
 * re-injects a file's instructions when its CURRENT copy is absent from the
 * surface (deepseek-harness packages/context/agent-instructions presence
 * gate, index.ts:137/:163 — presence+identity, not payload diff), so
 * compressing the newest row of a scope makes that file come straight back,
 * while compressing a STALE copy of the same file is silent. Live-audited
 * shape (session-f25e4fad): EVERY injection row — baseline and worktree —
 * carries `source.changes[].scope` = `"<dir>\u0000<file>"` (root
 * `.\u0000AGENTS.md`, worktree `worktrees/<name>\u0000AGENTS.md`), which is
 * stable across config tweaks unlike `baselineIdentity`. Tail-scan the log,
 * group by scope, keep the last seq of each group. O(events), mirrors
 * indexWatermarkOf. Rows without `changes[]` (legacy shapes) are SKIPPED
 * entirely: identity is what the host's presence gate needs in order to
 * re-inject a file, so a scope-less row can never come back and must not be
 * guarded (the earlier shape gave each its own group, which made every legacy
 * row a permanent hard-reject — issue #71 review S3).
 */
export function newestInstructionSeqsOf(session: Session): Set<number> {
  const newest = new Map<string, number>()
  // Snapshot read (0.1.5 seam): the host stripped `session.events`, so read
  // the dense log array instead — `sessionEventsOf` prefers `snapshotEvents()`
  // and only falls back to `.events` on the older generation (seq == index).
  const events = sessionEventsOf(session)
  for (let seq = 0; seq < events.length; seq += 1) {
    const event = events[seq]
    if (event === undefined || !isAgentInstructionsRow(event)) continue
    const source = (event.data as { source?: { changes?: Array<{ scope?: unknown }> } }).source
    const changes = Array.isArray(source?.changes) ? source.changes : []
    const scopes = changes
      .map((change) => (typeof change?.scope === 'string' ? change.scope : ''))
      .filter((scope) => scope.length > 0)
    if (scopes.length === 0) {
      // No identity: the host's presence gate (deepseek-harness
      // packages/context/agent-instructions) needs a scope to know WHICH file
      // went missing, so this row can never be re-injected. Guarding it would
      // hard-reject hand-built ranges over it for nothing (S3).
      continue
    }
    for (const scope of scopes) newest.set(scope, seq)
  }
  return new Set(newest.values())
}

/**
 * Surface seqs NO caller may compress: the CURRENT (newest) injected
 * agent-instructions row of every scope, restricted to rows still visible on
 * the surface (one definition of "current" — `newestInstructionSeqsOf`).
 * `buildCompressibleSeqRanges` never OFFERS them, and both compress entry
 * points (`handleCompress` in src/tools.ts, `/acp compress` in
 * src/commands.ts) probe the RESOLVED span against this set and HARD-REJECT a
 * covering range before the kernel applies it, so nothing durable lands and no
 * phantom block can exist. This supersedes the earlier F7 draft (warn only):
 * folding a current copy reclaims nothing — the host re-injects it — so there
 * is no legitimate outcome to warn about. Deliberately NARROW (issue #71
 * review F4): only CURRENT agent-instructions rows — the audited loop driver.
 * Engine-authored metadata rows (nudge echo, compress-pair stub) stay
 * foldable like main, and STALE copies of the same file stay compressible —
 * removing them while the newest copy stays visible is the real cleanup.
 */
export function guardedSurfaceSeqsOf(session: Session): Set<number> {
  const guarded = new Set<number>()
  const newestInstructions = newestInstructionSeqsOf(session)
  for (const seq of session.surface.nodes) {
    const event = eventAtOf(session, seq)
    if (event === undefined) continue
    if (isAgentInstructionsRow(event) && newestInstructions.has(seq)) guarded.add(seq)
  }
  return guarded
}

/**
 * The kernel's own view of what can be compressed, as the engine hands it to
 * the range table: the geometry (`nudge.compressibleRanges`) plus the ref map
 * that turns a kernel ref back into a surface seq (`state.messageRefs`).
 *
 * Structural shapes only, so the engine passes the kernel's own objects
 * straight through and tests can hand-build a view.
 */
export interface KernelRangeView {
  /** Kernel `recommendedRanges`/`compressibleRanges` entries (oldest first). */
  readonly ranges: readonly { readonly startRef: string; readonly endRef: string }[]
  /** Kernel ref map: `mNNNNN` → our message id (which IS the surface seq). */
  readonly refs: { readonly byRef: Readonly<Record<string, string>> }
}

/** `mNNNNN` → surface seq, or null when this session has no such ref. */
function seqOfKernelRef(refs: KernelRangeView['refs'], ref: string): number | null {
  const id = refs.byRef[ref]
  if (id === undefined) return null
  // Our CoreMessage ids ARE surface seqs (src/messages.ts), so the kernel's ref
  // map is the bridge between the two id dialects.
  const seq = Number(id)
  return Number.isInteger(seq) ? seq : null
}

/**
 * Surface seqs the range table must never offer, in two roles: they are skipped
 * when scanning a span AND they split it, because a span that reaches across
 * one would shadow it. Three sources:
 *
 * - the recent tail (`preserveRecent`, default 5) — cheap protection for the
 *   messages the current step is still working with;
 * - the last REAL user turn (never an injected row — see `isRealUserTurn`);
 * - the newest instruction row of every scope: the host re-injects the current
 *   copy of an instruction file the moment it disappears from the surface, so
 *   folding it reclaims nothing (rule 16).
 */
function protectedSurfaceSeqs(session: Session, preserve: number): Set<number> {
  const nodes = session.surface.nodes
  const protectedSeqs = new Set<number>()
  // `nodes.slice(-preserve)` would protect EVERYTHING when preserve is 0
  // (`slice(-0) === slice(0)`) — guard so 0 means "no recent protection".
  if (preserve > 0) {
    for (const seq of nodes.slice(-preserve)) protectedSeqs.add(seq)
  }
  // Only a REAL user turn may win "last user message" protection. A plain
  // `role === 'user'` scan protects the injected AGENTS.md row instead whenever
  // the host appended it in the same enter batch as the user input — the actual
  // last user message was then left compressible while synthetic output sat
  // safe (issue #71 PR1). The classifier subsumes the narrower guards the old
  // scan carried: checkpoints are their own class, and engine-authored rows
  // (prune tombstones, compress-pair stubs) are `metadata`.
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = eventAtOf(session, nodes[index]!)
    if (event !== undefined && isRealUserTurn(event)) {
      protectedSeqs.add(nodes[index]!)
      break
    }
  }
  for (const seq of newestInstructionSeqsOf(session)) protectedSeqs.add(seq)
  return protectedSeqs
}

/** One compressible run inside a kernel range. `start`/`end` are surface seqs. */
interface CompressibleSegment {
  start: number
  end: number
  count: number
  tokens: number
  toolCount: number
}

/**
 * Split the surface nodes at `fromIndex..toIndex` (a kernel range, in surface
 * order) into contiguous compressible runs.
 *
 * A node that cannot be compressed ENDS the run rather than being skipped: the
 * host guards (instruction rows, the protected tail) are barriers, and a span
 * that reached across one would shadow it — the compress → re-inject loop of
 * issue #71 depends on that. Panel edges are reported as min/max because the
 * surface is locally unordered after a replacement (a checkpoint node lands
 * with a much higher seq than its neighbours).
 */
function compressibleSegmentsOf(
  session: Session,
  fromIndex: number,
  toIndex: number,
  protectedSeqs: ReadonlySet<number>,
): CompressibleSegment[] {
  const nodes = session.surface.nodes
  const segments: CompressibleSegment[] = []
  let current: CompressibleSegment | null = null
  const flush = (): void => {
    if (current !== null) segments.push(current)
    current = null
  }
  for (let index = fromIndex; index <= toIndex; index += 1) {
    const seq = nodes[index]
    if (seq === undefined) continue
    const event = eventAtOf(session, seq)
    if (
      event === undefined
      || protectedSeqs.has(seq)
      || isCheckpointNode(event)
      || isSystemNode(event)
      // Host policy rows (AGENTS.md injections in both shapes, skill catalogs,
      // unknown plugin rows — `classifySurfaceEvent` 'instruction') are
      // barriers. Compressing the CURRENT copy of an instruction file makes the
      // host re-inject it on its next step — the tokens come straight back, and
      // a model that keeps compressing them loops forever (live-measured: 20 of
      // 43 compressions in a long session re-triggered an injection within 7
      // events; observed again live in session-8c15904e, seq 8 absorbed by a
      // compress → host re-injected at seq 53191). Stale copies stay barriers
      // here too; the system-side GC that removes them lands separately
      // (instruction hygiene PR2). Engine-authored metadata rows (nudge echo,
      // compress-pair stub) intentionally fall through and stay foldable.
      || classifySurfaceEvent(event) === 'instruction'
    ) {
      flush()
      continue
    }
    const tokens = defaultCountTokens(extractEventText(event))
    const isTool = isToolEvent(event)
    if (current === null) {
      current = { start: seq, end: seq, count: 1, tokens, toolCount: isTool ? 1 : 0 }
    } else {
      current.start = Math.min(current.start, seq)
      current.end = Math.max(current.end, seq)
      current.count += 1
      current.tokens += tokens
      current.toolCount += isTool ? 1 : 0
    }
  }
  flush()
  return segments
}

/**
 * Compressible spans in the DSH seq dialect, for the nudge range table.
 *
 * The GEOMETRY — which messages group into one compressible span — comes from
 * the kernel's own ranges (design decision 7: the kernel owns the algorithm).
 * The kernel splits a group when the next message is a user turn and the group
 * already holds 3+ messages, and after any protected or already-compressed
 * message, so a row reads as "roughly one stretch of work" rather than an
 * arbitrary slice. This function only does the two jobs the kernel cannot:
 *
 * 1. Translate refs into surface seqs — DSH has no `<acp>` ref tags; seq is our
 *    ref (design decision 2).
 * 2. Apply the host guards on top of the kernel's grouping: injected
 *    instruction rows split a span and the newest copy of every scope is never
 *    offered, checkpoints and the surface's system node are not compressible,
 *    and the recent tail plus the last REAL user turn stay protected (rule 16).
 *
 * History — why this used to compute the spans itself. A kernel range's edges
 * were derived by counting refs, and a surface replacement breaks that
 * arithmetic: the checkpoint node of a replace lands mid-array carrying a much
 * higher ref, so ref order and array order diverge and the spans came back
 * reversed (`end < start`) or lost large tool results entirely. The table was
 * therefore self-computed from the surface, labeled `UPSTREAM:` and tracked as
 * issue #38 (rule 11). The pinned kernel segments by ARRAY adjacency instead
 * (upstream #207) and the drift is gone — measured on a session whose
 * compressed span sits in the MIDDLE of the surface: every ref resolves to the
 * right seq, no span crosses the shadowed hole, and the compressed span is
 * excluded. Rules 3 and 11 are updated with it.
 */
export function buildCompressibleSeqRanges(
  session: Session,
  kernelView: KernelRangeView,
  opts: { preserveRecent?: number } = {},
): SeqCompressibleRange[] {
  // Orphan tool messages corrupt the pairing balance cache and fragment every
  // large span. Prune them before mapping so the table reflects the surface
  // that will actually be compressed (issue #18).
  stripOrphanedSurfaceToolMessages(session)
  const nodes = session.surface.nodes
  const indexOfSeq = new Map<number, number>()
  for (let index = 0; index < nodes.length; index += 1) indexOfSeq.set(nodes[index]!, index)
  const protectedSeqs = protectedSurfaceSeqs(session, opts.preserveRecent ?? 5)
  const out: SeqCompressibleRange[] = []
  for (const range of kernelView.ranges) {
    const startSeq = seqOfKernelRef(kernelView.refs, range.startRef)
    const endSeq = seqOfKernelRef(kernelView.refs, range.endRef)
    // A ref the kernel knows but this surface does not contributes nothing —
    // skip the range rather than guess a span for it.
    const from = startSeq === null ? undefined : indexOfSeq.get(startSeq)
    const to = endSeq === null ? undefined : indexOfSeq.get(endSeq)
    if (from === undefined || to === undefined) continue
    const segments = compressibleSegmentsOf(session, Math.min(from, to), Math.max(from, to), protectedSeqs)
    for (const segment of segments) {
      try {
        const { start, end } = resolveSurfaceRange(session, segment.start, segment.end)
        out.push({
          start,
          end,
          count: segment.count,
          tokens: segment.tokens,
          toolPct: segment.count > 0 ? Math.round((segment.toolCount / segment.count) * 100) : 0,
        })
      } catch {
        // Cannot be balanced into a compressible span — skip.
      }
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

/**
 * Default decompress page size (#112): a block shadowing hundreds of
 * messages used to be returned whole in ONE tool result — big enough to
 * flood the context window or get silently trimmed by the host's
 * tool-result pruner before the model ever saw the tail. One page per call
 * keeps every recovery usable; `offset` walks the rest.
 *
 * A page is bounded by BOTH this message count and a rendered-character
 * budget ({@link DEFAULT_DECOMPRESS_PAGE_CHARS}). Count alone was not enough:
 * the host's `dsh-compaction-tool-result-pruner` (docs/dsh-porting-analysis.md)
 * trims by CHARACTERS (thresholdChars 8192), so a wide page of long messages
 * still crossed that line and had its middle dropped. The char bound keeps an
 * ordinary page under the pruner threshold so it comes back intact; the
 * message count doubles as a hard ceiling so a pathological `limit` can't
 * re-open the whole-block flooding half of #112.
 */
export const DEFAULT_DECOMPRESS_PAGE = 100

/**
 * Rendered-character budget per decompress page (#112). Kept below the host's
 * tool-result pruner threshold (8192, docs/dsh-porting-analysis.md) with
 * headroom for the block header, the `[seq N]` prefixes, and the continue hint,
 * so a normal page survives intact instead of middle-trimmed. Deliberately NOT
 * tied to acp-kernel's `config.truncate.threshold`: that knob truncates a single
 * oversized tool output during compression, whereas the host pruner trims our
 * whole decompress result — different mechanisms, different thresholds.
 */
export const DEFAULT_DECOMPRESS_PAGE_CHARS = 7000

export interface DecompressPage {
  /** Requested offset floored to >= 0; reported as-is when it lands past the end. */
  offset: number
  /** Limit actually applied (clamped to [1, DEFAULT_DECOMPRESS_PAGE]). */
  limit: number
  /** Total shadowed messages in the block (tier-expanded). */
  total: number
  /** This page's shadowed seqs, in expansion order. */
  seqs: number[]
  /** True when no further page follows this one. */
  exhausted: boolean
}

/**
 * Slice a block's expanded shadowed-seq list into one page. A page holds at most
 * `limit` messages AND at most `charBudget` rendered characters, where
 * `renderLen(seq)` reports each message's on-the-wire length (0 when it carries
 * no text). Seqs whose original carries no text still occupy a slot, so `offset`
 * stays a stable continuation index across calls while the log is frozen.
 * Out-of-range / negative / non-finite values clamp instead of failing (optional
 * convenience params, not semantic boundaries); non-numeric input falls back to
 * the default rather than leaking NaN into the result. The first message of the
 * page is always included even if it alone exceeds the budget, so a walk always
 * makes progress past a single giant message.
 */
export function sliceDecompressPage(
  expanded: number[],
  offset: number,
  limit: number,
  charBudget: number,
  renderLen: (seq: number) => number,
): DecompressPage {
  const offN = typeof offset === 'number' ? offset : Number(offset)
  const safeOffset = Number.isFinite(offN) && offN > 0 ? Math.floor(offN) : 0
  const limN = typeof limit === 'number' ? limit : Number(limit)
  const safeLimit = Number.isFinite(limN) && limN >= 1 ? Math.min(Math.floor(limN), DEFAULT_DECOMPRESS_PAGE) : DEFAULT_DECOMPRESS_PAGE
  const start = Math.min(safeOffset, expanded.length)
  const endCap = Math.min(start + safeLimit, expanded.length)
  let end = start
  let acc = 0
  for (let i = start; i < endCap; i += 1) {
    const seq = expanded[i]!
    const len = renderLen(seq)
    // Stop only once we've already taken at least one message and the next
    // would push the page over the budget — guarantees forward progress.
    if (i > start && acc + len > charBudget) break
    acc += len
    end = i + 1
  }
  // Report the requested offset (floored to >= 0), not the length-clamped slice
  // start: when the caller asks past the end, naming the offset they actually
  // passed ("offset 500 is past the end") is clearer than the clamped position.
  return { offset: safeOffset, limit: safeLimit, total: expanded.length, seqs: expanded.slice(start, end), exhausted: end >= expanded.length }
}
