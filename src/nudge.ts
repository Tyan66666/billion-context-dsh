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
  renderNudgeText,
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
      toolPct: range.toolPct,
      textPct: 100 - range.toolPct,
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
export function buildNudgeText(
  nudge: NudgeDecision,
  emergency: boolean,
  session: import('@deepseek-ai/dsh-session').Session,
  prompts: ResolvedPrompts = DEFAULT_RESOLVED,
): string {
  // A host override of any nudge slot → template rendering (config.prompts
  // keeps its v0.1.9 contract: custom copy wins). Only the pristine default
  // reference reaches the kernel path.
  if (prompts.nudge !== DEFAULT_RESOLVED.nudge) {
    return renderNudgeFromTemplates(nudge, emergency, session, prompts)
  }
  const rendered = renderNudgeText(nudge)
  return adaptKernelNudgeToSeq(rendered.text, nudge, session, prompts)
}

/**
 * Take the kernel-rendered nudge text and replace its ref-ID-oriented segments
 * with our surface-seq equivalents. Everything else (frame, philosophy,
 * breakdown, HOW_TO_COMPRESS_RULES, tier rules, tip) stays kernel verbatim.
 */
function adaptKernelNudgeToSeq(
  text: string,
  nudge: NudgeDecision,
  session: import('@deepseek-ai/dsh-session').Session,
  prompts: ResolvedPrompts,
): string {
  let out = text
  // Tier nudges: replace the kernel trigger block (block ids bN) with our tier
  // line carrying surface seqs. The kernel's TIER2/3 rules stay in the tail.
  if ((nudge.tier === 2 || nudge.tier === 3) && (nudge.tierTargetBlocks?.length ?? 0) > 0) {
    out = replaceTierTrigger(out, nudge, session, prompts)
  } else if (out.includes('"startId"')) {
    // Emergency nudges: replace the ref-ID JSON example with a seq example.
    out = replaceEmergencyExample(out)
  }
  // Replace the ref-ID range table (mNNNNN) with the surface-seq table.
  // A zero-range table leaves the kernel's own "[No specific ranges detected]"
  // notice intact — it is a better prompt than an empty table.
  const seqTable = rangeTable(session, prompts)
  if (seqTable !== '') out = replaceRangesStr(out, seqTable)
  return out
}

/** Replace the kernel rangesStr segment (`Compressible ranges (N, oldest first):…`) with our seq table. */
function replaceRangesStr(text: string, seqTable: string): string {
  const match = text.match(/\n\n(?:Compressible ranges \(|\[No specific ranges detected)/)
  if (!match) return text
  const start = match.index!
  const rest = text.slice(start + 2)
  const next = rest.match(/\n\n/)
  const end = next !== null ? start + 2 + next.index! : text.length
  const before = text.slice(0, start)
  const after = text.slice(end)
  // seqTable starts with '\n' (the range table's leading blank line), so
  // `before` + '\n' + seqTable yields one blank line before the table.
  return before + '\n' + seqTable + after
}

/** Replace the kernel tier trigger segment (`[TIER n …TRIGGER]…Example: compress(…)`) with our tier line. */
function replaceTierTrigger(
  text: string,
  nudge: NudgeDecision,
  session: import('@deepseek-ai/dsh-session').Session,
  prompts: ResolvedPrompts,
): string {
  const start = text.search(/\n\n(?:\[TIER \d|\[EMERGENCY — TIER \d)/)
  if (start === -1) return text
  const rest = text.slice(start + 2)
  const next = rest.match(/\n\nHOW TO COMPRESS/)
  const end = next !== null ? start + 2 + next.index! : text.length
  const targets = nudge.tierTargetBlocks!
  const summarySeqs = targets
    .map((block) => summarySeqOfKernelBlock(session, block.blockId))
    .filter((seq): seq is number => seq !== null)
  const pending = nudge.tier === 2 ? nudge.breakdown?.pendingT2 : nudge.breakdown?.pendingT3
  const tokens = typeof pending === 'number' ? pending : 0
  const tierValue = nudge.tier === null ? 2 : nudge.tier
  const tierLine = renderTemplate(prompts.nudge.tier, {
    tier: tierValue,
    count: targets.length,
    prevTier: tierValue - 1,
    tokens,
    seqs: summarySeqs.join(', '),
  })
  return text.slice(0, start) + '\n\n' + tierLine + text.slice(end)
}

/** Replace the kernel emergency JSON example (startId/endId) with a seq example. */
function replaceEmergencyExample(text: string): string {
  const start = text.search(/\n\n\{ "topic":/)
  if (start === -1) return text
  const rest = text.slice(start + 2)
  const next = rest.match(/\n\nCompressible ranges |\n\n\[No specific/)
  const end = next !== null ? start + 2 + next.index! : text.length
  return text.slice(0, start)
    + '\n\ncompress({ content: [{ startSeq, endSeq, summary }] }) — use the seqs from the range table above.'
    + text.slice(end)
}

/**
 * Template rendering path (used only when a host overrides a `prompts.nudge`
 * slot). Kept byte-compatible with the pre-refactor assembly: frame → breakdown
 * → growth → guidance → tier(+rules)/range table → tip.
 */
function renderNudgeFromTemplates(
  nudge: NudgeDecision,
  emergency: boolean,
  session: import('@deepseek-ai/dsh-session').Session,
  prompts: ResolvedPrompts,
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
