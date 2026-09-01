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
import { type CompressionCore } from 'acp-kernel';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { AcpStateStore } from './state.ts';
import { type KernelConfigInput } from './config.ts';
import type { AcpWindow } from './window.ts';
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
 * `currentInstructionRowsInSpan` is the overlap probe over the RESOLVED span
 * (shrink-then-expand may move edges, so the requested span is not enough);
 * `protectedRowRejectionNote` renders the rejection the model sees — it must
 * name the seqs and point at the stale-copy alternative so the model can
 * re-cut instead of retrying the same call. `guardedSurfaceSeqsOf` supplies
 * the protected set.
 */
export declare function currentInstructionRowsInSpan(guarded: ReadonlySet<number>, start: number, end: number): number[];
export declare function protectedRowRejectionNote(start: number, end: number, hits: readonly number[]): string;
/** Build the four ACP model tools bound to one engine. */
export declare function makeTools(env: ToolEnvironment): ToolDefinition[];
