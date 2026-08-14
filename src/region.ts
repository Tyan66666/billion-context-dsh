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
    throw new Error(
      `billion-context-dsh: seq ${start}..${end} not in the current surface — `
      + 'surface seqs are sparse message nodes (only user/message, assistant/message, '
      + 'tool/result events); consult acp_status for the current surface range',
    )
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
    tier: input.tier ?? 1,
    ...(input.kernelBlockId === undefined ? {} : { kernelBlockId: input.kernelBlockId }),
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
    // Surface nodes can be locally out of order after surface replacements in
    // long sessions; a node with a SMALLER seq than the running segment would
    // produce a reversed range (e.g. 110295..106762). Break the segment so
    // ranges always stay start <= end.
    if (cur !== null && seq < cur.start) {
      flush()
      cur = null
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
  const ledger = rebuildBlockLedger(session.events)
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
  const event = session.events[seq]
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
  const ledger = rebuildBlockLedger(session.events)
  const byId = new Map(ledger.map((entry) => [entry.blockId, entry]))
  const root = byId.get(blockId)
  if (root === undefined) return []
  const out: number[] = []
  const seen = new Set<string>()
  const visit = (entry: AcpBlockLedgerEntry): void => {
    if (seen.has(entry.blockId)) return
    seen.add(entry.blockId)
    for (const seq of entry.shadowedSeqs) {
      const childId = checkpointBlockIdOf(session.events, seq)
      const child = childId === null ? undefined : byId.get(childId)
      if (child !== undefined) visit(child)
      else out.push(seq)
    }
  }
  visit(root)
  return out
}
