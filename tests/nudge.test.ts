import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createCore, defaultCountTokens, type CompressionCore, type NudgeDecision } from 'acp-kernel'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { AcpStateStore } from '../src/state.ts'
import { buildNudge, buildNudgeText, computeSurfaceBreakdown, rangeTable, resolveTokenCount, EMERGENCY_NUDGE_MAX_PER_TURN } from '../src/nudge.ts'
import { makeTools, type ToolEnvironment } from '../src/tools.ts'
import { rebuildBlockLedger, runCompactionTransaction } from '../src/region.ts'
import { allLogMessages, eventsToCoreMessages, surfaceEventsOf } from '../src/messages.ts'
import { Session } from '@deepseek-ai/dsh-session'
import { appendToolCall, appendToolResult, appendTurn, appendUser, buildTextSession, longText, wholeSurfaceRangeView } from './helpers.ts'

function fakeAgent(session: import('@deepseek-ai/dsh-session').Session): Agent {
  return {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: new Context(),
  } as unknown as Agent
}

function fakeExec(session: import('@deepseek-ai/dsh-session').Session): ToolRunContext {
  const agent = fakeAgent(session)
  return {
    callId: 'call-acp',
    name: 'compress',
    arguments: {},
    signal: new AbortController().signal,
    agent,
  } as unknown as ToolRunContext
}

function makeEnv(limit: number): ToolEnvironment {
  return {
    kernel: createCore({}) as CompressionCore,
    store: new AcpStateStore(),
    modelContextLimit: limit,
  }
}

function toolOf(env: ToolEnvironment, name: string) {
  const tool = makeTools(env).find((definition) => definition.name === name)
  assert.ok(tool, `tool ${name} registered`)
  return tool
}

test('M4: buildNudge injects a compressible-range table under pressure', () => {
  // Small window + long history → the kernel recommends compression.
  const env = makeEnv(4000)
  const session = buildTextSession(12)
  const lastNudgeTurn = new Map<string, number>()
  const emergencyNudges = new Map<string, { turn: number; count: number }>()

  const outcome = buildNudge(fakeAgent(session), env, lastNudgeTurn, emergencyNudges)
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
  const emergencyNudges = new Map<string, { turn: number; count: number }>()
  const agent = fakeAgent(session)

  const first = buildNudge(agent, env, lastNudgeTurn, emergencyNudges)
  assert.ok(first !== null, 'first injection happens')
  assert.equal(first!.emergency, false, 'this is a normal-pressure nudge')
  assert.equal(buildNudge(agent, env, lastNudgeTurn, emergencyNudges), null, 'same turn is deduped')
  assert.equal(lastNudgeTurn.get(session.id), 1, 'the turn was recorded')
})

test('M4: no nudge is produced for a comfortable context', () => {
  const env = makeEnv(128000)
  const session = buildTextSession(12)
  const lastNudgeTurn = new Map<string, number>()
  assert.equal(buildNudge(fakeAgent(session), env, lastNudgeTurn, new Map()), null)
})

test('M4: emergency nudges are capped per user turn (issue #108)', () => {
  // Extreme pressure (usage >= 98%) forces the overflow/emergency path on
  // EVERY pre-step (the kernel wants to inject every time). Repeated pre-steps
  // in the same turn must NOT re-inject an emergency nudge forever — that was
  // the runaway feedback loop (each durable nudge's own tokens push usage
  // higher). The per-turn budget bounds it to EMERGENCY_NUDGE_MAX_PER_TURN:
  // the first 3 calls inject, the 4th returns null, and every call after
  // stays null.
  const env = makeEnv(1500)
  const session = buildTextSession(12)
  const lastNudgeTurn = new Map<string, number>()
  const emergencyNudges = new Map<string, { turn: number; count: number }>()
  const agent = fakeAgent(session)
  let capHits = 0

  const outcomes: Array<ReturnType<typeof buildNudge>> = []
  for (let i = 0; i < EMERGENCY_NUDGE_MAX_PER_TURN + 3; i++) {
    outcomes.push(buildNudge(agent, env, lastNudgeTurn, emergencyNudges, () => { capHits += 1 }))
  }
  for (let i = 0; i < EMERGENCY_NUDGE_MAX_PER_TURN; i++) {
    assert.ok(outcomes[i] !== null, `call ${i + 1} injects within the per-turn budget`)
    assert.equal(outcomes[i]!.emergency, true, 'every injected nudge here is emergency')
  }
  assert.equal(outcomes[EMERGENCY_NUDGE_MAX_PER_TURN], null, `call ${EMERGENCY_NUDGE_MAX_PER_TURN + 1} returns null once the per-turn budget is spent`)
  for (let i = EMERGENCY_NUDGE_MAX_PER_TURN + 1; i < outcomes.length; i++) {
    assert.equal(outcomes[i], null, `call ${i + 1} stays suppressed`)
  }
  assert.equal(capHits, 3, 'the cap-hit hook fires for every suppressed call (host logs it)')
})

test('M4: the emergency nudge cap resets on a new user turn (issue #108)', () => {
  // The budget is per USER TURN: once the turn advances, the session gets a
  // fresh EMERGENCY_NUDGE_MAX_PER_TURN budget (same semantics as the normal
  // per-turn dedup).
  const env = makeEnv(1500)
  const session = buildTextSession(12)
  const lastNudgeTurn = new Map<string, number>()
  const emergencyNudges = new Map<string, { turn: number; count: number }>()
  const agent = fakeAgent(session)

  for (let i = 0; i < EMERGENCY_NUDGE_MAX_PER_TURN; i++) {
    assert.ok(buildNudge(agent, env, lastNudgeTurn, emergencyNudges) !== null, `turn 1: call ${i + 1} injects`)
  }
  assert.equal(buildNudge(agent, env, lastNudgeTurn, emergencyNudges), null, 'turn 1: call 4 is capped')

  appendTurn(session, 2)
  const fresh = buildNudge(agent, env, lastNudgeTurn, emergencyNudges)
  assert.ok(fresh !== null, 'turn 2: the cap resets and an emergency nudge lands again')
  assert.equal(fresh.emergency, true, 'turn 2: still an emergency nudge')
})

test('M4: a normal nudge does not consume the emergency budget (issue #108)', () => {
  // Mixed pressure within one user turn: a normal-pressure nudge (above the
  // 70% over-limit line, below the 85% emergency line) fires once and then
  // dedups — but it must NOT eat into the emergency budget. When the same
  // turn's pressure then crosses the emergency line, the full
  // EMERGENCY_NUDGE_MAX_PER_TURN emergency injections are still available.
  // 12 longText messages = 12,391 tokens; limit 16000 → 77.4% (normal);
  // +3 user messages = 15,490 → 96.8% (emergency).
  const env = makeEnv(16000)
  const session = buildTextSession(12)
  const lastNudgeTurn = new Map<string, number>()
  const emergencyNudges = new Map<string, { turn: number; count: number }>()
  const agent = fakeAgent(session)

  const first = buildNudge(agent, env, lastNudgeTurn, emergencyNudges)
  assert.ok(first !== null, 'a normal-pressure nudge lands at 77%')
  assert.equal(first.emergency, false, 'it is a normal nudge, not emergency')
  assert.equal(buildNudge(agent, env, lastNudgeTurn, emergencyNudges), null, 'the normal nudge dedups within the turn')

  appendUser(session, longText('more', 100))
  appendUser(session, longText('more', 101))
  appendUser(session, longText('more', 102))

  for (let i = 0; i < EMERGENCY_NUDGE_MAX_PER_TURN; i++) {
    const outcome = buildNudge(agent, env, lastNudgeTurn, emergencyNudges)
    assert.ok(outcome !== null, `emergency call ${i + 1} lands — the normal nudge did not consume the budget`)
    assert.equal(outcome.emergency, true, 'now it is an emergency nudge')
  }
  assert.equal(buildNudge(agent, env, lastNudgeTurn, emergencyNudges), null, 'call 4 is capped even after the normal nudge')
})

test('M4: range table is computed from the surface, skipping the protected tail', () => {
  const session = buildTextSession(12)
  const text = rangeTable(session, wholeSurfaceRangeView(session))
  assert.match(text, /Compressible ranges/)
  assert.match(text, /Surface: 12 nodes, seqs 1\.\.12/, 'the range table also reports the surface span so edges are locatable')
  // The protected recent tail (last 5 messages) is skipped; older runs appear.
  assert.match(text, /seq \d+\.\.\d+ — \d+ messages/)
  assert.doesNotMatch(text, /65000/)
})

const NUDGE_TIER_SUMMARY = 'Tiered distillation test summary covering the authentication subsystem, the refresh-token lifecycle, the login flow, the rate-limiting strategy, the bcrypt cost factor, the session revocation rules, the deployment pipeline, the kubernetes canary rollout, and the health-check probe configuration with all critical file paths and decisions preserved verbatim for later recovery. '.repeat(50)

test('M4: buildNudge recommends tier-2 distillation when tier-1 blocks accumulate', async () => {
  // ~19K-char summaries ≈ 4.75K tokens each; the surface after two tier-1
  // compressions is [c1, c2, 11, 12] ≈ 14.5K tokens against an 8K window →
  // over-limit/emergency. Plain-message pending (all protected) < minCompressRange
  // (5000), tier-1 summaries pending ≈ 9.5K ≥ 5000 → the kernel picks tier 2.
  const env = makeEnv(8000)
  const session = buildTextSession(12)
  const compress = toolOf(env, 'compress')
  await compress.execute({ content: [{ startSeq: 1, endSeq: 5, summary: NUDGE_TIER_SUMMARY }] } as never, fakeExec(session))
  // seq 10 is inside the protected recent tail: excluded with a warning, but
  // the block still lands (covering 6..9).
  await compress.execute({ content: [{ startSeq: 6, endSeq: 10, summary: NUDGE_TIER_SUMMARY }] } as never, fakeExec(session))

  const lastNudgeTurn = new Map<string, number>()
  const emergencyNudges = new Map<string, { turn: number; count: number }>()
  const outcome = buildNudge(fakeAgent(session), env, lastNudgeTurn, emergencyNudges)
  assert.ok(outcome !== null, 'distillable tier-1 blocks produce a tier-2 nudge')
  const text = outcome!.message.content.map((block) => (block as { text?: string }).text ?? '').join('')
  assert.match(text, /Tier 2:/)
  assert.match(text, /2 tier-1 block\(s\) distillable/)
})

test('M4: buildNudgeText renders the distillable tier-2 line with surface seqs', async () => {
  const env = makeEnv(128000)
  const session = buildTextSession(12)
  const compress = toolOf(env, 'compress')
  await compress.execute({ content: [{ startSeq: 1, endSeq: 5, summary: NUDGE_TIER_SUMMARY }] } as never, fakeExec(session))

  const b1 = env.store.stateFor(session).blocks.find((block) => block.blockId === 'b1')
  assert.ok(b1 !== undefined, 'the tier-1 block exists in the live kernel state')
  const decision: NudgeDecision = {
    shouldInject: true,
    reason: 'tier-2 distillation recommended',
    compressibleRanges: [],
    tierTargetBlocks: [b1!],
    contextUsage: 0.9,
    tier: 2,
    breakdown: {
      usage: 0.9,
      growth: 0,
      growthReference: 0,
      effectiveThreshold: 0,
      nudgeGrowthTokens: 50000,
      growthFloor: 20000,
      hasPendingNudge: 0,
      overLimit: 1,
      emergencyOverride: 0,
      pendingT1: 0,
      pendingT2: 4750,
      pendingT3: 0,
    },
  }
  const text = buildNudgeText(decision, false, session, wholeSurfaceRangeView(session))
  assert.match(text, /Tier 2: 1 tier-1 block\(s\) distillable \(4750 tokens\)/)
  const summarySeq = rebuildBlockLedger(session.snapshotEvents())[0]!.summarySeq
  assert.ok(summarySeq !== undefined, 'the checkpoint seq is derivable from the log')
  assert.match(text, new RegExp(`seqs ${summarySeq}`), 'the line carries the surface seq of the block summary node')
})

test('M4: resolveTokenCount prefers projectedTokens over surfaceTokens over character heuristic', () => {
  const session = buildTextSession(2)
  const coreMessages = [
    { id: '1', role: 'user' as const, contentType: 'text' as const, text: 'hello' },
    { id: '2', role: 'assistant' as const, contentType: 'text' as const, text: 'world' },
  ]

  // 1. Falls back to character heuristic when no services are available.
  const bareAgent = { session, ctx: new Context() } as unknown as Agent
  const heuristic = defaultCountTokens('hello') + defaultCountTokens('world')
  assert.equal(resolveTokenCount(bareAgent, coreMessages), heuristic)

  // 2. Uses surfaceTokens when tokenMeter is available but sessionProjections is not.
  const withMeter = {
    session,
    ctx: {
      get(name: string) {
        if (name === 'tokenMeter') {
          return {
            measure: () => ({ surfaceTokens: 99999 }),
          }
        }
        return undefined
      },
    },
  } as unknown as Agent
  assert.equal(resolveTokenCount(withMeter, coreMessages), 99999)

  // 3. Uses projectedTokens when sessionProjections is available (highest priority).
  const withProjections = {
    session,
    ctx: {
      get(name: string) {
        if (name === 'sessionProjections') {
          return {
            snapshot: () => ({
              values: { contextPressure: { projectedTokens: 123456 } },
            }),
          }
        }
        if (name === 'tokenMeter') {
          return {
            measure: () => ({ surfaceTokens: 99999 }),
          }
        }
        return undefined
      },
    },
  } as unknown as Agent
  assert.equal(resolveTokenCount(withProjections, coreMessages), 123456)

  // 4. Rejects zero or negative from projectedTokens, falls through to surfaceTokens.
  const withZeroProjected = {
    session,
    ctx: {
      get(name: string) {
        if (name === 'sessionProjections') {
          return {
            snapshot: () => ({
              values: { contextPressure: { projectedTokens: 0 } },
            }),
          }
        }
        if (name === 'tokenMeter') {
          return {
            measure: () => ({ surfaceTokens: 77777 }),
          }
        }
        return undefined
      },
    },
  } as unknown as Agent
  assert.equal(resolveTokenCount(withZeroProjected, coreMessages), 77777, 'zero projectedTokens falls through to surfaceTokens')
})

test('M4: nudge contextBreakdown reflects the SURFACE, not the compressed-away history (#85.2K-tool regression)', () => {
  // A session with tool pairs; we compress the FIRST pair via a durable
  // transaction. The kernel computes `contextBreakdown` from the FULL log
  // (allLogMessages), so the raw nudge reports the historical tool total (both
  // pairs — the compressed one included). computeSurfaceBreakdown must report
  // only the LIVE surface tool messages (the surviving pair B), matching what
  // acp_status shows.
  const env: ToolEnvironment = { kernel: createCore({}) as CompressionCore, store: new AcpStateStore(), modelContextLimit: 128000 }
  const session = Session.create('breakdown')
  appendTurn(session, 1)
  appendToolCall(session, 'plan a', 'c1')          // seq 2
  appendToolResult(session, longText('resA', 0), 'c1') // seq 3
  appendToolCall(session, 'plan b', 'c2')          // seq 4
  appendToolResult(session, longText('resB', 1), 'c2') // seq 5
  appendUser(session, longText('question', 2))     // seq 6
  // Durably compress exactly pair A (seqs 2..3) into one block.
  runCompactionTransaction(session, {
    start: 2,
    end: 3,
    shadowedSeqs: [2, 3],
    summary: [{ type: 'text', text: 'summary covering pair A with the auth subsystem decisions preserved verbatim' }],
    shadowedTokenCount: 500,
    provider: 'test-provider',
    model: 'test-model',
    kernelBlockId: 'b1',
    effectiveMessageIds: ['2', '3'],
    directMessageIds: ['2', '3'],
  })
  // First access after the durable transaction → stateFor rehydrates the block
  // from the ledger (state.ts rebuildKernelBlocks); the block stays active.
  const state = env.store.stateFor(session)
  assert.ok(state.blocks.some((b) => b.active), 'transaction rebuilt one active block')

  const surfaceMessages = eventsToCoreMessages(surfaceEventsOf(session), new Map())
  // Full-log perspective: the compressed-away pair A is still in the log, so a
  // full-log breakdown would count BOTH tool pairs.
  const allToolTokens = allLogMessages(session)
    .filter((m) => m.contentType === 'tool-result')
    .reduce((sum, m) => sum + defaultCountTokens(m.text ?? ''), 0)
  const surfaceBreakdown = computeSurfaceBreakdown(state, surfaceMessages, 12345, 100)
  assert.ok(surfaceBreakdown.tool > 0, 'the surviving surface tool pair is counted')
  assert.ok(surfaceBreakdown.tool < allToolTokens, 'surface tool < full-log tool (compressed pair excluded)')
  // summaries reflect the active block, not zero.
  assert.ok(surfaceBreakdown.summaries > 0, 'active block summaries are counted')
})

test('M4: nudge contextBreakdown is wired to the surface (kernel path uses computeSurfaceBreakdown)', () => {
  // computeSurfaceBreakdown is exported and buildNudge re-points the nudge's
  // contextBreakdown to it before rendering; the pure function is verified
  // above. Here we assert the bare bodies (no blocks, no compression) produce a
  // sane total that matches the surface sum — a smoke guard that the override
  // does not corrupt the breakdown shape.
  const env: ToolEnvironment = { kernel: createCore({}) as CompressionCore, store: new AcpStateStore(), modelContextLimit: 128000 }
  const session = buildTextSession(6)
  const state = env.store.stateFor(session)
  const surfaceMessages = eventsToCoreMessages(surfaceEventsOf(session), new Map())
  const bd = computeSurfaceBreakdown(state, surfaceMessages, 9999, 50)
  assert.deepEqual(
    Object.keys(bd).sort(),
    ['code', 'growth', 'summaries', 'system', 'text', 'tool', 'total'],
    'breaks down into tool/text/code/system/summaries/total/growth',
  )
  assert.equal(bd.total, 9999)
  assert.equal(bd.growth, 50)
  // No blocks → summaries is zero; text carries the alternating user/assistant plain text.
  assert.equal(bd.summaries, 0)
  assert.ok(bd.text > 0)
})
