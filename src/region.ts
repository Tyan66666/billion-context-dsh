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
import { extractText } from './messages.ts'

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
 * Validate one inclusive surface span: both edges on the current surface, in
 * surface order, and tool-call/result balanced at both edges.
 */
export function resolveSurfaceRange(
  session: Session,
  start: number,
  end: number,
): { start: number; end: number } {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(start)
  const endIdx = nodes.indexOf(end)
  if (startIdx < 0 || endIdx < 0) {
    throw new Error(`billion-context-dsh: seq ${start}..${end} not in the current surface`)
  }
  if (startIdx > endIdx) {
    throw new Error(`billion-context-dsh: reversed range ${start}..${end}`)
  }
  if (!toolPairingBalancedBefore(session, start)) {
    throw new Error('billion-context-dsh: range start sits inside a tool-call/result pair')
  }
  if (!toolPairingBalancedAfter(session, end)) {
    throw new Error('billion-context-dsh: range end sits inside a tool-call/result pair')
  }
  return { start, end }
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
    ledger.push({
      blockId: data.compactionId,
      summary: extractText(data.summary),
      shadowedSeqs: [...data.shadowedSeqs],
      shadowedTokenCount: data.shadowedTokenCount,
      start: data.shadowedRange.start,
      end: data.shadowedRange.end,
    })
  }
  return ledger
}
