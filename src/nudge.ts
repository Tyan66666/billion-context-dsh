/**
 * M4 — ACP nudge: the kernel's compression recommendation, rendered as an
 * injected user message with a seq-based compressible-range table (D1:
 * "seq is the ref" — DSH has no in-memory message rewrite hook, so the model
 * targets ranges by surface seq rather than by <acp> tags).
 * @module billion-context-dsh/nudge
 */

import {
  COMPRESS_PHILOSOPHY,
  HOW_TO_COMPRESS_RULES,
  TIER2_DISTILL_RULES,
  TIER3_CONDENSE_RULES,
  defaultCountTokens,
  renderNudgeText,
  type CompressionCore,
  type CompressionState,
  type ContextBreakdown,
  type CoreMessage,
  type NudgeDecision,
} from 'acp-kernel'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AcpStateStore } from './state.ts'
import { allLogMessages, eventsToCoreMessages, isCheckpointNode, surfaceEventsOf } from './messages.ts'
import {
  buildCompressibleSeqRanges,
  findOpenTurn,
  summarySeqOfKernelBlock,
  surfaceSummary,
  type KernelRangeView,
  type MediaPriceOf,
  type SeqCompressibleRange,
} from './region.ts'
import { mediaPriceViaMeter } from './host-tokens.ts'
import { sessionEventsOf } from './session-events.ts'
import { kernelConfigFor, type KernelConfigInput } from './config.ts'
import { DEFAULT_RESOLVED, renderTemplate, type ResolvedPrompts } from './prompts.ts'

/**
 * B6 nudge 瘦身（2026-09-08 方案 §4 B6）：哲学段与压缩规则段**移出 nudge**——
 * 它们已经住在系统提示与工具描述里（各注一次），每拍复读=同一份文本反复计费
 * （本会话实测：nudge 正文 6.1 KB/次 × 3 = 18.4 KB）。nudge 只留「该压缩了 + 压缩哪些」。
 *
 * UPSTREAM: this is a labeled host-side workaround (AGENTS.md rule 11), not a
 * long-term design. The four texts below are imported from acp-kernel and are
 * removed from already-rendered nudge text, so the clean fix belongs upstream:
 * an acp-kernel option that renders the nudge without the guidance blocks.
 * Drop stripNudgeGuidance and use that option once it exists. Tracked in
 * docs/dsh-porting-verification.md.
 */
const GUIDANCE_BLOCKS = [COMPRESS_PHILOSOPHY, HOW_TO_COMPRESS_RULES, TIER2_DISTILL_RULES, TIER3_CONDENSE_RULES] as const

export function stripNudgeGuidance(text: string): string {
  let out = text
  for (const block of GUIDANCE_BLOCKS) out = out.split(block).join('')
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

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
 * The kernel's decision and live state in the shape the range table needs.
 *
 * The kernel owns the compressible geometry (`nudge.compressibleRanges`); the
 * ref map turns a kernel ref back into a surface seq. Both objects come from
 * the SAME turn — the map must be the one `processTurn` just returned, never a
 * rehydrated store state, or the refs point at ids this surface does not have.
 */
function kernelRangeViewOf(nudge: NudgeDecision, state: CompressionState): KernelRangeView {
  return { ranges: nudge.compressibleRanges ?? [], refs: state.messageRefs }
}

/**
 * Range-row suffix naming the image/file blocks a span carries, so the model
 * does not read "~0 tokens" as "nothing to reclaim" for a picture-heavy span
 * (issue #117). Counts, not prices: the price sits in the token column.
 */
function mediaSuffixOf(range: SeqCompressibleRange): string {
  if (range.images === 0 && range.files === 0) return ''
  const parts: string[] = []
  if (range.images > 0) parts.push(`+${range.images} image${range.images === 1 ? '' : 's'}`)
  if (range.files > 0) parts.push(`+${range.files} file${range.files === 1 ? '' : 's'}`)
  // ` | ` is the separator the same row already uses for the tool/text share
  // column (`[tool X% | text Y%]`) and the one AGENTS.md rule 19 documents; a
  // comma inside the bracket reads as prose.
  return ` [${parts.join(' | ')}]`
}

/**
 * Lazy per-seq media price. The FIRST lookup triggers one meter measurement, so
 * the range walk only asks about seqs that really carry an attachment — a
 * media-free session never pays for the measurement (issue #117, issue #110).
 */
function meterMediaPriceResolver(
  agent: Agent,
  session: import('@deepseek-ai/dsh-session').Session,
): MediaPriceOf {
  let prices: ReadonlyMap<number, number> | null = null
  return (seq: number) => {
    if (prices === null) prices = mediaPriceViaMeter(session, agent.ctx)
    return prices.get(seq) ?? 0
  }
}

/**
 * Render the compressible-range table as seq refs for the model.
 *
 * The spans are the kernel's own (`compressibleRanges`, translated to surface
 * seqs) with the host guards applied on top — see buildCompressibleSeqRanges.
 * This function used to self-compute them from the surface as a labeled
 * `UPSTREAM:` workaround for kernel ref-map drift; that drift is fixed upstream
 * (acp-kernel #207) and the workaround is gone (rule 11).
 */
export function rangeTable(
  session: import('@deepseek-ai/dsh-session').Session,
  kernelView: KernelRangeView,
  prompts: ResolvedPrompts = DEFAULT_RESOLVED,
  mediaPriceOf?: MediaPriceOf,
): string {
  const ranges = buildCompressibleSeqRanges(
    session,
    kernelView,
    mediaPriceOf === undefined ? {} : { mediaPriceOf },
  ).slice(0, 6)
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
      media: mediaSuffixOf(range),
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
 * Compute a SURFACE-ONLY context breakdown for display, aligned with
 * `acp_status` (kernel `buildStatusReport`/`renderOverview`).
 *
 * The kernel's own `computeContextBreakdown` (which the nudge text renders)
 * walks the message array it is fed — and `buildNudge` feeds it the FULL log
 * (`allLogMessages`, needed so T2/T3 distillation can anchor every block). So
 * a session with compressed blocks reports HISTORICAL totals there: every
 * original tool/text message already absorbed into a block is counted again,
 * e.g. `85.2K tool` for ~8.5K of live tool context. `acp_status` instead feeds
 * `buildStatusReport` the VISIBLE surface + active-block summaries, so its
 * breakdown reads the true current context. This function reproduces that
 * visible-surface reality for the nudge line so the two tools agree.
 *
 * Classification replicates kernel `computeContextBreakdown` (tool-call/
 * tool-result → tool, `system` role → system, `` code `` fence in text →
 * code, else text) EXCEPT summaries: kernel detects summaries by a
 * `[Compressed conversation section]` text prefix, which never matches a DSH
 * checkpoint node (our summary is the plain summary + `compactCheckpointSource`
 * source marker). We instead count active-block summaries directly from kernel
 * state (same source `buildStatusReport` uses), and the caller must exclude
 * checkpoint summary nodes from `messages` (they are not in any block's
 * `effectiveMessageIds` and would double-count — mirror of `/acp` status's
 * `isCheckpointNode` exclusion).
 */
export function computeSurfaceBreakdown(
  state: CompressionState,
  messages: readonly CoreMessage[],
  total: number,
  growth: number,
): ContextBreakdown {
  let system = 0
  let tool = 0
  let code = 0
  let text = 0
  for (const message of messages) {
    const tokens = defaultCountTokens(message.text ?? '')
    if (message.contentType === 'tool-call' || message.contentType === 'tool-result') {
      tool += tokens
    } else if (message.role === 'system') {
      system += tokens
    } else if ((message.text ?? '').includes('```')) {
      code += tokens
    } else {
      text += tokens
    }
  }
  let summaries = 0
  for (const block of state.blocks) {
    if (block.active) summaries += defaultCountTokens(block.summary)
  }
  return { system, tool, summaries, code, text, total, growth }
}

/**
 * Max emergency nudge injections within a single user turn. Bounds the
 * positive-feedback loop where an unrelieved ≥emergency-threshold pressure
 * re-injects a durable emergency nudge on every pre-step forever (issue #108).
 * Mirrors billion-context-pi commit 414acd1 (cap emergency nudge injections per
 * user turn). Normal-pressure nudges remain limited to one per turn regardless.
 */
export const EMERGENCY_NUDGE_MAX_PER_TURN = 3

/**
 * Decide and build one nudge message for the agent's next pre-step. Returns
 * null when the kernel recommends no nudge or the per-turn budget is spent:
 * normal-pressure nudges fire at most once per user turn, and emergency nudges
 * are capped at {@link EMERGENCY_NUDGE_MAX_PER_TURN} per user turn so an
 * unrelieved ≥threshold pressure cannot re-inject a durable nudge on every
 * pre-step forever (issue #108). Also advances the in-memory kernel state (ref
 * assignment) so the compress tool can resolve seq → mNNNNN refs.
 *
 * `onEmergencyCapHit` (optional) fires when the kernel still wants an
 * emergency nudge but the per-turn budget is spent — the host uses it to log
 * why the model stops receiving nudges (issue #108 review).
 */
export function buildNudge(
  agent: Agent,
  env: NudgeEnvironment,
  lastNudgeTurn: Map<string, number>,
  emergencyNudges: Map<string, { turn: number; count: number }>,
  onEmergencyCapHit?: () => void,
): NudgeOutcome | null {
  const session = agent.session
  const state = env.store.stateFor(session)
  // Full log for the kernel (so block anchors survive — see handleCompress);
  // the measured token count stays a SURFACE measurement.
  const coreMessages = allLogMessages(session)
  const surfaceEvents = surfaceEventsOf(session)
  const surfaceMessages = eventsToCoreMessages(surfaceEvents)
  const tokenCount = measuredTokenCount(agent, surfaceMessages)
  const config = kernelConfigFor(env)
  const turn = env.kernel.processTurn({ messages: coreMessages, state, config, tokenCount })
  env.store.set(session, turn.state)

  const nudge = turn.nudge
  if (nudge === undefined || !nudge.shouldInject) return null
  // Media-bearing spans are invisible to every text estimator, so their price
  // comes from the host meter. Lazily: a media-free session never pays for a
  // measurement (meterMediaPriceResolver only measures on first lookup).
  const mediaPriceOf = meterMediaPriceResolver(agent, session)
  // The kernel computed `contextBreakdown` from the FULL log (allLogMessages),
  // so after any compression it reports HISTORICAL totals (a huge `tool` that
  // is really the compressed-away originals). Override it with the visible
  // surface + active-block summaries so the nudge line matches acp_status
  // (which renders from `buildStatusReport` over the surface). Checkpoint
  // summary nodes are excluded (they are not in any block's effectiveMessageIds
  // and would double-count) — the same exclusion `/acp` status applies. The
  // breakdown is display-only and never drives injection, so this override is
  // safe for the decision path.
  const statusMessages = eventsToCoreMessages(
    surfaceEvents.filter((event) => isCheckpointNode(event) === false),
  )
  nudge.contextBreakdown = computeSurfaceBreakdown(turn.state, statusMessages, tokenCount, nudge.contextBreakdown?.growth ?? 0)
  const emergency = nudge.breakdown?.emergencyOverride === 1

  const turnNumber = findOpenTurn(sessionEventsOf(session)) ?? 0
  if (!emergency) {
    // Normal-pressure nudge: at most one per user turn (unchanged behavior).
    if (lastNudgeTurn.get(session.id) === turnNumber) return null
    lastNudgeTurn.set(session.id, turnNumber)
  } else {
    // Emergency nudge: bounded per user turn. Without this cap an unrelieved
    // ≥emergencyThreshold pressure re-injects a durable nudge on EVERY pre-step
    // (each appended as a user/message event), and the nudge's own tokens push
    // usage higher → a runaway feedback loop (issue #108; mirrors pi #223/#250
    // and commit 414acd1).
    const record = emergencyNudges.get(session.id)
    if (record !== undefined && record.turn === turnNumber) {
      if (record.count >= EMERGENCY_NUDGE_MAX_PER_TURN) {
        onEmergencyCapHit?.()
        return null
      }
      record.count += 1
    } else {
      emergencyNudges.set(session.id, { turn: turnNumber, count: 1 })
    }
  }

  const text = buildNudgeText(
    nudge,
    emergency,
    session,
    kernelRangeViewOf(nudge, turn.state),
    env.prompts,
    mediaPriceOf,
  )
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
  kernelView: KernelRangeView,
  prompts: ResolvedPrompts = DEFAULT_RESOLVED,
  mediaPriceOf?: MediaPriceOf,
): string {
  // A host override of any nudge slot → template rendering (config.prompts
  // keeps its v0.1.9 contract: custom copy wins). Only the pristine default
  // reference reaches the kernel path.
  if (prompts.nudge !== DEFAULT_RESOLVED.nudge) {
    return renderNudgeFromTemplates(nudge, emergency, session, kernelView, prompts, mediaPriceOf)
  }
  const rendered = renderNudgeText(nudge)
  return adaptKernelNudgeToSeq(rendered.text, nudge, session, kernelView, prompts, mediaPriceOf)
}

/**
 * Take the kernel-rendered nudge text and replace its ref-ID-oriented segments
 * with our surface-seq equivalents.
 *
 * The B6 slim step (`stripNudgeGuidance`) runs first: it removes the
 * philosophy, HOW_TO_COMPRESS_RULES and tier-2/3 rule blocks, because they
 * already live in the system prompt and the tool descriptions — repeating them
 * in every nudge only re-billed the same ~6 KB. What stays kernel-verbatim:
 * the frame, the context breakdown, the tier line and the batch tip.
 *
 * Only the ref-ID-oriented segments are replaced with our seq-based
 * equivalents, because DSH has no `<acp>` ref tags — see
 * docs/dsh-porting-verification.md:
 */
function adaptKernelNudgeToSeq(
  text: string,
  nudge: NudgeDecision,
  session: import('@deepseek-ai/dsh-session').Session,
  kernelView: KernelRangeView,
  prompts: ResolvedPrompts,
  mediaPriceOf?: MediaPriceOf,
): string {
  // B6：先摘掉哲学/规则段（它们住在系统提示与工具描述里），再做 seq 适配
  let out = stripNudgeGuidance(text)
  // Tier nudges: replace the kernel trigger block (block ids bN) with our tier
  // line carrying surface seqs. The kernel's TIER2/3 rule blocks were already
  // removed by stripNudgeGuidance above — those rules live in the system prompt.
  if ((nudge.tier === 2 || nudge.tier === 3) && (nudge.tierTargetBlocks?.length ?? 0) > 0) {
    out = replaceTierTrigger(out, nudge, session, prompts)
  } else if (out.includes('"startId"')) {
    // Emergency nudges: replace the ref-ID JSON example with a seq example.
    out = replaceEmergencyExample(out)
  }
  // Replace the ref-ID range table (mNNNNN) with the surface-seq table.
  // A zero-range table leaves the kernel's own "[No specific ranges detected]"
  // notice intact — it is a better prompt than an empty table.
  const seqTable = rangeTable(session, kernelView, prompts, mediaPriceOf)
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
    .sort((a, b) => a - b)
  const pending = nudge.tier === 2 ? nudge.breakdown?.pendingT2 : nudge.breakdown?.pendingT3
  const tokens = typeof pending === 'number' ? pending : 0
  const tierValue = nudge.tier === null ? 2 : nudge.tier
  const tierLine = renderTemplate(prompts.nudge.tier, {
    tier: tierValue,
    count: targets.length,
    prevTier: tierValue - 1,
    tokens,
    seqs: summarySeqs.join(', '),
    firstSeq: summarySeqs[0] ?? 'n/a',
    lastSeq: summarySeqs[summarySeqs.length - 1] ?? 'n/a',
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
  kernelView: KernelRangeView,
  prompts: ResolvedPrompts,
  mediaPriceOf?: MediaPriceOf,
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
      .sort((a, b) => a - b)
    const pending = nudge.tier === 2 ? nudge.breakdown?.pendingT2 : nudge.breakdown?.pendingT3
    const tokens = typeof pending === 'number' ? pending : 0
    const tierLine = renderTemplate(prompts.nudge.tier, {
      tier: nudge.tier,
      count: targets.length,
      prevTier: nudge.tier - 1,
      tokens,
      seqs: summarySeqs.join(', '),
      firstSeq: summarySeqs[0] ?? 'n/a',
      lastSeq: summarySeqs[summarySeqs.length - 1] ?? 'n/a',
    })
    if (tierLine !== '') parts.push(tierLine)
    // Tier-specific rules from kernel (TIER2_DISTILL_RULES / TIER3_CONDENSE_RULES).
    const tierRules = nudge.tier === 2 ? TIER2_DISTILL_RULES : TIER3_CONDENSE_RULES
    parts.push('', tierRules)
  } else {
    // Range table for non-tier nudges (DSH-specific: seq-based, not ref-ID-based).
    parts.push(rangeTable(session, kernelView, prompts, mediaPriceOf))
  }

  // Batch-compress tip (from kernel's nudge-text.ts style).
  if (prompts.nudge.tip !== '') parts.push('', prompts.nudge.tip)

  // B6：模板路径同样摘掉哲学/规则段——否则宿主只要覆盖任一 nudge 槽位（如只改 tip），
  // 整份 6 KB 指引就会重新贴回来（独立复核 2026-09-08 发现的软缺口）。
  return stripNudgeGuidance(parts.join('\n'))
}
