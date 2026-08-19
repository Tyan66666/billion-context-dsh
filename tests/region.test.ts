import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AcpStateStore } from '../src/state.ts'
import {
  AlreadyCompressedRangeError,
  assertNoActiveCompaction,
  blockIdOfKernelRef,
  blockRegistry,
  buildCompressibleSeqRanges,
  deferCompressPairHide,
  findOpenTurn,
  hideCompressToolPair,
  openToolCallIds,
  rebuildBlockLedger,
  resolveSurfaceRange,
  runCompactionTransaction,
  shadowedSeqsOf,
  stripOrphanedSurfaceToolMessages,
} from '../src/region.ts'
import { appendTurn, appendToolCall, appendToolResult, appendMultiToolCall, appendUser, appendAssistant, buildTextSession, longText } from './helpers.ts'

test('M2: AcpStateStore initialises one state per session', () => {
  const store = new AcpStateStore()
  const session = Session.create('s1')
  const first = store.stateFor(session)
  assert.equal(store.stateFor(session), first, 'same session returns the cached state')
  const other = Session.create('s2')
  assert.notEqual(store.stateFor(other), first, 'different session gets its own state')
  store.delete(session)
  assert.notEqual(store.stateFor(session), first, 'delete drops the cache')
})

test('M5: findOpenTurn / assertNoActiveCompaction track the durable lock', () => {
  const session = Session.create('s')
  assert.equal(findOpenTurn(session.events), null)
  appendTurn(session, 1)
  assert.equal(findOpenTurn(session.events), 1)
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(findOpenTurn(session.events), null)
  assertNoActiveCompaction(session.events)
})

test('M5: runCompactionTransaction lands the four events and shadows the range', () => {
  const session = buildTextSession(6)
  const { compactionId, seqs } = runCompactionTransaction(session, {
    start: 1,
    end: 4,
    shadowedSeqs: [1, 2, 3, 4],
    summary: [{ type: 'text', text: 'Auth system summary with enough detail.' }],
    shadowedTokenCount: 4321,
    provider: 'test-provider',
    model: 'test-model',
  })
  assert.ok(compactionId.length > 0)
  assert.equal(seqs.length, 4)

  const types = session.events.slice(-4).map((event) => event.type)
  assert.deepEqual(types, ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'])

  // Surface: the shadowed seqs are gone, the summary node is on the surface.
  for (const seq of [1, 2, 3, 4]) assert.ok(!session.surface.nodes.includes(seq))
  assert.ok(session.surface.nodes.includes(seqs[2]!), 'the replacement node joins the surface')

  // The summary node carries the checkpoint source.
  const replaceEvent = session.events[seqs[2]!]!
  assert.equal(replaceEvent.type, 'user/message')
  const source = (replaceEvent.data as { source?: { plugin?: string } }).source
  assert.equal(source?.plugin, 'compact')

  // Derived messages shrank: 6 messages → 2 surviving + 1 summary = 3.
  assert.equal(session.deriveMessages().length, 3)

  // The durable log still holds every original event (decompress can recover).
  assert.equal(session.events.length, 6 + 1 /*turn*/ + 4)
})

test('M5: the block ledger rebuilds from the log without kernel state', () => {
  const session = buildTextSession(8)
  runCompactionTransaction(session, {
    start: 1,
    end: 4,
    shadowedSeqs: [1, 2, 3, 4],
    summary: [{ type: 'text', text: 'First block summary with plenty of detail.' }],
    shadowedTokenCount: 1000,
    provider: 'p',
    model: 'm',
  })
  runCompactionTransaction(session, {
    start: 6,
    end: 8,
    shadowedSeqs: [6, 7, 8],
    summary: [{ type: 'text', text: 'Second block summary with plenty of detail.' }],
    shadowedTokenCount: 2000,
    provider: 'p',
    model: 'm',
  })
  const ledger = rebuildBlockLedger(session.events)
  assert.equal(ledger.length, 2)
  assert.deepEqual(ledger[0]!.shadowedSeqs, [1, 2, 3, 4])
  assert.equal(ledger[1]!.shadowedTokenCount, 2000)
  assert.equal(ledger[1]!.start, 6)
})

test('M5: blockIdOfKernelRef resolves the bN the model tool shows back to the compaction id', () => {
  const session = buildTextSession(8)
  runCompactionTransaction(session, {
    start: 1,
    end: 4,
    shadowedSeqs: [1, 2, 3, 4],
    summary: [{ type: 'text', text: 'First block summary with plenty of detail.' }],
    shadowedTokenCount: 1000,
    provider: 'p',
    model: 'm',
    kernelBlockId: 'b1',
  })
  runCompactionTransaction(session, {
    start: 6,
    end: 8,
    shadowedSeqs: [6, 7, 8],
    summary: [{ type: 'text', text: 'Second block summary with plenty of detail.' }],
    shadowedTokenCount: 2000,
    provider: 'p',
    model: 'm',
    kernelBlockId: 'b2',
  })
  const ledger = rebuildBlockLedger(session.events)
  // The acp_status block rows (bN) must resolve to the durable ids the
  // decompress/search tools accept — the whole point of the dual-id support.
  assert.equal(blockIdOfKernelRef(session, 'b1'), ledger[0]!.blockId)
  assert.equal(blockIdOfKernelRef(session, 'b2'), ledger[1]!.blockId)
  // Unknown / malformed refs are not resolved (caller falls back to prefix).
  assert.equal(blockIdOfKernelRef(session, 'b99'), null)
  assert.equal(blockIdOfKernelRef(session, 'b0'), null)
  assert.equal(blockIdOfKernelRef(session, 'b01'), null, 'no zero-padding normalisation')
  assert.equal(blockIdOfKernelRef(session, 'B1'), null, 'case-sensitive')
  assert.equal(blockIdOfKernelRef(session, 'b1 '), null, 'no trailing-space tolerance')
  assert.equal(blockIdOfKernelRef(session, ledger[0]!.blockId.slice(0, 8)), null, 'a UUID prefix is not a kernel ref')
})

test('M5: rebuildKernelBlocks and blockRegistry synthesise identical bN ids (no id-space drift)', () => {
  // P1-2: two independent bN syntheses exist (region.ts blockRegistry and
  // state.ts rebuildKernelBlocks, via AcpStateStore). acp_status displays the
  // kernel state's blockId while decompress resolves through blockRegistry —
  // if the two ever drift, the model tool shows bN ids that decompress cannot
  // resolve (the exact bug this feature fixes). Pin them together.
  const session = buildTextSession(8)
  runCompactionTransaction(session, {
    start: 1,
    end: 4,
    shadowedSeqs: [1, 2, 3, 4],
    summary: [{ type: 'text', text: 'First block summary with plenty of detail.' }],
    shadowedTokenCount: 1000,
    provider: 'p',
    model: 'm',
  })
  runCompactionTransaction(session, {
    start: 6,
    end: 8,
    shadowedSeqs: [6, 7, 8],
    summary: [{ type: 'text', text: 'Second block summary with plenty of detail.' }],
    shadowedTokenCount: 2000,
    provider: 'p',
    model: 'm',
  })
  // Fresh store forces the log-rebuild path (the "restarted engine" case).
  const kernelBlocks = new AcpStateStore().stateFor(session).blocks
  const registry = blockRegistry(session)
  assert.equal(kernelBlocks.length, registry.length)
  for (let index = 0; index < kernelBlocks.length; index += 1) {
    assert.equal(
      kernelBlocks[index]!.blockId,
      registry[index]!.kernelBlockId,
      `block ${index}: kernel state bN must equal the registry bN`,
    )
    assert.equal(blockIdOfKernelRef(session, kernelBlocks[index]!.blockId), registry[index]!.blockId)
  }
})

test('M5: resolveSurfaceRange rejects missing, reversed, and pair-broken ranges', () => {
  const session = buildTextSession(6)
  assert.deepEqual(resolveSurfaceRange(session, 1, 4), { start: 1, end: 4 })
  assert.throws(() => resolveSurfaceRange(session, 99, 100), /not in the current surface/)
  assert.throws(
    () => resolveSurfaceRange(session, 99, 100),
    /consult acp_status for the current surface range/,
    'missing-boundary error should point the model at acp_status',
  )
  assert.throws(() => resolveSurfaceRange(session, 4, 1), /reversed range/)
  assert.deepEqual(shadowedSeqsOf(session, 1, 3), [1, 2, 3])
})

test('M5: resolveSurfaceRange recovers stale edges to the live remainder', () => {
  const session = buildTextSession(6)
  runCompactionTransaction(session, {
    start: 1,
    end: 4,
    shadowedSeqs: [1, 2, 3, 4],
    summary: [{ type: 'text', text: 'First block summary with plenty of detail.' }],
    shadowedTokenCount: 1000,
    provider: 'p',
    model: 'm',
  })
  // Surface is [checkpoint, 5, 6]: seqs 1..4 were shadowed by the block.
  // A stale range whose start was shadowed (the classic old-nudge reuse) snaps
  // to the still-live content of the requested span.
  assert.deepEqual(resolveSurfaceRange(session, 3, 6), { start: 5, end: 6, recovered: true })
  // A fully live range keeps the current behavior (no recovery flag).
  assert.deepEqual(resolveSurfaceRange(session, 5, 6), { start: 5, end: 6 })
})

test('M5: a fully shadowed span throws AlreadyCompressedRangeError with the covering blocks', () => {
  const session = buildTextSession(6)
  runCompactionTransaction(session, {
    start: 1,
    end: 4,
    shadowedSeqs: [1, 2, 3, 4],
    summary: [{ type: 'text', text: 'First block summary with plenty of detail.' }],
    shadowedTokenCount: 1000,
    provider: 'p',
    model: 'm',
  })
  assert.throws(
    () => resolveSurfaceRange(session, 1, 4),
    (error: unknown) => error instanceof AlreadyCompressedRangeError
      && error.start === 1
      && error.end === 4
      && error.coveringBlockIds.length === 1
      && error.coveringBlockIds[0] === rebuildBlockLedger(session.events)[0]!.blockId,
    're-compressing an already compressed span reports the covering block',
  )
})

test('M5: recovery never folds block checkpoint nodes (distillation stays explicit)', () => {
  const session = buildTextSession(12)
  runCompactionTransaction(session, {
    start: 1,
    end: 5,
    shadowedSeqs: [1, 2, 3, 4, 5],
    summary: [{ type: 'text', text: 'First block summary with plenty of detail.' }],
    shadowedTokenCount: 1000,
    provider: 'p',
    model: 'm',
  })
  runCompactionTransaction(session, {
    start: 6,
    end: 10,
    shadowedSeqs: [6, 7, 8, 9, 10],
    summary: [{ type: 'text', text: 'Second block summary with plenty of detail.' }],
    shadowedTokenCount: 1000,
    provider: 'p',
    model: 'm',
  })
  // Surface: [c1, c2, 11, 12] — the requested span 3..9 holds only shadowed
  // content (its live nodes would be the two checkpoints, which are never
  // folded on a stale reference): already compressed, both blocks reported.
  assert.throws(
    () => resolveSurfaceRange(session, 3, 9),
    (error: unknown) => error instanceof AlreadyCompressedRangeError
      && error.coveringBlockIds.length === 2,
    'a span whose only live nodes are checkpoints is already compressed, not distilled',
  )
  // A stale span covering both blocks AND the live tail compresses only the tail.
  assert.deepEqual(resolveSurfaceRange(session, 3, 12), { start: 11, end: 12, recovered: true })

  // Now a gap between the blocks: block2 shadows 8..10, leaving 6..7 live.
  const gapped = buildTextSession(12)
  runCompactionTransaction(gapped, {
    start: 1,
    end: 5,
    shadowedSeqs: [1, 2, 3, 4, 5],
    summary: [{ type: 'text', text: 'First block summary with plenty of detail.' }],
    shadowedTokenCount: 1000,
    provider: 'p',
    model: 'm',
  })
  runCompactionTransaction(gapped, {
    start: 8,
    end: 10,
    shadowedSeqs: [8, 9, 10],
    summary: [{ type: 'text', text: 'Second block summary with plenty of detail.' }],
    shadowedTokenCount: 1000,
    provider: 'p',
    model: 'm',
  })
  // Surface: [c1, c2, 6, 7, 11, 12]. A stale span 3..9 covers both blocks and
  // the live middle — only the middle is compressed, neither block is touched.
  assert.deepEqual(resolveSurfaceRange(gapped, 3, 9), { start: 6, end: 7, recovered: true })
})

test('M5: a second active compaction is rejected', () => {
  const session = buildTextSession(4)
  session.append('compaction/start', { compactionId: 'c1', turn: 1 })
  assert.throws(() => assertNoActiveCompaction(session.events), /already active/)
})

test('M5: tool-call ranges are auto-adjusted to balanced edges', () => {
  const session = Session.create('pair')
  appendTurn(session, 1)
  appendUser(session, longText('q', 0))
  appendToolCall(session, 'calling', 'call_1')
  appendToolResult(session, 'result text', 'call_1')
  appendUser(session, longText('q2', 1))
  // surface: [1 user, 2 tool-call, 3 tool/result, 4 user]
  // A range whose end sits inside the pair (…, tool-call) nudges the end back
  // to the nearest balanced cut.
  assert.deepEqual(resolveSurfaceRange(session, 1, 2), { start: 1, end: 1 })
  // A complete call/result pair is balanced and unchanged.
  assert.deepEqual(resolveSurfaceRange(session, 2, 3), { start: 2, end: 3 })
  assert.deepEqual(resolveSurfaceRange(session, 1, 3), { start: 1, end: 3 })
  // A lone tool message (2 or 3 alone) expands outward to its balanced pair.
  assert.deepEqual(resolveSurfaceRange(session, 2, 2), { start: 2, end: 3 }, 'lone tool-call expands to include its result')
  assert.deepEqual(resolveSurfaceRange(session, 3, 3), { start: 2, end: 3 }, 'lone tool-result expands to include its call')
  // A range that can neither shrink nor expand still fails with guidance.
  assert.throws(() => resolveSurfaceRange(session, 99, 100), /not in the current surface/)
})

test('M5: multi-tool-call boundaries are shifted to plain-ref cuts', () => {
  const session = Session.create('multi')
  appendTurn(session, 1)
  appendUser(session, longText('msg', 0))                     // seq 1
  appendMultiToolCall(session, 'plan', ['c1', 'c2'], 1, 1)   // seq 2 (2 calls: no bare ref)
  appendToolResult(session, longText('res', 0), 'c1', 1, 1)  // seq 3
  appendToolResult(session, longText('res', 1), 'c2', 1, 1)  // seq 4
  appendUser(session, longText('msg', 1))                     // seq 5
  // surface: [1 user, 2 multi-call, 3 res, 4 res, 5 user]
  // An edge on the multi-call message (2) is NOT a valid boundary: it has no
  // bare-seq ref. The start shrinks inward to the nearest clean cut (5); the
  // request collapses to a single plain-ref message rather than crossing the
  // unresolved multi-call round.
  assert.deepEqual(resolveSurfaceRange(session, 2, 5), { start: 5, end: 5 })
  assert.deepEqual(resolveSurfaceRange(session, 3, 5), { start: 5, end: 5 })
  // A lone multi-call message cannot shrink at all, so it EXPANDS outward to
  // the smallest clean enclosing pair — the whole call/result round (1..4).
  assert.deepEqual(resolveSurfaceRange(session, 2, 2), { start: 1, end: 4 })
  // A clean text range that merely CONTAINS the multi-call round is unchanged.
  assert.deepEqual(resolveSurfaceRange(session, 1, 5), { start: 1, end: 5 })
})

test('M5: pass-2 expansion must not cross a checkpoint into value-reversed seqs', () => {
  const session = Session.create('nonmono')
  appendTurn(session, 1)
  appendUser(session, longText('q0', 0))                           // seq 1
  appendMultiToolCall(session, 'plan', ['c1', 'c2', 'c3', 'c4'])   // seq 2 (4 calls: no bare ref)
  appendToolResult(session, longText('res', 0), 'c1')              // seq 3
  appendToolResult(session, longText('res', 1), 'c2')              // seq 4
  appendToolResult(session, longText('res', 2), 'c3')              // seq 5
  appendToolResult(session, longText('res', 3), 'c4')              // seq 6
  appendUser(session, longText('q1', 1))                           // seq 7
  // nodes: [1, 2, 3, 4, 5, 6, 7]
  // A later compaction replaces node 1 with a summary checkpoint at seq 8.
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: longText('summary', 0) }],
    source: { kind: 'user', plugin: 'compact' },
  }), { surfaceOp: { op: 'replace', start: 1, end: 1 }, sourceEventSeqs: [1] })
  // nodes: [8, 2, 3, 4, 5, 6, 7] — NON-monotonic: the newer checkpoint seq 8
  // sits ahead of the older residual nodes 2..7 (the live production shape
  // behind the '110295..106762' reversed nudge range).
  // The whole multi-call round 2..6 has no clean inward cut, so pass-2 expands
  // the start toward the checkpoint; the resulting span 8..6 is value-reversed
  // and must be rejected instead of being shadowed.
  assert.throws(() => resolveSurfaceRange(session, 2, 6), /balanced range|reversed/)
  // The residual round alone (3..6) collapses too and must not cross the
  // checkpoint either.
  assert.throws(() => resolveSurfaceRange(session, 3, 6), /balanced range|reversed/)
  // A span that does not touch the unresolved round still resolves cleanly:
  // the trailing user message is a plain-ref boundary on both sides.
  assert.deepEqual(resolveSurfaceRange(session, 6, 7), { start: 7, end: 7 })
})

test('M5: ledger backfills shadowedTokenCount for legacy blocks written as 0', () => {
  const session = buildTextSession(6)
  // A legacy block: compaction/summary with shadowedTokenCount 0 (pre-fix).
  session.append('compaction/start', { compactionId: 'legacy-1', turn: 1 })
  session.append('compaction/summary', {
    compactionId: 'legacy-1',
    summary: [{ type: 'text', text: 'legacy summary with enough detail' }],
    shadowedRange: { start: 1, end: 3 },
    shadowedSeqs: [1, 2, 3],
    shadowedTokenCount: 0,
    provider: 'p',
    model: 'm',
  })
  session.append('user/message', {
    id: 'legacy-repl',
    role: 'user',
    content: [{ type: 'text', text: 'legacy summary' }],
    source: { kind: 'plugin', plugin: 'compact', compactionId: 'legacy-1' },
  } as never, { surfaceOp: { op: 'replace', start: 1, end: 3 }, sourceEventSeqs: [1, 2, 3] })
  session.append('compaction/end', { compactionId: 'legacy-1', turn: 1 })
  const ledger = rebuildBlockLedger(session.events)
  assert.equal(ledger.length, 1)
  assert.ok(ledger[0]!.shadowedTokenCount > 0, 'legacy 0 is backfilled from shadowed originals')
})

test('M5: stripOrphanedSurfaceToolMessages removes orphan results and orphan calls', () => {
  const session = Session.create('orphans')
  appendTurn(session, 1)
  appendUser(session, longText('q0', 0))                // seq 1
  appendToolResult(session, 'orphan result', 'result-orphan') // seq 2 (no call anywhere before it)
  appendUser(session, longText('q1', 1))                // seq 3
  appendToolCall(session, 'orphan call', 'call-orphan') // seq 4 (no result)
  // Surface before cleanup: [1, 2, 3, 4] — the orphan result drives the
  // pairing balance negative, so every range resolve throws.
  assert.throws(() => resolveSurfaceRange(session, 1, 4), /no matching tool-call/)

  const hidden = stripOrphanedSurfaceToolMessages(session)
  assert.equal(hidden, 2, 'both the orphan call and the orphan result are pruned')

  // The empty assistant pruning nodes derive to nothing: only q0/q1 remain.
  assert.equal(session.deriveMessages().length, 2)
  // The pairing cache is healthy again and the surface yields compressible spans.
  assert.doesNotThrow(() => resolveSurfaceRange(session, 1, session.surface.nodes[session.surface.nodes.length - 1]!))
  assert.doesNotThrow(() => buildCompressibleSeqRanges(session, { preserveRecent: 0 }), 'orphan cleanup leaves the range table computable')
})

test('M5: buildCompressibleSeqRanges carries kernel-parity toolPct and oldest-first order', () => {
  // Mixed session: a text turn, then the last user message (always protected,
  // breaking the segment), then an assistant reply + tool pair. The range
  // table must report the tool share per range (kernel `toolPct` parity) and
  // order ranges oldest-first (stable across turns, kernel `oldest first`).
  const session = Session.create('toolpct')
  appendTurn(session, 1)
  appendUser(session, longText('q0', 0))                  // seq 1 — text segment
  appendAssistant(session, longText('a0', 1), 1, 1)       // seq 2 — text segment
  appendUser(session, longText('q1', 2))                  // seq 3 — last user → protected → break
  appendAssistant(session, longText('a1', 3), 1, 2)       // seq 4 — joins the tool segment
  appendToolCall(session, longText('call', 4), 'call_1', 1, 3)   // seq 5 — tool
  appendToolResult(session, longText('result', 5), 'call_1', 1, 4) // seq 6 — tool

  const ranges = buildCompressibleSeqRanges(session, { preserveRecent: 0 })
  assert.equal(ranges.length, 2, 'protected user message splits the surface into two ranges')
  assert.equal(ranges[0]!.toolPct, 0, 'text-only range reports toolPct 0')
  assert.equal(ranges[1]!.toolPct, Math.round((2 / 3) * 100), '2-tool-of-3-msg range reports the tool share (67)')
  // Oldest-first: start seqs are non-decreasing (stable ordering for the model).
  for (let index = 1; index < ranges.length; index += 1) {
    assert.ok(ranges[index]!.start >= ranges[index - 1]!.start, 'ranges ordered oldest-first')
  }
})

test('M5: stripOrphanedSurfaceToolMessages preserves an in-flight tool call', () => {
  const session = Session.create('in-flight')
  appendTurn(session, 1)
  appendUser(session, longText('q', 0))
  appendToolCall(session, 'running compress', 'call-acp') // result not appended yet
  const before = session.deriveMessages().length
  const hidden = stripOrphanedSurfaceToolMessages(session, new Set(['call-acp']))
  assert.equal(hidden, 0, 'the executing compress call is not treated as an orphan')
  assert.equal(session.deriveMessages().length, before, 'the in-flight call stays on the surface')
  assert.ok(session.surface.nodes.includes(session.events.find((event) => event.type === 'assistant/message')!.seq), 'the assistant call node remains visible')
})

test('M5: hideCompressToolPair removes the compress call/result from the invalid surface', () => {
  const session = Session.create('compress-pair')
  appendTurn(session, 1)
  appendUser(session, longText('old', 0))                       // seq 1
  appendToolCall(session, 'compressing history', 'call-acp')    // seq 2 (the compress tool call)
  // The compress tool runs mid-turn: its durable summary node is inserted
  // before the current tool/result, producing [summary, compress-call, result].
  runCompactionTransaction(session, {
    start: 1,
    end: 1,
    shadowedSeqs: [1],
    summary: [{ type: 'text', text: 'Compression summary with enough technical detail to replace the old message.' }],
    shadowedTokenCount: 1000,
    provider: 'test-provider',
    model: 'test-model',
  })
  const result = session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: 'res-acp',
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'call-acp', content: [{ type: 'text', text: 'ok' }] }],
      source: { kind: 'tool', callId: 'call-acp' },
    },
  } as never, { surfaceOp: 'append' })
  const before = session.deriveMessages()
  assert.ok(before.some((message) => message.role === 'assistant' && message.content.some((block) => (block as { type?: string }).type === 'tool-call')), 'the invalid surface has the compress tool-call visible')

  assert.equal(hideCompressToolPair(session, 'call-acp', result.seq), true)
  const after = session.deriveMessages()
  assert.equal(after.length, 2, 'the compaction summary plus the preserved compress result text remain visible')
  assert.ok(!after.some((message) => message.role === 'assistant' && message.content.some((block) => (block as { type?: string }).type === 'tool-call')), 'compress call is hidden')
  assert.ok(!after.some((message) => message.role === 'user' && message.content.some((block) => (block as { type?: string }).type === 'tool-result')), 'compress result is hidden as a tool-result')
  assert.ok(after.some((message) => message.role === 'user' && message.content.some((block) => (block as { type?: string }).type === 'text' && (block as { text?: string }).text === 'ok')), 'the compress outcome text is preserved for the model')
  assert.ok(session.events.some((event) => event.type === 'compaction/prune'), 'the hide is recorded as a durable prune')
})

test('M5: stripOrphanedSurfaceToolMessages prunes legacy broken pairs (call → summary → result)', () => {
  const session = Session.create('broken-pair')
  appendTurn(session, 1)
  appendUser(session, longText('q', 0))                                   // seq 1
  appendToolCall(session, 'compress call', 'call-broken')                 // seq 2
  appendUser(session, 'Legacy compaction summary inserted between call and result.') // seq 3
  appendToolResult(session, 'ok', 'call-broken')                          // seq 4 — non-adjacent result
  assert.equal(session.deriveMessages().length, 4)
  const hidden = stripOrphanedSurfaceToolMessages(session)
  assert.equal(hidden, 2, 'the broken call and its non-adjacent result are both pruned')
  const after = session.deriveMessages()
  assert.equal(after.length, 2, 'only the two user messages remain visible')
  assert.ok(!after.some((message) => message.role === 'tool'), 'no orphaned tool result remains')
  assert.ok(!after.some((message) => message.role === 'assistant' && message.content.some((block) => (block as { type?: string }).type === 'tool-call')), 'no orphaned tool-call remains')
  assert.doesNotThrow(() => buildCompressibleSeqRanges(session, { preserveRecent: 0 }), 'the healed surface is range-solvable')
})

test('M5: stripOrphanedSurfaceToolMessages keeps healthy multi-call pairs', () => {
  const session = Session.create('multi-call')
  appendTurn(session, 1)
  appendUser(session, longText('q', 0))
  appendMultiToolCall(session, 'compress + other', ['call-a', 'call-b'])
  appendToolResult(session, 'a ok', 'call-a')
  appendToolResult(session, 'b ok', 'call-b')
  const hidden = stripOrphanedSurfaceToolMessages(session)
  assert.equal(hidden, 0, 'adjacent multi-call results are healthy — nothing pruned')
  assert.equal(session.deriveMessages().length, 4, 'the whole pair stays on the surface')
})

test('M5: openToolCallIds reports exactly the in-flight calls', () => {
  const session = Session.create('open-calls')
  appendTurn(session, 1)
  appendUser(session, longText('q', 0))
  appendToolCall(session, 'compress', 'call-acp')
  appendToolCall(session, 'other tool', 'call-other')
  assert.deepEqual([...openToolCallIds(session)].sort(), ['call-acp', 'call-other'])
  appendToolResult(session, 'ok', 'call-other')
  assert.deepEqual([...openToolCallIds(session)], ['call-acp'], 'only the unanswered call remains open')
})

test('M5: hideCompressToolPair refuses a multi-call node (hiding would orphan siblings)', () => {
  const session = Session.create('multi-call-hide')
  appendTurn(session, 1)
  appendUser(session, longText('old', 0))
  appendMultiToolCall(session, 'compress + other', ['call-acp', 'call-other'])
  appendToolResult(session, 'ok', 'call-acp') // adjacent to the call node
  assert.equal(hideCompressToolPair(session, 'call-acp'), false, 'a multi-call node is never hidden')
  const after = session.deriveMessages()
  assert.ok(after.some((message) => message.content.some((block) => (block as { type?: string }).type === 'tool-result')), 'the sibling result stays visible')
  assert.ok(after.some((message) => message.role === 'assistant' && message.content.some((block) => (block as { type?: string }).type === 'tool-call')), 'the tool-call node stays visible')
})

test('M5: deferCompressPairHide lands the hide on the microtask queue', async () => {
  const session = Session.create('deferred-hide')
  appendTurn(session, 1)
  appendUser(session, longText('old', 0))                    // seq 1
  appendToolCall(session, 'compressing history', 'call-acp') // seq 2
  // The compress tool runs mid-turn: its durable summary node is inserted
  // before the current tool/result, producing [summary, compress-call, result].
  runCompactionTransaction(session, {
    start: 1,
    end: 1,
    shadowedSeqs: [1],
    summary: [{ type: 'text', text: 'Compression summary with enough technical detail to replace the old message.' }],
    shadowedTokenCount: 1000,
    provider: 'test-provider',
    model: 'test-model',
  })
  const result = session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: 'res-acp',
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'call-acp', content: [{ type: 'text', text: 'ok' }] }],
      source: { kind: 'tool', callId: 'call-acp' },
    },
  } as never, { surfaceOp: 'append' })
  let errored: unknown = null
  deferCompressPairHide(session, 'call-acp', result.seq, (error) => { errored = error })
  // Synchronously the pair is still on the surface — the hide is deferred.
  assert.ok(session.deriveMessages().some((message) => message.role === 'assistant' && message.content.some((block) => (block as { type?: string }).type === 'tool-call')), 'hide is deferred — the pair is still visible synchronously')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(errored, null, 'the deferred hide does not error')
  const after = session.deriveMessages()
  assert.ok(!after.some((message) => message.role === 'assistant' && message.content.some((block) => (block as { type?: string }).type === 'tool-call')), 'the pair is hidden after the microtask drains')
  assert.ok(after.some((message) => message.role === 'user' && message.content.some((block) => (block as { type?: string }).type === 'text' && (block as { text?: string }).text === 'ok')), 'the compress result text is preserved')
})
