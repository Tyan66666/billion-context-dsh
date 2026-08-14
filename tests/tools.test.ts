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
  assert.match((empty as { text: string }).text, /context window: 128000 \(configured\)/, 'without a windowFor the env falls back to modelContextLimit')

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

test('M3: acp_status shows the auto-detected context window and source', async () => {
  const env = {
    ...makeEnv(),
    windowFor: async () => ({
      limit: 1000000,
      source: 'auto' as const,
      provider: 'test-provider',
      model: 'test-model',
    }),
  }
  const session = buildTextSession(12)
  const status = await toolOf(env, 'acp_status').execute({}, fakeExec(session))
  const text = (status as { text: string }).text
  assert.match(text, /context window: 1000000 \(auto-detected from test-provider\/test-model\)/)
  assert.match(text, /estimated context: \d+ \/ 1000000/, 'pressure is computed against the probed window')
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

const TIER_SUMMARY = 'Tiered distillation test summary covering the authentication subsystem, the refresh-token lifecycle, the login flow, the rate-limiting strategy, the bcrypt cost factor, the session revocation rules, the deployment pipeline, the kubernetes canary rollout, and the health-check probe configuration with all critical file paths and decisions preserved verbatim for later recovery. '.repeat(50)

test('M3: distilling a block summary node produces a tier-2 block', async () => {
  const env = makeEnv()
  const session = buildTextSession(12)
  const compress = toolOf(env, 'compress')
  await compress.execute({
    content: [{ startSeq: 1, endSeq: 5, summary: TIER_SUMMARY }],
  } as never, fakeExec(session))

  const ledger = rebuildBlockLedger(session.events)
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0]!.tier, 1)
  const summarySeq = ledger[0]!.summarySeq
  assert.ok(summarySeq !== undefined, 'the checkpoint node seq is derivable from the log')
  assert.ok(session.surface.nodes.includes(summarySeq!), 'the active block checkpoint is on the surface')

  // Compressing the checkpoint node itself must DISTILL (tier 2), not fold the
  // summary as a plain message.
  const result = await compress.execute({
    content: [{ startSeq: summarySeq, endSeq: summarySeq, summary: TIER_SUMMARY }],
  } as never, fakeExec(session))
  const text = (result as { text: string }).text
  assert.match(text, /Compressed 1 block/)
  assert.match(text, /tier 2/, 'the block line reports the distillation tier')

  const after = rebuildBlockLedger(session.events)
  assert.equal(after.length, 2)
  assert.equal(after[1]!.tier, 2)
  assert.deepEqual(after[1]!.shadowedSeqs, [summarySeq], 'the tier-2 block shadows the parent checkpoint node')
  assert.deepEqual(after[1]!.parentBlockIds, [ledger[0]!.blockId], 'the distilled parent is recorded durably')
  assert.equal(after[1]!.kernelBlockId, 'b2', 'the kernel block id is recorded for faithful rehydration')
  assert.ok(after[1]!.effectiveMessageIds!.includes('1'), 'the tier-2 block records its parents ORIGINAL coverage, not the checkpoint node')

  // decompress on the tier-2 block expands through the parent to the originals.
  const decompress = toolOf(env, 'decompress')
  const rec = await decompress.execute({ blockId: after[1]!.blockId }, fakeExec(session))
  const recText = (rec as { text: string }).text
  assert.match(recText, /tier 2, distills 1 block/)
  assert.match(recText, /\[msg 0\]/)
  assert.match(recText, /\[msg 4\]/)
})

test('M3: distilling a tier-2 block produces tier 3', async () => {
  const env = makeEnv()
  const session = buildTextSession(12)
  const compress = toolOf(env, 'compress')
  await compress.execute({ content: [{ startSeq: 1, endSeq: 5, summary: TIER_SUMMARY }] } as never, fakeExec(session))
  const ledger1 = rebuildBlockLedger(session.events)
  const tier1Seq = ledger1[0]!.summarySeq!
  await compress.execute({ content: [{ startSeq: tier1Seq, endSeq: tier1Seq, summary: TIER_SUMMARY }] } as never, fakeExec(session))

  const ledger2 = rebuildBlockLedger(session.events)
  assert.equal(ledger2.length, 2)
  assert.equal(ledger2[1]!.tier, 2)
  const tier2Seq = ledger2[1]!.summarySeq
  assert.ok(tier2Seq !== undefined)

  const result = await compress.execute({
    content: [{ startSeq: tier2Seq, endSeq: tier2Seq, summary: TIER_SUMMARY }],
  } as never, fakeExec(session))
  assert.match((result as { text: string }).text, /tier 3/)

  const after = rebuildBlockLedger(session.events)
  assert.equal(after.length, 3)
  assert.equal(after[2]!.tier, 3)
  assert.deepEqual(after[2]!.parentBlockIds, [ledger2[1]!.blockId])
  assert.equal(after[2]!.kernelBlockId, 'b3')

  // decompress recurses through BOTH levels back to the originals.
  const decompress = toolOf(env, 'decompress')
  const rec = await decompress.execute({ blockId: after[2]!.blockId }, fakeExec(session))
  const recText = (rec as { text: string }).text
  assert.match(recText, /tier 3, distills 1 block/)
  assert.match(recText, /\[msg 0\]/)
  assert.match(recText, /\[msg 4\]/)
})

test('M3: overlapping batch entries skip the later range with a warning', async () => {
  const env = makeEnv()
  const session = buildTextSession(12)
  const compress = toolOf(env, 'compress')
  const result = await compress.execute({
    content: [
      { startSeq: 1, endSeq: 3, summary: 'First overlapping segment: JWT access tokens, Redis refresh tokens, login flow, rate limiting, bcrypt cost 12.' },
      { startSeq: 3, endSeq: 5, summary: 'Second overlapping segment: kubernetes canary rollout, health probes, docker registry push.' },
    ],
  } as never, fakeExec(session))
  const text = (result as { text: string }).text
  assert.match(text, /Compressed 1 block/, 'only the earlier range creates a block')
  assert.match(text, /Skipped range/, 'the overlap is surfaced as a warning')
  assert.match(text, /1 range\(s\) skipped/)

  const ledger = rebuildBlockLedger(session.events)
  assert.equal(ledger.length, 1, 'no phantom durable block for the skipped range')
  assert.deepEqual(ledger[0]!.shadowedSeqs, [1, 2, 3])
})

test('M3: a mixed boundary [message..blockSummary] distills and folds extra messages', async () => {
  const env = makeEnv()
  const session = buildTextSession(12)
  const compress = toolOf(env, 'compress')
  // Tier-1 in the middle so the checkpoint lands AFTER older residual nodes.
  await compress.execute({ content: [{ startSeq: 3, endSeq: 7, summary: TIER_SUMMARY }] } as never, fakeExec(session))

  const ledger = rebuildBlockLedger(session.events)
  assert.equal(ledger.length, 1)
  const summarySeq = ledger[0]!.summarySeq!
  // Surface: [1, 2, c1, 8, 9, 10, 11, 12] — span [2..c1] crosses the block edge.
  const result = await compress.execute({
    content: [{ startSeq: 2, endSeq: summarySeq, summary: TIER_SUMMARY }],
  } as never, fakeExec(session))
  const text = (result as { text: string }).text
  assert.match(text, /tier 2/, 'a block boundary in the span makes the range distill')

  const after = rebuildBlockLedger(session.events)
  assert.equal(after.length, 2)
  assert.equal(after[1]!.tier, 2)
  assert.deepEqual(after[1]!.shadowedSeqs, [2, summarySeq])
  assert.deepEqual(after[1]!.parentBlockIds, [ledger[0]!.blockId])

  // The folded message (seq 2 = assistant, index 1) is recoverable alongside
  // the distilled originals (seqs 3..7 → [msg 2]..[msg 6]).
  const decompress = toolOf(env, 'decompress')
  const rec = await decompress.execute({ blockId: after[1]!.blockId }, fakeExec(session))
  const recText = (rec as { text: string }).text
  assert.match(recText, /\[reply 1\]/, 'the folded assistant message is in the recursion')
  assert.match(recText, /\[msg 4\]/, 'a distilled original from the parent block is in the recursion')
})
