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

import { defineTool, ToolArgsError, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { buildStatusReport, defaultCountTokens, searchBlocks, type CompressionCore, type MessageRole, type SearchDoc } from 'acp-kernel'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { AcpStateStore } from './state.ts'
import { kernelConfigFor, type KernelConfigInput } from './config.ts'
import { resolveTokenCount } from './nudge.ts'
import type { AcpWindow } from './window.ts'
import {
  AlreadyCompressedRangeError,
  blockIdOfKernelRef,
  blockRefForSummarySeq,
  blockRegistry,
  compactionIdsOfKernelBlocks,
  expandShadowedSeqs,
  rebuildBlockLedger,
  resolveSurfaceRange,
  runCompactionTransaction,
  shadowedSeqsOf,
  stripOrphanedSurfaceToolMessages,
  openToolCallIds,
  surfaceSummary,
  type ResolvedSurfaceRange,
} from './region.ts'
import { allLogMessages, buildToolCallIndex, eventsToCoreMessages, extractEventText, surfaceEventsOf } from './messages.ts'
import { shadowedTokensViaMeter } from './host-tokens.ts'
import { DEFAULT_RESOLVED, type ResolvedPrompts } from './prompts.ts'

export interface ToolEnvironment extends KernelConfigInput {
  readonly kernel: CompressionCore
  readonly store: AcpStateStore
  /** Resolve the effective context window for an agent (optional: status falls back to modelContextLimit). */
  readonly windowFor?: (agent: Agent) => Promise<AcpWindow>
  /** Resolved prompt templates (optional: falls back to DEFAULT_RESOLVED). */
  readonly prompts?: ResolvedPrompts
  /**
   * Call ids of compress invocations that created a durable block. The engine
   * listens for the matching `tool/result` and hides the call/result pair from
   * the surface, preventing the compaction summary from sitting between them
   * (strict providers reject that sequence with HTTP 400).
   */
  readonly compressCallIdsToHide?: Set<string>
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

/**
 * Resolve the effective context window for a tool or command run: probe the
 * agent's real window via `windowFor` when provided, otherwise fall back to
 * the environment's `modelContextLimit`. Shared by the compress and
 * acp_status tool handlers and the `/acp` command so the resolution logic
 * lives in exactly one place (issue #63 — the tools used the 128K fallback
 * for pressure decisions even when auto-detection had found a larger window).
 */
export async function resolveEffectiveWindow(env: ToolEnvironment, agent: Agent): Promise<AcpWindow> {
  return env.windowFor === undefined
    ? { limit: env.modelContextLimit, source: 'explicit' as const }
    : await env.windowFor(agent)
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
  //
  // The items fields are the opposite case: startSeq/endSeq/summary MUST be
  // `required: true`. Without that, a model call that omits `summary` (only
  // startSeq/endSeq/topic present) passed schema validation and failed late
  // inside the kernel with "Summary is empty" — and live sessions showed the
  // model retrying the identical broken call in a loop. With the fields
  // required, the same call is rejected at the schema gate with
  // `missing required property "content[0].summary"`, which tells the model
  // exactly which field to add (same pattern as decompress's required
  // blockId / search_context's required query).
  arguments: { type: 'json', description: 'Tolerated wrapped-arguments form (model-generated); unwrapped in handleCompress. Prefer passing content directly.' },
  topic: { type: 'string' as const, description: 'Fallback topic for entries without their own.' },
  content: {
    type: 'array' as const,
    description: 'One or more ranges to compress, each with startSeq/endSeq boundaries (surface seqs) and a dense summary. Required — pass it directly, not wrapped in an arguments key.',
    items: {
      type: 'object' as const,
      properties: {
        startSeq: {
          required: true,
          oneOf: [
            { type: 'integer' as const, description: 'First surface seq of the range.' },
            { type: 'string' as const, description: 'Seq as text; a trailing #callId fragment is ignored.' },
          ],
        },
        endSeq: {
          required: true,
          oneOf: [
            { type: 'integer' as const, description: 'Inclusive last surface seq of the range.' },
            { type: 'string' as const, description: 'Seq as text; a trailing #callId fragment is ignored.' },
          ],
        },
        summary: { type: 'string' as const, required: true, description: 'Complete technical summary replacing the range; keep paths, decisions, values verbatim. Minimum 50 characters.' },
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

/**
 * Match a drilldown mN ref: "m00306" / "m306" (kernel `refToIndex` semantics,
 * `m0*(\d{1,5})`), tolerating a trailing `#callId` fragment (symmetric with
 * `parseSeq`'s `#` handling). Returns the ref index, or null for non-mN input.
 */
const MN_RE = /^m0*(\d{1,5})(?:#.*)?$/i

function mnRefIndex(value: string): number | null {
  const match = MN_RE.exec(value.trim())
  if (match === null) return null
  const index = Number(match[1])
  return index >= 1 && index <= 99999 ? index : null
}

/**
 * Resolve a compress boundary arg to a surface seq. Accepts:
 *  - a bare surface seq (number, "295", "295#call_00_x" — `parseSeq`);
 *  - a drilldown mN ref ("m00306" / "m306") — reverse-mapped via the CURRENT
 *    turn's `messageRefs.byRef` (CoreMessage.id = seq or "seq#callId" → split
 *    on "#"). Unknown mN (never assigned on the current surface) fails with
 *    guidance; a valid mN whose span was already compressed falls through to
 *    the existing recover-stale / already-compressed semantics (rule 7).
 * `byRef` MUST come from `turn.state.messageRefs` (after `processTurn`), not
 * the persisted store state: acp_status's turn is never persisted, so mN refs
 * shown in a drilldown (including refs for messages that arrived since the
 * last nudge/compress) only exist on the current turn's ref map — a lookup
 * against the stored state would report a false "unknown mN" and dead-loop
 * the model between acp_status and compress.
 */
function parseBoundary(value: number | string, byRef: Record<string, string>): number {
  const text = String(value)
  const index = mnRefIndex(text)
  if (index === null) return parseSeq(value)
  // Normalize to the kernel's padded key ("m00306") — byRef holds exact keys.
  const ref = `m${String(index).padStart(5, '0')}`
  const raw = byRef[ref]
  if (raw === undefined) {
    throw new Error(
      `billion-context-dsh: mN "${text}" not found on the current surface — re-run acp_status for fresh refs (the surface may have moved)`,
    )
  }
  const seq = Number(String(raw).split('#')[0]!)
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error(
      `billion-context-dsh: mN "${text}" maps to a non-seq id "${raw}" — re-run acp_status`,
    )
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

/**
 * Peel the tolerated wrapped-arguments envelope `{ arguments: {…} }` that some
 * model channels emit for ANY tool — the same double-nesting that birthed
 * `unwrapCompressArgs` (live-verified on acp_status: a drilldown call arrived
 * as `{"arguments":{"scope":"compressed"}}` and was silently dropped, since
 * only compress unwrapped). The envelope may be an object or a JSON string;
 * inner keys win over outer duplicates. Args without an envelope pass through
 * untouched.
 */
function unwrapEnvelope<T extends object>(args: T): T {
  const envelope = (args as { arguments?: unknown }).arguments
  if (envelope === undefined) return args
  let inner: unknown = envelope
  if (typeof inner === 'string') {
    try {
      inner = JSON.parse(inner)
    } catch {
      return args
    }
  }
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return args
  return { ...args, ...(inner as object) } as T
}

/**
 * Enforce the items-level `required` contract on the EFFECTIVE content, after
 * the wrapped-arguments envelope has been peeled. The DSH schema gate only
 * sees the model's top-level arguments object — when the call arrives wrapped
 * as `{ arguments: { content: [...] } }`, the top-level `content` property is
 * absent there (it lives inside the envelope), so the gate never checks the
 * items and a missing `summary`/`startSeq`/`endSeq` sailed through to the
 * kernel, which fails late with a field-less "Summary is empty" and sent live
 * sessions into a retry loop (the same failure mode the schema gate fix for
 * the direct form closed). Running the SAME check on the unwrapped content
 * closes that window for both forms, and produces the identical
 * `invalid arguments: missing required property "content[0].summary"` surface
 * by reusing the host's `ToolArgsError` instead of a hand-rolled format.
 * An empty/whitespace-only summary counts as missing (the kernel would
 * reject it anyway — fail early with the field name instead).
 */
function validateContentItems(content: NonNullable<CompressArgs['content']>): void {
  const violations: string[] = []
  content.forEach((item, index) => {
    const path = `content[${index}]`
    if (item.startSeq === undefined) violations.push(`missing required property "${path}.startSeq"`)
    if (item.endSeq === undefined) violations.push(`missing required property "${path}.endSeq"`)
    if (typeof item.summary !== 'string' || item.summary.trim().length === 0) {
      violations.push(`missing required property "${path}.summary"`)
    }
  })
  if (violations.length > 0) throw new ToolArgsError(violations)
}

/** Resolve seq → kernel ref, then applyCompression and land the transaction. */
async function handleCompress(env: ToolEnvironment, args: CompressArgs, exec: ToolRunContext): Promise<TextOutput> {
  const agent = requireAgent(exec)
  const session = agent.session
  // Clean orphan tool messages before any range solve: a single orphan result
  // corrupts the pairing balance cache and rejects every large range (issue
  // #18). Every call still in flight — the compress call itself AND any
  // sibling tool called in the same assistant message — must be excluded from
  // orphan pruning: its tool/result lands at the end of the step, and pruning
  // the call now would orphan that result.
  stripOrphanedSurfaceToolMessages(session, openToolCallIds(session))
  const state = env.store.stateFor(session)
  // The kernel gets the FULL log (visible + shadowed): syncBlocks deactivates
  // a block whose consumed messages are absent, and resolveBoundaries refuses
  // to anchor a block ref it cannot find, so tier-2/3 distillation needs the
  // originals present. The token count uses the same priority chain as the
  // nudge (projectedTokens → surfaceTokens → character heuristic).
  const coreMessages = allLogMessages(session)
  const surfaceMessages = eventsToCoreMessages(surfaceEventsOf(session))
  const tokenCount = resolveTokenCount(agent, surfaceMessages)
  const window = await resolveEffectiveWindow(env, agent)
  const config = kernelConfigFor({ ...env, modelContextLimit: window.limit })

  // Assign refs / advance state exactly like a turn would.
  const turn = env.kernel.processTurn({ messages: coreMessages, state, config, tokenCount })
  env.store.set(session, turn.state)
  const byRaw = turn.state.messageRefs.byRaw
  // mN drilldown refs resolve against the CURRENT turn's ref map (not the
  // stored state) — acp_status's turn is never persisted, so its mN rows only
  // exist here; the deterministic re-assignment yields the same mN for the
  // same messages (see parseBoundary).
  const byRef = turn.state.messageRefs.byRef

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
  // Items-level required check AFTER the envelope peel (see
  // validateContentItems for why the schema gate alone cannot do this).
  validateContentItems(args.content!)

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
    const startSeq = parseBoundary(range.startSeq, byRef)
    const endSeq = parseBoundary(range.endSeq, byRef)
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
  // A kernel error for ONE range must not poison the whole call: the other
  // ranges still created blocks. This matters for issue #18's "phantom range"
  // — messages absorbed into an earlier block's effectiveMessageIds (kernel
  // boundary adjustment) but still live on the surface resolve fine but make
  // the kernel throw "Range contains no compressible messages". Fail only
  // when NOTHING landed; otherwise land the successes and surface the
  // failures as advisory lines below.
  if (applied.result.errors.length > 0 && applied.result.blocksCreated === 0) {
    return { text: `compress failed: ${applied.result.errors.join('; ')}` }
  }
  env.store.set(session, applied.state)
  if (applied.result.blocksCreated > 0) {
    // Hide this compress call/result after the tool result lands, so the
    // compaction summary never sits between an assistant tool_calls block and
    // its tool response (strict providers reject that sequence).
    env.compressCallIdsToHide?.add(exec.callId)
  }

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
    // Price the reclaimed tokens in the HOST's token vocabulary (rule 12):
    // prefer the live meter's per-node prices, fall back to the exact mirror.
    // NEVER defaultCountTokens — that overdraws the meter on CJK (issue #54).
    const shadowedTokens = shadowedTokensViaMeter(session, shadowed, agent.ctx)
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
      ...(range.topic === undefined ? {} : { topic: range.topic }),
      ...(parentBlockIds.length === 0 ? {} : { parentBlockIds }),
      // Record the kernel block's raw coverage so a restarted engine
      // rehydrates the SAME effective messages (a tier-2 block's coverage is
      // its parents' originals, not the checkpoint node).
      directMessageIds: block.directMessageIds,
      effectiveMessageIds: block.effectiveMessageIds,
    })
    const adjusted = start !== range.startSeq || end !== range.endSeq
    // Always report the tier, even tier 1: a silently-downgraded distill
    // (boundary moved off the checkpoint seq → the kernel folds a plain
    // message) must be visible to the model immediately, or the model keeps
    // believing the distillation landed (issue #60, failure mode 2).
    const tierLabel = `, tier ${tier}`
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
  const failedLines = applied.result.errors.map((error) => `  ${error}`)
  const warningLines = [...freeWarnings.map((warning) => `  ${warning}`), ...failedLines, ...alreadyCompressedNotes, ...lines]
  const footer = totalSkipped > 0
    ? `  (${totalSkipped} range(s) skipped or failed — see above)`
    : ''
  return { text: `${summaryLine}\n${[...warningLines, footer].filter((line) => line !== '').join('\n')}` }
}

const decompressParameters = {
  blockId: { type: 'string' as const, required: true, description: 'Block id: the kernel block ref `bN` shown by acp_status (e.g. b1), or a compaction id / prefix from search_context.' },
} as const

interface DecompressArgs {
  blockId: string
}

/** Resolve a block arg to its durable compaction id: exact `bN` kernel ref
 *  first (acp_status shows `bN`), then the compaction-id prefix match that
 *  search_context and /acp have always used. The `bN` branch is exact
 *  (`/^b\d+$/` with `$`), so a UUID that happens to start with `b1` cannot be
 *  shadowed — full UUIDs and 8-char prefixes never match the anchored regex. */
function resolveBlockId(session: Session, arg: string): string | null {
  const byKernelRef = blockIdOfKernelRef(session, arg)
  if (byKernelRef !== null) return byKernelRef
  const ledger = rebuildBlockLedger(session.events)
  const byPrefix = ledger.find((entry) => entry.blockId.startsWith(arg))
  return byPrefix?.blockId ?? null
}

function handleDecompress(_env: ToolEnvironment, rawArgs: DecompressArgs, exec: ToolRunContext): TextOutput {
  const args = unwrapEnvelope<DecompressArgs>(rawArgs)
  const session = requireAgent(exec).session
  const blockId = resolveBlockId(session, args.blockId)
  if (blockId === null) {
    return { text: `decompress: block "${args.blockId}" not found (see acp_status for the block list)` }
  }
  const ledger = rebuildBlockLedger(session.events)
  const block = ledger.find((entry) => entry.blockId === blockId)
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

/** Event type → kernel message role (drives hybrid role weighting). */
function roleOfEvent(event: SessionEvent): MessageRole | null {
  switch (event.type) {
    case 'user/message': return 'user'
    case 'assistant/message': return 'assistant'
    case 'tool/result': return 'tool'
    default: return null
  }
}

/**
 * Build the unified SearchDoc[] from the log: one block doc per ledger entry
 * (ref = compactionId, so `decompress({ blockId })` closes the loop) plus one
 * message doc per shadowed ORIGINAL (expanded through distilled parents; each
 * seq is claimed by the earliest/innermost block that covered it, mirroring
 * pi's owner map — decompress on that block recovers the original).
 */
function buildSearchDocs(session: Session): SearchDoc[] {
  const ledger = rebuildBlockLedger(session.events)
  const docs: SearchDoc[] = []
  const claimed = new Set<number>()
  for (const block of ledger) {
    docs.push({
      kind: 'block',
      ref: block.blockId,
      text: block.summary,
      title: block.summary.slice(0, 60) || block.blockId,
      blockId: block.blockId,
      tier: block.tier,
      tokens: defaultCountTokens(block.summary),
    })
    for (const seq of expandShadowedSeqs(session, block.blockId)) {
      if (claimed.has(seq)) continue
      claimed.add(seq)
      const event = session.events[seq]
      if (event === undefined) continue
      const role = roleOfEvent(event)
      const text = extractEventText(event)
      if (role === null || text.length === 0) continue
      docs.push({
        kind: 'message',
        ref: `seq ${seq}`,
        text,
        title: `${role}: ${text.slice(0, 60)}`,
        role,
        blockId: block.blockId,
        tier: block.tier,
        tokens: defaultCountTokens(text),
      })
    }
  }
  return docs
}

function handleSearch(_env: ToolEnvironment, rawArgs: SearchArgs, exec: ToolRunContext): TextOutput {
  const args = unwrapEnvelope<SearchArgs>(rawArgs)
  const session = requireAgent(exec).session
  if (args.query.trim() === '') return { text: 'search_context: empty query (no matches)' }
  const docs = buildSearchDocs(session)
  // Trust the kernel: hybrid (0.7×BM25 stemmed + 0.3×fuzzy n-gram) is the
  // algorithm contract — no engine-side gate or threshold re-implements
  // search policy. Scores are surfaced so the model can judge a weak hit
  // (fuzzy-only tops out near 0.3).
  const results = searchBlocks(docs, args.query, { limit: args.limit ?? 5, previewLength: 160 })
  if (results.length === 0) return { text: `search_context: no matches for "${args.query}"` }
  const lines = results.map((r) => {
    const kind = r.kind === 'block' ? `block ${r.ref}` : `message ${r.ref} (${r.role ?? '?'}, in block ${r.blockId ?? '?'})`
    return `  - ${kind} (score ${r.score.toFixed(2)}): ${r.preview}`
  })
  return {
    text: `Matches for "${args.query}":\n${lines.join('\n')}\n\nDecompress with: decompress({ blockId })`,
  }
}

/** acp_status drilldown passthrough (kernel buildStatusReport options). All
 *  keys optional — no args = overview. `view`/`tool`/`sort`/`limit` only have
 *  meaning under `scope:"uncompressed"` (`tool` narrows to `view:"messages"`;
 *  `sort:"age"` applies to `scope:"compressed"`); the kernel ignores them in
 *  overview mode (upstream status-tool docstring documented the same scope).
 *  DSH schema compiler: `string` + `enum` supported, no `required: true`
 *  anywhere → all optional (schema.js:192-210). */
const statusParameters = {
  scope: {
    type: 'string' as const,
    enum: ['compressed', 'uncompressed'] as const,
    description: 'Drilldown scope: "compressed" lists compressed blocks, "uncompressed" lists visible messages. Omit for the overview.',
  },
  view: {
    type: 'string' as const,
    enum: ['ranges', 'messages'] as const,
    description: 'Drilldown view under scope:"uncompressed": "ranges" merges visible messages into ranges (default), "messages" lists every message.',
  },
  tool: {
    type: 'string' as const,
    description: 'Filter drilldown rows to one tool name (scope:"uncompressed" + view:"messages" only).',
  },
  sort: {
    type: 'string' as const,
    enum: ['size', 'time', 'tool', 'age'] as const,
    description: 'Row order: size (default, most tokens first), time, tool; "age" applies to compressed blocks.',
  },
  limit: {
    type: 'integer' as const,
    description: 'Cap on rows or blocks shown (default 30).',
  },
}

interface StatusArgs {
  scope?: 'compressed' | 'uncompressed'
  view?: 'ranges' | 'messages'
  tool?: string
  sort?: 'size' | 'time' | 'tool' | 'age'
  limit?: number
}

/** A compaction checkpoint summary node (`source.plugin === 'compact'`). These
 *  are NOT in any block's `effectiveMessageIds`, so feeding them to
 *  `buildStatusReport` would double-count the summary — once as `block.summary`
 *  (summaryTokens) and once as a visible text message (totalText). Excluded
 *  before status rendering (design §4.2 P1-3). */
function isCheckpointEvent(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  const source = (event.data as { source?: { plugin?: string } }).source
  return source?.plugin === 'compact'
}

async function handleStatus(env: ToolEnvironment, rawArgs: StatusArgs, exec: ToolRunContext): Promise<TextOutput> {
  // The model channel may wrap ANY tool's args under `{ arguments: {…} }`;
  // peel it or drilldown params never reach buildStatusReport (live-verified
  // `{"arguments":{"scope":"compressed"}}` silently rendered the overview).
  const args = unwrapEnvelope<StatusArgs>(rawArgs)
  const agent = requireAgent(exec)
  const session = agent.session
  const state = env.store.stateFor(session)
  const surface = surfaceEventsOf(session)
  // One tool-call index for both projections below (P2-5): tool/result
  // toolName/toolCallId are backfilled from the assistant tool-calls.
  const toolNames = buildToolCallIndex(surface)
  const coreMessages = allLogMessages(session)
  const surfaceMessages = eventsToCoreMessages(surface, toolNames)
  const tokenCount = resolveTokenCount(agent, surfaceMessages)
  const window = await resolveEffectiveWindow(env, agent)
  const config = kernelConfigFor({ ...env, modelContextLimit: window.limit })
  // Run the same pipeline the context transform runs, so what acp_status
  // reports matches what the model actually receives. The returned turn.state
  // carries the freshly assigned refs; it is NOT persisted — acp_status is a
  // read-only view, and env.store.set would advance the nudge baseline a
  // second time in the same turn (design §6.1 P2-2).
  const turn = env.kernel.processTurn({ messages: coreMessages, state, config, tokenCount })
  // Status messages = visible surface EXCLUDING checkpoint summary nodes (P1-3).
  const statusMessages = eventsToCoreMessages(
    surface.filter((event) => !isCheckpointEvent(event)),
    toolNames,
  )
  // Upstream-aligned: the kernel renders the breakdown (percentages of the
  // VISIBLE total — no window semantics; drilldown scope/view/tool/sort/limit
  // pass through verbatim); the engine only appends the nudge decision line,
  // the DSH Surface anchor, and — in drilldown mode — the mN-vs-seq note.
  const report = buildStatusReport(turn.state, statusMessages, defaultCountTokens, args)
  const lines = [report]
  // Mirror upstream pi (`if (args.scope) return base`): a drilldown request
  // answers with the kernel report alone — the nudge decision line is an
  // overview concept. The Surface anchor stays in ALL modes: it is the model's
  // compressible-ref locator (design P2-1).
  if (args.scope === undefined) {
    const nudge = turn.nudge
    if (nudge !== undefined) {
      lines.push('', `Nudge: ${nudge.shouldInject ? 'ACTIVE' : 'idle'} — ${nudge.reason}`)
    }
    // Issue #60 P2: the model's only route to T2/T3 distillation is a LIVE
    // checkpoint seq — but acp_status (kernel buildStatusReport) is blind to
    // summary nodes (they are excluded as messages, rule 9) and shows only bN
    // refs. Append an engine-side mapping bN → checkpoint seq for ACTIVE
    // blocks (only active blocks are distillable). Appending is the
    // kernel-alignment contract: the kernel owns the report text, the engine
    // owns the wiring — this row is wiring, never a rewrite of the report.
    const checkpointRows = blockRegistry(session)
      .filter((entry) => entry.active && entry.summarySeq !== null)
      .map((entry) => `${entry.kernelBlockId} → seq ${entry.summarySeq}`)
    if (checkpointRows.length > 0) {
      lines.push('', `Checkpoint seqs (active blocks — compress a checkpoint seq to distill it): ${checkpointRows.join(', ')}`)
    }
  }
  lines.push('', `Surface: ${surfaceSummary(session)}`)
  // Drilldown rows carry kernel refs (mN, dense log-order ids) — compress
  // accepts them directly (handleCompress reverse-maps mN → live surface seq
  // via the current turn's messageRefs.byRef; issue #31). The Surface anchor
  // remains the model's compressible-seq locator for nudge-style ranges.
  if (args.scope === 'uncompressed') {
    lines.push('', 'Note: drilldown rows are kernel refs (mN) — feed them straight to compress (auto-mapped to the live surface seq); an unknown mN fails with guidance.')
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
