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

import type { Context } from '@deepseek-ai/cordis'
import {
  CompactionEngine,
  ManualCompactionError,
  type CompactionAgentContext,
  type CompactionResult,
  type CompactionTrigger,
  type ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import { createCore, type CompressionCore } from 'acp-kernel'
import type {} from '@deepseek-ai/dsh-agent'
import { AcpStateStore } from './state.ts'
import { makeTools, type ToolEnvironment } from './tools.ts'
import { acpCommand } from './commands.ts'
import { buildNudge } from './nudge.ts'

export { AcpStateStore } from './state.ts'
export { kernelConfigFor, type KernelConfigInput } from './config.ts'
export { makeTools, type ToolEnvironment } from './tools.ts'
export { acpCommand } from './commands.ts'
export { buildNudge, type NudgeEnvironment, type NudgeOutcome } from './nudge.ts'
export {
  rebuildBlockLedger,
  resolveSurfaceRange,
  runCompactionTransaction,
  shadowedSeqsOf,
  findOpenTurn,
  assertNoActiveCompaction,
  type AcpBlockLedgerEntry,
  type CompactionTransactionInput,
} from './region.ts'
export { eventsToCoreMessages, projectEvent, surfaceEventsOf, extractEventText } from './messages.ts'

export interface AcpConfig {
  /** The context window used for pressure decisions. Default 128000. */
  readonly modelContextLimit: number
  /** Nudge window lower bound (usage fraction). Kernel default 0.45 — same as billion-context-pi. */
  readonly nudgeMinContextLimitPct?: number
  /** Nudge window upper bound (over-limit). Kernel default 0.75 — same as billion-context-pi. */
  readonly nudgeMaxContextLimitPct?: number
  /** Emergency nudge threshold (bypasses per-turn dedup). Kernel default 0.95 — same as billion-context-pi. */
  readonly nudgeEmergencyThresholdPct?: number
  /** Any other acp-kernel Config override (billion-context-pi's `coreOverrides` escape hatch). */
  readonly coreOverrides?: Partial<import('acp-kernel').Config>
  /** Register the four model tools on `ctx.tools`. Default true. */
  readonly autoTools: boolean
  /** Register the `/acp` command on `ctx.commands`. Default true. */
  readonly autoCommand: boolean
  /** Inject the nudge into `agent/pre-step` when the kernel recommends it. Default true. */
  readonly autoNudge: boolean
}

const DEFAULT_CONFIG: AcpConfig = {
  modelContextLimit: 128000,
  autoTools: true,
  autoCommand: true,
  autoNudge: true,
}

export function resolveAcpConfig(config: Partial<AcpConfig> = {}): AcpConfig {
  return { ...DEFAULT_CONFIG, ...config }
}

/**
 * The ACP compaction backend. Subclasses the seam exactly like
 * `dsh-compaction-basic`; swaps summarization-driven compaction for
 * model-driven block compression without touching the agent loop.
 */
export class AcpCompactionEngine extends CompactionEngine {
  /** The framework-agnostic ACP compression core, reused verbatim. */
  readonly kernel: CompressionCore
  /** Per-session kernel state. */
  readonly store: AcpStateStore
  /** Resolved engine configuration. */
  readonly config: AcpConfig

  private readonly lastNudgeTurn = new Map<string, number>()

  constructor(ctx: Context, config: Partial<AcpConfig> = {}) {
    super(ctx)
    this.config = resolveAcpConfig(config)
    this.kernel = createCore({})
    this.store = new AcpStateStore()

    const env: ToolEnvironment = {
      kernel: this.kernel,
      store: this.store,
      modelContextLimit: this.config.modelContextLimit,
      nudgeMinContextLimitPct: this.config.nudgeMinContextLimitPct,
      nudgeMaxContextLimitPct: this.config.nudgeMaxContextLimitPct,
      nudgeEmergencyThresholdPct: this.config.nudgeEmergencyThresholdPct,
      coreOverrides: this.config.coreOverrides,
    }

    if (this.config.autoTools) {
      const tools = ctx.get('tools')
      if (tools !== undefined) {
        for (const tool of makeTools(env)) tools.register(tool)
      }
    }
    if (this.config.autoCommand) {
      const commands = ctx.get('commands')
      if (commands !== undefined) commands.register(acpCommand(env))
    }
    if (this.config.autoNudge) {
      ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        if (decision.kind === 'reject') return decision
        const outcome = buildNudge(payload.agent, env, this.lastNudgeTurn)
        if (outcome === null) return decision
        return { kind: 'enter', messages: [...decision.messages, outcome.message] }
      })
    }
  }

  /** ACP is model-driven: automatic pressure policy never summarizes by itself. */
  override async compactIfNeeded(
    _agent: CompactionAgentContext,
    _trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    return null
  }

  /** Explicit idle-session compaction: ACP leaves the decision to the model. */
  override async compactNow(
    _agent: ManualCompactAgentContext,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    return null
  }

  /**
   * The model-driven path lands through the `compress` tool, which runs the
   * full durable transaction directly. This seam method rejects with guidance:
   * automatic summarization is exactly what ACP replaces.
   */
  override async compactRegion(
    _start: number,
    _end: number,
    _agent: CompactionAgentContext,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    signal?.throwIfAborted()
    throw new ManualCompactionError(
      'summary',
      'billion-context-dsh is model-driven: use the compress tool instead of automatic summarization',
    )
  }
}

export default AcpCompactionEngine
