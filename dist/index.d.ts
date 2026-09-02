/**
 * billion-context-dsh — Active Context Pruning (ACP) for the DeepSeek Harness,
 * delivered as a `CompactionEngine` backend.
 *
 * The model decides when and what to compress (pure ACP semantics):
 *  - the `compress` tool durably shadows a surface range with the model-written
 *    summary (no second LLM summarization call — the ACP cost win);
 *  - the original events stay in the append-only session log, so `decompress`,
 *    `search_context`, and replay always work;
 *  - refs are surface seqs carried by the injected nudge's range table (DSH
 *    has no in-memory message rewrite hook — see docs/dsh-porting-verification.md);
 *  - automatic policy never summarizes by itself: it nudges the model.
 *
 * Mount it wherever a compaction backend is expected:
 *
 * ```yaml
 * - id: compaction-billion-context
 *   name: 'billion-context-dsh'
 *   config:
 *     modelContextLimit: 128000
 * ```
 *
 * The package registers `ctx.compaction` plus the four model tools and the
 * `/acp` command when the hosting composition provides `ctx.tools` /
 * `ctx.commands`.
 * @module billion-context-dsh
 */
import type { Context } from '@deepseek-ai/cordis';
import { CompactionEngine, type CompactionAgentContext, type CompactionResult, type CompactionTrigger, type ManualCompactAgentContext } from '@deepseek-ai/dsh-compaction';
import { type CompressionCore } from 'acp-kernel';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { AcpStateStore } from './state.ts';
import { type ToolEnvironment } from './tools.ts';
import { type AcpPrompts, type ResolvedPrompts } from './prompts.ts';
import { type AcpWindow } from './window.ts';
export { AcpStateStore } from './state.ts';
export { kernelConfigFor, type KernelConfigInput } from './config.ts';
export { ACP_SYSTEM_PROMPT, ACP_SYSTEM_PROMPT_ORDER } from './system-prompt.ts';
export { DEFAULT_PROMPTS, DEFAULT_RESOLVED, renderSystemPrompt, renderTemplate, resolvePrompts, type AcpPrompts, type NudgePrompts, type PromptInput, type PromptOverride, type RangeTablePrompts, type ResolvedPrompts, type ToolPrompts, } from './prompts.ts';
export { makeTools, type ToolEnvironment } from './tools.ts';
export { acpCommand } from './commands.ts';
export { buildNudge, resolveTokenCount, type NudgeEnvironment, type NudgeOutcome } from './nudge.ts';
export { DEFAULT_CONTEXT_WINDOW, detectContextWindow, projectedContextWindow, windowSourceLabel, type AcpWindow, } from './window.ts';
export { AlreadyCompressedRangeError, rebuildBlockLedger, resolveSurfaceRange, runCompactionTransaction, shadowedSeqsOf, findOpenTurn, assertNoActiveCompaction, blockRegistry, blockRefForSummarySeq, compactionIdsOfKernelBlocks, summarySeqOfKernelBlock, expandShadowedSeqs, hideCompressToolPair, stripOrphanedSurfaceToolMessages, type AcpBlockLedgerEntry, type CompactionTransactionInput, type ResolvedSurfaceRange, } from './region.ts';
export { eventsToCoreMessages, projectEvent, surfaceEventsOf, extractEventText } from './messages.ts';
export interface AcpConfig {
    /**
     * The context window used for pressure decisions, in tokens. When omitted,
     * `autoModelContextLimit` (default true) resolves it automatically: the live
     * host session projection (`contextPressure.contextWindow`) is preferred,
     * then the model's real window is probed via
     * `agent.ctx.llm.resolveModelInfo(provider, model)`; an explicit value
     * always wins and disables both.
     */
    readonly modelContextLimit?: number;
    /** Auto-resolve the real context window: host session projection first, then the LLM runtime probe. Default true. */
    readonly autoModelContextLimit: boolean;
    /** Nudge window lower bound (usage fraction; validation only — the growth-driven trigger has no percentage floor). Kernel default 0.45 — same as billion-context-pi. */
    readonly nudgeMinContextLimitPct?: number;
    /**
     * Nudge window upper bound — over-limit guarantee line: above this the
     * kernel injects a nudge regardless of growth or cadence. Engine default
     * 0.70 (deliberately BELOW the kernel/billion-context-pi default 0.75 and
     * the host compaction-basic auto-compaction line 0.80, so the forced nudge
     * always fires first); an explicit value wins over this default — a
     * same-name key in `coreOverrides.nudge` wins over both (it merges last).
     */
    readonly nudgeMaxContextLimitPct?: number;
    /**
     * Emergency nudge threshold (bypasses the per-turn dedup). Engine default
     * 0.85 (down from the kernel/billion-context-pi default 0.95: 95% leaves
     * the model no room to act before the API rejects, and the host's 80%
     * compaction-basic line shadows it in standard/code/cordis modes).
     */
    readonly nudgeEmergencyThresholdPct?: number;
    /**
     * Any other acp-kernel Config override (billion-context-pi's `coreOverrides`
     * escape hatch). Merge order per section: kernel defaults → the engine pct
     * knobs above → these keys land LAST, so a same-name key here wins.
     */
    readonly coreOverrides?: Partial<import('acp-kernel').Config>;
    /**
     * Custom token-count function for the kernel's internal estimation.
     * Defaults to the kernel's `defaultCountTokens` (CJK: 1 char = 1 token,
     * other: 4 chars = 1 token — aligns with billion-context-pi).
     * Can be overridden for provider-specific tokenization, e.g. DeepSeek's
     * official coefficient: 1 CJK char ≈ 0.6 tokens, 1 other char ≈ 0.3 tokens.
     * Only affects the kernel's internal estimation (compressible range sizing,
     * nudge text, growth branch pending); the `projectedTokens` reading from
     * `sessionProjections` (used for nudge pressure decisions and acp_status)
     * is provider-anchored and unaffected by this function.
     */
    readonly countTokens?: (text: string) => number;
    /** Register the four model tools on `ctx.tools`. Default true. */
    readonly autoTools: boolean;
    /** Register the `/acp` command on `ctx.commands`. Default true. */
    readonly autoCommand: boolean;
    /** Inject the nudge into `agent/pre-step` when the kernel recommends it. Default true. */
    readonly autoNudge: boolean;
    /** Per-stage prompt template overrides (nudge / range table / system prompt / tool descriptions). See docs/configurable-prompts-design.md. */
    readonly prompts?: AcpPrompts;
}
export declare function resolveAcpConfig(config?: Partial<AcpConfig>): AcpConfig;
/**
 * The ACP compaction backend. Subclasses the seam exactly like
 * `dsh-compaction-basic`; swaps summarization-driven compaction for
 * model-driven block compression without touching the agent loop.
 */
export declare class AcpCompactionEngine extends CompactionEngine {
    /** The framework-agnostic ACP compression core, reused verbatim. */
    readonly kernel: CompressionCore;
    /** Per-session kernel state. */
    readonly store: AcpStateStore;
    /** Resolved engine configuration. */
    readonly config: AcpConfig;
    /** Resolved prompt templates (validated at construction — fail-fast on template typos). */
    readonly prompts: ResolvedPrompts;
    /**
     * The environment wired into tools / command / nudge. Exposed so tests (and
     * introspection) can assert the forwarding actually happened: the config
     * chain user config → this.config → env → kernelConfigFor is all OPTIONAL
     * fields, so a dropped forwarding line fails typecheck silently and would
     * revive lost-config bugs with every unit test green.
     */
    readonly env: ToolEnvironment;
    private readonly lastNudgeTurn;
    /** Successful compress call ids awaiting their tool/result so the pair can be hidden. */
    private readonly compressCallIdsToHide;
    /** Per provider/model route the resolved window (probe failures cached too). */
    private readonly windowCache;
    constructor(ctx: Context, config?: Partial<AcpConfig>);
    /**
     * Resolve the effective context window for an agent. An explicitly
     * configured `modelContextLimit` always wins (no probe). Otherwise the live
     * session projection (`contextPressure.contextWindow`) is preferred when it
     * discloses one — it tracks the session's CURRENT route, so a mid-session
     * model switch repairs itself without a restart or config (see
     * projectedContextWindow). Falls back to probing the model's real window
     * via `agent.ctx.llm.resolveModelInfo` (cached per provider/model route,
     * probe failures cached too) and finally to DEFAULT_CONTEXT_WINDOW when
     * auto-detection is disabled or unavailable.
     */
    windowFor(agent: Agent): Promise<AcpWindow>;
    /** ACP is model-driven: automatic pressure policy never summarizes by itself. */
    compactIfNeeded(_agent: CompactionAgentContext, _trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null>;
    /** Explicit idle-session compaction: ACP leaves the decision to the model. */
    compactNow(_agent: ManualCompactAgentContext, signal: AbortSignal): Promise<CompactionResult | null>;
    /**
     * The model-driven path lands through the `compress` tool, which runs the
     * full durable transaction directly. This seam method rejects with guidance:
     * automatic summarization is exactly what ACP replaces.
     */
    compactRegion(_start: number, _end: number, _agent: CompactionAgentContext, signal?: AbortSignal): Promise<CompactionResult>;
}
export default AcpCompactionEngine;
