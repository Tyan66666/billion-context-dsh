/**
 * Issue #136 regression — the replace surfaceOp dialect.
 *
 * Every durable replace this engine writes (compress checkpoint, prune
 * tombstone) must carry the CURRENT protocol `{ op: 'replace', startSeq,
 * endSeq }`. dsh-session validates it strictly (exactly those three keys):
 * hosts ≤ 0.1.3-alpha.2 want `{ op, start, end }`, hosts ≥ 0.1.5-alpha.1 want
 * the seq names — so the engine emits one dialect only, and the peer range
 * floors accordingly (see tests/peer-range.test.ts). On the old dialect every
 * compress failed live with:
 *
 *   session event "user/message" carries an invalid replace surfaceOp
 *
 * These tests run against REAL dsh-session instances (devDep line 0.1.5-rc.1),
 * so a future protocol drift turns red here instead of bricking a live session.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  PRUNE_NOTE,
  buildCompressibleSeqRanges,
  rebuildBlockLedger,
  resolveSurfaceRange,
  runCompactionTransaction,
  stripOrphanedSurfaceToolMessages,
} from '../src/region.ts'
import { appendTurn, appendToolCall, appendToolResult, appendUser, longText, wholeSurfaceRangeView } from './helpers.ts'

/** turn + user + tool-call + tool/result + user → surface [1 user, 2 call, 3 result, 4 user]. */
function buildPairSession(): Session {
  const session = Session.create('surfaceop-dialect')
  appendTurn(session, 1)
  appendUser(session, longText('q1', 1))
  appendToolCall(session, 'checking the docs', 'call_1')
  appendToolResult(session, 'done', 'call_1')
  appendUser(session, longText('q2', 2))
  return session
}

test('issue #136: compress lands on a real 0.1.5 session with the startSeq/endSeq dialect', () => {
  const session = buildPairSession()
  // Pre-fix, this exact call threw "invalid replace surfaceOp" on every
  // 0.1.5-line host because the engine emitted { op, start, end }.
  const { seqs } = runCompactionTransaction(session, {
    start: 2,
    end: 3,
    shadowedSeqs: [2, 3],
    summary: [{ type: 'text', text: 'Tool round summary with enough detail.' }],
    shadowedTokenCount: 500,
    provider: 'p',
    model: 'm',
  })
  const replaceEvent = session.snapshotEvents()[seqs[2]!]!
  assert.equal(replaceEvent.type, 'user/message')
  // The validator accepts EXACTLY these three keys — pin the shape so a
  // future dialect rename fails here first, not in a live session.
  assert.deepEqual(
    Object.keys(replaceEvent.surfaceOp as object).sort(),
    ['endSeq', 'op', 'startSeq'],
    'replace surfaceOp must carry exactly op/startSeq/endSeq',
  )
  assert.deepEqual(replaceEvent.surfaceOp, { op: 'replace', startSeq: 2, endSeq: 3 })
  // The shadowed nodes left the surface, the checkpoint joined it, and the
  // ledger rebuilds from the log.
  assert.ok(!session.surface.nodes.includes(2) && !session.surface.nodes.includes(3))
  assert.ok(session.surface.nodes.includes(seqs[2]!), 'the replacement node joins the surface')
  assert.equal(rebuildBlockLedger(session.snapshotEvents()).length, 1)
})

test('issue #136: orphan stripping emits the same dialect and leaves a visible prune note', () => {
  const session = Session.create('surfaceop-prune')
  appendTurn(session, 1)
  appendUser(session, longText('q0', 0))                       // seq 1
  appendToolResult(session, 'orphan result', 'result-orphan')  // seq 2 — no call anywhere
  appendUser(session, longText('q1', 1))                       // seq 3

  const hidden = stripOrphanedSurfaceToolMessages(session)
  assert.equal(hidden, 1, 'the orphan result is pruned')

  // The prune path writes compaction/prune followed by a user/message replace;
  // that replace must use the current dialect and cite the hidden node.
  const events = session.snapshotEvents()
  const pruneIndex = events.findIndex((event) => event.type === 'compaction/prune')
  assert.ok(pruneIndex >= 0, 'a durable compaction/prune event is recorded')
  const replace = events[pruneIndex + 1]!
  assert.equal(replace.type, 'user/message')
  assert.deepEqual(replace.surfaceOp, { op: 'replace', startSeq: 2, endSeq: 2 })
  assert.deepEqual(replace.sourceEventSeqs, [2])
  // user/message events carry the message as `data` itself (no .message wrap).
  const textBlock = (replace.data as { content?: Array<{ type?: string; text?: string }> })
    .content?.find((block) => block.type === 'text')
  assert.equal(textBlock?.text, PRUNE_NOTE)
})

test('issue #136: the host-owned system prompt node is never offered as compressible', () => {
  // Host loop shape on 0.1.5: the system prompt is appended FIRST, so it is
  // surface node 0 ahead of every conversation message.
  const session = Session.create('surfaceop-system')
  // Like every surface-eligible event, the system node marks its append.
  session.append('system/message', { message: createSystemMessage('You are a test agent.', 'test-plugin') }, { surfaceOp: 'append' })
  const systemSeq = session.surface.nodes[0]!
  appendTurn(session, 1)
  appendUser(session, longText('q1', 1))                  // seq 2
  appendToolCall(session, 'checking the docs', 'call_1')  // seq 3
  appendToolResult(session, 'done', 'call_1')             // seq 4
  appendUser(session, longText('q2', 2))                  // seq 5

  // The host protects node 0: any non-system replace covering it throws. This
  // is WHY the engine must keep the node out of the compressible table —
  // offering it would hand the model a range that always fails.
  assert.throws(
    () => session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'nope' }] }),
      { surfaceOp: { op: 'replace', startSeq: systemSeq, endSeq: systemSeq }, sourceEventSeqs: [systemSeq] }),
    /node 0 holds the system prompt/,
  )

  const ranges = buildCompressibleSeqRanges(session, wholeSurfaceRangeView(session), { preserveRecent: 0 })
  assert.equal(ranges.length, 1, 'the system node splits off nothing — the rest forms one range')
  assert.deepEqual({ start: ranges[0]!.start, end: ranges[0]!.end }, { start: 2, end: 4 })

  // A stale range whose edge sits on the system node snaps past it instead of
  // trying to shadow it.
  const resolved = resolveSurfaceRange(session, systemSeq, 4)
  assert.ok(resolved.start > systemSeq, 'resolution never includes the system node')
})

test('issue #136: a system prompt NOT at seq 0 stays out of the surface (mid-session injection)', () => {
  // The host can inject a system node mid-session (e.g. a runtime prompt
  // refresh). The engine's table skip is seq-agnostic — the system node must
  // never appear in a compressible range regardless of where it sits.
  const session = Session.create('surfaceop-system-mid')
  appendTurn(session, 1)                                     // seq 0
  appendUser(session, longText('q1', 1))                  // seq 1
  appendToolCall(session, 'checking the docs', 'call_1')  // seq 2
  appendToolResult(session, 'done', 'call_1')             // seq 3
  // Mid-session system injection lands at seq 4.
  session.append('system/message', { message: createSystemMessage('Runtime refresh.', 'test-plugin') }, { surfaceOp: 'append' })
  const sysSeq = session.surface.nodes[3]!
  assert.equal(sysSeq, 4, 'the system node is surface node index 3, seq 4')
  appendUser(session, longText('q2', 2))                  // seq 5

  const ranges = buildCompressibleSeqRanges(session, wholeSurfaceRangeView(session), { preserveRecent: 0 })
  // The system node splits the surface: seqs 1-3 and 5 each form ranges,
  // never a span crossing through the system node.
  for (const range of ranges) {
    assert.ok(range.start !== sysSeq && range.end !== sysSeq, 'the system node is not a range edge')
    assert.ok(range.start > sysSeq || range.end < sysSeq, 'no range straddles the system node')
  }
  const allSeqs = ranges.flatMap((r) => [r.start, r.end])
  assert.ok(!allSeqs.includes(sysSeq), 'the system seq appears in no range edge')
})

test('issue #136: live-path resolution has an explicit system-node guard (defense in depth)', () => {
  // Regression for the review note: resolveSurfaceRange previously excluded
  // system nodes only INCIDENTALLY (hasPlainRef's default branch returns
  // false). The explicit guard is now part of cleanBefore/cleanAfter, so a
  // range whose edge falls on a system node snaps past it.
  const session = Session.create('surfaceop-live-guard')
  appendTurn(session, 1)                                     // seq 0
  appendUser(session, longText('q1', 1))                  // seq 1
  session.append('system/message', { message: createSystemMessage('Mid.', 'test-plugin') }, { surfaceOp: 'append' })
  const sysSeq = session.surface.nodes[1]!
  assert.equal(sysSeq, 2, 'the system node is surface node index 1, seq 2')
  appendUser(session, longText('q2', 2))                  // seq 3

  // Requesting a span that starts ON the system node must resolve to a
  // live, compressible remainder — never return the system node as an edge.
  const resolved = resolveSurfaceRange(session, sysSeq, 3)
  assert.ok(resolved.start !== sysSeq, 'the resolved start is not the system node')
  assert.ok(resolved.end !== sysSeq, 'the resolved end is not the system node')
  assert.ok(resolved.start > sysSeq, 'resolution shifts past the system node')
})

test('issue #136: stale-range recovery skips system nodes in the live remainder', () => {
  // Gap 1 from the #137 review: recoverStaleRange filters system nodes
  // explicitly (region.ts recoverStaleRange), but no test pinned it — a stale
  // span whose live remainder includes a system node must snap to the
  // remaining conversation, never return the system node as an edge.
  const session = Session.create('surfaceop-stale-system')
  appendTurn(session, 1)                                     // seq 0
  appendUser(session, longText('q1', 1))                  // seq 1
  appendToolCall(session, 'checking the docs', 'call_1')  // seq 2
  appendToolResult(session, 'done', 'call_1')             // seq 3
  appendUser(session, longText('q2', 2))                  // seq 4
  session.append('system/message', { message: createSystemMessage('Mid.', 'test-plugin') }, { surfaceOp: 'append' })
  const sysSeq = session.surface.nodes[4]!
  assert.equal(sysSeq, 5, 'the system node is surface node index 4, seq 5')
  appendUser(session, longText('q3', 3))                  // seq 6

  // Shadow seqs 1..4 (the pre-system conversation) into a block.
  runCompactionTransaction(session, {
    start: 1,
    end: 4,
    shadowedSeqs: [1, 2, 3, 4],
    summary: [{ type: 'text', text: 'First block summary with plenty of detail.' }],
    shadowedTokenCount: 1000,
    provider: 'p',
    model: 'm',
  })
  // Surface: [checkpoint, system@5, 6]. A stale span 1..6 recovers to the
  // live remainder — seq 6 only, with the system node skipped.
  const resolved = resolveSurfaceRange(session, 1, 6)
  assert.equal(resolved.start, 6, 'recovery lands on the live user seq, past the system node')
  assert.equal(resolved.end, 6)
  assert.ok(resolved.recovered === true, 'the span was recovered from stale edges')
  assert.notEqual(resolved.start, sysSeq, 'the system node is never a recovered edge')
})
