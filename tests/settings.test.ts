/**
 * M6 — runtime settings integration tests (0.2.0 seam line).
 *
 * The 0.2.0 settings service is `SettingsForms` (dsh-settings): sections are
 * keyed by profile entry id and only exist for plugins that declare their own
 * `static Config` schema. This engine declares none yet (tracked follow-up),
 * so on this line the engine registers NO section, captures no service handle,
 * and the six knobs keep their COMPOSITION values for the whole process life;
 * `/acp-prune config` degrades to advice. These tests lock that contract:
 *  - pure units: filterSettingsEntry whitelist, engine-default mirror,
 *    schema default parity, schema boundaries (integer / inclusive pct),
 *    parseSettingValue (incl. the `false` regression), describeSettingsChange
 *    diff flags, command-surface degradation without a service;
 *  - 0.2.0 line: exactly one warn naming the missing `static Config`, knobs
 *    stay at composition values, the surface reports unavailable, the
 *    settingsEnabled kill switch silences the warn, and composition-level
 *    values (preset fills, autoModelContextLimit gating) still reach every
 *    kernel consumer through readSettingsSource().
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service, type Message } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session } from '@deepseek-ai/dsh-session'
import {
  ACP_SETTINGS_NAMESPACE,
  AcpSettingsSchema,
  describeSettingsChange,
  filterSettingsEntry,
  makeSettingsCommandSurface,
  parseSettingValue,
  resolveAcpSettings,
  SETTING_DEFAULTS,
} from '../src/settings.ts'
import { AcpCompactionEngine, resolveAcpConfig, type AcpConfig } from '../src/index.ts'
import { kernelConfigFor } from '../src/config.ts'
import { acpCommand } from '../src/commands.ts'
import type { ToolEnvironment } from '../src/tools.ts'
import { DEFAULT_CONTEXT_WINDOW } from '../src/window.ts'

/**
 * Stand-in for the 0.2.0 dsh-settings service (SettingsForms): sections key
 * off profile entry ids, there is no consumer-side installSection, and
 * `describe()` lists only entries carrying a `static Config` schema — which
 * ours does not, so our namespace never appears. Registered under the same
 * `settings` name so the engine coexists with it exactly like on a real 0.2.x
 * host. Rule 5: the fixture mirrors the real host surface a user would see.
 */
class FormsLikeSettingsService extends Service {
  static provide = 'settings'
  readonly writable = false
  configure(_presentation?: unknown): () => void {
    return () => {}
  }
  describe(): unknown[] {
    return []
  }
  async update(_ns: string, _patch: Record<string, unknown>): Promise<void> {}
  async replace(_ns: string, _section: Record<string, unknown>): Promise<void> {}
  async mutate(_ns: string, _ops: readonly unknown[]): Promise<void> {}
}

/**
 * Mount the real engine as a composition-row-like plugin on a fresh fork of
 * `root`. `prepare` runs BEFORE construction — used to register log exporters
 * that must exist before the engine's constructor may emit.
 */
async function mountEngine(root: Context, config: Partial = {}, prepare?: (ctx: Context) => void): Promise<{ fiber: { dispose: () => Promise<void> }; engine: AcpCompactionEngine }> {
  let engine: AcpCompactionEngine | undefined
  const fiber = root.plugin((ctx) => {
    prepare?.(ctx)
    engine = new AcpCompactionEngine(ctx, config)
  })
  await fiber
  if (engine === undefined) throw new Error('engine did not mount')
  return { fiber, engine }
}

/** Drive /acp-prune through the real command handler (config paths never touch the agent). */
async function runAcp(env: ToolEnvironment, rawInput: string): Promise<string> {
  const command = acpCommand(env)
  const result = await command.handler({
    commandId: 'cmd-settings-test' as never,
    agent: {} as Agent,
    rawInput,
    signal: new AbortController().signal,
  } as never)
  assert.equal(result.kind, 'success')
  return (result as { text: string }).text
}

// ── Pure units ────────────────────────────────────────────────────────────

test('M6: filterSettingsEntry keeps only the six settings keys', () => {
  const entry = {
    modelContextLimit: 200000,
    autoModelContextLimit: false,
    nudgeMinContextLimitPct: 0.5,
    nudgeMaxContextLimitPct: 0.72,
    nudgeEmergencyThresholdPct: 0.9,
    autoNudge: false,
    autoTools: false,
    autoCommand: false,
    settingsEnabled: false,
    prompts: { nudge: { text: 'x' } },
    coreOverrides: { nudge: { maxContextLimitPct: 0.8 } },
    countTokens: (text: string) => text.length,
  }
  assert.deepEqual(filterSettingsEntry(entry), {
    modelContextLimit: 200000,
    autoModelContextLimit: false,
    nudgeMinContextLimitPct: 0.5,
    nudgeMaxContextLimitPct: 0.72,
    nudgeEmergencyThresholdPct: 0.9,
    autoNudge: false,
  })
})

test('M6: engine defaults mirror SETTING_DEFAULTS (untouched settings reproduce today behavior)', () => {
  const defaults = resolveAcpConfig({})
  assert.equal(defaults.autoModelContextLimit, SETTING_DEFAULTS.autoModelContextLimit)
  assert.equal(defaults.autoNudge, SETTING_DEFAULTS.autoNudge)
  assert.equal(defaults.nudgeMaxContextLimitPct, SETTING_DEFAULTS.nudgeMaxContextLimitPct)
  assert.equal(defaults.nudgeEmergencyThresholdPct, SETTING_DEFAULTS.nudgeEmergencyThresholdPct)
  assert.equal(defaults.modelContextLimit, undefined)
  assert.equal(defaults.nudgeMinContextLimitPct, undefined)
})

test('M6: schema defaults equal engine defaults at runtime', () => {
  // The schema output object OMITS keys whose value stays undefined (it has
  // no own property for them), so compare per key instead of whole objects.
  const viaSchema = AcpSettingsSchema({})
  const viaEngine = resolveAcpSettings({})
  for (const key of ['modelContextLimit', 'autoModelContextLimit', 'nudgeMinContextLimitPct', 'nudgeMaxContextLimitPct', 'nudgeEmergencyThresholdPct', 'autoNudge'] as const) {
    assert.equal(viaSchema[key], viaEngine[key], `key ${key} resolves identically`)
  }
})

test('M6: schema enforces an integer, at-least-1 context limit', () => {
  assert.equal(AcpSettingsSchema({ modelContextLimit: 1 }).modelContextLimit, 1)
  assert.equal(AcpSettingsSchema({ modelContextLimit: 200000 }).modelContextLimit, 200000)
  assert.throws(() => AcpSettingsSchema({ modelContextLimit: 0 }), />= 1/)
  assert.throws(() => AcpSettingsSchema({ modelContextLimit: 128000.5 }), /multiple of 1/)
})

test('M6: schema pct bounds are inclusive (0 and 1 accepted, outside rejected)', () => {
  assert.equal(AcpSettingsSchema({ nudgeMaxContextLimitPct: 0, nudgeEmergencyThresholdPct: 0 }).nudgeMaxContextLimitPct, 0)
  assert.equal(AcpSettingsSchema({ nudgeMaxContextLimitPct: 1, nudgeEmergencyThresholdPct: 1 }).nudgeEmergencyThresholdPct, 1)
  assert.throws(() => AcpSettingsSchema({ nudgeMaxContextLimitPct: -0.1 }), />= 0/)
  assert.throws(() => AcpSettingsSchema({ nudgeEmergencyThresholdPct: 1.1 }), /<= 1/)
})

test('M6: parseSettingValue — booleans, numbers, null; `false` is a value, not an error', () => {
  assert.deepEqual(parseSettingValue('true'), { ok: true, value: true })
  assert.deepEqual(parseSettingValue('false'), { ok: true, value: false })
  assert.deepEqual(parseSettingValue('.7'), { ok: true, value: 0.7 })
  assert.deepEqual(parseSettingValue('2e5'), { ok: true, value: 200000 })
  assert.deepEqual(parseSettingValue('200000'), { ok: true, value: 200000 })
  assert.deepEqual(parseSettingValue('null'), { ok: true, value: null })
  assert.equal(parseSettingValue('garbage').ok, false)
  assert.equal(parseSettingValue('1.5.2').ok, false)
  assert.equal(parseSettingValue('   ').ok, false)
  assert.equal(parseSettingValue('FALSE').ok, false)
})

test('M6: describeSettingsChange flags window cache, nudge dedup, and order warnings', () => {
  const base = resolveAcpSettings({})
  // No-op diff stays quiet.
  let effect = describeSettingsChange(base, base)
  assert.equal(effect.clearWindowCache, false)
  assert.equal(effect.clearNudgeDedup, false)
  assert.deepEqual(effect.warnings, [])
  // Window-related keys changed → drop the (failure-caching) window cache.
  assert.equal(describeSettingsChange(base, { ...base, modelContextLimit: 300000 }).clearWindowCache, true)
  assert.equal(describeSettingsChange(base, { ...base, autoModelContextLimit: false }).clearWindowCache, true)
  // Re-enabling nudges clears the dedup map; disabling does not.
  const off = { ...base, autoNudge: false }
  assert.equal(describeSettingsChange(off, base).clearNudgeDedup, true)
  assert.equal(describeSettingsChange(base, off).clearNudgeDedup, false)
  // Order anomalies warn (accept, never reject).
  effect = describeSettingsChange(base, { ...base, nudgeMinContextLimitPct: 0.8, nudgeMaxContextLimitPct: 0.7 })
  assert.equal(effect.warnings.length, 1)
  assert.match(effect.warnings[0]!, /lower bound never engages/)
  effect = describeSettingsChange(base, { ...base, nudgeMaxContextLimitPct: 0.9 })
  assert.equal(effect.warnings.length, 1)
  assert.match(effect.warnings[0]!, /emergency tier loses its headroom/)
})

test('M6: command surface degrades without a service', async () => {
  const surface = makeSettingsCommandSurface(() => undefined, () => resolveAcpSettings({}))
  assert.equal(surface.available, false)
  assert.equal(surface.describe(), undefined)
  assert.deepEqual(surface.snapshot(), resolveAcpSettings({}))
  await assert.rejects(surface.update({ autoNudge: false }), /not available/)
  await assert.rejects(surface.replaceSection({}), /not available/)
})

// ── 0.2.0 seam line: degrade-only settings contract ───────────────────────

test('M6: 0.2.0 host — exactly one warn, knobs keep composition values, surface unavailable', async () => {
  const root = new Context()
  await root.plugin(FormsLikeSettingsService)
  // Cordis drops warn-level messages at its default threshold, so capture them
  // through an explicit-level exporter registered before construction.
  const logs: Message[] = []
  const { fiber, engine } = await mountEngine(root, { nudgeMaxContextLimitPct: 0.66 }, (ctx) => {
    ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push(message) } })
  })
  try {
    const warns = logs.filter((m) => m.type === 'warn' && String(m.args[0]).includes('SettingsForms'))
    assert.equal(warns.length, 1, 'exactly one warn naming SettingsForms')
    // The composition value stays for the whole process life — nothing is
    // captured from the (unusable) settings service.
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.66)
    assert.equal(engine.env.nudgeMinContextLimitPct, SETTING_DEFAULTS.nudgeMinContextLimitPct)
    assert.equal(engine.env.modelContextLimit, DEFAULT_CONTEXT_WINDOW)
    assert.equal(engine.env.settingsCommand.available, false)
    assert.equal(engine.env.settingsCommand.describe(), undefined)
  } finally {
    await fiber.dispose()
  }
})

test('M6: settingsEnabled false is a kill switch — not even the warn fires', async () => {
  const root = new Context()
  const logs: Message[] = []
  const { fiber } = await mountEngine(root, { settingsEnabled: false }, (ctx) => {
    ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push(message) } })
  })
  try {
    assert.equal(logs.filter((m) => m.type === 'warn').length, 0)
  } finally {
    await fiber.dispose()
  }
})

test('M6: /acp-prune config degrades cleanly — list stays read-only, writes advise', async () => {
  const root = new Context()
  const { fiber, engine } = await mountEngine(root, { nudgeMaxContextLimitPct: 0.66 })
  try {
    // `list` never needs the service: it renders the effective values from
    // the read snapshot, so it keeps working (all keys attribute to
    // `default` — no descriptor exists without a registered section).
    const list = await runAcp(engine.env, 'config')
    assert.match(list, /nudgeMaxContextLimitPct\s+0\.66/)
    // Write paths cannot reach a service on this line: they advise instead of failing.
    const setResult = await runAcp(engine.env, 'config set nudgeMaxContextLimitPct 0.6')
    assert.match(setResult, /no settings provider/)
    const resetResult = await runAcp(engine.env, 'config reset nudgeMaxContextLimitPct')
    assert.match(resetResult, /no settings provider/)
    // The advice paths must not have touched the knob.
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.66)
  } finally {
    await fiber.dispose()
  }
})

test('M6: a COMPOSITION autoModelContextLimit false gates the window projection', async () => {
  // On this line the gate reads readSettingsSource(), which IS the composition
  // snapshot — so a composed `false` still disables auto detection the way a
  // settings-layer edit did on the 0.1.5 line.
  const root = new Context()
  const { fiber, engine } = await mountEngine(root, { autoModelContextLimit: false })
  try {
    const ctx = new Context()
    ctx.provide('sessionProjections', {
      snapshot: () => ({ values: { contextPressure: { contextWindow: 1000000 } } }),
    })
    ctx.provide('llm', {
      resolveModelInfo: async () => ({ context: { contextWindow: 64000 } }),
    })
    const agent = {
      id: 'test-session',
      session: Session.create('test-session'),
      options: { provider: 'test-provider', model: 'test-model' },
      ctx,
    } as unknown as Agent
    assert.notEqual((await engine.windowFor(agent)).source, 'projection')
  } finally {
    await fiber.dispose()
  }
})

test('M6: without the flag the window projection still wins (positive control)', async () => {
  const root = new Context()
  const { fiber, engine } = await mountEngine(root)
  try {
    const ctx = new Context()
    ctx.provide('sessionProjections', {
      snapshot: () => ({ values: { contextPressure: { contextWindow: 1000000 } } }),
    })
    ctx.provide('llm', {
      resolveModelInfo: async () => ({ context: { contextWindow: 64000 } }),
    })
    const agent = {
      id: 'test-session',
      session: Session.create('test-session'),
      options: { provider: 'test-provider', model: 'test-model' },
      ctx,
    } as unknown as Agent
    assert.equal((await engine.windowFor(agent)).source, 'projection')
  } finally {
    await fiber.dispose()
  }
})

test('M6: a composed preset fills absent thresholds for every reader (issue #176)', async () => {
  // Every kernel consumer reads the six knobs through readSettingsSource(),
  // never through the preset-resolved this.config — so the preset fill must
  // be part of the read snapshot itself, or the schema defaults (0.70/0.85)
  // silently beat every preset.
  const root = new Context()
  const { fiber, engine } = await mountEngine(root, { preset: 'aggressive' })
  try {
    assert.equal(engine.env.nudgeMinContextLimitPct, 0.3)
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.5)
    assert.equal(engine.env.nudgeEmergencyThresholdPct, 0.7)
    assert.equal(kernelConfigFor(engine.env).nudge.maxContextLimitPct, 0.5)
  } finally {
    await fiber.dispose()
  }
})

test('M6: an explicit composition value beats the composed preset', async () => {
  const root = new Context()
  const { fiber, engine } = await mountEngine(root, { preset: 'aggressive', nudgeMaxContextLimitPct: 0.55 })
  try {
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.55)
    // The other two threshold keys stay at their preset values.
    assert.equal(engine.env.nudgeMinContextLimitPct, 0.3)
    assert.equal(engine.env.nudgeEmergencyThresholdPct, 0.7)
  } finally {
    await fiber.dispose()
  }
})
