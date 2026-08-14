import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { AcpStateStore } from '../src/state.ts'
import {
  assertNoActiveCompaction,
  findOpenTurn,
  rebuildBlockLedger,
  resolveSurfaceRange,
  runCompactionTransaction,
  shadowedSeqsOf,
} from '../src/region.ts'
import { appendTurn, appendToolCall, appendToolResult, appendUser, appendAssistant, buildTextSession, longText } from './helpers.ts'

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

test('M5: resolveSurfaceRange rejects missing, reversed, and pair-broken ranges', () => {
  const session = buildTextSession(6)
  assert.deepEqual(resolveSurfaceRange(session, 1, 4), { start: 1, end: 4 })
  assert.throws(() => resolveSurfaceRange(session, 99, 100), /not in the current surface/)
  assert.throws(() => resolveSurfaceRange(session, 4, 1), /reversed range/)
  assert.deepEqual(shadowedSeqsOf(session, 1, 3), [1, 2, 3])
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
