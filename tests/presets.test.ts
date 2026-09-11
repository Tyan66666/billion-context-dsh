import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createCore, defaultConfig, type CompressionCore } from 'acp-kernel'
import { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { kernelConfigFor } from '../src/config.ts'
import { buildNudge } from '../src/nudge.ts'
import { AcpStateStore } from '../src/state.ts'
import { AcpCompactionEngine, resolveAcpConfig } from '../src/index.ts'
import { acpCommand } from '../src/commands.ts'
import { PRESETS, PRESET_NAMES, isPresetName, resolvePreset, type PresetName } from '../src/presets.ts'
import { appendTurn, appendUser } from './helpers.ts'

// --- Table integrity -------------------------------------------------------

test('presets: every tier obeys the kernel invariant min <= max <= emergency, within (0,1)', () => {
  for (const name of PRESET_NAMES) {
    const p = PRESETS[name]
    assert.ok(p.nudgeMinContextLimitPct > 0 && p.nudgeMinContextLimitPct < 1, `${name}: min in (0,1)`)
    assert.ok(p.nudgeMaxContextLimitPct > 0 && p.nudgeMaxContextLimitPct < 1, `${name}: max in (0,1)`)
    assert.ok(p.nudgeEmergencyThresholdPct > 0 && p.nudgeEmergencyThresholdPct < 1, `${name}: emergency in (0,1)`)
    // The kernel only *warns* about a reversed window (`validateConfig` never rejects a
    // config), so a preset must never ship an invalid row AND the engine's own merge
    // must not be able to produce one.
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

test('presets: every tier pins its exact three thresholds (the README table is a contract)', () => {
  // The invariant + monotonic tests above would all survive a silent value tweak
  // (e.g. aggressive.min 0.30 -> 0.35), yet the README documents these numbers as
  // the feature's contract for users tuning a deployment. Pin all fifteen literally.
  assert.deepEqual(
    PRESET_NAMES.map((name) => [name, PRESETS[name].nudgeMinContextLimitPct, PRESETS[name].nudgeMaxContextLimitPct, PRESETS[name].nudgeEmergencyThresholdPct]),
    [
      ['preserve', 0.55, 0.78, 0.93],
      ['relaxed', 0.5, 0.75, 0.9],
      ['balanced', 0.45, 0.7, 0.85],
      ['efficient', 0.4, 0.6, 0.78],
      ['aggressive', 0.3, 0.5, 0.7],
    ],
  )
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
  const resolved = resolveAcpConfig({ preset: 'aggressive', nudgeMaxContextLimitPct: 0.6 })
  assert.equal(resolved.nudgeMaxContextLimitPct, 0.6, 'explicit max overrides the preset')
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

test('config: an unknown preset fails engine CONSTRUCTION, not the first turn', () => {
  // resolveAcpConfig is only one caller; the engine is what a composition row
  // instantiates, so pin the failure at that boundary too (a typo in a
  // `compaction-acp` row takes the whole profile down — intentional fail-fast).
  assert.throws(
    () => new AcpCompactionEngine(new Context(), { preset: 'maximum' as PresetName }),
    /unknown preset "maximum" — valid presets: preserve, relaxed, balanced, efficient, aggressive/,
  )
})

test('config: an explicit override that inverts a preset window fails at construction', () => {
  // The kernel tolerates this: validateConfig only console.warns ("Thresholds may
  // not fire correctly"). Left alone, `preset: 'preserve'` (min 0.55) + max 0.5
  // ships a window whose over-limit line sits under the emergency line, so the
  // emergency path fires first and the tier does not mean what it says.
  assert.throws(
    () => resolveAcpConfig({ preset: 'preserve', nudgeMaxContextLimitPct: 0.5 }),
    /nudge thresholds are inverted \(min 0\.55 \/ max 0\.5 \/ emergency 0\.93\) — nudgeMinContextLimitPct must be <= nudgeMaxContextLimitPct/,
  )
  // The same override at or above min still resolves (a preset is a starting point).
  assert.equal(resolveAcpConfig({ preset: 'preserve', nudgeMaxContextLimitPct: 0.6 }).nudgeMaxContextLimitPct, 0.6)
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

test('config: a same-name key in coreOverrides.nudge outranks the preset (documented last merge)', () => {
  const resolved = resolveAcpConfig({ preset: 'efficient' })
  const fromPreset = kernelConfigFor({
    modelContextLimit: 128000,
    nudgeMaxContextLimitPct: resolved.nudgeMaxContextLimitPct,
  })
  assert.equal(fromPreset.nudge.maxContextLimitPct, PRESETS.efficient.nudgeMaxContextLimitPct, 'the preset decides max by default')

  // A real deployment writes a full nudge object in its composition row; the
  // engine spreads it last, so its keys win over both the kernel default and the
  // preset-resolved pct (README documents this precedence).
  const overridden = kernelConfigFor({
    modelContextLimit: 128000,
    nudgeMaxContextLimitPct: resolved.nudgeMaxContextLimitPct,
    coreOverrides: { nudge: { ...defaultConfig(128000).nudge, maxContextLimitPct: 0.95 } },
  })
  assert.equal(overridden.nudge.maxContextLimitPct, 0.95, 'coreOverrides.nudge lands last')
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

test('config: a lower tier lowers the over-limit line — efficient fires where balanced stays quiet', () => {
  // At ~61% usage: below the balanced max 0.70 line but above the efficient max
  // 0.60 line — that gap is the difference this test isolates.
  //
  // A FRESH nudge state cannot observe the line at all: since kernel 0.0.54 a
  // first-sight mass-ready state (never shown, no baseline) fires immediately
  // whenever usage >= minContextLimitPct, and 61% clears every tier's min
  // (balanced 0.45, efficient 0.40). So each env is warmed with one call whose
  // result is discarded; the over-limit line decides the call after it.
  const balancedEnv = nudgeEnvFor('balanced')
  const balancedAgent = fakeAgent(midSession())
  buildNudge(balancedAgent, balancedEnv, new Map<string, number>(), new Map())
  const quiet = buildNudge(balancedAgent, balancedEnv, new Map<string, number>(), new Map())
  assert.equal(quiet, null, 'balanced (max 0.70) does not fire at ~61% usage')

  const efficientEnv = nudgeEnvFor('efficient')
  const efficientAgent = fakeAgent(midSession())
  buildNudge(efficientAgent, efficientEnv, new Map<string, number>(), new Map())
  const loud = buildNudge(efficientAgent, efficientEnv, new Map<string, number>(), new Map())
  assert.ok(loud !== null, 'efficient (max 0.60) fires the over-limit nudge at ~61% usage')
  assert.equal(loud!.emergency, false, '61% is above max but below the emergency line')
})

// --- Display: /acp status names the tier ------------------------------------

test('config: /acp status names the preset with the thresholds it resolved to', async () => {
  const agent = fakeAgent(midSession())
  const result = await acpCommand(nudgeEnvFor('efficient')).handler({
    commandId: 'cmd-test' as never,
    agent,
    rawInput: 'status',
    signal: new AbortController().signal,
  } as never)

  assert.equal(result.kind, 'success')
  const text = (result as { text: string }).text
  // The panel prints the thresholds actually in force: an explicit override on
  // top of the preset shows through (the whole point of the display line), and
  // with no coreOverrides.nudge the resolved preset values are what lands in
  // kernelConfigFor anyway.
  assert.match(
    text,
    /\n {2}preset: efficient \(trim more often — favors low token usage over keeping full history\) \[min 40% · max 60% · emergency 78%\]/,
  )
})

test('config: /acp status preset line mirrors a same-name key in coreOverrides.nudge', async () => {
  // kernelConfigFor spreads coreOverrides.nudge LAST, so its keys are the ones
  // actually in force — the panel must print those, not the lower preset values.
  // Minimal single-key override (the shape a real composition row uses); the two
  // keys absent from it must still show the preset-resolved values.
  const agent = fakeAgent(midSession())
  const base = nudgeEnvFor('efficient')
  const result = await acpCommand({
    ...base,
    coreOverrides: { nudge: { maxContextLimitPct: 0.95 } },
  }).handler({
    commandId: 'cmd-test' as never,
    agent,
    rawInput: 'status',
    signal: new AbortController().signal,
  } as never)

  assert.equal(result.kind, 'success')
  const text = (result as { text: string }).text
  assert.match(
    text,
    /\n {2}preset: efficient \(trim more often — favors low token usage over keeping full history\) \[min 40% · max 95% · emergency 78%\]/,
  )
})
