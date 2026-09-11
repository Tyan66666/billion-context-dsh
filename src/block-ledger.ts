/**
 * M5 support — durable block-ledger encoding inside `compaction/summary`.
 *
 * The frozen released-v0 reader (`@deepseek-ai/dsh-session-format-v0-to-v1`)
 * validates every `compaction/summary` payload against an EXACT member
 * allow-list and rejects the first member outside it (issue #141). The six ACP
 * tier/lineage fields used to be written as top-level members, which bricked
 * every pre-upgrade v0 session log the moment the host switched to that
 * reader.
 *
 * The fix moves those fields OUT of the top-level members and INTO the already
 * admitted optional `rawOutput` member, as one text content block carrying a
 * namespaced JSON object. The frozen reader sees only admitted members; the
 * namespaced payload survives losslessly and round-trips back through
 * {@link decodeAcpBlockLedger}. `compaction/*` events are log-only, so this
 * block is inert to the model and to surface derivation — pure durable storage.
 *
 * Decode is strict on the marker/version but lenient per-field, and it NEVER
 * throws: an unknown/absent marker or a future version yields "no ledger data"
 * (the caller falls back to tier-1 reconstruction). Old files and future format
 * generations must degrade, not brick.
 * @module billion-context-dsh/block-ledger
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** Marker key identifying an ACP block-ledger payload inside a `compaction/summary` rawOutput text block. */
export const ACP_BLOCK_LEDGER_MARKER = '$dshAcpBlockLedger'
/** Current block-ledger payload version. Bump (and add a legacy reader) when the shape changes. */
export const ACP_BLOCK_LEDGER_VERSION = 1

/**
 * The six ACP tier/lineage fields carried durably per compressed block so a
 * restarted engine rehydrates the SAME kernel blocks (tier, lineage, coverage)
 * instead of collapsing everything to tier 1.
 */
export interface AcpBlockLedgerPayload {
  /** Compression tier: 1 (message range), 2 (distills tier-1), 3 (distills tier-2). */
  readonly tier?: 1 | 2 | 3
  /** The acp-kernel block id (`bN`) created for this transaction. */
  readonly kernelBlockId?: string
  /** Short block label (kernel `CompressionBlock.topic`). */
  readonly topic?: string
  /** Durable compaction ids of the blocks distilled into this one. */
  readonly parentBlockIds?: readonly string[]
  /** The kernel block's direct message ids at creation (raw CoreMessage ids). */
  readonly directMessageIds?: readonly string[]
  /** The kernel block's effective message ids at creation (raw CoreMessage ids). */
  readonly effectiveMessageIds?: readonly string[]
}

/** True only for an array whose every element is a string. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * Encode the block-ledger fields as a single text content block whose text is a
 * namespaced JSON object. The marker + version are always present so decode can
 * recognise the payload; empty/absent fields are omitted to keep it minimal.
 * The offline recovery normalizer reuses this exact encoder so rescued files
 * match what a live engine writes (no shape drift).
 */
export function encodeAcpBlockLedger(payload: AcpBlockLedgerPayload): ContentBlock[] {
  const obj: Record<string, unknown> = { [ACP_BLOCK_LEDGER_MARKER]: ACP_BLOCK_LEDGER_VERSION }
  if (payload.tier !== undefined) obj.tier = payload.tier
  if (payload.kernelBlockId !== undefined) obj.kernelBlockId = payload.kernelBlockId
  if (payload.topic !== undefined) obj.topic = payload.topic
  if (payload.parentBlockIds !== undefined && payload.parentBlockIds.length > 0) {
    obj.parentBlockIds = [...payload.parentBlockIds]
  }
  if (payload.directMessageIds !== undefined) obj.directMessageIds = [...payload.directMessageIds]
  if (payload.effectiveMessageIds !== undefined) obj.effectiveMessageIds = [...payload.effectiveMessageIds]
  return [{ type: 'text', text: JSON.stringify(obj) }]
}

/**
 * Decode + validate the block-ledger payload out of a `compaction/summary`
 * `rawOutput` value read back from the log. Scans the content blocks for the
 * namespaced JSON object, checks the marker/version strictly, accepts each field
 * only if well-typed, and returns `{}` (no ledger data) on ANY problem — it
 * never throws, because old files and future format generations must degrade to
 * the tier-1 fallback rather than brick the session.
 */
export function decodeAcpBlockLedger(rawOutput: unknown): AcpBlockLedgerPayload {
  try {
    if (!Array.isArray(rawOutput)) return {}
    for (const block of rawOutput) {
      if (block === null || typeof block !== 'object') continue
      const candidate = block as { type?: unknown; text?: unknown }
      if (candidate.type !== 'text' || typeof candidate.text !== 'string') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(candidate.text)
      } catch {
        continue // not JSON — not our payload; keep scanning
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const record = parsed as Record<string, unknown>
      if (record[ACP_BLOCK_LEDGER_MARKER] !== ACP_BLOCK_LEDGER_VERSION) continue
      // Mutable accumulator (the public payload type is readonly); returning it
      // satisfies AcpBlockLedgerPayload because mutable props are assignable to readonly.
      const result: {
        tier?: 1 | 2 | 3
        kernelBlockId?: string
        topic?: string
        parentBlockIds?: string[]
        directMessageIds?: string[]
        effectiveMessageIds?: string[]
      } = {}
      if (record.tier === 1 || record.tier === 2 || record.tier === 3) result.tier = record.tier
      if (typeof record.kernelBlockId === 'string') result.kernelBlockId = record.kernelBlockId
      if (typeof record.topic === 'string') result.topic = record.topic
      if (isStringArray(record.parentBlockIds)) result.parentBlockIds = [...record.parentBlockIds]
      if (isStringArray(record.directMessageIds)) result.directMessageIds = [...record.directMessageIds]
      if (isStringArray(record.effectiveMessageIds)) result.effectiveMessageIds = [...record.effectiveMessageIds]
      return result
    }
    return {}
  } catch {
    return {}
  }
}
