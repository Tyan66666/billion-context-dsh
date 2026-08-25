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
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { AcpStateStore } from './state.ts'
import { makeTools, type ToolEnvironment } from './tools.ts'
import { acpCommand } from './commands.ts'
import { buildNudge } from './nudge.ts'
import { buildIndexMessage, indexWatermarkOf, pendingToolTokenTotal, pendingTextTokenTotal, resolveMessageIndexConfig, type MessageIndexConfig, type ResolvedMessageIndexConfig } from './message-index.ts'
import { ACP_SYSTEM_PROMPT_ORDER } from './system-prompt.ts'
import { renderSystemPrompt, resolvePrompts, type AcpPrompts, type ResolvedPrompts } from './prompts.ts'
import { DEFAULT_CONTEXT_WINDOW, detectContextWindow, type AcpWindow } from './window.ts'
import { deferCompressPairHide, stripOrphanedSurfaceToolMessages } from './region.ts'

export { AcpStateStore } from './state.ts'
export { kernelConfigFor, type KernelConfigInput } from './config.ts'
export { ACP_SYSTEM_PROMPT, ACP_SYSTEM_PROMPT_ORDER } from './system-prompt.ts'
export {
  DEFAULT_PROMPTS,
  DEFAULT_RESOLVED,
  renderSystemPrompt,
  renderTemplate,
  resolvePrompts,
  type AcpPrompts,
  type NudgePrompts,
  type PromptInput,
  type PromptOverride,
  type RangeTablePrompts,
  type ResolvedPrompts,
  type ToolPrompts,
} from './prompts.ts'
export { makeTools, type ToolEnvironment } from './tools.ts'
export { acpCommand } from './commands.ts'
export { buildNudge, resolveTokenCount, type NudgeEnvironment, type NudgeOutcome } from './nudge.ts'
export {
  buildIndexMessage,
  collectIndexEntries,
  indexWatermarkOf,
  resolveMessageIndexConfig,
  truncateToTokenBudget,
  MESSAGE_INDEX_DEFAULTS,
  type IndexEntry,
  type MessageIndexConfig,
  type ResolvedMessageIndexConfig,
} from './message-index.ts'
export {
  DEFAULT_CONTEXT_WINDOW,
  detectContextWindow,
  windowSourceLabel,
  type AcpWindow,
} from './window.ts'
export {
  AlreadyCompressedRangeError,
  rebuildBlockLedger,
  resolveSurfaceRange,
  runCompactionTransaction,
  shadowedSeqsOf,
  findOpenTurn,
  assertNoActiveCompaction,
  blockRegistry,
  blockRefForSummarySeq,
  compactionIdsOfKernelBlocks,
  summarySeqOfKernelBlock,
  expandShadowedSeqs,
  hideCompressToolPair,
  stripOrphanedSurfaceToolMessages,
  type AcpBlockLedgerEntry,
  type CompactionTransactionInput,
  type ResolvedSurfaceRange,
} from './region.ts'
export { eventsToCoreMessages, projectEvent, surfaceEventsOf, extractEventText } from './messages.ts'

export interface AcpConfig {
  /**
   * The context window used for pressure decisions, in tokens. When omitted,
   * `autoModelContextLimit` (default true) probes the model's real window via
   * `agent.ctx.llm.resolveModelInfo(provider, model)`; an explicit value
   * always wins and disables the probe.
   */
  readonly modelContextLimit?: number
  /** Probe the model's real context window from the LLM runtime. Default true. */
  readonly autoModelContextLimit: boolean
  /** Nudge window lower bound (usage fraction; validation only — the growth-driven trigger has no percentage floor). Kernel default 0.45 — same as billion-context-pi. */
  readonly nudgeMinContextLimitPct?: number
  /**
   * Nudge window upper bound — over-limit guarantee line: above this the
   * kernel injects a nudge regardless of growth or cadence. Engine default
   * 0.70 (deliberately BELOW the kernel/billion-context-pi default 0.75 and
   * the host compaction-basic auto-compaction line 0.80, so the forced nudge
   * always fires first); an explicit value wins over this default — a
   * same-name key in `coreOverrides.nudge` wins over both (it merges last).
   */
  readonly nudgeMaxContextLimitPct?: number
  /**
   * Emergency nudge threshold (bypasses the per-turn dedup). Engine default
   * 0.85 (down from the kernel/billion-context-pi default 0.95: 95% leaves
   * the model no room to act before the API rejects, and the host's 80%
   * compaction-basic line shadows it in standard/code/cordis modes).
   */
  readonly nudgeEmergencyThresholdPct?: number
  /**
   * Any other acp-kernel Config override (billion-context-pi's `coreOverrides`
   * escape hatch). Merge order per section: kernel defaults → the engine pct
   * knobs above → these keys land LAST, so a same-name key here wins.
   */
  readonly coreOverrides?: Partial<import('acp-kernel').Config>
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
  readonly countTokens?: (text: string) => number
  /** Register the four model tools on `ctx.tools`. Default true. */
  readonly autoTools: boolean
  /** Register the `/acp` command on `ctx.commands`. Default true. */
  readonly autoCommand: boolean
  /** Inject the nudge into `agent/pre-step` when the kernel recommends it. Default true. */
  readonly autoNudge: boolean
  /**
   * Per-message numbering directory (acp-index): at the first pre-step of
   * each turn, one compact plugin message numbers every new surface node, so
   * the model can map seqs to content without a rewrite hook; token-delay
   * counters (`maxDelayToolTokens`, `maxDelayTextTokens`) additionally
   * re-inject mid-turn when a long tool run accumulates enough unindexed
   * content. See docs/message-index-design.md.
   */
  readonly messageIndex?: MessageIndexConfig
  /** Per-stage prompt template overrides (nudge / range table / system prompt / tool descriptions). See docs/configurable-prompts-design.md. */
  readonly prompts?: AcpPrompts
}

const DEFAULT_CONFIG: AcpConfig = {
  autoModelContextLimit: true,
  autoTools: true,
  autoCommand: true,
  autoNudge: true,
  // Nudge thresholds: engine defaults 0.70/0.85 — deliberately below the
  // kernel/billion-context-pi 0.75/0.95. 0.95 leaves no room to act before
  // the API rejects, and the host's compaction-basic line (thresholdRatio
  // 0.80) shadows it in standard/code/cordis modes; 0.70 keeps the forced
  // over-limit nudge ahead of that 80% line. Explicit values always win
  // against these defaults — `coreOverrides` merges last and beats them on
  // same-name keys.
  nudgeMaxContextLimitPct: 0.7,
  nudgeEmergencyThresholdPct: 0.85,
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
  /** Resolved prompt templates (validated at construction — fail-fast on template typos). */
  readonly prompts: ResolvedPrompts
  /**
   * The environment wired into tools / command / nudge. Exposed so tests (and
   * introspection) can assert the forwarding actually happened: the config
   * chain user config → this.config → env → kernelConfigFor is all OPTIONAL
   * fields, so a dropped forwarding line fails typecheck silently and would
   * revive lost-config bugs with every unit test green.
   */
  readonly env: ToolEnvironment
  /** Resolved acp-index options (per-message numbering directory). */
  readonly messageIndex: ResolvedMessageIndexConfig

  private readonly lastNudgeTurn = new Map<string, number>()
  /** Successful compress call ids awaiting their tool/result so the pair can be hidden. */
  private readonly compressCallIdsToHide = new Set<string>()
  /** Per provider/model route the resolved window (probe failures cached too). */
  private readonly windowCache = new Map<string, AcpWindow>()

  constructor(ctx: Context, config: Partial<AcpConfig> = {}) {
    super(ctx)
    this.config = resolveAcpConfig(config)
    // Resolve + validate prompt templates BEFORE building env: a template typo
    // must fail engine construction, never silently leak into model context.
    this.prompts = resolvePrompts(config.prompts)
    this.messageIndex = resolveMessageIndexConfig(config.messageIndex)
    const ports = this.config.countTokens !== undefined ? { countTokens: this.config.countTokens } : {}
    this.kernel = createCore(ports)
    this.store = new AcpStateStore()

    const env: ToolEnvironment = {
      kernel: this.kernel,
      store: this.store,
      // Initial value before any probe; windowFor() replaces it per pre-step.
      modelContextLimit: this.config.modelContextLimit ?? DEFAULT_CONTEXT_WINDOW,
      nudgeMinContextLimitPct: this.config.nudgeMinContextLimitPct,
      nudgeMaxContextLimitPct: this.config.nudgeMaxContextLimitPct,
      nudgeEmergencyThresholdPct: this.config.nudgeEmergencyThresholdPct,
      coreOverrides: this.config.coreOverrides,
      windowFor: (agent) => this.windowFor(agent),
      prompts: this.prompts,
      compressCallIdsToHide: this.compressCallIdsToHide,
    }
    this.env = env

    // Tools and commands may not be registered yet on cold start: cordis
    // starts unrelated composition rows concurrently, so the first
    // `ctx.get('tools')` can legitimately be undefined even though the row
    // ships later in the file. HMR-style reloads always see them (already
    // present), but a fresh process races — the tools silently vanished on
    // restart. Register eagerly, then re-attempt when the service appears
    // (`internal/service`) or the app finishes booting (`ready`); guard so a
    // late callback never double-registers.
    const tools = ctx.get('tools')
    if (tools !== undefined) {
      for (const tool of makeTools(env)) tools.register(tool)
    } else {
      let done = false
      const registerTools = (): void => {
        if (done) return
        const registry = ctx.get('tools')
        if (registry === undefined) return
        done = true
        for (const tool of makeTools(env)) registry.register(tool)
      }
      ctx.on('internal/service', (name: unknown) => {
        if (name === 'tools') registerTools()
      })
    }
    const commands = ctx.get('commands')
    if (commands !== undefined) {
      commands.register(acpCommand(env))
    } else {
      let done = false
      const registerCommand = (): void => {
        if (done) return
        const registry = ctx.get('commands')
        if (registry === undefined) return
        done = true
        registry.register(acpCommand(env))
      }
      ctx.on('internal/service', (name: unknown) => {
        if (name === 'commands') registerCommand()
      })
    }
    // After a successful compress tool result is appended, hide its
    // call/result pair. The durable summary node was inserted mid-turn (before
    // the result), so leaving the pair visible would put a user message between
    // an assistant tool_calls block and its tool response — strict providers
    // reject that request with HTTP 400 (issue #18).
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'tool/result') return
      const message = event.data.message
      const block = message.content[0]
      const callId = block?.toolCallId ?? message.source.callId
      if (typeof callId !== 'string' || !this.compressCallIdsToHide.has(callId)) return
      this.compressCallIdsToHide.delete(callId)
      // session.append is NOT reentrant: calling it synchronously inside this
      // session/event dispatch (the outer append still holds the reentry lock)
      // throws "session append cannot reenter while another append is being
      // published" on live, store-attached sessions, and the dispatcher
      // silently swallows the error — the hide would be a no-op. Defer it to a
      // microtask: microtasks drain after the append fully publishes and
      // before the agent loop resumes, so the pair is hidden before the next
      // request is built.
      deferCompressPairHide(session, callId, event.seq, (error) => {
        ctx.logger.warn(`billion-context-dsh: hide compress call/result pair failed: ${String(error)}`)
      })
    })
    ctx.on('agent/pre-step', async (payload, next) => {
      // A crash-interrupted tool leaves an orphan call/result on the surface:
      // it corrupts the pairing balance cache AND can 400 the next request
      // (strict providers reject tool messages without their call/response).
      // Clean them before EVERY step — not only when a nudge fires — so a
      // low-pressure session never hits the orphan 400 (issue #18). No call is
      // in flight at pre-step (the previous step's tools all landed), so the
      // default empty in-flight set is safe.
      stripOrphanedSurfaceToolMessages(payload.agent.session)
      const decision = await next()
      if (decision.kind === 'reject') return decision
      // Index first (reference data), nudge second (the actionable ask) — both
      // ride the SAME enter decision so the inbox batch is replaced exactly
      // once, and neither can land between a tool-call and its result (pre-step
      // runs before any call of the step; the durable appends are position-safe,
      // same envelope the nudge has always used).
      const extras: UserMessage[] = []
      // Cadence: the directory is emitted when the step claimed inbox input
      // (`payload.messages` — what the loop removed from the inbox for THIS
      // step: the first step of a turn, or a mid-turn follow-up), OR when a
      // token-delay guard trips. Per-turn alone leaves a very long turn (one
      // user message, dozens of internal tool rounds) unnumbered for tens of
      // thousands of tokens — the model loses seq↔content alignment mid-turn;
      // the guards re-inject on content volume even though tool continuation
      // steps claim nothing and would otherwise never emit a directory line.
      // Tool output (`maxDelayToolTokens`) and conversation messages
      // (`maxDelayTextTokens`, default 0 = conversation never trips) are
      // counted separately, and any counter crossing its threshold fires the
      // re-injection. Short turns never cross the thresholds, so per-turn-only
      // behavior is unchanged, and empty-claim wake-up rounds stay
      // synthetic-free (step 0 never trips the guard, so a host zero-cost wake
      // round with a stale watermark cannot be turned into a real model step).
      // The guard is lazy on purpose: when the step already claimed input the
      // directory WILL be built, so scanning the pending totals would be pure
      // waste; and when the index is disabled (the default) the whole block is
      // skipped, keeping the hot path at zero cost.
      const dueByTurn = payload.messages.length > 0
      let dueByDelay = false
      let watermark = 0
      if (!dueByTurn && this.messageIndex.enabled && payload.step > 0) {
        const { maxDelayToolTokens, maxDelayTextTokens } = this.messageIndex
        if (maxDelayToolTokens > 0 || maxDelayTextTokens > 0) {
          watermark = indexWatermarkOf(payload.agent.session)
          if (maxDelayToolTokens > 0) {
            dueByDelay = pendingToolTokenTotal(payload.agent.session, watermark, maxDelayToolTokens)
              >= maxDelayToolTokens
          }
          if (!dueByDelay && maxDelayTextTokens > 0) {
            dueByDelay = pendingTextTokenTotal(payload.agent.session, watermark, maxDelayTextTokens)
              >= maxDelayTextTokens
          }
        }
      }
      if (dueByTurn || dueByDelay) {
        const indexMessage = buildIndexMessage(payload.agent.session, this.messageIndex, watermark)
        if (indexMessage !== null) extras.push(indexMessage)
      }
      if (this.config.autoNudge) {
        const window = await this.windowFor(payload.agent)
        const outcome = buildNudge(payload.agent, { ...env, modelContextLimit: window.limit }, this.lastNudgeTurn)
        if (outcome !== null) extras.push(outcome.message)
      }
      if (extras.length === 0) return decision
      return { kind: 'enter', messages: [...decision.messages, ...extras] }
    })
    // The load-bearing ACP guidance lives in the system prompt ONCE; nudges
    // stay short and advisory (model-driven: the model decides). The
    // systemPrompt service may not be registered yet on cold start (cordis
    // starts unrelated composition rows concurrently), so apply the same
    // retry pattern as tools and commands: eager registration, then
    // re-attempt when the service appears via `internal/service`; guard so a
    // late callback never double-registers.
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined) {
      systemPrompt.section({
        name: 'billion-context-dsh',
        order: ACP_SYSTEM_PROMPT_ORDER,
        text: renderSystemPrompt(this.prompts),
      })
    } else {
      let done = false
      const registerSystemPrompt = (): void => {
        if (done) return
        const registry = ctx.get('systemPrompt')
        if (registry === undefined) return
        done = true
        registry.section({
          name: 'billion-context-dsh',
          order: ACP_SYSTEM_PROMPT_ORDER,
          text: renderSystemPrompt(this.prompts),
        })
      }
      ctx.on('internal/service', (name: unknown) => {
        if (name === 'systemPrompt') registerSystemPrompt()
      })
    }
  }

  /**
   * Resolve the effective context window for an agent. An explicitly
   * configured `modelContextLimit` always wins (no probe). Otherwise probe the
   * model's real window via `agent.ctx.llm.resolveModelInfo` (cached per
   * provider/model route, probe failures cached too) and fall back to
   * DEFAULT_CONTEXT_WINDOW when auto-detection is disabled or unavailable.
   */
  async windowFor(agent: Agent): Promise<AcpWindow> {
    if (this.config.modelContextLimit !== undefined) {
      return { limit: this.config.modelContextLimit, source: 'explicit' }
    }
    const provider = agent.options.provider ?? ''
    const model = agent.options.model ?? ''
    const key = `${provider}\0${model}`
    const cached = this.windowCache.get(key)
    if (cached !== undefined) return cached
    let window: AcpWindow
    if (!this.config.autoModelContextLimit) {
      window = { limit: DEFAULT_CONTEXT_WINDOW, source: 'default', provider, model }
    } else {
      const detected = await detectContextWindow(agent, provider, model)
      if (detected === null) {
        // Probe failures are cached below too, so the 128K fallback sticks for
        // the whole process lifetime — a gateway operator who fixes the model
        // API must restart (or set modelContextLimit) before the probe retries.
        // Warn loudly instead of failing silently: pressure numbers computed
        // against the fallback are what issue #63's false emergency nudges
        // came from (a gateway that disclosed no window read as ~55% of 128K
        // when the real window was 1M).
        this.ctx.logger.warn(
          `billion-context-dsh: context-window auto-detection failed for ${provider}/${model} — using the ${DEFAULT_CONTEXT_WINDOW} fallback (restart to re-probe, or set modelContextLimit explicitly)`,
        )
        window = { limit: DEFAULT_CONTEXT_WINDOW, source: 'default', provider, model, probeFailed: true }
      } else {
        window = { limit: detected, source: 'auto', provider, model }
      }
    }
    this.windowCache.set(key, window)
    return window
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
