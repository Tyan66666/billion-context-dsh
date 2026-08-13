import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createCore, defaultConfig, type CompressionCore } from 'acp-kernel'
import { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { kernelConfigFor, type KernelConfigInput } from '../src/config.ts'
import { buildNudge } from '../src/nudge.ts'
import { AcpStateStore } from '../src/state.ts'
import { buildTextSession, appendTurn, appendUser } from './helpers.ts'

test('config: defaults equal the kernel (and billion-context-pi) defaults', () => {
  const input: KernelConfigInput = { modelContextLimit: 128000 }
  const config = kernelConfigFor(input)
  const kernel = defaultConfig(128000)
  assert.equal(config.nudge.minContextLimitPct, kernel.nudge.minContextLimitPct)
  assert.equal(config.nudge.maxContextLimitPct, kernel.nudge.maxContextLimitPct)
  assert.equal(config.nudge.emergencyThresholdPct, kernel.nudge.emergencyThresholdPct)
  assert.equal(config.nudge.growthRatio, kernel.nudge.growthRatio)
  // These are the values billion-context-pi ships (kernel defaults, unmodified).
  assert.equal(config.nudge.minContextLimitPct, 0.45)
  assert.equal(config.nudge.maxContextLimitPct, 0.75)
  assert.equal(config.nudge.emergencyThresholdPct, 0.95)
})

test('config: explicit nudge thresholds override without dropping other defaults', () => {
  const config = kernelConfigFor({
    modelContextLimit: 128000,
    nudgeMinContextLimitPct: 0.2,
    nudgeEmergencyThresholdPct: 0.6,
  })
  assert.equal(config.nudge.minContextLimitPct, 0.2)
  assert.equal(config.nudge.emergencyThresholdPct, 0.6)
  // Unspecified knobs keep their kernel defaults (merged, not replaced).
  assert.equal(config.nudge.maxContextLimitPct, 0.75)
  assert.equal(config.nudge.growthRatio, 0.05)
  assert.equal(config.nudge.frequency, 5)
})

test('config: coreOverrides pass through (billion-context-pi escape hatch)', () => {
  const config = kernelConfigFor({
    modelContextLimit: 128000,
    coreOverrides: { preserveRecentMessages: 3 },
  })
  assert.equal(config.preserveRecentMessages, 3)
})

function fakeAgent(session: import('@deepseek-ai/dsh-session').Session): Agent {
  return {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: new Context(),
  } as unknown as Agent
}

function envOf(extra: Partial<KernelConfigInput>) {
  return {
    kernel: createCore({}) as CompressionCore,
    store: new AcpStateStore(),
    modelContextLimit: 128000,
    ...extra,
  }
}

/** 12 large messages ≈ 60K estimated tokens, compressible content well over the kernel threshold. */
function bigSession(): Session {
  const session = Session.create('big-session')
  appendTurn(session, 1)
  const text = 'JWT access tokens with fifteen minute expiry and refresh tokens stored in Redis with thirty day TTL. '.repeat(600)
  for (let index = 0; index < 12; index += 1) {
    appendUser(session, `${text} [msg ${index}]`)
  }
  return session
}

test('config: a lowered over-limit threshold triggers the nudge', () => {
  // bigSession ≈ 182K estimated tokens against a 300K limit ≈ 61% usage:
  // below the default 75% over-limit line — the ordinary path is growth-gated
  // (fresh state, growth 0 < floor), so nothing fires by default. Lowering
  // the over-limit threshold to 50% forces the nudge regardless of growth.
  const session = bigSession()
  const lastNudgeTurn = new Map<string, number>()
  const agent = fakeAgent(session)

  const withDefaults = buildNudge(agent, envOf({ modelContextLimit: 300000 }), lastNudgeTurn)
  assert.equal(withDefaults, null, '61% usage is growth-gated below the default 75% line')

  const withLowMax = buildNudge(
    agent,
    envOf({ modelContextLimit: 300000, nudgeMaxContextLimitPct: 0.5 }),
    lastNudgeTurn,
  )
  assert.ok(withLowMax !== null, 'lowering the over-limit threshold to 50% forces the nudge')
  assert.equal(withLowMax!.emergency, false)
})
