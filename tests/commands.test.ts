/**
 * M4 — `/acp` slash command regression tests.
 *
 * Covers the human-side status panel: nudge arbitration (the panel now runs a
 * read-only `processTurn` and reports `nudge: idle|ACTIVE` + how many tokens
 * remain until the next nudge), and the block ledger listing.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createCore, type CompressionCore } from 'acp-kernel'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session } from '@deepseek-ai/dsh-session'
import { AcpStateStore } from '../src/state.ts'
import { acpCommand } from '../src/commands.ts'
import type { ToolEnvironment } from '../src/tools.ts'
import { appendTurn, appendUser, appendAssistant, longText } from './helpers.ts'

function makeEnv(limit = 128000): ToolEnvironment {
  return {
    kernel: createCore({}) as CompressionCore,
    store: new AcpStateStore(),
    modelContextLimit: limit,
    // Engine-level defaults (src/index.ts DEFAULT_CONFIG): the nudge line the
    // human panel reports must match what the engine actually ships.
    nudgeMaxContextLimitPct: 0.7,
    nudgeEmergencyThresholdPct: 0.85,
    compressCallIdsToHide: new Set(),
  }
}

/** A session with `count` alternating user/assistant text messages inside one open turn. */
function buildSession(count: number): Session {
  const session = Session.create('test-session')
  appendTurn(session, 1)
  for (let index = 0; index < count; index += 1) {
    if (index % 2 === 0) appendUser(session, longText('msg', index))
    else appendAssistant(session, longText('reply', index), 1, index)
  }
  return session
}

function fakeAgent(session: Session): Agent {
  return {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: new Context(),
  } as unknown as Agent
}

async function runAcp(env: ToolEnvironment, agent: Agent, rawInput: string): Promise<string> {
  const command = acpCommand(env)
  const result = await command.handler({
    commandId: 'cmd-test' as never,
    agent,
    rawInput,
    signal: new AbortController().signal,
  } as never)
  assert.equal(result.kind, 'success')
  return (result as { text: string }).text
}

test('M4: /acp status reports nudge arbitration + distance to next nudge (idle)', async () => {
  const env = makeEnv(128000)
  const session = buildSession(12)
  const text = await runAcp(env, fakeAgent(session), '')

  assert.ok(text.includes('ACP status — session test-session'), 'header line')
  assert.ok(text.includes('estimated context:'), 'context line')
  assert.ok(text.includes('context window: 128000'), 'window line')
  // The nudge line is the human-side window into kernel arbitration (pi-aligned).
  assert.match(text, /\n  nudge: idle — /, 'nudge line with kernel reason')
  assert.match(text, /\n  next nudge: ~[\d,]+ tokens to go \(usage \d+% → 70% line\)/, 'distance line uses the engine nudge line (70%)')
})

test('M4: /acp status reports ACTIVE nudge when usage crosses the nudge line', async () => {
  // 12 long messages ≈ 12.4K tokens; a 16K window puts usage at ~77% — past
  // the engine 70% nudge line — so the kernel arbitrates ACTIVE.
  const env = makeEnv(16000)
  const session = buildSession(12)
  const text = await runAcp(env, fakeAgent(session), 'status')

  assert.match(text, /\n  nudge: ACTIVE( \[T\d\])? — /, 'ACTIVE nudge line')
  // ACTIVE nudges do not carry a "next nudge" distance (already there).
  assert.ok(!text.includes('next nudge:'), 'no distance line while ACTIVE')
})

test('M4: /acp status lists compressed blocks from the ledger', async () => {
  const env = makeEnv(128000)
  const session = buildSession(12)
  // Compress a range via the tool so the ledger has a block to list.
  const { makeTools } = await import('../src/tools.ts')
  const compress = makeTools(env).find((definition) => definition.name === 'compress')!
  const agent = fakeAgent(session)
  await compress.execute({
    content: [{
      startSeq: 1,
      endSeq: 5,
      summary: 'Authentication system: JWT access tokens with 15 minute expiry, refresh tokens in Redis with 30 day TTL, login flow in src/auth/login.ts with sliding-window rate limiting.',
    }],
  } as never, {
    callId: 'call-acp',
    name: 'compress',
    arguments: {},
    signal: new AbortController().signal,
    agent,
  } as never)

  const text = await runAcp(env, agent, 'status')
  assert.ok(text.includes('blocks: 1'), 'ledger block count')
  assert.match(text, /\n  - [0-9a-f]{8}: seqs /, 'block listing line')
})

test('M4: /acp status lists ALL blocks, not just the oldest 10 (issue #47)', async () => {
  const env = makeEnv(128000)
  // 70 messages = 12 non-overlapping 5-message compress ranges (1..60), with
  // the last 10 messages left live so no range hits the kernel protected zone
  // (the last 5 messages are never compressible).
  const session = buildSession(70)
  const { makeTools } = await import('../src/tools.ts')
  const compress = makeTools(env).find((definition) => definition.name === 'compress')!
  const agent = fakeAgent(session)

  const blockPrefixes: string[] = []
  for (let batch = 0; batch < 12; batch += 1) {
    const start = batch * 5 + 1
    const result = await compress.execute({
      content: [{
        startSeq: start,
        endSeq: start + 4,
        summary: `Batch ${batch}: authentication subsystem, JWT access tokens with 15 minute expiry, refresh tokens in Redis with 30 day TTL, login flow in src/auth/login.ts with sliding-window rate limiting.`,
      }],
    } as never, {
      callId: `call-batch-${batch}`,
      name: 'compress',
      arguments: {},
      signal: new AbortController().signal,
      agent,
    } as never) as { text: string }
    const prefix = result.text.match(/block ([0-9a-f]{8})/)?.[1]
    assert.ok(prefix !== undefined, `batch ${batch} lands a block`)
    blockPrefixes.push(prefix)
  }
  assert.equal(blockPrefixes.length, 12, '12 batches → 12 blocks')

  const text = await runAcp(env, agent, 'status')
  assert.ok(text.includes('blocks: 12'), 'ledger counts all 12 blocks')
  // The old slice(0, 10) hid everything past the 10th block — the 11th and
  // 12th must now be listed (issue #47 regression).
  assert.ok(text.includes(blockPrefixes[10]!), `11th block ${blockPrefixes[10]} is listed`)
  assert.ok(text.includes(blockPrefixes[11]!), `12th block ${blockPrefixes[11]} is listed`)
  const listingLines = text.split('\n').filter((line) => /^  - [0-9a-f]{8}: seqs /.test(line))
  assert.equal(listingLines.length, 12, 'all 12 block rows are listed')
})

test('M4: /acp decompress resolves both the compaction-id prefix and the kernel bN ref', async () => {
  const env = makeEnv(128000)
  const session = buildSession(12)
  const { makeTools } = await import('../src/tools.ts')
  const compress = makeTools(env).find((definition) => definition.name === 'compress')!
  const agent = fakeAgent(session)
  const compressResult = await compress.execute({
    content: [{
      startSeq: 1,
      endSeq: 5,
      summary: 'Authentication system: JWT access tokens with 15 minute expiry, refresh tokens in Redis with 30 day TTL, login flow in src/auth/login.ts with sliding-window rate limiting.',
    }],
  } as never, {
    callId: 'call-acp',
    name: 'compress',
    arguments: {},
    signal: new AbortController().signal,
    agent,
  } as never) as { text: string }
  const blockId = compressResult.text.match(/block ([0-9a-f]{8})/)?.[1]!
  assert.ok(blockId.length === 8, 'compress result carries a block id')

  const byPrefix = await runAcp(env, agent, `decompress ${blockId}`)
  assert.ok(byPrefix.includes('Block '), 'prefix resolution works')

  const byKernelRef = await runAcp(env, agent, 'decompress b1')
  assert.ok(byKernelRef.includes('Block '), 'kernel bN ref resolution works')
})
