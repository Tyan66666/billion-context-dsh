/**
 * M3 — the four model tools: compress / decompress / search_context /
 * acp_status, registered through `ctx.tools` (defineTool).
 *
 * compress is the heart of ACP: the model writes the summary and the tool
 * lands it as a durable surface replacement (no second LLM summarization
 * call). decompress recovers shadowed content read-only from the log (DSH
 * keeps the originals — V5). search_context scores blocks rebuilt from the
 * log. acp_status reports the block ledger and pressure.
 * @module billion-context-dsh/tools
 */

import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defaultCountTokens, type CompressionCore } from 'acp-kernel'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AcpStateStore } from './state.ts'
import { kernelConfigFor, type KernelConfigInput } from './config.ts'
import {
  rebuildBlockLedger,
  resolveSurfaceRange,
  runCompactionTransaction,
  shadowedSeqsOf,
} from './region.ts'
import { eventsToCoreMessages, extractEventText, surfaceEventsOf } from './messages.ts'

export interface ToolEnvironment extends KernelConfigInput {
  readonly kernel: CompressionCore
  readonly store: AcpStateStore
}

interface TextOutput {
  text: string
}

function textOutput(): {
  schema: { type: 'object'; properties: { text: { type: 'string' } }; additionalProperties: boolean }
  render: (args: unknown, value: TextOutput) => import('@deepseek-ai/dsh-llm').ContentBlock[]
} {
  return {
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      additionalProperties: false,
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  }
}

function requireAgent(exec: ToolRunContext): Agent {
  if (exec.agent === undefined) {
    throw new Error('billion-context-dsh: tool requires an agent execution context')
  }
  return exec.agent
}

const compressParameters = {
  topic: { type: 'string' as const, description: 'Fallback topic for entries without their own.' },
  content: {
    type: 'array' as const,
    required: true,
    description: 'One or more ranges to compress, each with startSeq/endSeq boundaries (surface seqs) and a dense summary.',
    items: {
      type: 'object' as const,
      properties: {
        startSeq: {
          oneOf: [
            { type: 'integer' as const, description: 'First surface seq of the range.' },
            { type: 'string' as const, description: 'Seq as text; a trailing #callId fragment is ignored.' },
          ],
        },
        endSeq: {
          oneOf: [
            { type: 'integer' as const, description: 'Inclusive last surface seq of the range.' },
            { type: 'string' as const, description: 'Seq as text; a trailing #callId fragment is ignored.' },
          ],
        },
        summary: { type: 'string' as const, description: 'Complete technical summary replacing the range; keep paths, decisions, values verbatim. Minimum 50 characters.' },
        topic: { type: 'string' as const, description: 'Short label (3-5 words) for this range.' },
      },
      additionalProperties: false,
    },
  },
} as const

/** Normalize a seq arg: number, "295", or "295#call_00_xxx" → 295. */
function parseSeq(value: number | string): number {
  const text = String(value).split('#')[0]!.trim()
  const seq = Number(text)
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error(`billion-context-dsh: invalid seq "${String(value)}" — use a surface seq like 295`)
  }
  return seq
}

interface CompressArgs {
  topic?: string
  content: Array<{ startSeq: number | string; endSeq: number | string; summary: string; topic?: string }>
}

/** Resolve seq → kernel ref, then applyCompression and land the transaction. */
async function handleCompress(env: ToolEnvironment, args: CompressArgs, exec: ToolRunContext): Promise<TextOutput> {
  const agent = requireAgent(exec)
  const session = agent.session
  const state = env.store.stateFor(session)
  const coreMessages = eventsToCoreMessages(surfaceEventsOf(session))
  const tokenCount = coreMessages.reduce((sum, message) => sum + defaultCountTokens(message.text ?? ''), 0)
  const config = kernelConfigFor(env)

  // Assign refs / advance state exactly like a turn would.
  const turn = env.kernel.processTurn({ messages: coreMessages, state, config, tokenCount })
  env.store.set(session, turn.state)
  const byRaw = turn.state.messageRefs.byRaw

  const ranges = args.content.map((range) => {
    const startSeq = parseSeq(range.startSeq)
    const endSeq = parseSeq(range.endSeq)
    const startRef = byRaw[String(startSeq)]
    const endRef = byRaw[String(endSeq)]
    if (startRef === undefined || endRef === undefined) {
      throw new Error(
        `billion-context-dsh: seq ${startSeq}..${endSeq} has no assigned ref — `
        + 'the range must be on the current surface (run acp_status for the live seq list)',
      )
    }
    return {
      startSeq,
      endSeq,
      startRef,
      endRef,
      summary: range.summary,
      ...(range.topic ?? args.topic) === undefined ? {} : { topic: range.topic ?? args.topic },
    }
  })

  const applied = env.kernel.applyCompression({
    ranges: ranges.map(({ startRef, endRef, summary, topic }) => ({ startRef, endRef, summary, topic })),
    messages: coreMessages,
    state: turn.state,
    config,
  })
  if (applied.result.errors.length > 0) {
    return { text: `compress failed: ${applied.result.errors.join('; ')}` }
  }
  env.store.set(session, applied.state)

  const lines: string[] = []
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index]!
    const original = args.content[index]!
    // The edges may have been nudged to the nearest tool-pairing-balanced cut;
    // shadow exactly what resolveSurfaceRange approved.
    const { start, end } = resolveSurfaceRange(session, range.startSeq, range.endSeq)
    const shadowed = shadowedSeqsOf(session, start, end)
    // Estimate the reclaimed tokens from the actual shadowed messages so the
    // durable ledger (compaction/summary.shadowedTokenCount) reports a real
    // number instead of 0.
    let shadowedTokens = 0
    for (const seq of shadowed) {
      const event = session.events[seq]
      if (event !== undefined) shadowedTokens += defaultCountTokens(extractEventText(event))
    }
    const { compactionId } = runCompactionTransaction(session, {
      start,
      end,
      shadowedSeqs: shadowed,
      summary: [{ type: 'text', text: original.summary }],
      shadowedTokenCount: shadowedTokens,
      provider: agent.options.provider ?? '',
      model: agent.options.model ?? '',
    })
    const adjusted = start !== range.startSeq || end !== range.endSeq
    lines.push(
      `  block ${compactionId.slice(0, 8)}: seqs ${start}..${end}, ${shadowed.length} messages shadowed`
      + (adjusted ? ` (adjusted from ${range.startSeq}..${range.endSeq} to balanced edges)` : ''),
    )
  }

  return {
    text: `Compressed ${applied.result.blocksCreated} block(s), ~${applied.result.tokensCompressed} tokens reclaimed.\n${lines.join('\n')}`,
  }
}

const decompressParameters = {
  blockId: { type: 'string' as const, required: true, description: 'Block id from acp_status or search_context (the compaction id).' },
} as const

interface DecompressArgs {
  blockId: string
}

function handleDecompress(_env: ToolEnvironment, args: DecompressArgs, exec: ToolRunContext): TextOutput {
  const session = requireAgent(exec).session
  const ledger = rebuildBlockLedger(session.events)
  const block = ledger.find((entry) => entry.blockId.startsWith(args.blockId))
  if (block === undefined) {
    return { text: `decompress: block "${args.blockId}" not found (see acp_status for the block list)` }
  }
  const parts: string[] = []
  for (const seq of block.shadowedSeqs) {
    const event = session.events[seq]
    const text = event === undefined ? '' : extractEventText(event)
    if (text.length > 0) parts.push(`[seq ${seq}] ${text}`)
  }
  return {
    text: `Block ${block.blockId} — ${block.summary}\n\n${parts.join('\n\n') || '(no recoverable content)'}`,
  }
}

const searchParameters = {
  query: { type: 'string' as const, required: true, description: 'Search terms to find inside compressed blocks.' },
  limit: { type: 'integer' as const, description: 'Maximum results (default 5).' },
} as const

interface SearchArgs {
  query: string
  limit?: number
}

function handleSearch(_env: ToolEnvironment, args: SearchArgs, exec: ToolRunContext): TextOutput {
  const session = requireAgent(exec).session
  const ledger = rebuildBlockLedger(session.events)
  const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean)
  const scored: Array<{ blockId: string; score: number; summary: string }> = []
  for (const block of ledger) {
    const original = block.shadowedSeqs
      .map((seq) => extractEventText(session.events[seq]!))
      .join('\n')
    const haystack = `${block.summary}\n${original}`.toLowerCase()
    let score = 0
    for (const term of terms) score += haystack.split(term).length - 1
    if (score > 0) scored.push({ blockId: block.blockId, score, summary: block.summary })
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, args.limit ?? 5)
  if (top.length === 0) return { text: `search_context: no matches for "${args.query}"` }
  return {
    text: `Matches for "${args.query}":\n`
      + top.map((hit) => `  - ${hit.blockId} (score ${hit.score}): ${hit.summary.slice(0, 160)}`).join('\n')
      + '\n\nDecompress with: decompress({ blockId })',
  }
}

const statusParameters = {} as const

interface StatusArgs {
  [key: string]: never
}

function handleStatus(env: ToolEnvironment, _args: StatusArgs, exec: ToolRunContext): TextOutput {
  const session = requireAgent(exec).session
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
    lines.push(`  - ${block.blockId.slice(0, 8)}: seqs ${block.start}..${block.end} (${block.shadowedSeqs.length} msgs) — ${block.summary.slice(0, 80)}`)
  }
  return { text: lines.join('\n') }
}

/** Build the four ACP model tools bound to one engine. */
export function makeTools(env: ToolEnvironment): ToolDefinition[] {
  return [
    defineTool({
      name: 'compress',
      description:
        'Replace older conversation ranges with dense summaries you write. '
        + 'Each message seq is a surface reference. Single range: compress({ content: [{ startSeq, endSeq, summary }] }). '
        + 'Batch multiple unrelated ranges in one call. Never compress content the current step is actively using.',
      parameters: compressParameters,
      output: textOutput(),
      async execute(args, exec) {
        return handleCompress(env, args as CompressArgs, exec)
      },
    }),
    defineTool({
      name: 'decompress',
      description: 'Recover the original content of a compressed block by its blockId (read-only; does not unshadow the range).',
      parameters: decompressParameters,
      output: textOutput(),
      execute(args, exec) {
        return Promise.resolve(handleDecompress(env, args as DecompressArgs, exec))
      },
    }),
    defineTool({
      name: 'search_context',
      description: 'Search inside compressed blocks (summaries and original content) for information the model no longer sees in context.',
      parameters: searchParameters,
      output: textOutput(),
      execute(args, exec) {
        return Promise.resolve(handleSearch(env, args as SearchArgs, exec))
      },
    }),
    defineTool({
      name: 'acp_status',
      description: 'Report the ACP block ledger: compressed blocks, reclaimed tokens, and current context pressure.',
      parameters: statusParameters,
      output: textOutput(),
      execute(args, exec) {
        return Promise.resolve(handleStatus(env, args as StatusArgs, exec))
      },
    }),
  ]
}
