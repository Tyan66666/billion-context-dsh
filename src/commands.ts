/**
 * M4 — the `/acp` slash command: a human-friendly window into the same
 * machinery the model tools expose (status, one-shot compress, decompress,
 * runtime settings read/write).
 * @module billion-context-dsh/commands
 */

import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveEffectiveWindow, type ToolEnvironment } from './tools.ts'
import { resolveTokenCount } from './nudge.ts'
import { kernelConfigFor } from './config.ts'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import {
  parseSettingValue,
  SETTINGS_KEYS,
  type AcpSettings,
  type AcpSettingsInput,
  type SettingsCommandSurface,
  type SettingsKey,
} from './settings.ts'
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
  // A failed probe falls back to the 128K default AND is cached for the
  // process lifetime — the /acp panel must say so explicitly, or the operator
  // can't tell why pressure looks wrong (issue #63: a gateway that disclosed
  // no window read as ~55% of 128K instead of ~18% of the real 1M window).
  if (window.probeFailed === true) {
    lines.push(`  ⚠ window auto-detection failed — using the ${limit} fallback (change modelContextLimit or autoModelContextLimit via /acp config — or restart — to re-probe)`)
  }
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
      + 'Usage: /acp status | /acp compress <startSeq> <endSeq> <summary> | /acp decompress <blockId> | /acp config [list|set <key> <value>|reset <key>|all]',
    handler: async (invocation) => {
      const raw = invocation.rawInput.trim()
      if (raw === '' || raw === 'status') {
        return { kind: 'success', text: await statusText(env, invocation.agent) }
      }
      if (raw === 'config' || raw.startsWith('config ')) {
        return { kind: 'success', text: await configText(env, raw.slice('config'.length).trim()) }
      }
      if (raw.startsWith('compress')) {
        return { kind: 'success', text: compressText(env, invocation.agent, raw.slice('compress'.length).trim().split(/\s+/) ) }
      }
      if (raw.startsWith('decompress')) {
        return { kind: 'success', text: decompressText(env, invocation.agent, raw.slice('decompress'.length).trim().split(/\s+/)) }
      }
      return { kind: 'error', text: `unknown /acp subcommand "${raw.split(/\s+/)[0]}" — use status | compress | decompress | config` }
    },
  }
}

/** True for plain objects — the settings descriptor layers are JSON documents. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSettingsKey(key: string): key is SettingsKey {
  return (SETTINGS_KEYS as readonly string[]).includes(key)
}

/** Display form of one knob in the list table: an absent value shows what it MEANS, not a blank. */
function formatSettingsValue(key: SettingsKey, value: AcpSettings[SettingsKey]): string {
  if (value === undefined) {
    if (key === 'modelContextLimit') return 'auto'
    if (key === 'nudgeMinContextLimitPct') return '0.45 (kernel)'
    return '—'
  }
  return String(value)
}

function configListText(surface: SettingsCommandSurface | undefined): string {
  if (surface === undefined) return 'runtime settings are not wired in this engine build'
  const snapshot = surface.snapshot()
  const descriptor = surface.describe()
  const lines = [
    'ACP runtime settings — namespace "compaction-acp"',
    '  key                         value        source',
  ]
  for (const key of SETTINGS_KEYS) {
    // Presence in a layer marks the override: user settings.yaml wins over
    // the composition row (base), which wins over the engine default.
    const userSection = isRecord(descriptor?.user) ? descriptor.user : {}
    const baseSection = isRecord(descriptor?.base) ? descriptor.base : {}
    const source = key in userSection ? 'user' : key in baseSection ? 'base' : 'default'
    lines.push(`  ${key.padEnd(27)} ${formatSettingsValue(key, snapshot[key]).padEnd(12)} ${source}`)
  }
  lines.push('', '  changes apply to running sessions immediately (no restart)')
  lines.push('  coreOverrides (composition layer) merge LAST and beat these values on same-name keys')
  lines.push('  /acp config reset <key> returns the key to the composition row / engine default')
  return lines.join('\n')
}

async function configSetText(surface: SettingsCommandSurface | undefined, key: string, rawValue: string): Promise<string> {
  if (!isSettingsKey(key)) {
    return `unknown key "${key}" — keys: ${SETTINGS_KEYS.join(', ')}`
  }
  if (surface === undefined) return 'runtime settings are not wired in this engine build'
  if (!surface.available) {
    return 'no settings provider in this process — edit the compaction-acp row in cordis.patch.yml instead (a restart applies it)'
  }
  const parsed = parseSettingValue(rawValue)
  if (!parsed.ok) return parsed.reason
  if (parsed.value === null) {
    // `null` is the reset-this-key sentinel: same path as /acp config reset.
    return configResetText(surface, key)
  }
  // Narrow the union to the key's field type; the settings schema re-validates
  // at the service boundary, so a mismatched value fails there, not here.
  const patch: AcpSettingsInput = key === 'autoNudge' || key === 'autoModelContextLimit'
    ? { [key]: parsed.value as boolean }
    : { [key]: parsed.value as number }
  try {
    await surface.update(patch)
  } catch (error) {
    if (error instanceof SettingsConflictError) {
      return 'conflict: another writer changed this setting at the same time — run /acp config again'
    }
    return `rejected: ${String(error)}`
  }
  const windowNote = key === 'modelContextLimit' || key === 'autoModelContextLimit'
    ? '\n  window cache cleared — the next step re-resolves the context window'
    : ''
  return `✓ ${key} = ${String(parsed.value)} — applied to running sessions${windowNote}`
}

async function configResetText(surface: SettingsCommandSurface | undefined, target: string): Promise<string> {
  if (surface === undefined) return 'runtime settings are not wired in this engine build'
  if (!surface.available) {
    return 'no settings provider in this process — edit the compaction-acp row in cordis.patch.yml instead (a restart applies it)'
  }
  if (target === 'all') {
    await surface.replaceSection({})
    return '✓ all runtime settings reset — values now come from the composition row / engine defaults'
  }
  if (!isSettingsKey(target)) {
    return `unknown key "${target}" — keys: ${SETTINGS_KEYS.join(', ')}`
  }
  const descriptor = surface.describe()
  // Single-key reset = delete the key from the USER section; the namespace
  // then falls back to the composition row (base) or the engine default.
  const userSection = isRecord(descriptor?.user) ? { ...descriptor.user } : {}
  delete userSection[target]
  await surface.replaceSection(userSection)
  const baseSection = isRecord(descriptor?.base) ? descriptor.base : {}
  const baseValue = baseSection[target]
  return `✓ ${target} reset — it now reads ${baseValue === undefined ? 'the engine default' : `the composition value ${String(baseValue)}`}`
}

async function configText(env: ToolEnvironment, rest: string): Promise<string> {
  const surface = env.settingsCommand
  const args = rest.split(/\s+/).filter((part) => part.length > 0)
  const verb = args[0] ?? 'list'
  if (verb === 'list') return configListText(surface)
  if (verb === 'set') {
    if (args.length < 3) return 'usage: /acp config set <key> <value> (e.g. /acp config set nudgeMaxContextLimitPct 0.72)'
    return configSetText(surface, args[1]!, args.slice(2).join(' '))
  }
  if (verb === 'reset') {
    return configResetText(surface, args[1] ?? 'all')
  }
  return `unknown /acp config verb "${verb}" — use list | set <key> <value> | reset <key>|all`
}
