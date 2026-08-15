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
import { resolveTokenCount } from './nudge.ts'
import { windowSourceLabel, type AcpWindow } from './window.ts'
import {
  AlreadyCompressedRangeError,
  blockRefForSummarySeq,
  compactionIdsOfKernelBlocks,
  expandShadowedSeqs,
  rebuildBlockLedger,
  resolveSurfaceRange,
  runCompactionTransaction,
  shadowedSeqsOf,
  surfaceSummary,
  type ResolvedSurfaceRange,
} from './region.ts'
import { allLogMessages, eventsToCoreMessages, extractEventText, surfaceEventsOf } from './messages.ts'
import { DEFAULT_RESOLVED, type ResolvedPrompts } from './prompts.ts'

export interface ToolEnvironment extends KernelConfigInput {
  readonly kernel: CompressionCore
  readonly store: AcpStateStore
  /** Resolve the effective context window for an agent (optional: status falls back to modelContextLimit). */
  readonly windowFor?: (agent: Agent) => Promise<AcpWindow>
  /** Resolved prompt templates (optional: falls back to DEFAULT_RESOLVED). */
  readonly prompts?: ResolvedPrompts
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
  // Tolerated wrapped-arguments form: some models emit
  // `{ "arguments": "{\"content\": [...]}" }` (double-nested) or
  // `{ "arguments": { "content": [...] } }` instead of the unwrapped
  // `{ "content": [...] }`. The old DSH validator surfaced this as
  // `invalid arguments: "arguments" must be an object` and the model retried
  // forever. `arguments` is accepted as an optional JSON node so the wrapped
  // shape passes schema validation; `handleCompress` unwraps it and falls back
  // to a clear runtime error when neither form carries content. `content` is
  // intentionally NOT `required: true` — a required property would reject the
  // wrapped shape before `handleCompress` can see it. The tool description
  // still tells the model content is mandatory.
  arguments: { type: 'json', description: 'Tolerated wrapped-arguments form (model-generated); unwrapped in handleCompress. Prefer passing content directly.' },
  topic: { type: 'string' as const, description: 'Fallback topic for entries without their own.' },
  content: {
    type: 'array' as const,
    description: 'One or more ranges to compress, each with startSeq/endSeq boundaries (surface seqs) and a dense summary. Required — pass it directly, not wrapped in an arguments key.',
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
  /** Tolerated wrapped-arguments form (model-generated double-nesting). */
  arguments?: string | { content?: CompressArgs['content'] }
  topic?: string
  content?: Array<{ startSeq: number | string; endSeq: number | string; summary: string; topic?: string }>
}

/**
 * Unwrap the tolerated wrapped-arguments forms back to the canonical shape:
 * `{ arguments: "{\"content\": [...]}" }` or `{ arguments: { content: [...] } }`
 * → `{ content: [...] }`. The direct `{ content: [...] }` form passes through
 * untouched. Returns null when no form carries content (caller raises).
 */
function unwrapCompressArgs(args: CompressArgs): CompressArgs | null {
  if (args.content !== undefined) return args
  if (args.arguments === undefined) return null
  let inner: unknown = args.arguments
  if (typeof inner === 'string') {
    try {
      inner = JSON.parse(inner)
    } catch {
      return null
    }
  }
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return null
  const content = (inner as { content?: unknown }).content
  if (content === undefined) return null
  return { ...args, content: content as CompressArgs['content'] }
}

/** Resolve seq → kernel ref, then applyCompression and land the transaction. */
async function handleCompress(env: ToolEnvironment, args: CompressArgs, exec: ToolRunContext): Promise<TextOutput> {
  const agent = requireAgent(exec)
  const session = agent.session
  const state = env.store.stateFor(session)
  // The kernel gets the FULL log (visible + shadowed): syncBlocks deactivates
  // a block whose consumed messages are absent, and resolveBoundaries refuses
  // to anchor a block ref it cannot find, so tier-2/3 distillation needs the
  // originals present. The token count uses the same priority chain as the
  // nudge (projectedTokens → surfaceTokens → character heuristic).
  const coreMessages = allLogMessages(session)
  const surfaceMessages = eventsToCoreMessages(surfaceEventsOf(session))
  const tokenCount = resolveTokenCount(agent, surfaceMessages)
  const config = kernelConfigFor(env)

  // Assign refs / advance state exactly like a turn would.
  const turn = env.kernel.processTurn({ messages: coreMessages, state, config, tokenCount })
  env.store.set(session, turn.state)
  const byRaw = turn.state.messageRefs.byRaw

  // Tolerate the wrapped-arguments forms some models emit (double-nested
  // `{ arguments: "..." }`), which the old DSH validator surfaced as
  // `"arguments" must be an object` and sent the model into a retry loop.
  const unwrapped = unwrapCompressArgs(args)
  if (unwrapped === null) {
    return {
      text: 'compress: missing content — pass the content array directly: compress({ content: [{ startSeq, endSeq, summary }] })',
    }
  }
  args = unwrapped

  const ranges: Array<
    ResolvedSurfaceRange & {
      startSeq: number
      endSeq: number
      startRef: string
      endRef: string
      summary: string
      topic?: string
    }
  > = []
  // Ranges whose whole span was already shadowed by earlier compressions.
  // They land as advisory warnings, never as errors or phantom blocks.
  const alreadyCompressedNotes: string[] = []
  for (const range of args.content!) {
    const startSeq = parseSeq(range.startSeq)
    const endSeq = parseSeq(range.endSeq)
    let resolved: ResolvedSurfaceRange
    try {
      // Balance edges FIRST: the requested edges may sit on multi-tool-call
      // assistant messages, which project to `${seq}#${callId}` CoreMessage ids
      // and therefore have NO bare-`${seq}` ref. resolveSurfaceRange shifts them
      // to clean tool-pairing-balanced cuts that always carry a bare ref, so the
      // resolved refs exist and the shadowed span matches the returned range.
      // Edges shadowed by an earlier compression (stale nudge table / old
      // compress result) are remapped to the still-live content of the span.
      resolved = resolveSurfaceRange(session, startSeq, endSeq)
    } catch (error) {
      if (error instanceof AlreadyCompressedRangeError) {
        const covering = error.coveringBlockIds
        const blockNote = covering.length === 0
          ? ''
          : ` (block ${covering[0]!.slice(0, 8)}${covering.length > 1 ? ` +${covering.length - 1} more` : ''})`
        alreadyCompressedNotes.push(
          `  seqs ${error.start}..${error.end} already compressed${blockNote} — nothing to reclaim; decompress to recover the originals`,
        )
        continue
      }
      throw error
    }
    // An edge on an ACTIVE block's checkpoint summary node resolves to the
    // kernel block ref (bN) — the boundary that makes applyCompression distill
    // (tier 2/3) instead of folding the summary as a plain message.
    const startBlockRef = blockRefForSummarySeq(session, resolved.start)
    const endBlockRef = blockRefForSummarySeq(session, resolved.end)
    const startRef = startBlockRef ?? byRaw[String(resolved.start)]
    const endRef = endBlockRef ?? byRaw[String(resolved.end)]
    if (startRef === undefined || endRef === undefined) {
      throw new Error(
        `billion-context-dsh: seq ${resolved.start}..${resolved.end} has no assigned ref — `
        + 'the range must be on the current surface (run acp_status for the live seq list)',
      )
    }
    ranges.push({
      ...resolved,
      startSeq,
      endSeq,
      startRef,
      endRef,
      summary: range.summary,
      ...(range.topic ?? args.topic) === undefined ? {} : { topic: range.topic ?? args.topic },
    })
  }

  // Nothing to do: every requested range was already compressed.
  if (ranges.length === 0) {
    const text = ['Compressed 0 block(s), ~0 tokens reclaimed.', ...alreadyCompressedNotes]
    if (alreadyCompressedNotes.length > 0) {
      text.push('  (all requested ranges were already compressed — decompress a block to recover its originals)')
    }
    return { text: text.join('\n') }
  }

  const applied = env.kernel.applyCompression({
    ranges: ranges.map(({ startRef, endRef, summary, topic }) => ({ startRef, endRef, summary, topic })),
    messages: coreMessages,
    state: turn.state,
    config,
    // Deliberately NOT overriding protectedMessageIds: with the full log the
    // kernel's recent/last-user protection is computed over the same
    // non-block-covered messages as the visible feed, so default behavior is
    // preserved. Any 'Excluded N protected message(s)' warning is surfaced.
  })
  if (applied.result.errors.length > 0) {
    return { text: `compress failed: ${applied.result.errors.join('; ')}` }
  }
  env.store.set(session, applied.state)

  // Match freshly created kernel blocks to the requested ranges by their
  // range key (the kernel stamps startRef/endRef onto each new block).
  const previousIds = new Set(turn.state.blocks.map((block) => block.blockId))
  const newBlocks = applied.state.blocks.filter((block) => !previousIds.has(block.blockId))
  const blockByRangeKey = new Map(newBlocks.map((block) => [`${block.startRef}::${block.endRef}`, block]))
  // Warnings carry two shapes: range-prefixed ("Skipped range (a..b) — …")
  // attributable to a specific range, and free-form ("Excluded N protected
  // message(s) …") attributable to the call as a whole.
  const warningByRangeKey = new Map<string, string[]>()
  const freeWarnings: string[] = []
  for (const warning of applied.result.warnings) {
    const match = /^Skipped range \((.+?)\.\.(.+?)\)/.exec(warning)
    if (match !== null) {
      const key = `${match[1]}::${match[2]}`
      const list = warningByRangeKey.get(key) ?? []
      list.push(warning)
      warningByRangeKey.set(key, list)
    } else {
      freeWarnings.push(warning)
    }
  }

  const lines: string[] = []
  let skippedRanges = 0
  for (const range of ranges) {
    const key = `${range.startRef}::${range.endRef}`
    const block = blockByRangeKey.get(key)
    if (block === undefined) {
      // The kernel skipped this range (already compressed / overlapped): no
      // kernel block was created, so no durable transaction is landed — the
      // ledger must never record a block the kernel does not know.
      skippedRanges += 1
      const warnings = warningByRangeKey.get(key) ?? []
      for (const warning of warnings) lines.push(`  ${warning}`)
      continue
    }
    // The edges were already balanced above; shadow exactly that span.
    const { start, end } = range
    const shadowed = shadowedSeqsOf(session, start, end)
    // Estimate the reclaimed tokens from the actual shadowed messages so the
    // durable ledger (compaction/summary.shadowedTokenCount) reports a real
    // number instead of 0.
    let shadowedTokens = 0
    for (const seq of shadowed) {
      const event = session.events[seq]
      if (event !== undefined) shadowedTokens += defaultCountTokens(extractEventText(event))
    }
    const tier = block.tier === 2 || block.tier === 3 ? block.tier : 1
    const parentBlockIds = compactionIdsOfKernelBlocks(session, block.directBlockIds)
    const { compactionId } = runCompactionTransaction(session, {
      start,
      end,
      shadowedSeqs: shadowed,
      summary: [{ type: 'text', text: range.summary }],
      shadowedTokenCount: shadowedTokens,
      provider: agent.options.provider ?? '',
      model: agent.options.model ?? '',
      tier,
      kernelBlockId: block.blockId,
      ...(parentBlockIds.length === 0 ? {} : { parentBlockIds }),
      // Record the kernel block's raw coverage so a restarted engine
      // rehydrates the SAME effective messages (a tier-2 block's coverage is
      // its parents' originals, not the checkpoint node).
      directMessageIds: block.directMessageIds,
      effectiveMessageIds: block.effectiveMessageIds,
    })
    const adjusted = start !== range.startSeq || end !== range.endSeq
    const tierLabel = tier === 1 ? '' : `, tier ${tier}`
    const note = range.recovered === true
      ? ` (seqs ${range.startSeq}..${range.endSeq} were already shadowed — compressed the live remainder ${start}..${end})`
      : adjusted
        ? ` (adjusted from ${range.startSeq}..${range.endSeq} to balanced edges)`
        : ''
    lines.push(
      `  block ${compactionId.slice(0, 8)}: seqs ${start}..${end}, ${shadowed.length} messages shadowed${tierLabel}${note}`,
    )
  }

  const summaryLine = `Compressed ${applied.result.blocksCreated} block(s), ~${applied.result.tokensCompressed} tokens reclaimed.`
  const totalSkipped = skippedRanges + alreadyCompressedNotes.length
  const warningLines = [...freeWarnings.map((warning) => `  ${warning}`), ...alreadyCompressedNotes, ...lines]
  const footer = totalSkipped > 0
    ? `  (${totalSkipped} range(s) skipped — see warnings above)`
    : ''
  return { text: `${summaryLine}\n${[...warningLines, footer].filter((line) => line !== '').join('\n')}` }
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
  // Tier-2/3 blocks shadow parent checkpoint nodes: expand to the originals.
  for (const seq of expandShadowedSeqs(session, block.blockId)) {
    const event = session.events[seq]
    const text = event === undefined ? '' : extractEventText(event)
    if (text.length > 0) parts.push(`[seq ${seq}] ${text}`)
  }
  const tierNote = block.tier > 1 ? ` (tier ${block.tier}, distills ${block.parentBlockIds.length} block(s))` : ''
  return {
    text: `Block ${block.blockId} — ${block.summary}${tierNote}\n\n${parts.join('\n\n') || '(no recoverable content)'}`,
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

async function handleStatus(env: ToolEnvironment, _args: StatusArgs, exec: ToolRunContext): Promise<TextOutput> {
  const agent = requireAgent(exec)
  const session = agent.session
  const ledger = rebuildBlockLedger(session.events)
  const totalTokens = ledger.reduce((sum, block) => sum + block.shadowedTokenCount, 0)
  const coreMessages = eventsToCoreMessages(surfaceEventsOf(session))
  const estimated = resolveTokenCount(agent, coreMessages)
  const window = env.windowFor === undefined
    ? { limit: env.modelContextLimit, source: 'explicit' as const }
    : await env.windowFor(agent)
  const limit = window.limit
  const lines = [
    `ACP status — session ${session.id}`,
    `  blocks: ${ledger.length}`,
    `  tokens compressed: ${totalTokens}`,
    `  estimated context: ${estimated} / ${limit} (${Math.round((estimated / limit) * 100)}%)`,
    `  context window: ${limit} (${windowSourceLabel(window)})`,
    `  surface: ${surfaceSummary(session)}`,
  ]
  for (const block of ledger.slice(0, 10)) {
    lines.push(`  - ${block.blockId.slice(0, 8)}: seqs ${block.start}..${block.end} (${block.shadowedSeqs.length} msgs) — ${block.summary.slice(0, 80)}`)
  }
  return { text: lines.join('\n') }
}

/** Build the four ACP model tools bound to one engine. */
export function makeTools(env: ToolEnvironment): ToolDefinition[] {
  const prompts = env.prompts ?? DEFAULT_RESOLVED
  return [
    defineTool({
      name: 'compress',
      description: prompts.tools.compress,
      parameters: compressParameters,
      output: textOutput(),
      async execute(args, exec) {
        return handleCompress(env, args as CompressArgs, exec)
      },
    }),
    defineTool({
      name: 'decompress',
      description: prompts.tools.decompress,
      parameters: decompressParameters,
      output: textOutput(),
      execute(args, exec) {
        return Promise.resolve(handleDecompress(env, args as DecompressArgs, exec))
      },
    }),
    defineTool({
      name: 'search_context',
      description: prompts.tools.searchContext,
      parameters: searchParameters,
      output: textOutput(),
      execute(args, exec) {
        return Promise.resolve(handleSearch(env, args as SearchArgs, exec))
      },
    }),
    defineTool({
      name: 'acp_status',
      description: prompts.tools.acpStatus,
      parameters: statusParameters,
      output: textOutput(),
      execute(args, exec) {
        return handleStatus(env, args as StatusArgs, exec)
      },
    }),
  ]
}
