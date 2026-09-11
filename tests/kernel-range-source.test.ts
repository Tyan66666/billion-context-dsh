/**
 * The nudge range table takes its GEOMETRY from the kernel and only adds the
 * host guards on top (AGENTS.md rule 3, design decision 7).
 *
 * These tests run the REAL kernel over the engine's feeding pattern (the FULL
 * log, `allLogMessages`) so the whole chain is covered end to end: the ref →
 * surface-seq mapping, the kernel's own grouping, and the invariant that a
 * shadowed span is never offered.
 *
 * Background — why this file exists. The table used to be computed from the
 * surface by the engine itself, as a labeled `UPSTREAM:` workaround: a kernel
 * range's edges were derived by counting refs, and a surface replacement breaks
 * that arithmetic (the checkpoint node of a replace lands mid-array carrying a
 * much higher ref), so spans came back reversed or lost large tool results
 * (issue #38). The pinned kernel segments by ARRAY adjacency instead (upstream
 * #207, released in 0.0.56) and the workaround is gone — these tests keep the
 * door closed: they fail if the mapping is broken (ref arithmetic), if the host
 * guards are dropped, or if a shadowed span becomes visible again.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createCore, type CompressionCore } from 'acp-kernel'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildCompressibleSeqRanges, runCompactionTransaction, shadowedSeqsOf, type KernelRangeView } from '../src/region.ts'
import { allLogMessages, isRealUserTurn } from '../src/messages.ts'
import { eventAtOf } from '../src/session-events.ts'
import { kernelConfigFor } from '../src/config.ts'
import { AcpStateStore } from '../src/state.ts'
import { appendAssistant, appendToolCall, appendToolResult, appendTurn, appendUser, longText } from './helpers.ts'

interface KernelProbe {
  readonly view: KernelRangeView
  /** True when the kernel considers this seq consumed (inside an active block). */
  readonly isShadowed: (seq: number) => boolean
}

/** Run the real kernel the way the engine does: full log, live state. */
function kernelProbe(session: Session): KernelProbe {
  const kernel = createCore({}) as CompressionCore
  const store = new AcpStateStore()
  const state = store.stateFor(session)
  const turn = kernel.processTurn({
    messages: allLogMessages(session),
    state,
    config: kernelConfigFor({ modelContextLimit: 128000 }),
    tokenCount: 300000,
  })
  const shadowed = new Set<number>()
  for (const block of turn.state.blocks) {
    for (const id of block.effectiveMessageIds) shadowed.add(Number(id))
  }
  const byRaw = (turn.state.messageRefs?.byRaw ?? {}) as Record<string, string>
  return {
    view: { ranges: turn.nudge?.compressibleRanges ?? [], refs: turn.state.messageRefs },
    isShadowed: (seq: number) => shadowed.has(seq) || byRaw[String(seq)] === 'BLOCKED',
  }
}

/** The seq window a kernel range maps onto, or null when a ref is unknown. */
function mappedWindow(view: KernelRangeView, range: { startRef: string; endRef: string }): { lo: number; hi: number } | null {
  const start = view.refs.byRef[range.startRef]
  const end = view.refs.byRef[range.endRef]
  if (start === undefined || end === undefined) return null
  return { lo: Math.min(Number(start), Number(end)), hi: Math.max(Number(start), Number(end)) }
}

/** True when at least one kernel range covers this seq. */
function kernelCovers(view: KernelRangeView, seq: number): boolean {
  return view.ranges
    .map((range) => mappedWindow(view, range))
    .some((window) => window !== null && window.lo <= seq && seq <= window.hi)
}

/** One turn of realistic traffic: user, assistant, tool call, tool result. */
function appendWorkTurn(session: Session, turn: number): void {
  appendTurn(session, turn)
  appendUser(session, longText(`q${turn}`, turn))
  appendAssistant(session, longText(`a${turn}`, turn + 10), turn, 1)
  appendToolCall(session, longText(`call${turn}`, turn + 20), `call_${turn}`, turn, 2)
  appendToolResult(session, longText(`result${turn}`, turn + 30), `call_${turn}`, turn, 3)
}

function denseSession(turns: number): Session {
  const session = Session.create('kernel-range-source')
  for (let turn = 1; turn <= turns; turn += 1) appendWorkTurn(session, turn)
  return session
}

/** Append a host-injected AGENTS.md row in the real source shape. */
function appendInstructionRow(session: Session, scope: string, version: string): number {
  const event = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `Instructions for ${scope} (${version}): keep tests green.` }],
    source: {
      kind: 'agent-instructions',
      form: 'instructions',
      baseline: true,
      baselineIdentity: { projectRoot: '', projectRootMarkers: ['.git'], maxBytes: 65536 },
      changes: [{ action: 'set', scope, path: 'AGENTS.md', digest: `digest-${version}` }],
    },
  }), { surfaceOp: 'append' })
  return event.seq
}

/** The seq of the last REAL user turn (never an injected row). */
function lastRealUserSeqOf(session: Session): number | undefined {
  const nodes = session.surface.nodes
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = eventAtOf(session, nodes[index]!)
    if (event !== undefined && isRealUserTurn(event)) return nodes[index]!
  }
  return undefined
}

/** Every offered span must be buildable from live surface nodes. */
function assertSpansAreLive(session: Session, ranges: ReturnType<typeof buildCompressibleSeqRanges>): void {
  const live = new Set(session.surface.nodes)
  for (const range of ranges) {
    assert.ok(
      live.has(range.start) && live.has(range.end),
      `range ${range.start}..${range.end} must start and end on a live surface node`,
    )
  }
}

test('kernel range source: refs map to live seqs, shadowed spans are never offered, order is oldest-first', () => {
  const session = denseSession(6)
  const probe = kernelProbe(session)
  const ranges = buildCompressibleSeqRanges(session, probe.view, { preserveRecent: 0 })

  assert.ok(ranges.length > 0, 'a dense multi-turn session offers compressible spans')
  assert.ok(
    ranges.length >= 2,
    'the kernel groups by turn (a group of 3+ messages followed by a user turn splits), so a multi-turn surface offers several spans rather than one giant range',
  )
  assertSpansAreLive(session, ranges)
  for (const range of ranges) {
    for (let seq = range.start; seq <= range.end; seq += 1) {
      assert.ok(
        !probe.isShadowed(seq),
        `no offered span may cover a shadowed seq (found ${seq} inside ${range.start}..${range.end})`,
      )
    }
  }
  for (let index = 1; index < ranges.length; index += 1) {
    assert.ok(ranges[index]!.start >= ranges[index - 1]!.start, 'ranges are ordered oldest-first')
  }
})

test('kernel range source: refs resolve through the ref map, never by ref arithmetic', () => {
  // A ref's NUMBER says nothing about where its message sits on the surface:
  // after a replacement the checkpoint node carries a much higher seq than its
  // neighbours, and every insert shifts array indices. The removed workaround
  // existed precisely because the kernel once derived edges from ref
  // arithmetic — this pins that the ref MAP is the only bridge between the two
  // dialects.
  //
  // The window is deliberately wide (nodes 1..20 of 24) so that the arithmetic
  // reading is unmistakable: treating the ref number as an array index would
  // look at nodes 3..6 and offer a span that never reaches the window's far
  // side, while the mapped reading covers it.
  const session = denseSession(6)
  const nodes = session.surface.nodes
  assert.ok(nodes.length >= 24, 'the fixture is wide enough to separate the two readings')
  const view: KernelRangeView = {
    ranges: [{ startRef: 'm00004', endRef: 'm00007' }],
    refs: { byRef: { m00004: String(nodes[1]!), m00007: String(nodes[20]!) } },
  }
  const ranges = buildCompressibleSeqRanges(session, view, { preserveRecent: 0 })
  assert.ok(ranges.length > 0, 'the mapped window yields a span')
  const lo = Math.min(...ranges.map((range) => range.start))
  const hi = Math.max(...ranges.map((range) => range.end))
  assert.ok(lo <= nodes[5]!, `the span reaches the far end of its start (<= ${nodes[5]}), got ${lo}`)
  assert.ok(hi >= nodes[15]!, `the span reaches the far end of the mapped window (>= ${nodes[15]}), got ${hi}`)
})

test('kernel range source: a MIDDLE-span compression leaves no hole and later spans stay offered', () => {
  // The exact shape that broke ref arithmetic: compress a span in the middle of
  // the session, not the head, so the checkpoint node lands mid-array.
  const session = denseSession(8)
  const nodes = session.surface.nodes
  const start = nodes[8]!
  const end = nodes[11]!
  const shadowed = shadowedSeqsOf(session, start, end)
  assert.ok(shadowed.length > 0, 'the fixture actually shadows a span')
  runCompactionTransaction(session, {
    start,
    end,
    shadowedSeqs: shadowed,
    summary: [{ type: 'text', text: 'Probe summary replacing a middle span with enough detail to be a block.' }],
    shadowedTokenCount: 1234,
    provider: 'test-provider',
    model: 'test-model',
    topic: 'middle block',
  })

  const probe = kernelProbe(session)
  const ranges = buildCompressibleSeqRanges(session, probe.view, { preserveRecent: 0 })

  assert.ok(ranges.length > 0, 'a surface replacement does not empty the range table')
  assertSpansAreLive(session, ranges)
  // The kernel must not offer the compressed span back: its ranges come from
  // the same state the compress updated. Losing this is what made the old drift
  // silent — a shadowed span looked compressible.
  assert.ok(
    !probe.view.ranges.some((range) => {
      const window = mappedWindow(probe.view, range)
      return window !== null && shadowed.some((seq) => window.lo <= seq && seq <= window.hi)
    }),
    'no kernel range covers the compressed span',
  )
  for (const range of ranges) {
    for (const seq of shadowed) {
      assert.ok(
        !(range.start <= seq && seq <= range.end),
        `no offered span may cover the compressed span (found ${seq} inside ${range.start}..${range.end})`,
      )
    }
  }
  // The material AFTER the compression is still offered — losing it was the
  // user-visible symptom of the drift (large tool results vanished from the
  // nudge table).
  assert.ok(
    ranges.some((range) => range.start > Math.max(...shadowed)),
    'spans after the compressed range are still offered',
  )
})

test('kernel range source: host guards still apply on top of the kernel geometry', () => {
  // Two AGENTS.md copies, v1 then v2, of the SAME scope. The STALE copy (v1)
  // sits mid-session while its group holds fewer than 3 messages, so the
  // kernel's own split rule (which needs a group of 3+) groups ACROSS it. Stale
  // copies are the hard case: the newest-copy pin does not cover them, so only
  // the barrier keeps them out of the table — and folding one still buys
  // nothing, because the host re-injects the current copy the moment a row
  // disappears (issue #71).
  const session = Session.create('kernel-range-guards')
  appendWorkTurn(session, 1)
  appendTurn(session, 2)
  appendUser(session, longText('q2', 5))
  appendAssistant(session, longText('a2', 6), 2, 1)
  const staleSeq = appendInstructionRow(session, 'project-root', 'v1')
  appendWorkTurn(session, 3)
  const currentSeq = appendInstructionRow(session, 'project-root', 'v2')
  for (let turn = 4; turn <= 6; turn += 1) appendWorkTurn(session, turn)

  assert.notEqual(staleSeq, currentSeq, 'the fixture carries two copies of one scope')
  const lastRealUserSeq = lastRealUserSeqOf(session)
  assert.ok(lastRealUserSeq !== undefined, 'the fixture has a real user turn')

  const probe = kernelProbe(session)
  assert.ok(
    kernelCovers(probe.view, staleSeq),
    'the fixture premise holds: the kernel groups across the stale instruction row',
  )

  const ranges = buildCompressibleSeqRanges(session, probe.view, { preserveRecent: 0 })
  assert.ok(ranges.length > 0, 'other spans are still offered')

  // Guards are BARRIERS, so no offered span can bracket a guarded seq — the
  // check is exact, not merely "the edges happen to miss it".
  for (const range of ranges) {
    const brackets = (seq: number): boolean => range.start <= seq && seq <= range.end
    assert.ok(!brackets(staleSeq), `no offered span covers the STALE instruction row (${staleSeq})`)
    assert.ok(!brackets(currentSeq), `no offered span covers the CURRENT instruction row (${currentSeq})`)
    assert.ok(!brackets(lastRealUserSeq), `no offered span covers the last real user message (${lastRealUserSeq})`)
  }
})
