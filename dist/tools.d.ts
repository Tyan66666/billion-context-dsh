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
export declare const compressParameters: {
    readonly arguments: {
        readonly type: 'json';
        readonly description: 'Tolerated wrapped-arguments form (model-generated); unwrapped in handleCompress. Prefer passing content directly.';
    };
    readonly topic: {
        readonly type: 'string';
        readonly description: 'Fallback topic for entries without their own.';
    };
    readonly content: {
        readonly type: 'array';
        readonly description: 'One or more ranges to compress, each with startSeq/endSeq boundaries (surface seqs) and a dense summary. Required — pass it directly, not wrapped in an arguments key.';
        readonly items: {
            readonly type: 'object';
            readonly properties: {
                readonly startSeq: {
                    readonly required: true;
                    readonly oneOf: readonly [{
                        readonly type: 'integer';
                        readonly description: 'First surface seq of the range.';
                    }, {
                        readonly type: 'string';
                        readonly description: 'Seq as text; a trailing #callId fragment is ignored.';
                    }];
                };
                readonly endSeq: {
                    readonly required: true;
                    readonly oneOf: readonly [{
                        readonly type: 'integer';
                        readonly description: 'Inclusive last surface seq of the range.';
                    }, {
                        readonly type: 'string';
                        readonly description: 'Seq as text; a trailing #callId fragment is ignored.';
                    }];
                };
                readonly summary: {
                    readonly type: 'string';
                    readonly required: true;
                    readonly description: 'Complete technical summary replacing the range; keep paths, decisions, values verbatim. Minimum 50 characters.';
                };
                readonly topic: {
                    readonly type: 'string';
                    readonly description: 'Short label (3-5 words) for this range.';
                };
                readonly verifiedReadings: {
                    readonly type: 'array';
                    readonly items: {
                        readonly type: 'string';
                    };
                    readonly description: 'Optional: acceptance readings that are already green before this compression (e.g. "t0-fastpath 8/8", "closedloop 414/414"). Stored structurally on the compaction/summary event and recovered by verifiedReadingsOf, so later steps need not re-run the checks.';
                };
            };
            readonly additionalProperties: false;
        };
    };
};
/** Build the four ACP model tools bound to one engine. */
export declare function makeTools(env: ToolEnvironment): ToolDefinition[];
