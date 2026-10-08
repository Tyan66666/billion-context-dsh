import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createCore, type CompressionCore } from 'acp-kernel'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { AcpStateStore } from '../src/state.ts'
import { makeTools, type ToolEnvironment } from '../src/tools.ts'
import { hideSurfaceSeqs, rebuildBlockLedger, runCompactionTransaction, shadowedSeqsOf } from '../src/region.ts'
import { appendMultiToolCall, appendToolResult, appendTurn, appendUser, longText } from './helpers.ts'

function makeEnv(limit = 128000): ToolEnvironment {
  return {
    kernel: createCore({}) as CompressionCore,
    store: new AcpStateStore(),
    modelContextLimit: limit,
    compressCallIdsToHide: new Set(),
  }
}

function fakeExec(session: Session, overrides: Partial<ToolRunContext> = {}): ToolRunContext {
  const agent = {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: new Context(),
  } as unknown as Agent
  return {
    callId: 'call-acp',
    name: 'compress',
    arguments: {},
    signal: new AbortController().signal,
    agent,
    ...overrides,
  } as unknown as ToolRunContext
}

function toolOf(env: ToolEnvironment, name: string) {
  const tool = makeTools(env).find((definition) => definition.name === name)
  assert.ok(tool, `tool ${name} registered`)
  return tool
}

/** User question + one multi-tool-call round with two long results. Surface seqs: 1 user, 2 assistant (calls c1, c2), 3 result c1, 4 result c2. */
function buildToolPairSession(): Session {
  const session = Session.create('test-session')
  appendTurn(session, 1)
  appendUser(session, longText('question', 0))
  appendMultiToolCall(session, longText('plan', 1), ['c1', 'c2'])
  appendToolResult(session, longText('result', 2), 'c1')
  appendToolResult(session, longText('result', 3), 'c2')
  return session
}

const SUMMARY: ContentBlock[] = [{ type: 'text', text: 'The tool round was consumed; its outputs are no longer needed.' }]

/**
 * The load-time invariant the released readers enforce on every compaction
 * event: `shadowedSeqs` must name an EXACT current surface span (non-empty,
 * both edges present, element-wise positional equality) — checked against the
 * surface AS OF THE EVENT'S POSITION in the log, because each compaction's own
 * replace removes its span from the surface for everything after it. A
 * violation makes the whole session log unloadable forever (issue #201). The
 * pinned v0-to-v1 relationships reader cannot be the oracle here — its
 * applySurface reads the V0 replace dialect ({ op, start, end }) that current
 * hosts no longer emit — so the tests replay the surface walk themselves with
 * the current dialect ({ op, startSeq, endSeq }).
 */
type LogEventLike = {
  seq: number
  type: string
  data: { shadowedRange?: { start?: number; end?: number }; shadowedSeqs?: number[] }
  surfaceOp?: { op?: string; startSeq?: number; endSeq?: number }
}

const SURFACE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

function assertLogSpansExact(events: LogEventLike[]): void {
  const surface: number[] = []
  for (const event of events) {
    if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
      const range = event.data.shadowedRange
      const seqs = Array.isArray(event.data.shadowedSeqs) ? event.data.shadowedSeqs : []
      assert.ok(
        range !== undefined && typeof range.start === 'number' && typeof range.end === 'number' && seqs.length > 0,
        `${event.type} must name a non-empty exact current surface span`,
      )
      const startIdx = surface.indexOf(range!.start!)
      const endIdx = surface.indexOf(range!.end!)
      assert.ok(
        startIdx >= 0 && endIdx >= startIdx,
        `${event.type} span ${range!.start}..${range!.end} must sit on the current surface`,
      )
      assert.deepEqual(
        surface.slice(startIdx, endIdx + 1),
        seqs,
        `${event.type} shadowedSeqs must equal the current surface slice`,
      )
      continue
    }
    if (!SURFACE_EVENT_TYPES.has(event.type)) continue
    const op = event.surfaceOp
    if (op?.op === 'replace') {
      const startIdx = surface.indexOf(op.startSeq!)
      const endIdx = surface.indexOf(op.endSeq!)
      assert.ok(startIdx >= 0 && endIdx >= startIdx, `replace ${op.startSeq}..${op.endSeq} must sit on the tracked surface`)
      surface.splice(startIdx, endIdx - startIdx + 1, Number(event.seq))
    } else {
      surface.push(Number(event.seq))
    }
  }
}

test('issue #201: a second transaction over an already-shadowed span fails before writing anything', () => {
  const session = buildToolPairSession()
  const first = runCompactionTransaction(session, {
    start: 2, end: 4, shadowedSeqs: [2, 3, 4],
    summary: [...SUMMARY], shadowedTokenCount: 1000,
    provider: 'test-provider', model: 'test-model',
  })
  assert.ok(first.compactionId)
  // The span left the surface; shadowedSeqsOf now degrades silently to [].
  assert.deepEqual(shadowedSeqsOf(session, 2, 4), [])
  const eventsBefore = session.snapshotEvents().length

  // Pre-fix this call wrote compaction/start + a dead compaction/summary
  // (shadowedSeqs: []) + a compensating compaction/end, THEN threw
  // "sourceEventSeqs must not be empty" — bricking the log on next load.
  assert.throws(
    () => runCompactionTransaction(session, {
      start: 2, end: 4, shadowedSeqs: shadowedSeqsOf(session, 2, 4),
      summary: [...SUMMARY], shadowedTokenCount: 1000,
      provider: 'test-provider', model: 'test-model',
    }),
    /not an exact current surface span/,
  )
  assert.equal(session.snapshotEvents().length, eventsBefore, 'zero durable writes on rejection')
  assert.equal(rebuildBlockLedger(session.snapshotEvents()).length, 1, 'the first block is untouched')
})

test('issue #201: two batch ranges collapsing onto one span land ONE block, never a dead transaction', async () => {
  const env = makeEnv()
  const session = buildToolPairSession()
  const compress = toolOf(env, 'compress')

  // Two single tool results in one round: each expands outward to the SAME
  // enclosing balanced span (seqs 2..4), i.e. the exact reporter scenario.
  const result = await compress.execute({
    content: [
      { startSeq: 3, endSeq: 3, summary: 'The first tool result has been fully consumed; its contents are no longer needed for the task.' },
      { startSeq: 4, endSeq: 4, summary: 'The second tool result has been fully consumed; its contents are no longer needed for the task.' },
    ],
  } as never, fakeExec(session))
  const text = (result as { text: string }).text
  assert.match(text, /Compressed 1 block/)
  assert.match(text, /same span as an earlier range in this call/)

  const summaries = session.snapshotEvents().filter((event) => event.type === 'compaction/summary')
  assert.equal(summaries.length, 1)
  assert.deepEqual((summaries[0]!.data as { shadowedSeqs: number[] }).shadowedSeqs, [2, 3, 4])
  for (const event of session.snapshotEvents()) {
    if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
      assert.ok((event.data as { shadowedSeqs: unknown[] }).shadowedSeqs.length > 0, 'no event may carry empty shadowedSeqs')
    }
  }
  assert.equal(rebuildBlockLedger(session.snapshotEvents()).length, 1)
  assertLogSpansExact(session.snapshotEvents() as unknown as LogEventLike[])
})

test('issue #201: the invariant oracle rejects the dead-transaction shapes the old code wrote', () => {
  const session = buildToolPairSession()
  runCompactionTransaction(session, {
    start: 2, end: 4, shadowedSeqs: [2, 3, 4],
    summary: [...SUMMARY], shadowedTokenCount: 1000,
    provider: 'test-provider', model: 'test-model',
  })
  const healthy = session.snapshotEvents() as unknown as LogEventLike[]
  assertLogSpansExact(healthy)

  // Pre-fix poison shapes: a second transaction over the same span wrote
  // compaction/start, a compaction/summary whose shadowedSeqs no longer name
  // the live slice, and a compensating compaction/end.
  const variants: Array<{ label: string; data: LogEventLike['data'] }> = [
    { label: 'empty', data: { shadowedRange: { start: 2, end: 4 }, shadowedSeqs: [] } },
    { label: 'garbage tail', data: { shadowedRange: { start: 2, end: 4 }, shadowedSeqs: [4] } },
  ]
  for (const variant of variants) {
    const baseSeq = 1000
    const poisoned: LogEventLike[] = [
      ...healthy,
      { seq: baseSeq, type: 'compaction/start', data: {} },
      { seq: baseSeq + 1, type: 'compaction/summary', data: variant.data },
      { seq: baseSeq + 2, type: 'compaction/end', data: {} },
    ]
    assert.throws(
      () => assertLogSpansExact(poisoned),
      /current surface/,
      `poison shape "${variant.label}" must be rejected`,
    )
  }
})

test('issue #201: hideSurfaceSeqs validates the span before writing anything', () => {
  const offSurface = buildToolPairSession()
  const beforeOff = offSurface.snapshotEvents().length
  assert.throws(() => hideSurfaceSeqs(offSurface, [999]), /cannot prune seqs 999/)
  assert.equal(offSurface.snapshotEvents().length, beforeOff, 'zero durable writes on rejection')

  const unsorted = buildToolPairSession()
  const beforeUnsorted = unsorted.snapshotEvents().length
  assert.throws(() => hideSurfaceSeqs(unsorted, [4, 3]), /cannot prune seqs 4, 3/)
  assert.equal(unsorted.snapshotEvents().length, beforeUnsorted, 'zero durable writes on rejection')

  const valid = buildToolPairSession()
  hideSurfaceSeqs(valid, [3])
  const prunes = valid.snapshotEvents().filter((event) => event.type === 'compaction/prune')
  assert.equal(prunes.length, 1)
  assert.deepEqual((prunes[0]!.data as { shadowedSeqs: number[] }).shadowedSeqs, [3])
  assertLogSpansExact(valid.snapshotEvents() as unknown as CompactionLikeEvent[], valid.surface.nodes.map(Number))
})
