/**
 * M4 — ACP nudge: the kernel's compression recommendation, rendered as an
 * injected user message with a seq-based compressible-range table (D1:
 * "seq is the ref" — DSH has no in-memory message rewrite hook, so the model
 * targets ranges by surface seq rather than by <acp> tags).
 * @module billion-context-dsh/nudge
 */

import {
  estimateTokensFast,
  type CompressionCore,
  type CoreMessage,
  type NudgeDecision,
} from 'acp-kernel'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AcpStateStore } from './state.ts'
import { eventsToCoreMessages, surfaceEventsOf } from './messages.ts'
import { findOpenTurn } from './region.ts'
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

/** Render the compressible-range table as seq refs for the model. */
export function rangeTable(nudge: NudgeDecision, state: { messageRefs: { byRef: Record<string, string> } }): string {
  const byRef = state.messageRefs.byRef
  const lines = nudge.compressibleRanges.slice(0, 6).map((range) => {
    const startRaw = byRef[range.startRef]
    const endRaw = byRef[range.endRef]
    if (startRaw === undefined || endRaw === undefined) return null
    const start = Number(startRaw)
    const end = Number(endRaw)
    // The kernel ref map can drift after surface replacements, resolving a
    // range to stale/out-of-order seqs (end before start) — drop those rather
    // than confusing the model with impossible ranges.
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null
    return `  - seq ${start}..${end} — ${range.count} messages, ~${range.tokens} tokens`
  })
  const visible = lines.filter((line): line is string => line !== null)
  if (visible.length === 0) return ''
  return [
    '',
    'Compressible ranges (refs are surface seqs):',
    ...visible,
    'Compress with: compress({ content: [{ startSeq, endSeq, summary }] })',
  ].join('\n')
}

/**
 * The token count driving pressure decisions. Prefer the host's token meter
 * (anchored on real provider usage — matches the UI occupancy) and fall back
 * to the fast heuristic when the meter is absent (tests, minimal hosts).
 */
function measuredTokenCount(agent: Agent, coreMessages: CoreMessage[]): number {
  const meter = agent.ctx?.get?.('tokenMeter') as
    | { measure?: (session: unknown) => { totalTokens?: number } }
    | undefined
  const measured = meter?.measure?.(agent.session)?.totalTokens
  if (typeof measured === 'number' && measured > 0) return measured
  return coreMessages.reduce((sum, message) => sum + estimateTokensFast(message.text ?? ''), 0)
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

  const text = buildNudgeText(nudge, emergency, turn.state)
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
  state: { messageRefs: { byRef: Record<string, string> } },
): string {
  const pct = Math.round(nudge.contextUsage * 100)
  const frame = emergency
    ? `⚠️ Context usage is at ${pct}% of the window — nearly full. Consider compressing consumed ranges soon so working context stays available; the choice and timing are yours.`
    : `Context usage is at ${pct}%. This is a suggestion, not a requirement — you decide whether and when to compress.`
  const guidance = 'Compress by need, not by percentage: replace only ranges you have genuinely consumed, with dense self-contained summaries.'
  return [frame, '', guidance, rangeTable(nudge, state)].join('\n')
}
