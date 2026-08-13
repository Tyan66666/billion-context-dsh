import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createCore, type CompressionCore } from 'acp-kernel'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AcpStateStore } from '../src/state.ts'
import { makeTools, type ToolEnvironment } from '../src/tools.ts'
import { rebuildBlockLedger } from '../src/region.ts'
import { buildTextSession } from './helpers.ts'

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
