/**
 * M4 — ACP nudge: the kernel's compression recommendation, rendered as an
 * injected user message with a seq-based compressible-range table (D1:
 * "seq is the ref" — DSH has no in-memory message rewrite hook, so the model
 * targets ranges by surface seq rather than by <acp> tags).
 * @module billion-context-dsh/nudge
 */

import {
  estimateTokensFast,
  renderNudgeText,
  type CompressionCore,
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
function rangeTable(nudge: NudgeDecision, state: { messageRefs: { byRef: Record<string, string> } }): string {
  const byRef = state.messageRefs.byRef
  const lines = nudge.compressibleRanges.slice(0, 6).map((range) => {
    const startRaw = byRef[range.startRef]
    const endRaw = byRef[range.endRef]
    if (startRaw === undefined || endRaw === undefined) return null
    return `  - seq ${startRaw}..${endRaw} — ${range.count} messages, ~${range.tokens} tokens`
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
  const tokenCount = coreMessages.reduce((sum, message) => sum + estimateTokensFast(message.text ?? ''), 0)
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

  const rendered = renderNudgeText(nudge)
  const text = `${rendered.text}${rangeTable(nudge, turn.state)}`
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'acp-nudge' },
  })
  return { message, emergency }
}
