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
import { appendTurn, appendToolResult, appendToolCall, appendMultiToolCall, appendUser, appendAssistant, buildTextSession, longText } from './helpers.ts'

function makeEnv(limit = 128000): ToolEnvironment {
  return {
    kernel: createCore({}) as CompressionCore,
    store: new AcpStateStore(),
    modelContextLimit: limit,
    compressCallIdsToHide: new Set(),
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

test('M3: successful compress registers its call id for post-result pair hiding', async () => {
  const env = makeEnv()
  const session = buildTextSession(12)
  const compress = toolOf(env, 'compress')
  const result = await compress.execute({
    content: [{
      startSeq: 1,
      endSeq: 5,
      summary: 'Authentication system: JWT access tokens with 15 minute expiry, refresh tokens in Redis with 30 day TTL, login flow in src/auth/login.ts with sliding-window rate limiting at 10 requests per minute per IP address, bcrypt hashing at cost factor 12.',
    }],
  } as never, fakeExec(session))
  assert.match((result as { text: string }).text, /Compressed 1 block/)
  assert.ok(env.compressCallIdsToHide!.has('call-acp'), 'the engine knows to hide this compress call/result after the tool result lands')
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

test('M3: decompress accepts the kernel block ref bN that acp_status shows', async () => {
  const env = makeEnv()
  const session = buildTextSession(12)
  const compress = toolOf(env, 'compress')
  await compress.execute({
    content: [{
      startSeq: 1,
      endSeq: 5,
      summary: 'Authentication summary with enough technical detail to satisfy the kernel threshold: JWT, Redis refresh tokens, login flow, rate limiting, bcrypt.',
    }],
  } as never, fakeExec(session))

  const ledger = rebuildBlockLedger(session.events)
  const kernelBlockId = ledger[0]!.kernelBlockId
  assert.match(kernelBlockId!, /^b\d+$/, 'the durable block records its kernel ref')

  const decompress = toolOf(env, 'decompress')
  const result = await decompress.execute({ blockId: kernelBlockId! }, fakeExec(session))
  const text = (result as { text: string }).text
  // The bN path resolves to the SAME durable block as the compaction id.
  assert.match(text, /Block [0-9a-f-]{36} — Authentication/, 'bN resolves to the compaction id')
  assert.match(text, /\[msg 0\]/)
  assert.match(text, /\[msg 4\]/)
})

test('M3: decompress malformed or unknown bN forms are not found, not normalised', async () => {
  const env = makeEnv()
  const session = buildTextSession(12)
  const compress = toolOf(env, 'compress')
  await compress.execute({
    content: [{
      startSeq: 1,
      endSeq: 5,
      summary: 'Authentication summary with enough technical detail to satisfy the kernel threshold: JWT, Redis refresh tokens, login flow, rate limiting, bcrypt.',
    }],
  } as never, fakeExec(session))

  const decompress = toolOf(env, 'decompress')
  // Unknown ref, zero-padded ref, and uppercase are all NOT the canonical bN.
  for (const arg of ['b99', 'b0', 'b01', 'B1', 'b1 ', 'b1x']) {
    const result = await decompress.execute({ blockId: arg }, fakeExec(session))
    assert.match((result as { text: string }).text, /not found \(see acp_status/, `"${arg}" must be reported not found`)
  }
})

test('M3: decompress prefers an exact bN over a compaction-id prefix collision', async () => {
  const env = makeEnv()
  const session = buildTextSession(12)
  const compress = toolOf(env, 'compress')
  // Compress two ranges so the session has two blocks (b1, b2).
  await compress.execute({
    content: [
      {
        startSeq: 1,
        endSeq: 3,
        summary: 'First block: JWT access tokens with 15 minute expiry, refresh tokens in Redis, login flow in src/auth/login.ts, sliding-window rate limiting, bcrypt cost 12.',
      },
      {
        startSeq: 7,
        endSeq: 9,
        summary: 'Second block: deployment pipeline with docker builds, registry push, kubernetes canary rollout and health-check probes.',
      },
    ],
  } as never, fakeExec(session))

  // Collision semantics: a compaction UUID may start with "b2" (randomUUID is
  // hex). The anchored /^b\d+$/ must NOT treat such a prefix as a kernel ref,
  // so "b2" always resolves the REAL second block, and the full UUID prefix
  // (e.g. "b2abcd12") falls through to the compaction-id prefix match. We
  // assert both directions with the real blocks: "b2" hits the kernel ref;
  // passing a UUID-looking string that is not a kernel ref falls back.
  const ledger = rebuildBlockLedger(session.events)
  const second = ledger[1]!

  const decompress = toolOf(env, 'decompress')
  const byB2 = await decompress.execute({ blockId: 'b2' }, fakeExec(session))
  assert.match(
    (byB2 as { text: string }).text,
    new RegExp(`Block ${second.blockId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    'exact b2 resolves to the real second block',
  )
  // A prefix that LOOKS like it could collide ("b2..." hex) is not a kernel
  // ref: blockIdOfKernelRef rejects it, and the compaction-id prefix match
  // runs. With no block whose UUID starts with that exact prefix this is a
  // clean "not found" — proving the bN branch did not swallow the prefix.
  const uuidLike = `b2${'abcd1234'}`
  const byPrefix = await decompress.execute({ blockId: uuidLike }, fakeExec(session))
  assert.match((byPrefix as { text: string }).text, /not found \(see acp_status/, 'a bN-looking hex prefix is not a kernel ref and falls through')
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

test('M3: acp_status renders the upstream kernel breakdown without window rows', async () => {
  const env = makeEnv()
  const session = buildTextSession(12)
  const status = toolOf(env, 'acp_status')
  const empty = await status.execute({}, fakeExec(session))
  const text = (empty as { text: string }).text
  // Upstream-aligned: kernel buildStatusReport overview, percentages of visible total.
  assert.match(text, /CONTEXT BREAKDOWN\n  0 tool \(0%\) \| \d+(\.\d+)?K text \(100%\) \| 0 summaries \(0%\)/, 'kernel breakdown with visible-total percentages')
  assert.match(text, /No compressed blocks\./, 'kernel block ledger section')
  assert.match(text, /Nudge: idle — /, 'kernel nudge decision line')
  assert.match(text, /Surface: 12 nodes, seqs 1\.\.12/, 'the surface summary lets the model locate seqs without a nudge')
  // The model tool must NOT surface the context window (upstream has no window rows).
  assert.ok(!/estimated context/.test(text), 'no window-occupancy row in the model tool')
  assert.ok(!/context window/.test(text), 'no window row in the model tool')

  const compress = toolOf(env, 'compress')
  await compress.execute({
    content: [{
      startSeq: 1,
      endSeq: 5,
      summary: 'Authentication summary with enough technical detail to satisfy the kernel threshold: JWT, Redis refresh tokens, login flow, rate limiting, bcrypt.',
    }],
  } as never, fakeExec(session))

  const filled = await status.execute({}, fakeExec(session))
  const filledText = (filled as { text: string }).text
  assert.match(filledText, /COMPRESSED BLOCKS — 1 active/, 'block ledger after compression')
  assert.match(filledText, /b\d+ \(T1\)/, 'kernel block row with tier')
  assert.match(filledText, /Surface: 8 nodes, seqs 6\.\.15/, '12 messages - 5 shadowed + 1 summary = 8 surface nodes; the span is min..max even though the checkpoint node lands first in surface.nodes')
  assert.ok(!/estimated context/.test(filledText), 'still no window-occupancy row after compression')
  assert.ok(!/context window/.test(filledText), 'still no window row after compression')
})

test('M3: acp_status never shows the window even when windowFor auto-detects it', async () => {
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
  assert.match(text, /CONTEXT BREAKDOWN/, 'kernel breakdown still rendered')
  // The window is a human-side (/acp) concern; the model tool never sees it.
  assert.ok(!/context window/.test(text), 'window rows stay out of the model tool even with a probed window')
  assert.ok(!/estimated context/.test(text), 'window-occupancy rows stay out of the model tool')
})

test('M3: acp_status surfaces the ACTIVE nudge decision with a small window and compressible content', async () => {
  // P2-5 construction: ACTIVE requires BOTH usage ≥ threshold AND pending
  // content ≥ minCompressRange (5000 chars). A tiny window (500) plus the
  // long-text session drives usage far past the emergency line while the
  // surface still holds compressible ranges, so the kernel injects.
  const env = makeEnv(500)
  const session = buildTextSession(12)
  const status = await toolOf(env, 'acp_status').execute({}, fakeExec(session))
  const text = (status as { text: string }).text
  assert.match(text, /Nudge: ACTIVE — /, 'pressure + pending content → kernel injects')
})

test('M3: acp_status breakdown does not double-count the checkpoint summary (P1-3)', async () => {
  const env = makeEnv()
  const session = buildTextSession(12)
  const compress = toolOf(env, 'compress')
  await compress.execute({
    content: [{
      startSeq: 1,
      endSeq: 5,
      summary: 'Authentication summary with enough technical detail to satisfy the kernel threshold: JWT, Redis refresh tokens, login flow, rate limiting, bcrypt.',
    }],
  } as never, fakeExec(session))

  const status = await toolOf(env, 'acp_status').execute({}, fakeExec(session))
  const text = (status as { text: string }).text
  const breakdown = text.match(/CONTEXT BREAKDOWN\n  (.+)/)?.[1] ?? ''
  // The checkpoint summary node is excluded from the visible messages, so it
  // must count ONLY as summaries — never as text. If it leaked into text, the
  // text share would be inflated by the summary's own tokens.
  const summaries = breakdown.match(/([\d.]+K?) summaries/)?.[1] ?? '0'
  assert.ok(summaries !== '0', `summaries counted: got "${summaries}"`)
  // And the summary's token count is exactly what the block ledger reports.
  const ledger = rebuildBlockLedger(session.events)
  const summaryTokens = ledger.reduce((sum, block) => sum + block.shadowedTokenCount, 0)
  assert.ok(summaryTokens > 0, 'ledger records real reclaimed tokens')
})

test('M3: acp_status attributes tool results to their real tool name (toolName backfill)', async () => {
  // Mixed session in the REAL DSH shape (helpers.appendToolResult writes
  // source.callId + a nested tool-result block, no message.toolName): the tool
  // output must be counted under "bash", not an empty-name bucket — which
  // previously made Top tools render ` (62%)` and the kernel Tip `tool:""`.
  const env = makeEnv()
  const session = Session.create('test-session')
  appendTurn(session, 1)
  appendUser(session, 'list the workspace')
  appendToolCall(session, 'calling bash', 'call_1', 1, 1)
  appendToolResult(session, longText('tool output', 1), 'call_1', 1, 1)
  const status = await toolOf(env, 'acp_status').execute({}, fakeExec(session))
  const text = (status as { text: string }).text
  assert.match(text, /Top tools: bash/, 'tool result attributed to bash, not an empty-name bucket')
  assert.match(text, /tool:"bash"/, 'kernel Tip interpolates the real top tool, not tool:""')
  assert.ok(!/tool:""/.test(text), 'no empty tool name leaks into the Tip')
})

test('M3: acp_status drilldown passes scope/view/tool/sort/limit to the kernel report', async () => {
  const env = makeEnv()
  const session = buildTextSession(12)
  const status = toolOf(env, 'acp_status')

  // Messages view: per-message rows, sort + limit honored, surface anchor kept.
  const messages = await status.execute({ scope: 'uncompressed', view: 'messages', limit: 3 }, fakeExec(session))
  const msgText = (messages as { text: string }).text
  assert.match(msgText, /UNCOMPRESSED — .*\| 12 msgs/, 'kernel drilldown header lists all visible messages')
  assert.match(msgText, /Sorted by size/, 'kernel sort passthrough (default size)')
  assert.match(msgText, /m\d{5} \(/, 'per-message rows carry kernel refs (mN)')
  assert.match(msgText, /3 of 12 shown\./, 'limit truncation reported')
  assert.match(msgText, /Surface: 12 nodes, seqs 1\.\.12/, 'the surface seq anchor stays in drilldown mode')
  assert.ok(!/Nudge:/.test(msgText), 'drilldown mode omits the nudge decision line (upstream `if (args.scope) return base`)')

  // Tool filter narrows rows; an empty filter renders a zero-row header.
  const filtered = await status.execute({ scope: 'uncompressed', view: 'messages', tool: 'text' }, fakeExec(session))
  assert.match((filtered as { text: string }).text, /UNCOMPRESSED — text: /, 'tool filter reflected in the header')
  const empty = await status.execute({ scope: 'uncompressed', view: 'messages', tool: 'nonexistent' }, fakeExec(session))
  assert.match((empty as { text: string }).text, /0 msgs/, 'empty tool filter renders a zero-row header without crashing')

  // Ranges view merges visible messages into ranges.
  const ranges = await status.execute({ scope: 'uncompressed' }, fakeExec(session))
  assert.match((ranges as { text: string }).text, /UNCOMPRESSED — .*\| 12 visible messages/, 'ranges view header')

  // Compressed drilldown with zero blocks renders a zero-block header.
  const compressed = await status.execute({ scope: 'compressed' }, fakeExec(session))
  assert.match((compressed as { text: string }).text, /COMPRESSED — 0 blocks/, 'zero-block compressed drilldown renders without crashing')
})

test('M3: acp_status drilldown labels kernel refs (mN) and separates them from compress seqs', async () => {
  // P1-1: kernel drilldown rows are mN (dense log-order refs), which must NOT
  // be fed to compress (surface seqs). The engine appends an explicit note in
  // uncompressed drilldown mode so the model never mistakes mN for seqs.
  const env = makeEnv()
  const session = buildTextSession(12)
  const status = toolOf(env, 'acp_status')
  const text = (await status.execute({ scope: 'uncompressed', view: 'messages' }, fakeExec(session)) as { text: string }).text
  assert.match(text, /Note: drilldown rows are kernel refs \(mN\) for size awareness — compress uses the Surface: seqs above, never mN\./, 'explicit mN-vs-seq note in drilldown mode')
  // Overview mode does NOT carry the drilldown note (it has no mN rows).
  const overview = await toolOf(env, 'acp_status').execute({}, fakeExec(session))
  assert.ok(!/drilldown rows are kernel refs/.test((overview as { text: string }).text), 'note is drilldown-only')
})

test('M3: acp_status uncompressed drilldown excludes the checkpoint summary node', async () => {
  // P2-2: the summary node (source.plugin === 'compact') must not appear as a
  // drilldown row — it is already counted as block summaries. 12 msgs - 5
  // shadowed = 7 live rows; if the checkpoint leaked, it would read 8 msgs.
  const env = makeEnv()
  const session = buildTextSession(12)
  const compress = toolOf(env, 'compress')
  await compress.execute({
    content: [{
      startSeq: 1,
      endSeq: 5,
      summary: 'Authentication summary with enough technical detail to satisfy the kernel threshold: JWT, Redis refresh tokens, login flow, rate limiting, bcrypt.',
    }],
  } as never, fakeExec(session))

  const status = await toolOf(env, 'acp_status').execute({ scope: 'uncompressed', view: 'messages' }, fakeExec(session))
  const text = (status as { text: string }).text
  assert.match(text, /UNCOMPRESSED — .*\| 7 msgs/, 'checkpoint summary node excluded from drilldown rows (12 - 5 shadowed = 7 live)')
  const overview = await toolOf(env, 'acp_status').execute({}, fakeExec(session))
  assert.match((overview as { text: string }).text, /COMPRESSED BLOCKS — 1 active/, 'overview still counts the block (summary lives in ledger, not rows)')
})

test('M3: acp_status drilldown survives multi-tool-call nodes (seq#callId ids)', async () => {
  // Multi-call assistant nodes project to id `seq#callId` (messages.ts:147);
  // drilldown refs are still assigned and rendered per call.
  const env = makeEnv()
  const session = Session.create('test-session')
  appendTurn(session, 1)
  appendUser(session, 'run two tools')
  appendMultiToolCall(session, 'run two tools', ['call_a', 'call_b'], 1, 1)
  appendToolResult(session, longText('bash output', 1), 'call_a', 1, 1)
  appendToolResult(session, longText('read output', 1), 'call_b', 1, 1)
  const status = await toolOf(env, 'acp_status').execute({ scope: 'uncompressed', view: 'messages' }, fakeExec(session))
  const text = (status as { text: string }).text
  assert.match(text, /UNCOMPRESSED — /, 'drilldown renders with multi-call nodes')
  assert.match(text, /m\d{5} \(/, 'per-call rows still carry kernel refs')
  assert.ok(!/undefined/.test(text), 'no undefined leaks from seq#callId refs')
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

test('M3: compress tolerates the wrapped-arguments form ({ arguments: "..." } double-nesting)', async () => {
  // Some models emit `{ "arguments": "{\"content\": [...]}" }` (double-nested)
  // instead of the unwrapped `{ "content": [...] }`. The old DSH validator
  // surfaced this as `"arguments" must be an object` and sent the model into a
  // retry loop; the schema now accepts `arguments` as an optional JSON node
  // and handleCompress unwraps it before range resolution.
  const env = makeEnv()
  const session = buildTextSession(12)
  const compress = toolOf(env, 'compress')
  const wrapped = {
    arguments: JSON.stringify({
      content: [{
        startSeq: 1,
        endSeq: 3,
        summary: 'Authentication: JWT access tokens with 15 minute expiry, refresh tokens in Redis with 30 day TTL, login flow in src/auth/login.ts with sliding-window rate limiting at 10 requests per minute, bcrypt at cost 12.',
      }],
    }),
  }
  const result = await compress.execute(wrapped as never, fakeExec(session))
  const text = (result as { text: string }).text
  assert.match(text, /Compressed 1 block/, 'the wrapped form unwraps and compresses the same content')
  const ledger = rebuildBlockLedger(session.events)
  assert.equal(ledger.length, 1, 'the wrapped form lands the durable block')
})

test('M3: compress reports a clear error when neither form carries content', async () => {
  const env = makeEnv()
  const session = buildTextSession(4)
  const compress = toolOf(env, 'compress')
  const result = await compress.execute({ arguments: 'not even json' } as never, fakeExec(session))
  assert.match((result as { text: string }).text, /missing content/, 'no content in either form yields the guidance message')
  assert.equal(rebuildBlockLedger(session.events).length, 0, 'no block lands without content')
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

test('M3: compress remaps a stale range to the still-live remainder', async () => {
  const env = makeEnv()
  const session = buildTextSession(12)
  const compress = toolOf(env, 'compress')
  await compress.execute({
    content: [{
      startSeq: 1,
      endSeq: 5,
      summary: 'Authentication system: JWT access tokens with 15 minute expiry, refresh tokens in Redis with 30 day TTL, login flow in src/auth/login.ts with sliding-window rate limiting at 10 requests per minute per IP address, bcrypt hashing at cost factor 12.',
    }],
  } as never, fakeExec(session))

  // Reuse a stale nudge-style range whose START was shadowed by the block
  // above (the "seq 93148..174600 not in the current surface" class of bug).
  // The tool must remap it to the live remainder instead of erroring.
  const result = await compress.execute({
    content: [{
      startSeq: 3,
      endSeq: 10,
      summary: 'Deployment pipeline with docker builds, registry push, kubernetes canary rollout and health-check probes, plus the environment configuration matrix.',
    }],
  } as never, fakeExec(session))
  const text = (result as { text: string }).text
  assert.match(text, /Compressed 1 block/)
  assert.match(text, /were already shadowed — compressed the live remainder/)
  assert.match(text, /seqs 6\.\.10/)

  const ledger = rebuildBlockLedger(session.events)
  assert.equal(ledger.length, 2, 'the recovered range lands a second block')
  assert.deepEqual(ledger[1]!.shadowedSeqs, [6, 7, 8, 9, 10], 'only the live remainder is shadowed, never the checkpoint')
})

test('M3: compress reports a fully shadowed range as already compressed, no error', async () => {
  const env = makeEnv()
  const session = buildTextSession(12)
  const compress = toolOf(env, 'compress')
  await compress.execute({
    content: [{
      startSeq: 1,
      endSeq: 5,
      summary: 'Authentication system: JWT access tokens with 15 minute expiry, refresh tokens in Redis with 30 day TTL, login flow in src/auth/login.ts with sliding-window rate limiting at 10 requests per minute per IP address, bcrypt hashing at cost factor 12.',
    }],
  } as never, fakeExec(session))

  // The exact stale re-compression that used to throw
  // 'seq 1..5 not in the current surface' — now a clean advisory no-op.
  const result = await compress.execute({
    content: [{
      startSeq: 1,
      endSeq: 5,
      summary: 'Repeated summary that would otherwise fail on stale seqs with enough technical detail to pass the minimum length threshold.',
    }],
  } as never, fakeExec(session))
  const text = (result as { text: string }).text
  assert.match(text, /Compressed 0 block/)
  assert.match(text, /already compressed/)
  assert.match(text, /decompress to recover/)

  const ledger = rebuildBlockLedger(session.events)
  assert.equal(ledger.length, 1, 'no phantom block for the stale re-compression')
})

test('M3: a batch mixing a fresh range and a fully shadowed range lands one block', async () => {
  const env = makeEnv()
  const session = buildTextSession(12)
  const compress = toolOf(env, 'compress')
  await compress.execute({
    content: [{
      startSeq: 1,
      endSeq: 5,
      summary: 'Authentication system: JWT access tokens with 15 minute expiry, refresh tokens in Redis with 30 day TTL, login flow in src/auth/login.ts with sliding-window rate limiting at 10 requests per minute per IP address, bcrypt hashing at cost factor 12.',
    }],
  } as never, fakeExec(session))

  const result = await compress.execute({
    content: [
      {
        startSeq: 1,
        endSeq: 5,
        summary: 'Stale range that is already covered by the first block and must be skipped, not error.',
      },
      {
        startSeq: 7,
        endSeq: 9,
        summary: 'Fresh deployment segment: docker builds, registry push, kubernetes canary rollout and health-check probes.',
      },
    ],
  } as never, fakeExec(session))
  const text = (result as { text: string }).text
  assert.match(text, /Compressed 1 block/, 'only the fresh range creates a block')
  assert.match(text, /already compressed/)
  assert.match(text, /1 range\(s\) skipped/)

  const ledger = rebuildBlockLedger(session.events)
  assert.equal(ledger.length, 2, 'the stale entry never creates a durable block')
  assert.deepEqual(ledger[1]!.shadowedSeqs, [7, 8, 9])
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

test('M3: a kernel-rejected range does not poison the rest of the compress call', async () => {
  const env = makeEnv()
  const session = buildTextSession(12)
  const compress = toolOf(env, 'compress')
  const result = await compress.execute({
    content: [
      {
        startSeq: 1,
        endSeq: 3,
        summary: 'Authentication system: JWT access tokens with 15 minute expiry, refresh tokens in Redis with 30 day TTL, login flow in src/auth/login.ts with sliding-window rate limiting at 10 requests per minute per IP address, bcrypt hashing at cost factor 12.',
      },
      {
        startSeq: 11,
        endSeq: 12,
        summary: 'Recent tail messages fall inside the kernel protected zone, so the kernel rejects this range while the first range still lands.',
      },
    ],
  } as never, fakeExec(session))
  const text = (result as { text: string }).text
  assert.match(text, /Compressed 1 block/, 'the healthy range still lands')
  assert.match(text, /protected zone/, 'the rejected range is reported, not fatal')
  const ledger = rebuildBlockLedger(session.events)
  assert.equal(ledger.length, 1, 'exactly the healthy range produced a block')
})
