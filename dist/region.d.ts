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
import type { Session, SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session';
import { type ContentBlock } from '@deepseek-ai/dsh-llm';
/** One durable ACP block as rebuilt from the session log. */
export interface AcpBlockLedgerEntry {
    /** The compaction transaction id (stable block identity). */
    readonly blockId: string;
    readonly summary: string;
    /** The block's short label (kernel `CompressionBlock.topic`), when the compress request carried one. */
    readonly topic?: string;
    readonly shadowedSeqs: readonly number[];
    readonly shadowedTokenCount: number;
    readonly start: number;
    readonly end: number;
    /** Compression tier: 1 (message range), 2 (distills tier-1 blocks), 3 (distills tier-2 blocks). Legacy blocks default to 1. */
    readonly tier: 1 | 2 | 3;
    /** Compaction ids of the blocks this block distilled (parents). Empty for tier-1 blocks. */
    readonly parentBlockIds: readonly string[];
    /** The acp-kernel block id (`bN`) created for this transaction — absent for legacy blocks (synthesised by order). */
    readonly kernelBlockId?: string;
    /** The surface seq of this block's checkpoint summary node (derived from the log; null when the node is gone). */
    readonly summarySeq?: number;
    /** The kernel block's raw direct/effective message ids at creation (recorded since the tier feature; absent for legacy). */
    readonly directMessageIds?: readonly string[];
    readonly effectiveMessageIds?: readonly string[];
    /** Unix epoch ms of the compaction/summary event. */
    readonly createdAt: number;
}
/** The open turn number, or null when the log ends between turns. */
export declare function findOpenTurn(events: readonly SessionEvent[]): number | null;
/** Reject a second concurrent compaction for the same session. */
export declare function assertNoActiveCompaction(events: readonly SessionEvent[]): void;
/**
 * A requested range whose EVERY live message was already shadowed by one or
 * more blocks. The compress tool catches this and reports the range as already
 * compressed (with the covering block ids) instead of folding block summary
 * nodes as plain messages or erroring out. Distillation stays an explicit act:
 * target a LIVE checkpoint seq directly to distill (tier 2/3).
 */
export declare class AlreadyCompressedRangeError extends Error {
    readonly start: number;
    readonly end: number;
    readonly coveringBlockIds: readonly string[];
    constructor(start: number, end: number, coveringBlockIds: readonly string[]);
}
export interface ResolvedSurfaceRange {
    readonly start: number;
    readonly end: number;
    /**
     * True when the requested edges were not on the current surface and were
     * remapped to the still-live content of the requested span (an earlier
     * compression shadowed them). Callers surface this so the model sees what
     * was actually compressed instead of silently shadowing a different span.
     */
    readonly recovered?: boolean;
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
export declare function resolveSurfaceRange(session: Session, start: number, end: number): ResolvedSurfaceRange;
/** The surface seqs shadowed by the inclusive positional span. */
export declare function shadowedSeqsOf(session: Session, start: number, end: number): number[];
export interface CompactionTransactionInput {
    readonly start: number;
    readonly end: number;
    readonly shadowedSeqs: readonly number[];
    readonly summary: ContentBlock[];
    readonly shadowedTokenCount: number;
    readonly provider: string;
    readonly model: string;
    /** Short block label (kernel `CompressionBlock.topic`) — persisted so a restarted engine rehydrates it. */
    readonly topic?: string;
    /** Compression tier of this block (default 1). */
    readonly tier?: 1 | 2 | 3;
    /** The acp-kernel block id (`bN`) created by the kernel for this transaction. */
    readonly kernelBlockId?: string;
    /** Compaction ids of the blocks distilled into this one. */
    readonly parentBlockIds?: readonly string[];
    /** The kernel block's direct/effective message ids (raw CoreMessage ids) — recorded for faithful rehydration. */
    readonly directMessageIds?: readonly string[];
    readonly effectiveMessageIds?: readonly string[];
}
/**
 * ACP tier extension fields carried on `compaction/summary` events. The
 * upstream dsh-compaction event type does not know them, so reads and writes
 * go through this precise intersection (never `any`).
 */
export interface AcpCompactionSummaryFields {
    /** Compression tier (1/2/3) — 1 = message range, 2 = distills tier-1, 3 = distills tier-2. */
    readonly tier?: 1 | 2 | 3;
    /** Short block label (kernel `CompressionBlock.topic`) — the acp_status block title. */
    readonly topic?: string;
    /** The acp-kernel block id (`bN`) created for this transaction. */
    readonly kernelBlockId?: string;
    /** Durable compaction ids of the blocks distilled into this one. */
    readonly parentBlockIds?: readonly string[];
    /**
     * The kernel block's direct message ids (raw CoreMessage ids) at creation —
     * recorded so a restarted engine rehydrates the SAME coverage (a tier-2
     * block's coverage is its parents' originals, not the checkpoint node).
     */
    readonly directMessageIds?: readonly string[];
    /** The kernel block's effective message ids (raw CoreMessage ids) at creation. */
    readonly effectiveMessageIds?: readonly string[];
}
type CompactionSummaryData = SessionEventMap['compaction/summary'];
/** Read a `compaction/summary` event's data including the ACP tier extension fields. */
export declare function readCompactionSummary(event: SessionEvent): CompactionSummaryData & AcpCompactionSummaryFields;
/**
 * Run one durable compression transaction. Throws on invalid state; on success
 * the four events are in the log and the surface has one summary node.
 */
export declare function runCompactionTransaction(session: Session, input: CompactionTransactionInput): {
    compactionId: string;
    seqs: number[];
};
/** Rebuild the block ledger from the durable log (no kernel state needed). */
export declare function rebuildBlockLedger(events: readonly SessionEvent[]): AcpBlockLedgerEntry[];
/** One self-computed compressible span of the current surface. */
export interface SeqCompressibleRange {
    readonly start: number;
    readonly end: number;
    readonly count: number;
    readonly tokens: number;
    /** Share of messages that are tool messages (tool-call or tool-result), 0-100 — kernel `toolPct` parity. */
    readonly toolPct: number;
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
export declare function hideCompressToolPair(session: Session, callId: string, resultSeq?: number): boolean;
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
export declare function stripOrphanedSurfaceToolMessages(session: Session, inFlightCallIds?: ReadonlySet<string>): number;
/**
 * All tool-call ids currently visible on the surface with no matching
 * tool/result yet — the in-flight calls of the current step. Sibling tools
 * called in the same assistant message as `compress` are in-flight too, so
 * `handleCompress` must protect the whole set (not just its own call id) or
 * the sibling call would be pruned as an orphan and its result would land
 * orphaned (HTTP 400 until the next cleanup).
 */
export declare function openToolCallIds(session: Session): Set<string>;
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
export declare function deferCompressPairHide(session: Session, callId: string, resultSeq: number, onError?: (error: unknown) => void): void;
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
export declare function buildCompressibleSeqRanges(session: Session, opts?: {
    preserveRecent?: number;
}): SeqCompressibleRange[];
/**
 * A compact human-readable description of the current surface for the model:
 * node count plus the first/last message seqs. Surface seqs are sparse (the
 * event log interleaves non-message events and expanded delta batches), so a
 * model that never saw the nudge range table — e.g. low-pressure sessions
 * where no nudge fires — cannot guess its own seq space. acp_status and the
 * nudge's range table both surface this so compress edges can be located
 * without blind probing.
 */
export declare function surfaceSummary(session: Session): string;
/** One block as seen by the tier machinery: durable id ↔ kernel ref (`bN`). */
export interface AcpBlockRegistryEntry {
    /** The durable compaction id. */
    readonly blockId: string;
    /** The acp-kernel block ref (`bN`); synthesised by log order for legacy blocks. */
    readonly kernelBlockId: string;
    readonly tier: 1 | 2 | 3;
    /** The surface seq of this block's checkpoint summary node (null when gone). */
    readonly summarySeq: number | null;
    /** True until a LATER block distills this one. Only active blocks are distillable. */
    readonly active: boolean;
    readonly parentBlockIds: readonly string[];
}
/**
 * Rebuild the compactionId ↔ kernel-block-ref registry from the durable log.
 * Legacy blocks (pre-tier, no recorded `kernelBlockId`) are synthesised as
 * `b1`, `b2`, … in log order; recorded ids are kept as-is. A block is active
 * until a later block lists it as a parent.
 */
export declare function blockRegistry(session: Session): AcpBlockRegistryEntry[];
/**
 * The kernel block ref (`bN`) for a surface seq, when that seq is the
 * checkpoint summary node of a block — the edge the model must use to
 * distill (T2/T3). Active blocks distill; a stale (already-distilled) node
 * still maps to its `bN` so the kernel reports "already compressed" instead
 * of silently folding the summary as a plain message. Returns null for
 * anything else (plain messages, non-checkpoint nodes).
 */
export declare function blockRefForSummarySeq(session: Session, seq: number): string | null;
/** The durable compaction ids distilled by the given kernel block refs (`bN`). */
export declare function compactionIdsOfKernelBlocks(session: Session, kernelBlockIds: readonly string[]): string[];
/**
 * Resolve a kernel block ref (`bN`) — as shown by the model tool `acp_status`
 * (kernel `buildStatusReport` renders `block.blockId`) — to the durable
 * compaction id the decompress/search tools accept. Returns null when `bN` is
 * not an exact registry key (unknown ref). Only matches the canonical `bN`
 * form (`/^b\d+$/`); anything else is not a kernel ref and returns null so the
 * caller falls back to its compaction-id prefix match.
 */
export declare function blockIdOfKernelRef(session: Session, kernelRef: string): string | null;
/** The checkpoint summary seq of an ACTIVE kernel block (`bN`), or null. */
export declare function summarySeqOfKernelBlock(session: Session, kernelBlockId: string): number | null;
/**
 * The shadowed seqs of a block, recursing into distilled parent blocks: a
 * tier-2 block shadows its parent's checkpoint node, so recovering its
 * originals requires expanding that node into the parent block's own shadowed
 * seqs. Cycle-safe (a block can never be its own ancestor).
 */
export declare function expandShadowedSeqs(session: Session, blockId: string): number[];
export {};
