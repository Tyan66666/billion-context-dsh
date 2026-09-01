/**
 * M4 — ACP nudge: the kernel's compression recommendation, rendered as an
 * injected user message with a seq-based compressible-range table (D1:
 * "seq is the ref" — DSH has no in-memory message rewrite hook, so the model
 * targets ranges by surface seq rather than by <acp> tags).
 * @module billion-context-dsh/nudge
 */
import { type CompressionCore, type CoreMessage, type NudgeDecision } from 'acp-kernel';
import { type UserMessage } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { AcpStateStore } from './state.ts';
import { type KernelConfigInput } from './config.ts';
import { type ResolvedPrompts } from './prompts.ts';
/** Kernel inputs the nudge path shares with the compress tool. */
export interface NudgeEnvironment extends KernelConfigInput {
    readonly kernel: CompressionCore;
    readonly store: AcpStateStore;
    /** Resolved prompt templates (optional: falls back to DEFAULT_RESOLVED). */
    readonly prompts?: ResolvedPrompts;
}
export interface NudgeOutcome {
    readonly message: UserMessage;
    readonly emergency: boolean;
}
/**
 * Resolve the best available token count for ACP pressure decisions.
 *
 * Priority chain:
 * 1. `sessionProjections.contextPressure.projectedTokens` — matches the UI's
 *    context-occupancy display (includes fixed overhead: system prompt, tool
 *    definitions, AGENTS.md, etc.). Provider-anchored; reacts to compaction.
 * 2. `tokenMeter.measure(session).surfaceTokens` — heuristic surface-only
 *    estimate (pure conversation messages, no fixed overhead). Falls back
 *    when sessionProjections is unavailable or has no provider anchor yet.
 * 3. `defaultCountTokens` character heuristic — last resort for tests and
 *    minimal hosts that lack the token-meter service.
 */
export declare function resolveTokenCount(agent: Agent, coreMessages: CoreMessage[]): number;
/**
 * Render the compressible-range table as seq refs for the model.
 * Computed directly from the surface (not the kernel's ref map, which can
 * drift and hide large tool results) — see buildCompressibleSeqRanges.
 * UPSTREAM: this self-computation is a labeled workaround for kernel
 * ref-map drift after surface replacements (AGENTS.md rule 11) — drop it and
 * use kernel compressibleRanges once the drift is fixed upstream.
 */
export declare function rangeTable(session: import('@deepseek-ai/dsh-session').Session, prompts?: ResolvedPrompts): string;
/**
 * Decide and build one nudge message for the agent's next pre-step. Returns
 * null when the kernel recommends no nudge or one was already injected for the
 * current turn (emergency nudges always bypass the dedup). Also advances the
 * in-memory kernel state (ref assignment) so the compress tool can resolve
 * seq → mNNNNN refs.
 */
export declare function buildNudge(agent: Agent, env: NudgeEnvironment, lastNudgeTurn: Map<string, number>): NudgeOutcome | null;
/**
 * Render the nudge message text. DEFAULT (no `config.prompts.nudge` override)
 * calls the kernel's own `renderNudgeText` — EFFICIENCY_NOTE/EMERGENCY_HEADER,
 * context breakdown, HOW_TO_COMPRESS_RULES, tier rules, and the batch tip all
 * come from acp-kernel verbatim (the kernel-alignment principle). Only the
 * ref-ID-oriented segments are replaced with our seq-based equivalents,
 * because DSH has no `<acp>` ref tags — see docs/dsh-porting-verification.md:
 * - `rangesStr` (mNNNNN refs) → the surface-seq range table;
 * - the emergency JSON example (startId/endId) → a seq example;
 * - the tier trigger block (block ids bN) → our tier line with surface seqs.
 * When a host overrides any `prompts.nudge` slot, the template path is used so
 * `config.prompts` keeps full control (custom copy wins over kernel defaults).
 */
export declare function buildNudgeText(nudge: NudgeDecision, emergency: boolean, session: import('@deepseek-ai/dsh-session').Session, prompts?: ResolvedPrompts): string;
