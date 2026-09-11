/**
 * M3 — the four model tools: compress / decompress / search_context /
 * acp_status, registered through `ctx.tools` (defineTool).
 *
 * compress is the heart of ACP: the model writes the summary and the tool
 * lands it as a durable surface replacement (no second LLM summarization
 * call). decompress recovers shadowed content read-only from the log (DSH
 * keeps the originals — V5). search_context scores blocks rebuilt from the
 * log. acp_status reports the block ledger and pressure.
 * @module billion-context-dsh/tools
 */
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { type CompressionCore, type SearchDoc } from 'acp-kernel';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import type { AcpStateStore } from './state.ts';
import { type KernelConfigInput } from './config.ts';
import { type AcpWindow } from './window.ts';
import { type ResolvedPrompts } from './prompts.ts';
export interface ToolEnvironment extends KernelConfigInput {
    readonly kernel: CompressionCore;
    readonly store: AcpStateStore;
    /** Resolve the effective context window for an agent (optional: status falls back to modelContextLimit). */
    readonly windowFor?: (agent: Agent) => Promise<AcpWindow>;
    /** Resolved prompt templates (optional: falls back to DEFAULT_RESOLVED). */
    readonly prompts?: ResolvedPrompts;
    /**
     * Call ids of compress invocations that created a durable block. The engine
     * listens for the matching `tool/result` and hides the call/result pair from
     * the surface, preventing the compaction summary from sitting between them
     * (strict providers reject that sequence with HTTP 400).
     */
    readonly compressCallIdsToHide?: Set<string>;
}
/**
 * Resolve the effective context window for a tool or command run: probe the
 * agent's real window via `windowFor` when provided, otherwise fall back to
 * the environment's `modelContextLimit`. Shared by the compress and
 * acp_status tool handlers and the `/acp` command so the resolution logic
 * lives in exactly one place (issue #63 — the tools used the 128K fallback
 * for pressure decisions even when auto-detection had found a larger window).
 */
export declare function resolveEffectiveWindow(env: ToolEnvironment, agent: Agent): Promise<AcpWindow>;
/**
 * Pure gate helpers for the compress tool's CURRENT-instruction-row rejection.
 *
 * Decision history (issue #71 review): the first draft only WARNED when a
 * manual compress range swallowed a current injected row (F7), because the
 * compression is safe and self-healing. The owner reversed that during PR1
 * review: compressing a CURRENT row has NO legitimate outcome — the host
 * re-injects the newest AGENTS.md copy unconditionally the moment it leaves
 * the surface (presence gate, deepseek-harness
 * packages/context/agent-instructions/src/index.ts:137/:163), so the tokens
 * come straight back and the call is pure waste — and a hard reject keeps the
 * manual path consistent with the system-side GC's iron rule (PR2: never
 * clear a group's newest row). STALE copies stay compressible: removing them
 * while the newest stays visible is the actual cleanup and triggers no
 * re-injection. The range table (buildCompressibleSeqRanges) never offers
 * these rows, so the gate only fires on hand-built ranges.
 *
 * `guardedRowsInSpan` is the overlap probe. It takes the POSITIONAL span the
 * transaction will actually shadow (`shadowedSeqsOf`), never a numeric
 * `start <= seq <= end` interval: the surface is locally non-monotonic after
 * earlier replacements (a checkpoint seq spliced ahead of older residual
 * nodes), so a tier-2 distill of two checkpoints can carry a CURRENT
 * instruction row numerically inside its edges while the sliced span excludes
 * it — the interval probe rejected exactly the call the nudge hands the model
 * (issue #71 review B1). Probing the slice also keeps guard and effect in
 * agreement: `shadowedSeqsOf` is what the transaction prices and
 * `assertProvenance` verifies.
 * `protectedRowRejectionNote` renders the rejection the model sees: it names
 * the offending seqs AND the compressible slices left in the span, so the model
 * can re-cut (or split into two calls) instead of retrying the same call.
 * `guardedSurfaceSeqsOf` supplies the protected set.
 */
export declare function guardedRowsInSpan(guarded: ReadonlySet<number>, shadowed: readonly number[]): number[];
export declare function protectedRowRejectionNote(start: number, end: number, hits: readonly number[], shadowed: readonly number[]): string;
/**
 * Build the unified SearchDoc[] from the log: one block doc per ledger entry
 * (ref = compactionId, so `decompress({ blockId })` closes the loop) plus one
 * message doc per shadowed ORIGINAL (expanded through distilled parents; each
 * seq is claimed by the earliest/innermost block that covered it, mirroring
 * pi's owner map — decompress on that block recovers the original).
 * Cached per log snapshot (see searchDocsCache). Exported for the issue #133
 * regression tests (not part of the public API — index.ts re-exports only).
 */
export declare function buildSearchDocs(session: Session): SearchDoc[];
/** Build the four ACP model tools bound to one engine. */
export declare function makeTools(env: ToolEnvironment): ToolDefinition[];
