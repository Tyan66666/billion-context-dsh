/**
 * M4 — the `/acp` slash command: a human-friendly window into the same
 * machinery the model tools expose (status, one-shot compress, decompress).
 * @module billion-context-dsh/commands
 */

import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolEnvironment } from './tools.ts'
import {
  rebuildBlockLedger,
  resolveSurfaceRange,
  runCompactionTransaction,
  shadowedSeqsOf,
} from './region.ts'
import { eventsToCoreMessages, extractEventText, surfaceEventsOf } from './messages.ts'
import { defaultConfig, defaultCountTokens } from 'acp-kernel'

function statusText(env: ToolEnvironment, agent: Agent): string {
  const session = agent.session
  const ledger = rebuildBlockLedger(session.events)
  const totalTokens = ledger.reduce((sum, block) => sum + block.shadowedTokenCount, 0)
  const coreMessages = eventsToCoreMessages(surfaceEventsOf(session))
  const estimated = coreMessages.reduce((sum, message) => sum + defaultCountTokens(message.text ?? ''), 0)
  const limit = env.modelContextLimit
  const lines = [
    `ACP status — session ${session.id}`,
    `  blocks: ${ledger.length}`,
    `  tokens compressed: ${totalTokens}`,
    `  estimated context: ${estimated} / ${limit} (${Math.round((estimated / limit) * 100)}%)`,
  ]
  for (const block of ledger.slice(0, 10)) {
    lines.push(`  - ${block.blockId.slice(0, 8)}: seqs ${block.start}..${block.end} — ${block.summary.slice(0, 80)}`)
  }
  return lines.join('\n')
}

function compressText(env: ToolEnvironment, agent: Agent, args: string[]): string {
  if (args.length < 3) {
    return '/acp compress <startSeq> <endSeq> <summary...>'
  }
  const startSeq = Number(args[0])
  const endSeq = Number(args[1])
  const summary = args.slice(2).join(' ')
  if (!Number.isInteger(startSeq) || !Number.isInteger(endSeq)) {
    return '/acp compress: startSeq and endSeq must be integers'
  }
  const session = agent.session
  const { start, end } = resolveSurfaceRange(session, startSeq, endSeq)
  const shadowed = shadowedSeqsOf(session, startSeq, endSeq)
  let shadowedTokens = 0
  for (const seq of shadowed) {
    const event = session.events[seq]
    if (event !== undefined) shadowedTokens += defaultCountTokens(extractEventText(event))
  }
  const { compactionId } = runCompactionTransaction(session, {
    start,
    end,
    shadowedSeqs: shadowed,
    summary: [{ type: 'text', text: summary }],
    shadowedTokenCount: shadowedTokens,
    provider: agent.options.provider ?? '',
    model: agent.options.model ?? '',
  })
  return `Compressed seqs ${start}..${end} (${shadowed.length} messages) as block ${compactionId.slice(0, 8)}`
}

function decompressText(_env: ToolEnvironment, agent: Agent, args: string[]): string {
  if (args.length < 1) return '/acp decompress <blockId>'
  const session = agent.session
  const ledger = rebuildBlockLedger(session.events)
  const block = ledger.find((entry) => entry.blockId.startsWith(args[0]!))
  if (block === undefined) return `block "${args[0]}" not found (see /acp status)`
  const parts = block.shadowedSeqs
    .map((seq) => extractEventText(session.events[seq]!))
    .filter((text) => text.length > 0)
  return `Block ${block.blockId} — ${block.summary}\n\n${parts.join('\n\n') || '(no recoverable content)'}`
}

/** Register the /acp command (idempotent per engine). */
export function acpCommand(env: ToolEnvironment): CommandDefinition {
  return {
    name: 'acp',
    description:
      'Active Context Pruning — model-driven context compression. '
      + 'Usage: /acp status | /acp compress <startSeq> <endSeq> <summary> | /acp decompress <blockId>',
    handler: async (invocation) => {
      const raw = invocation.rawInput.trim()
      if (raw === '' || raw === 'status') {
        return { kind: 'success', text: statusText(env, invocation.agent) }
      }
      if (raw.startsWith('compress')) {
        return { kind: 'success', text: compressText(env, invocation.agent, raw.slice('compress'.length).trim().split(/\s+/) ) }
      }
      if (raw.startsWith('decompress')) {
        return { kind: 'success', text: decompressText(env, invocation.agent, raw.slice('decompress'.length).trim().split(/\s+/)) }
      }
      return { kind: 'error', text: `unknown /acp subcommand "${raw.split(/\s+/)[0]}" — use status | compress | decompress` }
    },
  }
}
