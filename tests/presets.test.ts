import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createCore, defaultConfig, type CompressionCore } from 'acp-kernel'
import { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { kernelConfigFor } from '../src/config.ts'
import { buildNudge } from '../src/nudge.ts'
import { AcpStateStore } from '../src/state.ts'
import { resolveAcpConfig } from '../src/index.ts'
import { PRESETS, PRESET_NAMES, isPresetName, resolvePreset, type PresetName } from '../src/presets.ts'
import { appendTurn, appendUser } from './helpers.ts'

// --- Table integrity -------------------------------------------------------

test('presets: every tier obeys the kernel invariant min <= max <= emergency, within (0,1)', () => {
  for (const name of PRESET_NAMES) {
    const p = PRESETS[name]
    assert.ok(p.nudgeMinContextLimitPct > 0 && p.nudgeMinContextLimitPct < 1, `${name}: min in (0,1)`)
    assert.ok(p.nudgeMaxContextLimitPct > 0 && p.nudgeMaxContextLimitPct < 1, `${name}: max in (0,1)`)
    assert.ok(p.nudgeEmergencyThresholdPct > 0 && p.nudgeEmergencyThresholdPct < 1, `${name}: emergency in (0,1)`)
    // acp-kernel validateConfig rejects the reverse; a preset must never ship an invalid row.
    assert.ok(p.nudgeMinContextLimitPct <= p.nudgeMaxContextLimitPct, `${name}: min <= max`)
    assert.ok(p.nudgeMaxContextLimitPct <= p.nudgeEmergencyThresholdPct, `${name}: max <= emergency`)
  }
})

test('presets: tiers form a monotonic spectrum (each step toward "aggressive" lowers all three)', () => {
  // PRESET_NAMES is ordered least -> most aggressive, so each value must be
  // strictly lower than the previous tier's.
  for (let i = 1; i < PRESET_NAMES.length; i += 1) {
    const earlier = PRESETS[PRESET_NAMES[i - 1]!]
    const later = PRESETS[PRESET_NAMES[i]!]
    assert.ok(later.nudgeMinContextLimitPct < earlier.nudgeMinContextLimitPct, `min drops ${PRESET_NAMES[i - 1]} -> ${PRESET_NAMES[i]}`)
    assert.ok(later.nudgeMaxContextLimitPct < earlier.nudgeMaxContextLimitPct, `max drops ${PRESET_NAMES[i - 1]} -> ${PRESET_NAMES[i]}`)
    assert.ok(later.nudgeEmergencyThresholdPct < earlier.nudgeEmergencyThresholdPct, `emergency drops ${PRESET_NAMES[i - 1]} -> ${PRESET_NAMES[i]}`)
  }
})

test('presets: PRESET_NAMES covers exactly the five PRESETS keys, in documented order', () => {
  const keys = Object.keys(PRESETS)
  assert.deepEqual([...PRESET_NAMES], ['preserve', 'relaxed', 'balanced', 'efficient', 'aggressive'])
  assert.deepEqual(keys.sort(), [...PRESET_NAMES].sort())
})

test('presets: balanced reproduces the current out-of-the-box engine defaults exactly', () => {
  // Choosing "balanced" must be a no-op relative to today's defaults: kernel
  // min 0.45, engine max 0.70, engine emergency 0.85.
  assert.equal(PRESETS.balanced.nudgeMinContextLimitPct, 0.45)
  assert.equal(PRESETS.balanced.nudgeMaxContextLimitPct, 0.7)
  assert.equal(PRESETS.balanced.nudgeEmergencyThresholdPct, 0.85)
  const defaults = resolveAcpConfig({})
  assert.equal(defaults.nudgeMaxContextLimitPct, 0.7)
  assert.equal(defaults.nudgeEmergencyThresholdPct, 0.85)
  assert.equal(defaults.nudgeMinContextLimitPct, undefined) // kernel 0.45 applies downstream
})

// --- Name guard + resolver -------------------------------------------------

test('presets: isPresetName accepts the five names and rejects everything else', () => {
  for (const name of PRESET_NAMES) assert.equal(isPresetName(name), true, `accepts ${name}`)
  assert.equal(isPresetName(''), false)
  assert.equal(isPresetName('Turbo'), false) // case-sensitive
  assert.equal(isPresetName('balanced '), false) // trailing space
  assert.equal(isPresetName('Balanced'), false)
  assert.equal(isPresetName(42), false)
  assert.equal(isPresetName(null), false)
  assert.equal(isPresetName(undefined), false)
  assert.equal(isPresetName({}), false)
  assert.equal(isPresetName(true), false)
})

test('presets: resolvePreset returns the matching tier and throws on unknown names', () => {
  for (const name of PRESET_NAMES) {
    assert.deepEqual(resolvePreset(name), PRESETS[name])
  }
  // Unknown names throw, and the message lists the valid set so a user can
  // self-correct from the error alone. `.*` bridges the separator between the
  // quoted name and the valid list; validating via the regex keeps this off
  // `assert.throws`'s (runtime-dependent) return value.
  assert.throws(
    () => resolvePreset('turbo'),
    /unknown preset "turbo".*valid presets: preserve, relaxed, balanced, efficient, aggressive/,
  )
})

// --- resolveAcpConfig: preset application + precedence ---------------------

test('config: a preset fills all three nudge thresholds when none are set explicitly', () => {
  const resolved = resolveAcpConfig({ preset: 'aggressive' })
  const p = PRESETS.aggressive
  assert.equal(resolved.nudgeMinContextLimitPct, p.nudgeMinContextLimitPct)
  assert.equal(resolved.nudgeMaxContextLimitPct, p.nudgeMaxContextLimitPct)
  assert.equal(resolved.nudgeEmergencyThresholdPct, p.nudgeEmergencyThresholdPct)
  // Non-threshold knobs are untouched by a preset.
  assert.equal(resolved.autoNudge, true)
  assert.equal(resolved.autoTools, true)
})

test('config: explicit threshold wins over the preset (precedence explicit > preset > default)', () => {
  const resolved = resolveAcpConfig({ preset: 'aggressive', nudgeMaxContextLimitPct: 0.9 })
  assert.equal(resolved.nudgeMaxContextLimitPct, 0.9, 'explicit max overrides the preset')
  // The other two still come from the preset.
  assert.equal(resolved.nudgeMinContextLimitPct, PRESETS.aggressive.nudgeMinContextLimitPct)
  assert.equal(resolved.nudgeEmergencyThresholdPct, PRESETS.aggressive.nudgeEmergencyThresholdPct)
})

test('config: a partial override on top of a preset keeps the rest of the preset', () => {
  const resolved = resolveAcpConfig({ preset: 'efficient', nudgeEmergencyThresholdPct: 0.95 })
  assert.equal(resolved.nudgeEmergencyThresholdPct, 0.95)
  assert.equal(resolved.nudgeMinContextLimitPct, PRESETS.efficient.nudgeMinContextLimitPct)
  assert.equal(resolved.nudgeMaxContextLimitPct, PRESETS.efficient.nudgeMaxContextLimitPct)
})

test('config: unknown preset name fails resolution loudly (fail-fast, no silent default fallback)', () => {
  assert.throws(
    () => resolveAcpConfig({ preset: 'maximum' as PresetName }),
    /unknown preset "maximum" — valid presets: preserve, relaxed, balanced, efficient, aggressive/,
  )
})

test('config: omitting the preset leaves today\'s behavior byte-for-byte intact', () => {
  const plain = resolveAcpConfig({})
  assert.equal(plain.preset, undefined)
  assert.equal(plain.nudgeMaxContextLimitPct, 0.7)
  assert.equal(plain.nudgeEmergencyThresholdPct, 0.85)
  assert.equal(plain.nudgeMinContextLimitPct, undefined)
  // Explicit thresholds with no preset are unaffected by the preset machinery.
  const explicit = resolveAcpConfig({ nudgeMaxContextLimitPct: 0.55, nudgeEmergencyThresholdPct: 0.8 })
  assert.equal(explicit.nudgeMaxContextLimitPct, 0.55)
  assert.equal(explicit.nudgeEmergencyThresholdPct, 0.8)
  assert.equal(explicit.preset, undefined)
})

// --- Chain: preset reaches the kernel config --------------------------------

test('config: the preset-resolved thresholds reach kernelConfigFor unchanged', () => {
  const resolved = resolveAcpConfig({ preset: 'efficient', modelContextLimit: 128000 })
  const kernelConfig = kernelConfigFor({
    modelContextLimit: 128000,
    nudgeMinContextLimitPct: resolved.nudgeMinContextLimitPct,
    nudgeMaxContextLimitPct: resolved.nudgeMaxContextLimitPct,
    nudgeEmergencyThresholdPct: resolved.nudgeEmergencyThresholdPct,
  })
  assert.equal(kernelConfig.nudge.minContextLimitPct, PRESETS.efficient.nudgeMinContextLimitPct)
  assert.equal(kernelConfig.nudge.maxContextLimitPct, PRESETS.efficient.nudgeMaxContextLimitPct)
  assert.equal(kernelConfig.nudge.emergencyThresholdPct, PRESETS.efficient.nudgeEmergencyThresholdPct)
  // Unrelated kernel knobs keep their defaults (a preset touches only the three pcts).
  assert.equal(kernelConfig.nudge.growthRatio, defaultConfig(128000).nudge.growthRatio)
})

// --- End-to-end: the preset actually changes the nudge decision -------------

function fakeAgent(session: Session): Agent {
  return { id: session.id, session, options: { provider: 'test-provider', model: 'test-model' }, ctx: new Context() } as unknown as Agent
}

/** ~61% usage against a 300K window — sits between the balanced (0.70) and efficient (0.60) over-limit lines. */
function midSession(): Session {
  const session = Session.create('mid-session')
  appendTurn(session, 1)
  const text = 'JWT access tokens with fifteen minute expiry and refresh tokens stored in Redis with thirty day TTL. '.repeat(600)
  for (let index = 0; index < 12; index += 1) appendUser(session, `${text} [msg ${index}]`)
  return session
}

function nudgeEnvFor(preset?: PresetName) {
  const resolved = resolveAcpConfig({ ...(preset !== undefined ? { preset } : {}), modelContextLimit: 300000 })
  return {
    kernel: createCore({}) as CompressionCore,
    store: new AcpStateStore(),
    modelContextLimit: 300000,
    nudgeMinContextLimitPct: resolved.nudgeMinContextLimitPct,
    nudgeMaxContextLimitPct: resolved.nudgeMaxContextLimitPct,
    nudgeEmergencyThresholdPct: resolved.nudgeEmergencyThresholdPct,
    preset,
  }
}

test('config: an aggressive-tier preset makes the nudge fire where the default tier stays quiet', () => {
  // At ~61% usage: below the balanced 0.70 line (growth-gated, fresh state ->
  // no nudge) but above the efficient 0.60 line (over-limit -> fires).
  const agent = fakeAgent(midSession())

  const quiet = buildNudge(agent, nudgeEnvFor('balanced'), new Map<string, number>())
  assert.equal(quiet, null, 'balanced (max 0.70) does not fire at ~61% usage')

  const loud = buildNudge(agent, nudgeEnvFor('efficient'), new Map<string, number>())
  assert.ok(loud !== null, 'efficient (max 0.60) fires the over-limit nudge at ~61% usage')
  assert.equal(loud!.emergency, false, '61% is above max but below the emergency line')
})
