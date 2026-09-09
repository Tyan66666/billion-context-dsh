/**
 * Regression tests for issue #133 — search_context latency degrading with
 * block count (ms → ~20 min at 190 blocks / 13.3M shadowed tokens). The
 * plugin layer rebuilt the block ledger (B+1) × O(B·N) per search and
 * re-extracted the full search corpus on every call. Guards:
 *  - rebuildBlockLedger is O(N+B) per snapshot (single-pass compactionId
 *    index) and memoized per snapshot (issue #109)
 *  - buildSearchDocs rebuilds the corpus once per log snapshot and returns
 *    the same array until the next append
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { rebuildBlockLedger, runCompactionTransaction } from '../src/region.ts'
import { buildSearchDocs } from '../src/tools.ts'
import { appendUser, buildTextSession } from './helpers.ts'

test('M5: rebuildBlockLedger is memoized per snapshot (issues #109/#133)', () => {
  const session = buildTextSession(8)
  runCompactionTransaction(session, {
    start: 1, end: 3, shadowedSeqs: [1, 2, 3],
    summary: [{ type: 'text', text: 'first summary detail' }],
    shadowedTokenCount: 100, provider: 'p', model: 'm',
  })
  runCompactionTransaction(session, {
    start: 4, end: 6, shadowedSeqs: [4, 5, 6],
    summary: [{ type: 'text', text: 'second summary detail' }],
    shadowedTokenCount: 200, provider: 'p', model: 'm',
  })
  const events = session.events
  const first = rebuildBlockLedger(events)
  const second = rebuildBlockLedger(events)
  assert.equal(first.length, 2)
  assert.equal(second, first, 'repeated calls on the same snapshot return the cached ledger')
  // a new append produces a new snapshot array → the memo must not leak across
  appendUser(session, 'a new message after the blocks')
  const third = rebuildBlockLedger(session.events)
  assert.notEqual(third, first, 'new snapshot rebuilds the ledger')
  assert.equal(third.length, 2, 'append-only log keeps the same blocks')
})

test('M5: ledger summarySeq keeps the first checkpoint per compactionId', () => {
  const cid = 'cid-first-wins'
  const events: readonly SessionEvent[] = [
    {
      type: 'user/message', seq: 1, time: 1,
      data: { content: [{ type: 'text', text: 'checkpoint one' }], source: { plugin: 'compact', compactionId: cid } },
    } as SessionEvent,
    {
      type: 'user/message', seq: 2, time: 2,
      data: { content: [{ type: 'text', text: 'checkpoint two' }], source: { plugin: 'compact', compactionId: cid } },
    } as SessionEvent,
    {
      type: 'compaction/summary', seq: 3, time: 3,
      data: {
        compactionId: cid,
        summary: [{ type: 'text', text: 's' }],
        shadowedRange: { start: 1, end: 1 },
        shadowedSeqs: [1],
        shadowedTokenCount: 5,
        provider: 'p',
        model: 'm',
      },
    } as SessionEvent,
  ]
  const ledger = rebuildBlockLedger(events)
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0]!.summarySeq, 1, 'first checkpoint wins (old per-block scan semantics)')
})

/** A session of `events` short messages (3 per mini-turn) with `blocks` contiguous compactions. */
function buildPerfSession(events: number, blocks: number): Session {
  const session = Session.create('perf-133')
  session.append('turn/start', { turn: 1 })
  const per = 3
  const turns = Math.floor((events - 1) / per)
  for (let i = 0; i < turns; i += 1) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `user message ${i} with some filler text` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: i,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `assistant reply ${i} with some filler text` }],
        provider: 'p',
        model: 'm',
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/result', {
      turn: 1,
      step: i,
      message: {
        id: `r${i}`,
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: `c${i}`, content: [{ type: 'text', text: `tool output ${i} with some filler text` }] }],
        source: { kind: 'tool', callId: `c${i}` },
      },
    }, { surfaceOp: 'append' })
  }
  const evs = session.events
  const span = Math.floor((turns * per) / blocks)
  let first = 1
  for (let b = 0; b < blocks; b += 1) {
    const last = Math.min(first + span - 1, turns * per)
    const shadowed: number[] = []
    for (let s = first; s <= last; s += 1) {
      const ev = evs[s]
      if (ev && (ev.type === 'user/message' || ev.type === 'assistant/message' || ev.type === 'tool/result')) shadowed.push(s)
    }
    runCompactionTransaction(session, {
      start: first,
      end: last,
      shadowedSeqs: shadowed,
      summary: [{ type: 'text', text: `perf block ${b}` }],
      shadowedTokenCount: 10,
      provider: 'p',
      model: 'm',
      topic: `perf ${b}`,
    })
    first = last + 1
  }
  return session
}

test('M3: search corpus build stays fast as blocks accumulate (issue #133)', () => {
  // 10K events / 150 blocks: the old per-search ledger rebuild
  // ((B+1) × O(B·N) ≈ 226M event iterations) took seconds here; the fixed
  // path is one O(N+B) pass + one corpus extraction.
  const session = buildPerfSession(10_000, 150)
  const t0 = performance.now()
  const docs = buildSearchDocs(session)
  const firstMs = performance.now() - t0
  assert.ok(firstMs < 500, `first buildSearchDocs took ${firstMs.toFixed(0)}ms`)
  assert.ok(docs.length > 300, `corpus should cover blocks + shadowed messages (got ${docs.length} docs)`)
  assert.equal(buildSearchDocs(session), docs, 'same log snapshot returns the cached corpus')
})

test('M3: search corpus cache invalidates when a new block lands (issue #133)', () => {
  const session = buildTextSession(12)
  runCompactionTransaction(session, {
    start: 1, end: 3, shadowedSeqs: [1, 2, 3],
    summary: [{ type: 'text', text: 'alpha block summary' }],
    shadowedTokenCount: 10, provider: 'p', model: 'm',
  })
  const before = buildSearchDocs(session)
  assert.equal(before.filter((d) => d.kind === 'block').length, 1)
  runCompactionTransaction(session, {
    start: 4, end: 6, shadowedSeqs: [4, 5, 6],
    summary: [{ type: 'text', text: 'beta block summary' }],
    shadowedTokenCount: 10, provider: 'p', model: 'm',
  })
  const after = buildSearchDocs(session)
  assert.notEqual(after, before, 'new snapshot rebuilds the corpus')
  assert.equal(after.filter((d) => d.kind === 'block').length, 2)
})
