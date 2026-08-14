/**
 * M4 — ACP nudge: the kernel's compression recommendation, rendered as an
 * injected user message with a seq-based compressible-range table (D1:
 * "seq is the ref" — DSH has no in-memory message rewrite hook, so the model
 * targets ranges by surface seq rather than by <acp> tags).
 * @module billion-context-dsh/nudge
 */

import {
  defaultCountTokens,
  type CompressionCore,
  type CoreMessage,
  type NudgeDecision,
} from 'acp-kernel'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AcpStateStore } from './state.ts'
import { eventsToCoreMessages, surfaceEventsOf } from './messages.ts'
import { buildCompressibleSeqRanges, findOpenTurn, surfaceSummary } from './region.ts'
import { kernelConfigFor, type KernelConfigInput } from './config.ts'

/** Kernel inputs the nudge path shares with the compress tool. */
export interface NudgeEnvironment extends KernelConfigInput {
  readonly kernel: CompressionCore
  readonly store: AcpStateStore
}

export interface NudgeOutcome {
  readonly message: UserMessage
  readonly emergency: boolean
}

/**
 * Render the compressible-range table as seq refs for the model.
 * Computed directly from the surface (not the kernel's ref map, which can
 * drift and hide large tool results) — see buildCompressibleSeqRanges.
 */
export function rangeTable(session: import('@deepseek-ai/dsh-session').Session): string {
  const ranges = buildCompressibleSeqRanges(session).slice(0, 6)
  if (ranges.length === 0) return ''
  const lines = ranges.map((range) => `  - seq ${range.start}..${range.end} — ${range.count} messages, ~${range.tokens} tokens`)
  return [
    '',
    `Surface: ${surfaceSummary(session)}`,
    'Compressible ranges (refs are surface seqs):',
    ...lines,
    'Compress with: compress({ content: [{ startSeq, endSeq, summary }] })',
  ].join('\n')
}

/**
 * The token count driving pressure decisions. Prefer the host token meter's
 * SURFACE tokens (the input-side heuristic total — matches acp_status and the
 * UI's message-token view). `totalTokens` is request-AND-RESPONSE pressure and
 * can far exceed the window in long sessions (observed 230% against a real
 * ~20% occupancy), so it is not used. Falls back to the fast heuristic when
 * the meter is absent (tests, minimal hosts).
 */
function measuredTokenCount(agent: Agent, coreMessages: CoreMessage[]): number {
  const meter = agent.ctx?.get?.('tokenMeter') as
    | { measure?: (session: unknown) => { surfaceTokens?: number } }
    | undefined
  const surface = meter?.measure?.(agent.session)?.surfaceTokens
  if (typeof surface === 'number' && surface > 0) return surface
  return coreMessages.reduce((sum, message) => sum + defaultCountTokens(message.text ?? ''), 0)
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
  const coreMessages = eventsToCoreMessages(surfaceEventsOf(session))
  const tokenCount = measuredTokenCount(agent, coreMessages)
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

  const text = buildNudgeText(nudge, emergency, session)
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'acp-nudge' },
  })
  return { message, emergency }
}

/**
 * A short ADVISORY nudge — ACP is model-driven, the model decides whether and
 * when to compress. Full guidance (tools, philosophy, summary rules) lives in
 * the system prompt once, not in every nudge.
 */
function buildNudgeText(
  nudge: NudgeDecision,
  emergency: boolean,
  session: import('@deepseek-ai/dsh-session').Session,
): string {
  // Cap the reported percentage at 100: a broken measurement (e.g. response
  // pressure folded in) must never surface as an absurd "230%" to the model.
  const pct = Math.round(Math.min(nudge.contextUsage, 1) * 100)
  const frame = emergency
    ? `⚠️ Context usage is at ${pct}% of the window — nearly full. Consider compressing consumed ranges soon so working context stays available; the choice and timing are yours.`
    : `Context usage is at ${pct}%. This is a suggestion, not a requirement — you decide whether and when to compress.`
  const guidance = 'Compress by need, not by percentage: replace only ranges you have genuinely consumed, with dense self-contained summaries.'
  return [frame, '', guidance, rangeTable(session)].join('\n')
}
