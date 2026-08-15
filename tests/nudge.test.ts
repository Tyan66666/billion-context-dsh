import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createCore, defaultCountTokens, type CompressionCore, type NudgeDecision } from 'acp-kernel'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { AcpStateStore } from '../src/state.ts'
import { buildNudge, buildNudgeText, rangeTable, resolveTokenCount } from '../src/nudge.ts'
import { makeTools, type ToolEnvironment } from '../src/tools.ts'
import { rebuildBlockLedger } from '../src/region.ts'
import { buildTextSession } from './helpers.ts'

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

test('M4: range table is computed from the surface, skipping the protected tail', () => {
  const session = buildTextSession(12)
  const text = rangeTable(session)
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
  const outcome = buildNudge(fakeAgent(session), env, lastNudgeTurn)
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
  const text = buildNudgeText(decision, false, session)
  assert.match(text, /Tier 2: 1 tier-1 block\(s\) distillable \(4750 tokens\)/)
  const summarySeq = rebuildBlockLedger(session.events)[0]!.summarySeq
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
