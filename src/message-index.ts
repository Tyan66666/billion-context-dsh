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
 * that numbers every surface node appended since the previous index message.
 * A token-delay guard re-injects mid-turn when a long tool run lets unindexed
 * content pile past its threshold. Tool output (`maxDelayToolTokens`) and
 * conversation messages (`maxDelayTextTokens`, 0 = off) are counted
 * separately, so a turn that never claims inbox input again still gets
 * numbered before the model loses seq↔content alignment:
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
  extractToolCallText,
  INDEX_PLUGIN,
  isCheckpointNode,
  isIndexMarkerEvent,
  isToolEvent,
  toolCallIdOfResultEvent,
  classifySurfaceEvent,
} from './messages.ts'

/** User-tunable acp-index options (all optional; see resolveMessageIndexConfig). */
export interface MessageIndexConfig {
  /** Emit directory messages at the first pre-step of each turn. Default false — opt-in in early releases; set true to enable. */
  readonly enabled?: boolean
  /** Per-entry preview budget in `defaultCountTokens` tokens (ellipsis included). Default 16. */
  readonly previewTokens?: number
  /**
   * Max entries catalogued in one message; a bigger backlog collapses into a
   * single placeholder line that becomes the new watermark. Default 100.
   */
  readonly backlogLimit?: number
  /**
   * Re-inject the directory mid-turn once unindexed TOOL text (tool-result
   * content and tool-call `arguments`; an assistant's own prose block is NOT
   * tool output and never counts) has accumulated at least this many tokens.
   * Per-turn cadence alone can leave a very long turn (one user message,
   * dozens of internal tool rounds) unnumbered for tens of thousands of
   * tokens — the model loses seq↔content alignment exactly when it needs it
   * most. The delay guard fires on tool continuation steps too (they claim no
   * inbox input, so the per-turn gate skips them); short turns never cross it,
   * so behavior is identical to per-turn-only. The watermark advances with
   * every injection, so a re-injection never renumbers anything. 0 disables
   * this counter. Default 8192.
   */
  readonly maxDelayToolTokens?: number
  /**
   * Like `maxDelayToolTokens`, but counts CONVERSATION text (user and pure
   * assistant messages and notes; an assistant node carrying a tool-call is
   * classified as tool and its prose counts toward neither counter). Default
   * 0 — conversation alone never triggers a re-injection: the model just
   * wrote or read those messages, so it never loses alignment with them; the
   * counter exists for hosts that want a long conversational turn to
   * re-inject too. Any counter crossing its threshold triggers a re-injection
   * (tool OR text).
   */
  readonly maxDelayTextTokens?: number
}

/** Fully resolved acp-index options. */
export interface ResolvedMessageIndexConfig {
  readonly enabled: boolean
  readonly previewTokens: number
  readonly backlogLimit: number
  readonly maxDelayToolTokens: number
  readonly maxDelayTextTokens: number
}

// Early releases ship the index DISABLED by default: it is a new model-facing
// injection, and out-of-the-box behavior must not change until it has proven
// itself in the field. Hosts opt in with `messageIndex: { enabled: true }`.
export const MESSAGE_INDEX_DEFAULTS: ResolvedMessageIndexConfig = { enabled: false, previewTokens: 16, backlogLimit: 100, maxDelayToolTokens: 8192, maxDelayTextTokens: 0 }

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
  // Delay thresholds are independent counters over DIFFERENT message kinds:
  // tool text (`maxDelayToolTokens`) and conversation text (`maxDelayTextTokens`,
  // default 0 = conversation never triggers). Each is clamped like backlogLimit
  // (>= 0, floor; invalid → default + warn). Missing keys fall back silently —
  // the common `{ enabled: true }` opt-in must not spam warnings.
  const clampDelay = (raw: unknown, key: 'maxDelayToolTokens' | 'maxDelayTextTokens', fallback: number): number => {
    if (raw === undefined) return fallback
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
      const floored = Math.floor(raw)
      if (floored !== raw) {
        console.warn(`[billion-context-dsh] messageIndex.${key} ${raw} is not an integer — floored to ${floored}`)
      }
      return floored
    }
    console.warn(`[billion-context-dsh] messageIndex.${key} must be a finite number >= 0, got ${String(raw)} — keeping default ${fallback}`)
    return fallback
  }
  const maxDelayToolTokens = clampDelay(config?.maxDelayToolTokens, 'maxDelayToolTokens', MESSAGE_INDEX_DEFAULTS.maxDelayToolTokens)
  const maxDelayTextTokens = clampDelay(config?.maxDelayTextTokens, 'maxDelayTextTokens', MESSAGE_INDEX_DEFAULTS.maxDelayTextTokens)
  return {
    enabled: config?.enabled ?? MESSAGE_INDEX_DEFAULTS.enabled,
    previewTokens,
    backlogLimit,
    maxDelayToolTokens,
    maxDelayTextTokens,
  }
}

/** One numbered surface node: its seq, a compact kind label, a budgeted content preview ('' when the node has no text), and the estimated token size of its text. */
export interface IndexEntry {
  readonly seq: number
  readonly label: string
  readonly preview: string
  readonly tokens: number
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

/**
 * Number every surfaced node, in surface order. Checkpoint nodes and prior
 * index messages are skipped. Rows ABOVE the watermark are the new batch.
 * Rows AT or BELOW the watermark normally already have a visible numbering
 * (their covering marker is still on the surface) and are skipped — but when
 * that covering marker was itself compressed away, its numbering set becomes
 * ORPHANED: still visible, still un-compressed, yet never re-numbered by the
 * simple `seq <= watermark` cut (issue #71 review, MAJOR-A). The covering
 * marker of a node is the smallest marker seq >= node (each marker numbered
 * [previous+1 .. itself]); if it no longer exists on the surface, the node is
 * re-numbered here — the directory never loses a visible seq.
 */
export function collectIndexEntries(session: Session, watermark: number, previewTokens: number): IndexEntry[] {
  const toolNames = toolNamesFor(session)
  // Marker seqs in log order (append-only, monotonic). Scanned per call like
  // indexWatermarkOf — same O(events) cost class, only on index turns.
  const markers: number[] = []
  for (let seq = 0; seq < session.events.length; seq += 1) {
    const event = session.events[seq]
    if (event !== undefined && isIndexMarkerEvent(event)) markers.push(seq)
  }
  const surfaceSet = new Set(session.surface.nodes)
  const entries: IndexEntry[] = []
  for (const seq of session.surface.nodes) {
    const event = session.events[seq]
    if (event === undefined || isCheckpointNode(event) || isIndexMarkerEvent(event)) continue
    if (seq <= watermark) {
      // Binary search: the smallest marker seq >= node = its covering marker.
      let lo = 0
      let hi = markers.length - 1
      let covering = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const marker = markers[mid]!
        if (marker >= seq) {
          covering = marker
          hi = mid - 1
        } else {
          lo = mid + 1
        }
      }
      // Covering marker still on the surface → its text carries the numbering
      // → skip (incremental directory). Missing or compressed-away → orphan →
      // re-number below.
      if (covering >= 0 && surfaceSet.has(covering)) continue
    }
    const text = extractEventText(event)
    // Plumbing rows — host instructions (AGENTS.md injections, skill catalogs,
    // policy snapshots) and engine metadata (nudge echoes, pair stubs) — get
    // BINDING-ONLY entries: their full text already sits in the model's view,
    // so a preview would spend tokens duplicating what is adjacent, and for
    // un-compressible classes it would advertise rows no compression can ever
    // reclaim. The `[N tok]` size marker stays: a huge policy row remains
    // visible AS a policy row, which is exactly how the model should see it.
    const cls = classifySurfaceEvent(event)
    const compact = cls === 'instruction' || cls === 'metadata'
    entries.push({
      seq,
      label: compact ? (cls === 'instruction' ? 'instr' : 'meta') : labelOf(event, toolNames),
      preview: compact ? '' : truncateToTokenBudget(text, previewTokens),
      tokens: defaultCountTokens(text),
    })
  }
  return entries
}

/**
 * Estimated `defaultCountTokens` total of surfaced TOOL text (tool-result
 * content + tool-call `arguments`) ABOVE the watermark, mirroring the skip
 * set of `collectIndexEntries` (checkpoints and prior index lines). The
 * pre-step listener compares this against `maxDelayToolTokens` to decide
 * whether a long tool run has accumulated enough unindexed output to deserve
 * a mid-turn re-injection — a cheap O(surface) sum, no message built. An
 * assistant message's own prose block is excluded (it is conversation, not
 * tool output); pure conversation never counts toward this counter (that is
 * `pendingTextTokenTotal` / `maxDelayTextTokens`).
 *
 * The guard only cares about crossing `cap` (it never needs the exact sum):
 * when `cap` is finite, the loop bails as soon as the running total reaches
 * it. A single multi-megabyte CJK tool dump must never cost a full
 * tokenization pass (~1.3s measured) on every pre-step, so a node whose text
 * is long enough to possibly cross the cap is only tokenized through the
 * shortest prefix that proves the crossing — the per-node cost is O(cap),
 * not O(text).
 */
export function pendingToolTokenTotal(session: Session, watermark: number, cap = Number.POSITIVE_INFINITY): number {
  return pendingTokensOf(session, watermark, cap, (event) => {
    if (event.type === 'tool/result') return extractEventText(event)
    if (event.type === 'assistant/message') return extractToolCallText(event)
    return ''
  })
}

/**
 * Same shape as `pendingToolTokenTotal` but over CONVERSATION text (user and
 * pure assistant messages and notes — an assistant node carrying a tool-call
 * is classified as tool) — the counter behind `maxDelayTextTokens`. Default 0
 * means the pre-step gate never consults it (conversation alone never
 * triggers).
 */
export function pendingTextTokenTotal(session: Session, watermark: number, cap = Number.POSITIVE_INFINITY): number {
  return pendingTokensOf(session, watermark, cap, (event) => (isToolEvent(event) ? '' : extractEventText(event)))
}

/**
 * Shared O(surface) scan: skip set + per-kind text extraction + capped early
 * exit with a per-node length pre-filter. `extract` returns the text this
 * counter counts for one event ('' = not this counter's kind).
 */
function pendingTokensOf(
  session: Session,
  watermark: number,
  cap: number,
  extract: (event: SessionEvent) => string,
): number {
  let total = 0
  for (const seq of session.surface.nodes) {
    if (seq <= watermark) continue
    const event = session.events[seq]
    // The counter measures UN-INDEXED content. Checkpoints, metadata rows
    // (directory lines, nudge echoes, pair stubs) and instruction rows
    // (AGENTS.md injections, skill catalogs, policy snapshots) never get
    // directory entries of their own and their text is engine/host plumbing,
    // not content the model needs re-aligned — skip them or a host enabling
    // maxDelayTextTokens would see the nudge echo / an AGENTS.md row inflate
    // the counter and re-inject early.
    if (event === undefined || isCheckpointNode(event)) continue
    const cls = classifySurfaceEvent(event)
    if (cls === 'metadata' || cls === 'instruction') continue
    const text = extract(event)
    if (text.length === 0) continue
    // `defaultCountTokens` prices every char at >= 1/4 token (ASCII floor), so
    // a text shorter than 4× the remaining budget can NEVER cross the cap on
    // its own — tokenize it in full. A longer one is tokenized only through
    // the shortest prefix that proves the crossing and the result is CAPPED at
    // `cap` (the prefix can price up to 4× the budget for CJK, 1 char/token),
    // bounding a single multi-megabyte CJK dump to O(cap) instead of O(text)
    // (~1.3s → ~1ms class).
    const charsNeededToCross = 4 * (cap - total) + 64
    if (charsNeededToCross < text.length) {
      total = Math.min(cap, total + defaultCountTokens(text.slice(0, charsNeededToCross)))
    } else {
      total += defaultCountTokens(text)
    }
    if (total >= cap) return total
  }
  return total
}

/**
 * Entries at or above this estimated token size get an explicit `[N tok]`
 * marker; smaller entries carry none. The preview is budget-capped, so a huge
 * tool dump and a one-line note render identically — the marker restores the
 * "this node is big, prime compress target" signal. Absence means "below
 * threshold", never "empty": an unmarked entry still shows its preview text,
 * and the exact number stays one acp_status drilldown away.
 */
const LARGE_ENTRY_MIN_TOKENS = 512

/** `550` → `[550 tok]`, `1500` → `[1.5K tok]`, `8000` → `[8K tok]`. */
function tokenMarker(tokens: number): string {
  return tokens >= 1000 ? `[${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}K tok]` : `[${tokens} tok]`
}

/** One catalog line per entry — bare `seq·label` when the node has no text; a `[N tok]` suffix marks entries at or above `LARGE_ENTRY_MIN_TOKENS`. */
function renderEntry(entry: IndexEntry): string {
  const body = entry.preview === '' ? `${entry.seq}·${entry.label}` : `${entry.seq}·${entry.label}「${entry.preview}」`
  return entry.tokens >= LARGE_ENTRY_MIN_TOKENS ? `${body}${tokenMarker(entry.tokens)}` : body
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
export function buildIndexMessage(session: Session, config: ResolvedMessageIndexConfig = MESSAGE_INDEX_DEFAULTS, watermark?: number): UserMessage | null {
  if (!config.enabled) return null
  const entries = collectIndexEntries(session, watermark ?? indexWatermarkOf(session), config.previewTokens)
  if (entries.length === 0) return null
  if (entries.length > config.backlogLimit) {
    const first = entries[0]!.seq
    const last = entries[entries.length - 1]!.seq
    return createUserMessage({
      content: [{ type: 'text', text: `[acp-index] ${first}..${last} — ${entries.length} earlier messages already exist, listed by seq only (inspect them via acp_status; to archive, compress THOSE seq ranges — not this line, which is too small to compress alone)` }],
      source: indexSource,
    })
  }
  const body = entries.map(renderEntry).join(' ')
  return createUserMessage({
    content: [{ type: 'text', text: `[acp-index] ${body}` }],
    source: indexSource,
  })
}
