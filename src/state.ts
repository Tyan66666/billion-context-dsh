/**
 * M2 — per-session ACP kernel state.
 *
 * The in-memory map holds the exact acp-kernel `CompressionState` while a
 * session is live. Durability does not rely on a sidecar file: every durable
 * compression writes a `compaction/summary` event whose shadowed range and
 * summary re-derive the block ledger (`rebuildBlockLedger` in region.ts), so a
 * restarted engine can answer decompress/search/status from the session log
 * alone — DSH's "log is the source of truth" model.
 *
 * Tier-2/3 distillation additionally requires the kernel state to KNOW the
 * blocks: `syncBlocks` deactivates a block whose consumed messages are absent
 * from the message array, and `resolveBoundaries` refuses to anchor a block
 * ref it cannot find — so on first access for a session that already has
 * durable blocks (e.g. after a server restart), the kernel blocks are
 * REHYDRATED from the ledger before use. Live updates continue through `set`.
 * @module billion-context-dsh/state
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createInitialState, type CompressionBlock, type CompressionState } from 'acp-kernel'
import { rebuildBlockLedger } from './region.ts'

/** Rebuild kernel `CompressionBlock`s from the durable ledger (no kernel run needed). */
function rebuildKernelBlocks(events: readonly SessionEvent[]): CompressionBlock[] {
  const ledger = rebuildBlockLedger(events)
  if (ledger.length === 0) return []
  // Durable compactionId → kernel block ref (bN), recorded or synthesised.
  const kernelIdOf = new Map<string, string>()
  const parentKernelIds = new Map<string, string[]>()
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
    parentKernelIds.set(
      entry.blockId,
      entry.parentBlockIds
        .map((parent) => kernelIdOf.get(parent))
        .filter((id): id is string => id !== undefined),
    )
  }
  const consumed = new Set<string>()
  for (const entry of ledger) {
    for (const parent of entry.parentBlockIds) consumed.add(parent)
  }
  const blocks: CompressionBlock[] = []
  for (const entry of ledger) {
    const blockId = kernelIdOf.get(entry.blockId)!
    // The kernel anchors a block by its effectiveMessageIds. Since the tier
    // feature, the transaction records the kernel block's raw coverage
    // (direct/effective message ids) verbatim, so rehydration is faithful —
    // a tier-2 block's coverage is its parents' ORIGINALS, not the checkpoint
    // node it shadows. Legacy blocks fall back to the shadowed seqs (tier 1)
    // or the checkpoint node (tier > 1; multi-tool-call assistant messages in
    // legacy blocks lose bare-seq coverage — a documented legacy limitation).
    const direct = entry.directMessageIds ?? [...entry.shadowedSeqs.map(String)]
    const effective = entry.effectiveMessageIds
      ?? (entry.tier > 1
        ? (entry.summarySeq === undefined ? [...entry.shadowedSeqs.map(String)] : [String(entry.summarySeq)])
        : [...entry.shadowedSeqs.map(String)])
    blocks.push({
      blockId,
      runId: `r${blocks.length + 1}`,
      tier: entry.tier,
      summary: entry.summary,
      directMessageIds: [...direct],
      effectiveMessageIds: [...effective],
      directBlockIds: parentKernelIds.get(entry.blockId) ?? [],
      compressedTokens: entry.shadowedTokenCount,
      createdAt: entry.createdAt,
      survivedCount: 0,
      generation: 'young',
      active: !consumed.has(entry.blockId),
    })
  }
  return blocks
}

/** The next kernel block id after the rehydrated blocks (or the initial 1). */
function nextBlockIdAfter(events: readonly SessionEvent[]): number {
  const blocks = rebuildKernelBlocks(events)
  let max = 0
  for (const block of blocks) {
    const num = Number(block.blockId.slice(1))
    if (Number.isInteger(num)) max = Math.max(max, num)
  }
  return max + 1
}

export class AcpStateStore {
  private readonly states = new Map<string, CompressionState>()

  /** Kernel state for one session, initialised on first access. */
  stateFor(session: Session): CompressionState {
    const id = session.id
    const existing = this.states.get(id)
    if (existing !== undefined) return existing
    const state = createInitialState()
    if (session.events.some((event) => event.type === 'compaction/summary')) {
      state.blocks = rebuildKernelBlocks(session.events)
      state.nextBlockId = nextBlockIdAfter(session.events)
    }
    this.states.set(id, state)
    return state
  }

  set(session: Session, state: CompressionState): void {
    this.states.set(session.id, state)
  }

  delete(session: Session): void {
    this.states.delete(session.id)
  }
}
