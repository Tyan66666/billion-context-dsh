/**
 * M7 — degeneration guard: detect (and optionally fold away) model output that
 * has collapsed into repetitive degenerate generation, so the attractor stops
 * riding along every later prompt and re-triggering more of the same.
 *
 * Ported from billion-context-pi's `src/degeneration.ts` (commit ee06de9,
 * v0.1.83) and adapted to the DSH CompactionEngine seam. Two differences from
 * pi, both forced by the host architecture:
 *   - pi OWNS the outgoing assembly, so it collapses the run IN THE OUTGOING
 *     VIEW (in-memory, per-request, originals untouched). DSH exposes no such
 *     hook — the outgoing view is derived from the durable surface and frozen
 *     before send (`dsh-agent-loop` `buildRequest`). So instead of collapsing
 *     text in place, the engine durably SHADOWS the degenerate node(s) through
 *     the same `compaction/prune` machinery orphan-pruning already uses
 *     (`hideSurfaceSeqs`). The original stays in the append-only log for
 *     decompress/search; only the visible surface loses the attractor.
 *   - DSH assistant turns carry `reasoning` blocks that the projection drops
 *     (a pure-thinking turn projects to nothing — see src/messages.ts), so
 *     detection reads the RAW event content, never the projected messages.
 *
 * Two detectors, each matched to a field-observed failure form:
 *   - run-length: a single codepoint repeated >= minRun (pi's original). Catches
 *     the symbol-stream runaway (DSH discussion #3946). Near-zero false
 *     positives on its own, so it needs no extra gate.
 *   - structural: a run of consecutive assistant turns that each carry
 *     reasoning, an EMPTY visible body, and NO tool call — the "tail
 *     continuation" form (thinking keeps going while the model stops calling
 *     tools and only "says" things into an empty body). Gated on >= N
 *     consecutive same-shape turns so an isolated short turn never trips it.
 *
 * Modes: off | observe | fold. `observe` (the default) detects and logs only —
 * it takes no surface action, so a false positive costs a log line, not a
 * clobbered turn. `fold` additionally shadows the qualifying node(s).
 * @module billion-context-dsh/degeneration
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { extractText, toolCallsOf } from './messages.ts'

export type DegenerationMode = 'off' | 'observe' | 'fold'

export interface DegenerationGuardConfig {
  /** Detection/action mode. Default 'observe'. */
  readonly mode?: DegenerationMode
  /** Minimum single-codepoint run length for the run-length detector. Default 200 (pi parity); sub-8 values are raised to 8. */
  readonly minRun?: number
  /** Minimum CONSECUTIVE same-shape assistant turns before the structural detector fires. Default 2. */
  readonly foldMinConsecutiveRounds?: number
  /**
   * Optional precision gate for the structural detector: when non-empty, a
   * self-abort phrase must appear in one of the matched turns' reasoning for
   * the finding to fire. Empty (default) means the base shape + consecutiveness
   * alone is enough. Set it to tighten folding when observe-mode logs show FP.
   */
  readonly selfAbortPhrases?: string[]
}

export interface ResolvedDegenerationGuard {
  readonly mode: DegenerationMode
  readonly minRun: number
  readonly foldMinConsecutiveRounds: number
  readonly selfAbortPhrases: readonly string[]
}

const DEFAULT_MODE: DegenerationMode = 'observe'
const DEFAULT_MIN_RUN = 200
/** Below 8 a "run" is indistinguishable from normal punctuation repetition. */
const MIN_VALID_MIN_RUN = 8
const DEFAULT_FOLD_MIN_CONSECUTIVE_ROUNDS = 2
/** Bound the blast radius of a single auto-fold episode. */
const MAX_FOLD_NODES_PER_STEP = 4
/** How many recent assistant turns the detectors will ever look back at. */
const DETECTION_WINDOW = 6

/**
 * The replacement text written where a folded degenerate node used to be. Fixed
 * by construction — it NEVER embeds the repeated sample, because echoing the
 * attractor back into context would re-seed exactly the pattern we removed
 * (the user's own field rule, and pi's `describeChar`-not-the-run convention).
 */
export const DEGENERATION_RECOVERY_NOTE =
  '[ACP] your previous turn ended in degenerate generation (repeated output); it was truncated from context. Resume your task from your last valid step.'

export function resolveDegenerationGuard(cfg?: DegenerationGuardConfig): ResolvedDegenerationGuard {
  // An unknown mode string (a typo like 'Fold') must degrade to the SAFE
  // default, never to fold: the consumer treats anything that is not exactly
  // 'off' or 'observe' as fold, so an unvalidated value would silently enable
  // automatic surface folding from a one-character config mistake.
  const mode: DegenerationMode = cfg?.mode === 'off' || cfg?.mode === 'fold' ? cfg.mode : DEFAULT_MODE
  let minRun = cfg?.minRun ?? DEFAULT_MIN_RUN
  if (!Number.isInteger(minRun) || minRun < 2) minRun = DEFAULT_MIN_RUN
  if (minRun < MIN_VALID_MIN_RUN) minRun = MIN_VALID_MIN_RUN
  let foldMinConsecutiveRounds = cfg?.foldMinConsecutiveRounds ?? DEFAULT_FOLD_MIN_CONSECUTIVE_ROUNDS
  if (!Number.isInteger(foldMinConsecutiveRounds) || foldMinConsecutiveRounds < 2) {
    foldMinConsecutiveRounds = DEFAULT_FOLD_MIN_CONSECUTIVE_ROUNDS
  }
  const selfAbortPhrases = (cfg?.selfAbortPhrases ?? []).filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  )
  return { mode, minRun, foldMinConsecutiveRounds, selfAbortPhrases }
}

/** One maximal single-codepoint run found by {@link findDegenerateRuns}. */
export interface DegenerateRun {
  readonly char: string
  readonly count: number
  /** UTF-16 start offset of the run within the input. */
  readonly index: number
}

/**
 * Find every maximal single-codepoint run of length >= minRun. Codepoint-safe:
 * surrogate pairs stay whole (a repeated emoji is one run of length N, not 2N
 * lone surrogates), mirroring pi's implementation exactly. Pure and
 * deterministic; returns [] for empty input or a degenerate minRun.
 */
export function findDegenerateRuns(text: string, minRun: number): DegenerateRun[] {
  if (minRun < 2 || text.length === 0) return []
  const cps = Array.from(text)
  const runs: DegenerateRun[] = []
  let i = 0
  let utf16Offset = 0
  while (i < cps.length) {
    const ch = cps[i]!
    let j = i
    while (j < cps.length && cps[j] === ch) j++
    const count = j - i
    if (count >= minRun) runs.push({ char: ch, count, index: utf16Offset })
    utf16Offset += count * ch.length
    i = j
  }
  return runs
}

interface TurnShape {
  readonly seq: number
  readonly hasReasoning: boolean
  readonly visibleTextEmpty: boolean
  readonly hasToolCalls: boolean
}

/** The content array of one assistant/message event, defensively read. */
function eventContent(event: SessionEvent): unknown {
  return (event.data as { message?: { content?: unknown } }).message?.content
}

/** Concatenated text of the `reasoning` blocks — the projection drops these, so read them raw. */
function reasoningText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block !== null && typeof block === 'object') {
      const b = block as { type?: unknown; text?: unknown }
      if (b.type === 'reasoning' && typeof b.text === 'string') parts.push(b.text)
    }
  }
  return parts.join('\n')
}

function turnShape(event: SessionEvent): TurnShape | null {
  if (event.type !== 'assistant/message') return null
  const content = eventContent(event)
  // `extractText` deliberately excludes reasoning blocks, so this is the VISIBLE
  // body only — the thing the user/model sees as the response text.
  const visible = extractText(content)
  return {
    seq: event.seq,
    hasReasoning: reasoningText(content).trim().length > 0,
    visibleTextEmpty: visible.trim().length === 0,
    hasToolCalls: toolCallsOf(content).length > 0,
  }
}

export interface DegenerationFinding {
  readonly kind: 'run-length' | 'structural'
  /** Surface seqs to fold, oldest-first. Every seq is a no-tool-call assistant node. */
  readonly seqs: readonly number[]
  /**
   * Machine-collectable magnitude for observe-mode readers to bucket hits WITHOUT
   * any sample text: run-length = the longest run count found; structural = the
   * consecutive-turn streak length (so readers can aggregate per
   * `foldMinConsecutiveRounds` tier). Counts only, never content (§五 rule).
   */
  readonly metric: number
  /** Human-readable summary. Deliberately carries NO sample text (§五 rule). */
  readonly detail: string
}

/**
 * Inspect the session's assistant turns and report the degenerate episodes that
 * qualify under the resolved config. Pure over the event array (no live
 * session, no mutation) so it is unit-testable in isolation. Returns [] when
 * mode is 'off' or nothing qualifies.
 *
 * `isLiveSeq` (optional) restricts detection to nodes still visible on the
 * current surface. The durable log keeps every original forever, so without it
 * an already-shadowed node (folded by this guard or absorbed by a compression)
 * keeps matching inside the lookback window: observe mode would re-log it every
 * step, fold mode would retry a prune the reader gate rejects with zero writes.
 * For the structural walk a non-live turn BREAKS the streak rather than being
 * skipped — deliberately conservative: after one stuck turn was folded away and
 * the recovery note was delivered, the episode must repeat on LIVE turns before
 * the guard acts again (the note gets its chance to work first).
 */
export function detectDegeneration(
  events: readonly SessionEvent[],
  cfg: ResolvedDegenerationGuard,
  isLiveSeq?: (seq: number) => boolean,
): DegenerationFinding[] {
  if (cfg.mode === 'off') return []

  const turns: TurnShape[] = []
  const bySeq = new Map<number, SessionEvent>()
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const shape = turnShape(event)
    if (shape !== null) {
      turns.push(shape)
      bySeq.set(event.seq, event)
    }
  }
  const n = turns.length
  if (n === 0) return []
  const startIdx = Math.max(0, n - DETECTION_WINDOW)
  const findings: DegenerationFinding[] = []

  // --- run-length detector (forms ②③: single-codepoint runaway) ---
  // Only nodes WITHOUT tool calls: folding a call-bearing node would orphan its
  // results and 400 the next request on strict providers.
  const runSeqs: number[] = []
  let runMaxCount = 0
  for (let idx = n - 1; idx >= startIdx; idx--) {
    const t = turns[idx]!
    if (t.hasToolCalls) continue
    if (isLiveSeq !== undefined && !isLiveSeq(t.seq)) continue
    const event = bySeq.get(t.seq)!
    const content = eventContent(event)
    const hits = findDegenerateRuns(extractText(content) + '\n' + reasoningText(content), cfg.minRun)
    if (hits.length > 0) {
      runSeqs.push(t.seq)
      for (const hit of hits) if (hit.count > runMaxCount) runMaxCount = hit.count
    }
  }
  if (runSeqs.length > 0) {
    findings.push({
      kind: 'run-length',
      seqs: runSeqs.reverse(),
      metric: runMaxCount,
      detail: `${runSeqs.length} recent assistant turn(s) carry a single-codepoint run of ${cfg.minRun}+`,
    })
  }

  // --- structural detector (form ①: tail continuation) ---
  // Walk back from the newest turn while each matches the base shape; the
  // consecutive requirement is what separates an episode from the ~1-3%/turn
  // baseline of isolated short turns (calibration data, issue #212).
  const structuralSeqs: number[] = []
  for (let idx = n - 1; idx >= startIdx; idx--) {
    const t = turns[idx]!
    if (isLiveSeq !== undefined && !isLiveSeq(t.seq)) break
    if (!(t.hasReasoning && t.visibleTextEmpty && !t.hasToolCalls)) break
    structuralSeqs.push(t.seq)
    if (structuralSeqs.length >= MAX_FOLD_NODES_PER_STEP) break
  }
  if (structuralSeqs.length >= cfg.foldMinConsecutiveRounds) {
    if (cfg.selfAbortPhrases.length > 0) {
      const anyPhrase = structuralSeqs.some((seq) => {
        const event = bySeq.get(seq)
        if (event === undefined) return false
        const r = reasoningText(eventContent(event)).toLowerCase()
        return cfg.selfAbortPhrases.some((p) => r.includes(p.toLowerCase()))
      })
      if (!anyPhrase) return findings
    }
    findings.push({
      kind: 'structural',
      seqs: structuralSeqs.reverse(),
      metric: structuralSeqs.length,
      detail: `${structuralSeqs.length} consecutive recent assistant turn(s) carried reasoning with an empty visible body and no tool call`,
    })
  }

  return findings
}

/**
 * Pre-fold safety gate (issue #212 review): re-verify, immediately before a node
 * is shadowed, that it is an assistant turn carrying NO tool call. Folding a
 * call-bearing node orphans its results and 400s the next request on strict
 * providers — a fatal user-facing failure. This is a second, independent check at
 * the point of the dangerous write; it does NOT trust the detector having filtered
 * such nodes upstream (the two can drift on refactor). Throws when the node must
 * not be folded; callers catch and skip (fail-safe — the session continues, the
 * node simply stays visible).
 */
export function assertFoldableAssistantNode(events: readonly SessionEvent[], seq: number): void {
  const event = events.find((candidate) => candidate.seq === seq)
  if (event === undefined || event.type !== 'assistant/message') {
    throw new Error(`seq ${seq} is not an assistant/message node`)
  }
  if (toolCallsOf(eventContent(event)).length > 0) {
    throw new Error(`seq ${seq} carries tool calls and must not be folded`)
  }
}
