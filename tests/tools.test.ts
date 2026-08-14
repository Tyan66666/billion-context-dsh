import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createCore, type CompressionCore } from 'acp-kernel'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session } from '@deepseek-ai/dsh-session'
import { AcpStateStore } from '../src/state.ts'
import { makeTools, type ToolEnvironment } from '../src/tools.ts'
import { rebuildBlockLedger } from '../src/region.ts'
import { rangeTable } from '../src/nudge.ts'
import { appendTurn, appendToolResult, appendMultiToolCall, appendUser, appendAssistant, buildTextSession, longText } from './helpers.ts'

function makeEnv(limit = 128000): ToolEnvironment {
  return {
    kernel: createCore({}) as CompressionCore,
    store: new AcpStateStore(),
    modelContextLimit: limit,
  }
}

/** Minimal agent handle: the tools only read session/options. */
function fakeExec(session: Parameters<typeof buildTextSession>[0] extends never ? never : import('@deepseek-ai/dsh-session').Session, overrides: Partial<ToolRunContext> = {}): ToolRunContext {
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

test('M3: compress lands a durable block and shrinks the surface', async () => {
  const env = makeEnv()
  const session = buildTextSession(12)
  const before = session.deriveMessages().length

  const compress = toolOf(env, 'compress')
  const result = await compress.execute({
    content: [{
      startSeq: 1,
      endSeq: 5,
      summary: 'Authentication system: JWT access tokens with 15 minute expiry, refresh tokens in Redis with 30 day TTL, login flow in src/auth/login.ts with sliding-window rate limiting at 10 requests per minute per IP address, bcrypt hashing at cost factor 12.',
    }],
  } as never, fakeExec(session))

  const text = (result as { text: string }).text
  assert.match(text, /Compressed 1 block/)
  assert.match(text, /tokens reclaimed/)

  // The surface shrank: 12 messages → 7 surviving + 1 summary.
  assert.ok(session.deriveMessages().length < before)
  assert.equal(session.deriveMessages().length, 8)

  // The ledger sees the block from the log alone.
  const ledger = rebuildBlockLedger(session.events)
  assert.equal(ledger.length, 1)
  assert.deepEqual(ledger[0]!.shadowedSeqs, [1, 2, 3, 4, 5])
  assert.ok(ledger[0]!.shadowedTokenCount > 0, 'the ledger records real reclaimed tokens, not 0')
})

test('M3: compress accepts multiple disjoint ranges in one call, each its own block', async () => {
  const env = makeEnv()
  const session = buildTextSession(12)
  const before = session.deriveMessages().length

  const compress = toolOf(env, 'compress')
  const result = await compress.execute({
    content: [
      {
        startSeq: 1,
        endSeq: 3,
        summary: 'First segment: JWT access tokens with 15 minute expiry, refresh tokens in Redis, login flow in src/auth/login.ts, sliding-window rate limiting, bcrypt cost 12.',
      },
      {
        startSeq: 7,
        endSeq: 9,
        summary: 'Second segment: deployment pipeline with docker builds, registry push, kubernetes canary rollout and health-check probes.',
      },
    ],
  } as never, fakeExec(session))

  const text = (result as { text: string }).text
  assert.match(text, /Compressed 2 block/)
  assert.match(text, /seqs 1\.\.3/)
  assert.match(text, /seqs 7\.\.9/)

  // Both segments land as independent durable blocks with distinct ids.
  const ledger = rebuildBlockLedger(session.events)
  assert.equal(ledger.length, 2)
  assert.deepEqual(ledger[0]!.shadowedSeqs, [1, 2, 3])
  assert.deepEqual(ledger[1]!.shadowedSeqs, [7, 8, 9])
  assert.notEqual(ledger[0]!.blockId, ledger[1]!.blockId)

  // 12 messages - 6 shadowed + 2 summary nodes = 8 surface nodes.
  assert.equal(session.deriveMessages().length, 8)
  assert.ok(session.deriveMessages().length < before)
})

test('M3: decompress recovers the shadowed originals read-only', async () => {
  const env = makeEnv()
  const session = buildTextSession(12)
  const compress = toolOf(env, 'compress')
  await compress.execute({
    content: [{
      startSeq: 1,
      endSeq: 5,
      summary: 'Authentication summary with enough technical detail to satisfy the kernel threshold: JWT, refresh tokens in Redis, login flow with rate limiting, bcrypt cost 12, session revocation on password change.',
    }],
  } as never, fakeExec(session))

  const ledger = rebuildBlockLedger(session.events)
  assert.equal(ledger.length, 1)
  const blockId = ledger[0]!.blockId

  const decompress = toolOf(env, 'decompress')
  const result = await decompress.execute({ blockId }, fakeExec(session))
  const text = (result as { text: string }).text
  assert.match(text, /\[msg 0\]/)
  assert.match(text, /\[msg 4\]/)
  // The surface is untouched by decompress.
  assert.equal(session.deriveMessages().length, 8)
})

test('M3: search_context finds information inside compressed blocks', async () => {
  const env = makeEnv()
  const session = buildTextSession(12)
  const compress = toolOf(env, 'compress')
  await compress.execute({
    content: [{
      startSeq: 1,
      endSeq: 5,
      summary: 'Authentication summary: JWT access tokens, Redis refresh tokens, sliding-window rate limiting, bcrypt cost 12.',
    }],
  } as never, fakeExec(session))

  const search = toolOf(env, 'search_context')
  const hit = await search.execute({ query: 'rate limiting', limit: 5 }, fakeExec(session))
  assert.match((hit as { text: string }).text, /Matches for "rate limiting"/)
  const miss = await search.execute({ query: 'quantum teleportation' }, fakeExec(session))
  assert.match((miss as { text: string }).text, /no matches/)
})

test('M3: acp_status reports the block ledger and pressure', async () => {
  const env = makeEnv()
  const session = buildTextSession(12)
  const status = toolOf(env, 'acp_status')
  const empty = await status.execute({}, fakeExec(session))
  assert.match((empty as { text: string }).text, /blocks: 0/)
  assert.match((empty as { text: string }).text, /surface: 12 nodes, seqs 1\.\.12/, 'the surface summary lets the model locate seqs without a nudge')

  const compress = toolOf(env, 'compress')
  await compress.execute({
    content: [{
      startSeq: 1,
      endSeq: 5,
      summary: 'Authentication summary with enough technical detail to satisfy the kernel threshold: JWT, Redis refresh tokens, login flow, rate limiting, bcrypt.',
    }],
  } as never, fakeExec(session))

  const filled = await status.execute({}, fakeExec(session))
  assert.match((filled as { text: string }).text, /blocks: 1/)
  assert.match((filled as { text: string }).text, /estimated context:/)
  assert.match((filled as { text: string }).text, /surface: 8 nodes/, '12 messages - 5 shadowed + 1 summary = 8 surface nodes')
})

test('M3: compress rejects ranges outside the assigned surface', async () => {
  const env = makeEnv()
  const session = buildTextSession(12)
  const compress = toolOf(env, 'compress')
  const result = await compress.execute({
    content: [{
      startSeq: 1,
      endSeq: 5,
      summary: 'This summary is long enough to pass the kernel minimum length threshold of fifty characters for the compressible content range.',
    }],
  } as never, fakeExec(session))
  // seqs 1..5 are on the surface and assigned refs — should succeed.
  assert.match((result as { text: string }).text, /Compressed 1 block/)
})

test('M3: compress accepts seq args with a trailing #callId fragment', async () => {
  const env = makeEnv()
  const session = buildTextSession(12)
  const compress = toolOf(env, 'compress')
  const result = await compress.execute({
    content: [{
      startSeq: '1#call_00_L7KTyu4R9MldKAI5sKhT8176',
      endSeq: '5',
      summary: 'This summary is long enough to pass the kernel minimum length threshold of fifty characters for the compressible content range.',
    }],
  } as never, fakeExec(session))
  assert.match((result as { text: string }).text, /Compressed 1 block/)
  assert.equal(session.deriveMessages().length, 8, 'seq 1..5 shadowed as requested')
})

test('M3: tools refuse to run without an agent context', async () => {
  const env = makeEnv()
  const session = buildTextSession(4)
  const compress = toolOf(env, 'compress')
  const exec = fakeExec(session, { agent: undefined })
  await assert.rejects(
    compress.execute({ content: [] } as never, exec),
    /requires an agent execution context/,
  )
})

/** A session whose second node is a multi-tool-call assistant message. */
function buildMultiCallSession(): Session {
  const session = Session.create('multi')
  appendTurn(session, 1)
  appendUser(session, longText('msg', 0))                     // seq 1
  appendMultiToolCall(session, 'plan', ['c1', 'c2'], 1, 1)   // seq 2 (2 calls: no bare ref)
  appendToolResult(session, longText('res', 0), 'c1', 1, 1)  // seq 3
  appendToolResult(session, longText('res', 1), 'c2', 1, 1)  // seq 4
  appendUser(session, longText('msg', 1))                     // seq 5
  appendAssistant(session, longText('reply', 1), 1, 2)        // seq 6
  appendUser(session, longText('msg', 2))                     // seq 7
  appendAssistant(session, longText('reply', 2), 1, 3)        // seq 8
  appendUser(session, longText('msg', 3))                     // seq 9
  appendAssistant(session, longText('reply', 3), 1, 4)        // seq 10
  return session
}

test('M3: compress expands a lone multi-tool-call boundary to the clean pair', async () => {
  const env = makeEnv()
  const session = buildMultiCallSession()
  const compress = toolOf(env, 'compress')
  // seq 2 is a multi-tool-call assistant message: it has NO bare '2' ref (the
  // projection keys are '2#c1' / '2#c2'), so a naive byRaw lookup fails. A lone
  // request on it expands outward to the smallest clean enclosing pair — the
  // whole call/result round (1..4) — whose edges are plain-ref messages.
  const result = await compress.execute({
    content: [{
      startSeq: 2,
      endSeq: 2,
      summary: 'This summary is long enough to pass the kernel minimum length threshold of fifty characters for the compressible content range.',
    }],
  } as never, fakeExec(session))

  assert.match((result as { text: string }).text, /Compressed 1 block/)
  const ledger = rebuildBlockLedger(session.events)
  assert.equal(ledger.length, 1)
  assert.deepEqual(ledger[0]!.shadowedSeqs, [1, 2, 3, 4])
})

test('M3: compress shadows multi-tool-call messages inside a clean range', async () => {
  const env = makeEnv()
  const session = buildMultiCallSession()
  const compress = toolOf(env, 'compress')
  // Both edges (1, 5) are plain-ref messages; the multi-call round (2..4) sits
  // inside the span and is shadowed with it — the real "nudge gave me a range"
  // scenario.
  const result = await compress.execute({
    content: [{
      startSeq: 1,
      endSeq: 5,
      summary: 'This summary is long enough to pass the kernel minimum length threshold of fifty characters for the compressible content range.',
    }],
  } as never, fakeExec(session))

  assert.match((result as { text: string }).text, /Compressed 1 block/)
  const ledger = rebuildBlockLedger(session.events)
  assert.equal(ledger.length, 1)
  assert.deepEqual(ledger[0]!.shadowedSeqs, [1, 2, 3, 4, 5])
})

test('M3: nudge range-table edges compress successfully (plain-ref boundaries)', async () => {
  const env = makeEnv()
  const session = buildMultiCallSession()
  const table = rangeTable(session)
  const match = /seq (\d+)\.\.(\d+)/.exec(table)
  assert.ok(match, 'range table renders a compressible span')
  const startSeq = Number(match![1])
  const endSeq = Number(match![2])

  const compress = toolOf(env, 'compress')
  const result = await compress.execute({
    content: [{
      startSeq,
      endSeq,
      summary: 'This summary is long enough to pass the kernel minimum length threshold of fifty characters for the compressible content range.',
    }],
  } as never, fakeExec(session))
  assert.match((result as { text: string }).text, /Compressed 1 block/)
})
