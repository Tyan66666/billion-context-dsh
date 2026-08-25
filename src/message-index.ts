/**
 * M6 — acp-index: durable per-message numbering directory.
 *
 * billion-context-pi numbers every message inline (`<acp>` ref tags), so the
 * model can always map an id to the content it saw. DSH cannot do that:
 * `Session.deriveMessages()` is a frozen pure projection with no decoration
 * seam, and the `agent/request` waterfall explicitly forbids mutating
 * model-visible content — the only sanctioned channel for model-visible text
 * is the session log itself (see docs/message-index-design.md for the three
 * verified host constraints). So the numbering lives IN the log: at the FIRST
 * pre-step of each turn — the step that claimed inbox input, never the model's
 * internal tool continuation steps — we append ONE compact plugin user message
 * that numbers every surface node appended since the previous index message:
 *
 *   [acp-index] 12·user「帮我跑下测试」 13·asst「先看配置…」 14·tool bash「ls」 15·result bash「file-a file-b」
 *
 * Why this shape:
 * - The watermark is the marker event's OWN seq. It was appended after
 *   everything it indexes, so "seq > marker seq" is exactly "not yet
 *   indexed" — and because recovery scans the LOG (not the surface), the
 *   watermark stays valid after compression shadows old ranges. Compressed
 *   index lines die together with the span they describe (the block summary
 *   takes over, same as pi's tags vanishing into summaries); later turns keep
 *   numbering from the last live seq, so the id space stays continuous.
 * - Entries carry token-budgeted previews (`defaultCountTokens`, CJK-aware:
 *   1 char = 1 token there, so budgets must be token-based, not char-based).
 * - A backlog over `backlogLimit` (cold start on an upgraded session, or a
 *   long disabled window) collapses into ONE placeholder marker line instead
 *   of a giant catalog — unbounded catalogs once priced sessions past the
 *   provider limit every single step with no way back.
 * - Index lines are ordinary visible tokens and are NOT excluded anywhere:
 *   pressure accounting stays honest. Two adapter-side exceptions: search
 *   excludes them from its shadowed doc set (synthetic rows out-ranked real
 *   hits), and range solving never mistakes them for the last real user turn.
 * @module billion-context-dsh/message-index
 */

import { defaultCountTokens } from 'acp-kernel'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  addToToolCallIndex,
  extractEventText,
  INDEX_PLUGIN,
  isCheckpointNode,
  isIndexMarkerEvent,
  toolCallIdOfResultEvent,
} from './messages.ts'

/** User-tunable acp-index options (all optional; see resolveMessageIndexConfig). */
export interface MessageIndexConfig {
  /** Emit directory messages at the first pre-step of each turn. Default false — opt-in in early releases; set true to enable. */
  readonly enabled?: boolean
  /** Per-entry preview budget in `defaultCountTokens` tokens (ellipsis included). Default 24. */
  readonly previewTokens?: number
  /**
   * Max entries catalogued in one message; a bigger backlog collapses into a
   * single placeholder line that becomes the new watermark. Default 100.
   */
  readonly backlogLimit?: number
}

/** Fully resolved acp-index options. */
export interface ResolvedMessageIndexConfig {
  readonly enabled: boolean
  readonly previewTokens: number
  readonly backlogLimit: number
}

// Early releases ship the index DISABLED by default: it is a new model-facing
// injection, and out-of-the-box behavior must not change until it has proven
// itself in the field. Hosts opt in with `messageIndex: { enabled: true }`.
export const MESSAGE_INDEX_DEFAULTS: ResolvedMessageIndexConfig = { enabled: false, previewTokens: 24, backlogLimit: 100 }

/**
 * Nested config is resolved key-by-key (NOT object-spread): a host writing
 * `{ messageIndex: { enabled: false } }` must not lose the other defaults
 * the way a shallow `{ ...DEFAULT_CONFIG, ...config }` merge would.
 */
export function resolveMessageIndexConfig(config?: MessageIndexConfig): ResolvedMessageIndexConfig {
  // A nonsense budget must not silently degrade every preview to a bare seq:
  // clamp/warn like prompts fail fast at construction, just softer (this runs
  // inside engine construction too, but a typo here should not brick startup).
  let previewTokens = MESSAGE_INDEX_DEFAULTS.previewTokens
  const rawPreview = config?.previewTokens
  if (rawPreview !== undefined) {
    if (typeof rawPreview === 'number' && Number.isFinite(rawPreview)) {
      previewTokens = Math.max(0, Math.floor(rawPreview))
      if (previewTokens !== rawPreview) {
        console.warn(`[billion-context-dsh] messageIndex.previewTokens ${rawPreview} is not a usable token count — clamped to ${previewTokens}`)
      }
    } else {
      console.warn(`[billion-context-dsh] messageIndex.previewTokens must be a finite number, got ${String(rawPreview)} — keeping default ${MESSAGE_INDEX_DEFAULTS.previewTokens}`)
    }
  }
  let backlogLimit = MESSAGE_INDEX_DEFAULTS.backlogLimit
  const rawBacklog = config?.backlogLimit
  if (rawBacklog !== undefined) {
    if (typeof rawBacklog === 'number' && Number.isFinite(rawBacklog) && rawBacklog >= 1) {
      backlogLimit = Math.floor(rawBacklog)
    } else {
      console.warn(`[billion-context-dsh] messageIndex.backlogLimit must be a finite number >= 1, got ${String(rawBacklog)} — keeping default ${MESSAGE_INDEX_DEFAULTS.backlogLimit}`)
    }
  }
  return {
    enabled: config?.enabled ?? MESSAGE_INDEX_DEFAULTS.enabled,
    previewTokens,
    backlogLimit,
  }
}

/** One numbered surface node: its seq, a compact kind label, and a budgeted content preview ('' when the node has no text). */
export interface IndexEntry {
  readonly seq: number
  readonly label: string
  readonly preview: string
}

/**
 * The newest acp-index marker seq in the LOG (0 when none). The marker's own
 * seq outranks everything it indexed because it was appended after them, so
 * no header parsing is needed. Scanning the log instead of the surface keeps
 * the watermark correct after a compression shadows old ranges — re-indexing
 * shadowed content would be wrong (its seqs no longer resolve on the surface).
 */
export function indexWatermarkOf(session: Session): number {
  for (let seq = session.events.length - 1; seq >= 0; seq -= 1) {
    const event = session.events[seq]
    if (event !== undefined && isIndexMarkerEvent(event)) return event.seq
  }
  return 0
}

/**
 * Flatten one preview: strip control characters (they render as garbage in a
 * single-line directory), collapse whitespace runs to single spaces, and map
 * delimiter-lookalike characters to ASCII (`「`/`"`/`’` → `'`, `·` → `,`) so
 * the entry's own `seq·label「…」` punctuation stays unambiguous.
 */
function flattenPreview(text: string): string {
  return text
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/[「」"'‘’]/g, "'")
    .replace(/·/g, ',')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Truncate to a `defaultCountTokens` token budget (the kernel's CJK-aware
 * estimator: 1 char/token for CJK, ~4 chars/token otherwise — rule 1).
 * Character-based caps would silently cost 4× more on CJK sessions.
 *
 * Two performance/correctness guards before the binary search:
 * - Worst-case density is flat-4 ASCII, so ANY prefix within the budget spans
 *   at most ~4×budget characters. Coarse-cut the RAW input first (flattening
 *   a megabyte node just to discard it cost ~350ms of synchronous pre-step
 *   time), flatten the small piece, re-cut to the same bound, and only then
 *   binary-search the exact prefix.
 * - The final cut never splits a surrogate pair (a lone half renders as U+FFFD).
 */
export function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (!Number.isFinite(maxTokens) || maxTokens < 1) return ''
  const rough = flattenPreview(text.slice(0, maxTokens * 4 + 64))
  const flat = rough.slice(0, maxTokens * 4 + 4)
  if (defaultCountTokens(flat) <= maxTokens) return flat
  let low = 1
  let high = flat.length
  let best = 0
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (defaultCountTokens(flat.slice(0, mid)) + 1 <= maxTokens) {
      best = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  // A budget-fitting cut landed mid-string; back off one code unit when it
  // would sever the low half of a surrogate pair.
  if (best > 0) {
    const code = flat.charCodeAt(best - 1)
    if (code >= 0xd800 && code <= 0xdbff) best -= 1
  }
  return `${flat.slice(0, best).trimEnd()}…`
}

function labelOf(event: SessionEvent, toolNames: ReadonlyMap<string, string>): string {
  switch (event.type) {
    case 'user/message':
      return 'user'
    case 'assistant/message': {
      const content = (event.data as { message?: { content?: unknown } }).message?.content
      const call = Array.isArray(content)
        ? content.find((block) => (block as { type?: unknown })?.type === 'tool-call')
        : undefined
      if (call === undefined) return 'asst'
      const name = (call as { name?: unknown }).name
      return typeof name === 'string' && name !== '' ? `tool ${name}` : 'tool'
    }
    case 'tool/result': {
      // Real tool-result events carry no toolName (hard-won rule 10) — backfill
      // from the assistant tool-call index like the projection does.
      const name = toolNames.get(toolCallIdOfResultEvent(event) ?? '') ?? ''
      return name !== '' ? `result ${name}` : 'result'
    }
    default:
      // Neutral on purpose: echoing the raw event.type would leak internal
      // session vocabulary into model-visible text.
      return 'note'
  }
}

/**
 * Incrementally-scanned assistant tool-call index per session. The log is
 * append-only and monotonic, so rescanning EVERY event on each pre-step made
 * directory building O(full log) every step (quadratic over a session). The
 * cache remembers how far it scanned; a shrink behind the same Session object
 * would mean a different log — restart defensively.
 */
const toolNameCaches = new WeakMap<Session, { scannedUpTo: number; readonly index: Map<string, string> }>()

function toolNamesFor(session: Session): ReadonlyMap<string, string> {
  const events = session.events
  let cache = toolNameCaches.get(session)
  if (cache === undefined || cache.scannedUpTo > events.length) {
    cache = { scannedUpTo: 0, index: new Map() }
    toolNameCaches.set(session, cache)
  }
  for (let seq = cache.scannedUpTo; seq < events.length; seq += 1) {
    const event = events[seq]
    if (event !== undefined) addToToolCallIndex(cache.index, event)
  }
  cache.scannedUpTo = events.length
  return cache.index
}

/** Number every surfaced node above the watermark, in surface order. Checkpoint nodes and prior index messages are skipped. */
export function collectIndexEntries(session: Session, watermark: number, previewTokens: number): IndexEntry[] {
  const toolNames = toolNamesFor(session)
  const entries: IndexEntry[] = []
  for (const seq of session.surface.nodes) {
    if (seq <= watermark) continue
    const event = session.events[seq]
    if (event === undefined || isCheckpointNode(event) || isIndexMarkerEvent(event)) continue
    entries.push({ seq, label: labelOf(event, toolNames), preview: truncateToTokenBudget(extractEventText(event), previewTokens) })
  }
  return entries
}

/** One catalog line per entry — bare `seq·label` when the node has no text. */
function renderEntry(entry: IndexEntry): string {
  return entry.preview === '' ? `${entry.seq}·${entry.label}` : `${entry.seq}·${entry.label}「${entry.preview}」`
}

const indexSource = { kind: 'plugin', plugin: INDEX_PLUGIN, form: 'catalog' } as const

/**
 * Build the next acp-index directory message for this session, or null when
 * nothing new is surfaced (or the feature is disabled). The returned message
 * is appended by the pre-step listener via the SAME enter decision the nudge
 * rides — a durable plugin user message, never interleaved between a
 * tool-call and its result (pre-step runs before any call of the step).
 *
 * Backlog guard: steady-state batches stay UNCAPPED — dropping entries while
 * advancing the watermark would orphan those seqs forever. But a backlog over
 * `backlogLimit` (cold start on an upgraded session, or a long disabled
 * window) collapses into ONE placeholder marker line: measured at ~27 tokens
 * per entry, a few thousand unindexed nodes priced past the provider limit
 * EVERY step, and since the marker was already durable the session could
 * never shrink itself back. The placeholder IS an acp-index marker, so its
 * own seq becomes the watermark and normal numbering resumes next turn;
 * the skipped seqs stay locatable via acp_status / compress summaries.
 */
export function buildIndexMessage(session: Session, config: ResolvedMessageIndexConfig = MESSAGE_INDEX_DEFAULTS): UserMessage | null {
  if (!config.enabled) return null
  const entries = collectIndexEntries(session, indexWatermarkOf(session), config.previewTokens)
  if (entries.length === 0) return null
  if (entries.length > config.backlogLimit) {
    const first = entries[0]!.seq
    const last = entries[entries.length - 1]!.seq
    return createUserMessage({
      content: [{ type: 'text', text: `[acp-index] ${first}..${last} — ${entries.length} earlier messages already exist, listed by seq only (inspect via acp_status, compress to archive)` }],
      source: indexSource,
    })
  }
  const body = entries.map(renderEntry).join(' ')
  return createUserMessage({
    content: [{ type: 'text', text: `[acp-index] ${body}` }],
    source: indexSource,
  })
}
