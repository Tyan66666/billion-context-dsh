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
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  CompactionId,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { defaultCountTokens } from 'acp-kernel'
import { extractEventText, extractText } from './messages.ts'

/** One durable ACP block as rebuilt from the session log. */
export interface AcpBlockLedgerEntry {
  /** The compaction transaction id (stable block identity). */
  readonly blockId: string
  readonly summary: string
  readonly shadowedSeqs: readonly number[]
  readonly shadowedTokenCount: number
  readonly start: number
  readonly end: number
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
  const event = session.events[seq]
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
 * Validate one inclusive surface span and adjust its edges to a
 * tool-pairing-balanced range whose boundaries carry a bare-seq ref. Missing
 * or reversed ranges still throw. An edge that sits inside a tool-call/result
 * pair — or on a multi-tool-call assistant message that has no bare-seq ref —
 * is first nudged inward to the nearest clean cut; if that collapses the range
 * (e.g. the model asked for a SINGLE tool result, which can never be balanced
 * alone), the range EXPANDS outward to the enclosing clean pair instead — a
 * lone tool message is almost always a "consumed output" the model genuinely
 * wants to compress. The returned range is what a caller should actually shadow.
 */
export function resolveSurfaceRange(
  session: Session,
  start: number,
  end: number,
): { start: number; end: number } {
  const nodes = session.surface.nodes
  const requestedStartIdx = nodes.indexOf(start)
  const requestedEndIdx = nodes.indexOf(end)
  if (requestedStartIdx < 0 || requestedEndIdx < 0) {
    throw new Error(`billion-context-dsh: seq ${start}..${end} not in the current surface`)
  }
  if (requestedStartIdx > requestedEndIdx) {
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
  if (startIdx <= endIdx) {
    return { start: nodes[startIdx]!, end: nodes[endIdx]! }
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
  if (cleanBefore(startIdx) && cleanAfter(endIdx)) {
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
}

/**
 * Run one durable compression transaction. Throws on invalid state; on success
 * the four events are in the log and the surface has one summary node.
 */
export function runCompactionTransaction(
  session: Session,
  input: CompactionTransactionInput,
): { compactionId: string; seqs: number[] } {
  assertNoActiveCompaction(session.events)
  const turn = findOpenTurn(session.events)
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
  }).seq)

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

/** Rebuild the block ledger from the durable log (no kernel state needed). */
export function rebuildBlockLedger(events: readonly SessionEvent[]): AcpBlockLedgerEntry[] {
  const ledger: AcpBlockLedgerEntry[] = []
  for (const event of events) {
    if (event.type !== 'compaction/summary') continue
    const data = event.data
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
    ledger.push({
      blockId: data.compactionId,
      summary: extractText(data.summary),
      shadowedSeqs: [...data.shadowedSeqs],
      shadowedTokenCount,
      start: data.shadowedRange.start,
      end: data.shadowedRange.end,
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
}

/** Whether a surface user message is a compaction checkpoint node (already compressed). */
function isCheckpointNode(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  const source = (event.data as { source?: { plugin?: string } }).source
  return source?.plugin === 'compact'
}

/**
 * Compute compressible spans directly from the surface — independent of the
 * kernel's ref map, which can drift after surface replacements in long
 * sessions and hide large tool results from the nudge range table. Skips the
 * recent protected tail, the last user message, and compaction checkpoints;
 * edges are then balanced through resolveSurfaceRange. Ranges are ordered by
 * size (largest reclaimed first).
 */
export function buildCompressibleSeqRanges(
  session: Session,
  opts: { preserveRecent?: number } = {},
): SeqCompressibleRange[] {
  const nodes = session.surface.nodes
  const preserve = opts.preserveRecent ?? 5
  const protectedSeqs = new Set<number>()
  for (const seq of nodes.slice(-preserve)) protectedSeqs.add(seq)
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = session.events[nodes[index]!]
    if (event?.type === 'user/message' && !isCheckpointNode(event)) {
      protectedSeqs.add(nodes[index]!)
      break
    }
  }
  const raw: SeqCompressibleRange[] = []
  let cur: SeqCompressibleRange | null = null
  const flush = (): void => {
    if (cur !== null) raw.push(cur)
    cur = null
  }
  for (const seq of nodes) {
    const event = session.events[seq]
    if (event === undefined || protectedSeqs.has(seq) || isCheckpointNode(event)) {
      flush()
      continue
    }
    const tokens = defaultCountTokens(extractEventText(event))
    if (cur === null) {
      cur = { start: seq, end: seq, count: 1, tokens }
    } else {
      cur = { start: cur.start, end: seq, count: cur.count + 1, tokens: cur.tokens + tokens }
    }
  }
  flush()
  const out: SeqCompressibleRange[] = []
  for (const range of raw) {
    try {
      const { start, end } = resolveSurfaceRange(session, range.start, range.end)
      const count = range.count
      out.push({ start, end, count, tokens: range.tokens })
    } catch {
      // Cannot be balanced into a compressible span — skip.
    }
  }
  return out.sort((a, b) => b.tokens - a.tokens)
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
  const first = nodes[0]!
  const last = nodes[nodes.length - 1]!
  return `${nodes.length} nodes, seqs ${first}..${last}`
}
