/**
 * M4 — the `/acp` slash command: a human-friendly window into the same
 * machinery the model tools expose (status, one-shot compress, decompress).
 * @module billion-context-dsh/commands
 */

import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveEffectiveWindow, type ToolEnvironment } from './tools.ts'
import { resolveTokenCount } from './nudge.ts'
import { kernelConfigFor } from './config.ts'
import {
  blockIdOfKernelRef,
  blockRefForSummarySeq,
  expandShadowedSeqs,
  rebuildBlockLedger,
  resolveSurfaceRange,
  runCompactionTransaction,
  shadowedSeqsOf,
} from './region.ts'
import { allLogMessages, eventsToCoreMessages, extractEventText, surfaceEventsOf } from './messages.ts'
import { shadowedTokensViaMeter } from './host-tokens.ts'
import { defaultConfig } from 'acp-kernel'
import { windowSourceLabel } from './window.ts'

async function statusText(env: ToolEnvironment, agent: Agent): Promise<string> {
  const session = agent.session
  const ledger = rebuildBlockLedger(session.events)
  const totalTokens = ledger.reduce((sum, block) => sum + block.shadowedTokenCount, 0)
  // Full log for the kernel (so block anchors survive — same input as the
  // nudge path); the measured token count stays a SURFACE measurement.
  const coreMessages = allLogMessages(session)
  const surfaceMessages = eventsToCoreMessages(surfaceEventsOf(session))
  const estimated = resolveTokenCount(agent, surfaceMessages)
  const window = await resolveEffectiveWindow(env, agent)
  const limit = window.limit
  const lines = [
    `ACP status — session ${session.id}`,
    `  blocks: ${ledger.length}`,
    `  tokens compressed: ${totalTokens}`,
    `  estimated context: ${estimated} / ${limit} (${Math.round((estimated / limit) * 100)}%)`,
    `  context window: ${limit} (${windowSourceLabel(window)})`,
  ]
  // Nudge arbitration on the SAME inputs the nudge path uses — a read-only
  // diagnostic, so run on a cloned state and never write it back to the store.
  const state = structuredClone(env.store.stateFor(session))
  const config = kernelConfigFor({ ...env, modelContextLimit: limit })
  const turn = env.kernel.processTurn({ messages: coreMessages, state, config, tokenCount: estimated })
  const nudge = turn.nudge
  if (nudge !== undefined) {
    const label = nudge.shouldInject ? (nudge.tier !== null ? `ACTIVE [T${nudge.tier}]` : 'ACTIVE') : 'idle'
    lines.push(`  nudge: ${label} — ${nudge.reason}`)
    if (!nudge.shouldInject) {
      const maxPct = config.nudge.maxContextLimitPct
      const toNudge = Math.max(0, Math.round(maxPct * limit - estimated))
      lines.push(`  next nudge: ~${toNudge.toLocaleString()} tokens to go (usage ${Math.round(nudge.contextUsage * 100)}% → ${Math.round(maxPct * 100)}% line)`)
    }
  }
  // Show ALL blocks, not just the oldest 10: /acp status is how the user
  // confirms recent work survived compression, and the block list is folded
  // in the GUI anyway, so length has no cost (issue #47).
  for (const block of ledger) {
    const tier = block.tier > 1 ? ` [T${block.tier}]` : ''
    lines.push(`  - ${block.blockId.slice(0, 8)}${tier}: seqs ${block.start}..${block.end} — ${block.summary.slice(0, 80)}`)
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
  // A checkpoint summary node can only be distilled through the kernel (the
  // compress tool); /acp compress is a plain T1 range transaction, so refuse
  // rather than silently folding the summary as a message.
  if (blockRefForSummarySeq(session, start) !== null || blockRefForSummarySeq(session, end) !== null) {
    return '/acp compress: the range touches a compressed block summary node — distill it with the compress tool (seq-based batch), not /acp compress'
  }
  // The RESOLVED edges define the claim span, never the raw inputs:
  // resolveSurfaceRange may adjust them to a balanced cut, and a raw edge
  // absent from the surface makes shadowedSeqsOf slice a garbage span that
  // assertProvenance rejects when the transaction lands (AGENTS.md rule 12).
  const shadowed = shadowedSeqsOf(session, start, end)
  // Price the reclaimed tokens in the HOST's token vocabulary (rule 12):
  // prefer the live meter's per-node prices, fall back to the exact mirror.
  const shadowedTokens = shadowedTokensViaMeter(session, shadowed, agent.ctx)
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
  // Accept the kernel block ref (`bN`) the model tool acp_status shows, as
  // well as the compaction-id prefix (same dual-id resolution as the tool).
  const blockId = blockIdOfKernelRef(session, args[0]!)
  const ledger = rebuildBlockLedger(session.events)
  const block = blockId === null
    ? ledger.find((entry) => entry.blockId.startsWith(args[0]!))
    : ledger.find((entry) => entry.blockId === blockId)
  if (block === undefined) return `block "${args[0]}" not found (see /acp status)`
  // Tier-2/3 blocks shadow parent checkpoint nodes: expand to the originals.
  const parts = expandShadowedSeqs(session, block.blockId)
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
        return { kind: 'success', text: await statusText(env, invocation.agent) }
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
