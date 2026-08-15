/**
 * M4 — ACP nudge: the kernel's compression recommendation, rendered as an
 * injected user message with a seq-based compressible-range table (D1:
 * "seq is the ref" — DSH has no in-memory message rewrite hook, so the model
 * targets ranges by surface seq rather than by <acp> tags).
 * @module billion-context-dsh/nudge
 */

import {
  COMPRESS_PHILOSOPHY,
  TIER2_DISTILL_RULES,
  TIER3_CONDENSE_RULES,
  defaultCountTokens,
  type CompressionCore,
  type CoreMessage,
  type NudgeDecision,
} from 'acp-kernel'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AcpStateStore } from './state.ts'
import { allLogMessages, eventsToCoreMessages, surfaceEventsOf } from './messages.ts'
import { buildCompressibleSeqRanges, findOpenTurn, summarySeqOfKernelBlock, surfaceSummary } from './region.ts'
import { kernelConfigFor, type KernelConfigInput } from './config.ts'
import { DEFAULT_RESOLVED, renderTemplate, type ResolvedPrompts } from './prompts.ts'

/** Kernel inputs the nudge path shares with the compress tool. */
export interface NudgeEnvironment extends KernelConfigInput {
  readonly kernel: CompressionCore
  readonly store: AcpStateStore
  /** Resolved prompt templates (optional: falls back to DEFAULT_RESOLVED). */
  readonly prompts?: ResolvedPrompts
}

export interface NudgeOutcome {
  readonly message: UserMessage
  readonly emergency: boolean
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
export function resolveTokenCount(agent: Agent, coreMessages: CoreMessage[]): number {
  // 1. Prefer sessionProjections.contextPressure.projectedTokens (matches UI).
  const projections = agent.ctx?.get?.('sessionProjections') as
    | { snapshot?: (session: unknown) => { values?: { contextPressure?: { projectedTokens?: number } } } }
    | undefined
  const projected = projections?.snapshot?.(agent.session)?.values?.contextPressure?.projectedTokens
  if (typeof projected === 'number' && projected > 0) return projected

  // 2. Fallback to tokenMeter surfaceTokens (heuristic, no fixed overhead).
  const meter = agent.ctx?.get?.('tokenMeter') as
    | { measure?: (session: unknown) => { surfaceTokens?: number } }
    | undefined
  const surface = meter?.measure?.(agent.session)?.surfaceTokens
  if (typeof surface === 'number' && surface > 0) return surface

  // 3. Last resort: character heuristic.
  return coreMessages.reduce((sum, message) => sum + defaultCountTokens(message.text ?? ''), 0)
}

/**
 * Render the compressible-range table as seq refs for the model.
 * Computed directly from the surface (not the kernel's ref map, which can
 * drift and hide large tool results) — see buildCompressibleSeqRanges.
 */
export function rangeTable(
  session: import('@deepseek-ai/dsh-session').Session,
  prompts: ResolvedPrompts = DEFAULT_RESOLVED,
): string {
  const ranges = buildCompressibleSeqRanges(session).slice(0, 6)
  // 零范围:整块省略(保留现状的提前返回与 nudge 尾部 '\n')。
  if (ranges.length === 0) return ''
  const lines = ranges.map((range) =>
    renderTemplate(prompts.rangeTable.line, {
      start: range.start,
      end: range.end,
      count: range.count,
      tokens: range.tokens,
    }),
  )
  return [
    // 前导空串元素产生 nudge 中范围表前的唯一空行(§4:parts 层不再加分隔)。
    '',
    renderTemplate(prompts.rangeTable.header, { surface: surfaceSummary(session) }),
    renderTemplate(prompts.rangeTable.title, { count: ranges.length }),
    ...lines,
    prompts.rangeTable.footer,
  ].join('\n')
}

/**
 * The token count driving pressure decisions. Prefer `resolveTokenCount` which
 * uses `sessionProjections.contextPressure.projectedTokens` (matches the UI's
 * context-occupancy display, including fixed overhead). Falls back to
 * `tokenMeter.measure(session).surfaceTokens`, then `defaultCountTokens`
 * character heuristic for tests and minimal hosts.
 */
function measuredTokenCount(agent: Agent, coreMessages: CoreMessage[]): number {
  return resolveTokenCount(agent, coreMessages)
}

/**
 * Decide and build one nudge message for the agent's next pre-step. Returns
 * null when the kernel recommends no nudge or one was already injected for the
 * current turn (emergency nudges always bypass the dedup). Also advances the
 * in-memory kernel state (ref assignment) so the compress tool can resolve
 * seq → mNNNNN refs.
 */
export function buildNudge(
  agent: Agent,
  env: NudgeEnvironment,
  lastNudgeTurn: Map<string, number>,
): NudgeOutcome | null {
  const session = agent.session
  const state = env.store.stateFor(session)
  // Full log for the kernel (so block anchors survive — see handleCompress);
  // the measured token count stays a SURFACE measurement.
  const coreMessages = allLogMessages(session)
  const surfaceMessages = eventsToCoreMessages(surfaceEventsOf(session))
  const tokenCount = measuredTokenCount(agent, surfaceMessages)
  const config = kernelConfigFor(env)
  const turn = env.kernel.processTurn({ messages: coreMessages, state, config, tokenCount })
  env.store.set(session, turn.state)

  const nudge = turn.nudge
  if (nudge === undefined || !nudge.shouldInject) return null
  const emergency = nudge.breakdown?.emergencyOverride === 1

  const turnNumber = findOpenTurn(session.events) ?? 0
  const alreadyShown = !emergency && lastNudgeTurn.get(session.id) === turnNumber
  if (alreadyShown) return null
  lastNudgeTurn.set(session.id, turnNumber)

  const text = buildNudgeText(nudge, emergency, session, env.prompts)
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'acp-nudge' },
  })
  return { message, emergency }
}

/**
 * Render the nudge message text — aligned with the kernel/billion-context-pi
 * style: efficiency note + philosophy, context breakdown, HOW_TO_COMPRESS_RULES,
 * then the DSH-specific seq-based range table and the batch-compress tip.
 * The range table is our own (seq-based, not ref-ID-based) because DSH has no
 * in-memory message rewrite hook — see docs/dsh-porting-verification.md.
 */
export function buildNudgeText(
  nudge: NudgeDecision,
  emergency: boolean,
  session: import('@deepseek-ai/dsh-session').Session,
  prompts: ResolvedPrompts = DEFAULT_RESOLVED,
): string {
  // Cap the reported percentage at 100: a broken measurement (e.g. response
  // pressure folded in) must never surface as an absurd "230%" to the model.
  const pct = Math.round(Math.min(nudge.contextUsage, 1) * 100)
  const frame = renderTemplate(
    emergency ? prompts.nudge.emergency : prompts.nudge.normal,
    { pct, philosophy: COMPRESS_PHILOSOPHY },
  )
  const parts: string[] = [frame]

  // Context breakdown (kernel style, from NudgeDecision.contextBreakdown).
  if (nudge.contextBreakdown) {
    const bd = nudge.contextBreakdown
    const breakdown = renderTemplate(prompts.nudge.breakdown, {
      system: Math.round(bd.system / 1000),
      tool: Math.round(bd.tool / 1000),
      summaries: Math.round(bd.summaries / 1000),
      code: Math.round(bd.code / 1000),
      text: Math.round(bd.text / 1000),
    })
    if (breakdown !== '') parts.push('', breakdown)
    if (bd.growth > 0) {
      const growth = renderTemplate(prompts.nudge.growth, { growth: Math.round(bd.growth / 1000) })
      if (growth !== '') parts.push(growth)
    }
  }

  // HOW_TO_COMPRESS_RULES as guidance (kernel puts it in every nudge).
  if (prompts.nudge.guidance !== '') parts.push('', prompts.nudge.guidance)

  // Tier line (distillation / condensation suggestion) + tier-specific rules.
  if ((nudge.tier === 2 || nudge.tier === 3) && (nudge.tierTargetBlocks?.length ?? 0) > 0) {
    const targets = nudge.tierTargetBlocks!
    const summarySeqs = targets
      .map((block) => summarySeqOfKernelBlock(session, block.blockId))
      .filter((seq): seq is number => seq !== null)
    const pending = nudge.tier === 2 ? nudge.breakdown?.pendingT2 : nudge.breakdown?.pendingT3
    const tokens = typeof pending === 'number' ? pending : 0
    const tierLine = renderTemplate(prompts.nudge.tier, {
      tier: nudge.tier,
      count: targets.length,
      prevTier: nudge.tier - 1,
      tokens,
      seqs: summarySeqs.join(', '),
    })
    if (tierLine !== '') parts.push(tierLine)
    // Tier-specific rules from kernel (TIER2_DISTILL_RULES / TIER3_CONDENSE_RULES).
    const tierRules = nudge.tier === 2 ? TIER2_DISTILL_RULES : TIER3_CONDENSE_RULES
    parts.push('', tierRules)
  } else {
    // Range table for non-tier nudges (DSH-specific: seq-based, not ref-ID-based).
    parts.push(rangeTable(session, prompts))
  }

  // Batch-compress tip (from kernel's nudge-text.ts style).
  if (prompts.nudge.tip !== '') parts.push('', prompts.nudge.tip)

  return parts.join('\n')
}
