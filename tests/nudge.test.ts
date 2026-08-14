import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createCore, type CompressionCore } from 'acp-kernel'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AcpStateStore } from '../src/state.ts'
import { buildNudge, rangeTable } from '../src/nudge.ts'
import { buildTextSession } from './helpers.ts'

function fakeAgent(session: import('@deepseek-ai/dsh-session').Session): Agent {
  return {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: new Context(),
  } as unknown as Agent
}

function makeEnv(limit: number) {
  return {
    kernel: createCore({}) as CompressionCore,
    store: new AcpStateStore(),
    modelContextLimit: limit,
  }
}

test('M4: buildNudge injects a compressible-range table under pressure', () => {
  // Small window + long history → the kernel recommends compression.
  const env = makeEnv(4000)
  const session = buildTextSession(12)
  const lastNudgeTurn = new Map<string, number>()

  const outcome = buildNudge(fakeAgent(session), env, lastNudgeTurn)
  assert.ok(outcome !== null, 'a nudge is produced under pressure')
  const text = outcome!.message.content.map((block) => (block as { text?: string }).text ?? '').join('')
  assert.match(text, /compress/i)
  assert.match(text, /seq \d+\.\.\d+/, 'the range table uses surface seq refs')
  assert.match(text, /compress\(\{ content: \[\{ startSeq, endSeq, summary \}\] \}\)/, 'the tool call shape is spelled out')
})

test('M4: a nudge is injected at most once per turn (dedup)', () => {
  // 12 messages ≈ 12.4K tokens; limit 15000 → ~83% usage: above the 75%
  // OVER-LIMIT line but below the 95% emergency threshold.
  const env = makeEnv(15000)
  const session = buildTextSession(12)
  const lastNudgeTurn = new Map<string, number>()
  const agent = fakeAgent(session)

  const first = buildNudge(agent, env, lastNudgeTurn)
  assert.ok(first !== null, 'first injection happens')
  assert.equal(first!.emergency, false, 'this is a normal-pressure nudge')
  assert.equal(buildNudge(agent, env, lastNudgeTurn), null, 'same turn is deduped')
  assert.equal(lastNudgeTurn.get(session.id), 1, 'the turn was recorded')
})

test('M4: no nudge is produced for a comfortable context', () => {
  const env = makeEnv(128000)
  const session = buildTextSession(12)
  const lastNudgeTurn = new Map<string, number>()
  assert.equal(buildNudge(fakeAgent(session), env, lastNudgeTurn), null)
})

test('M4: emergency nudges bypass the per-turn dedup', () => {
  // Extreme pressure (usage >= 98%) forces the overflow warning through.
  const env = makeEnv(1500)
  const session = buildTextSession(12)
  const lastNudgeTurn = new Map<string, number>()
  const agent = fakeAgent(session)

  const first = buildNudge(agent, env, lastNudgeTurn)
  assert.ok(first !== null)
  const second = buildNudge(agent, env, lastNudgeTurn)
  assert.ok(second !== null, 'emergency nudge bypasses dedup')
  assert.equal(second!.emergency, true)
})

test('M4: range table drops ranges whose refs resolve to stale/out-of-order seqs', () => {
  const nudge = {
    compressibleRanges: [
      { startRef: 'm00001', endRef: 'm00002', count: 2, tokens: 500, toolPct: 0, textPct: 100 },
      // end < start — stale ref mapping after a surface replacement
      { startRef: 'm00003', endRef: 'm00004', count: 2, tokens: 300, toolPct: 0, textPct: 100 },
    ],
  } as never
  const state = {
    messageRefs: {
      byRef: { m00001: '10', m00002: '12', m00003: '65000', m00004: '14000' },
    },
  } as never
  const text = rangeTable(nudge as never, state as never)
  assert.match(text, /seq 10\.\.12/)
  assert.doesNotMatch(text, /65000/)
})
