/**
 * M6 — runtime settings integration tests (phase 1, issue #75).
 *
 * Coverage map (design doc §6):
 *  - pure units: filterSettingsEntry whitelist, engine-default mirror,
 *    schema default parity, schema boundaries (integer / inclusive pct),
 *    parseSettingValue (incl. the `false` regression), describeSettingsChange
 *    diff flags, command-surface degradation without a service;
 *  - E2E: a REAL engine on a bare cordis Context with an in-memory settings
 *    provider — external edits hot-apply to the live env, /acp config
 *    list/set/reset round-trips, the kill switch ignores the provider;
 *  - V1 gate: dispose-then-remount the same namespace (HMR-style reload)
 *    must not hit "settings namespace is already registered".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { Agent } from '@deepseek-ai/dsh-agent'
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
import { acpCommand } from '../src/commands.ts'
import type { ToolEnvironment } from '../src/tools.ts'
import { DEFAULT_CONTEXT_WINDOW } from '../src/window.ts'

/** In-memory settings provider: load/persist over a plain map; tests push external edits through publishForTest. */
class MemorySettingsProvider extends SettingsProvider {
  static provide = 'settings'
  readonly writable = true
  private stored: Record<string, unknown> = {}

  protected override async load(): Promise<Record<string, unknown>> {
    return this.stored
  }

  protected override async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.stored[String(ns)] = section
  }

  /** Simulate an external edit (someone editing settings.yaml on disk). */
  publishForTest(doc: Record<string, unknown>): void {
    this.publish(doc)
  }
}

/** Let the async watcher chain (commit → watch → onChange) settle. */
async function flushRounds(rounds = 3): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** Mount the real engine as a composition-row-like plugin on a fresh fork of `root`. */
async function mountEngine(root: Context, config: Partial<AcpConfig> = {}): Promise<{ fiber: { dispose: () => Promise<void> }; engine: AcpCompactionEngine }> {
  let engine: AcpCompactionEngine | undefined
  const fiber = root.plugin((ctx) => {
    engine = new AcpCompactionEngine(ctx, config)
  })
  await fiber
  if (engine === undefined) throw new Error('engine did not mount')
  return { fiber, engine }
}

/** Drive /acp through the real command handler (config paths never touch the agent). */
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
  await assert.rejects(surface.update({ autoNudge: false }), /not available/)
})

// ── E2E with a real engine + in-memory provider ───────────────────────────

test('M6: engine env reads LIVE settings — an external edit hot-applies', async () => {
  const root = new Context()
  await root.plugin(MemorySettingsProvider)
  const { fiber, engine } = await mountEngine(root)
  try {
    assert.equal(engine.env.modelContextLimit, DEFAULT_CONTEXT_WINDOW)
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.7)
    const provider = root.get('settings') as MemorySettingsProvider
    provider.publishForTest({ [ACP_SETTINGS_NAMESPACE]: { nudgeMaxContextLimitPct: 0.6 } })
    await flushRounds()
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.6)
  } finally {
    await fiber.dispose()
  }
})

test('M6: /acp config list/set/reset round-trips through a real provider', async () => {
  const root = new Context()
  await root.plugin(MemorySettingsProvider)
  const { fiber, engine } = await mountEngine(root)
  try {
    const list = await runAcp(engine.env, 'config')
    assert.match(list, /nudgeMaxContextLimitPct/)
    assert.match(list, /source/)

    const setResult = await runAcp(engine.env, 'config set nudgeMaxContextLimitPct 0.6')
    assert.match(setResult, /✓/)
    await flushRounds()
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.6)

    // A boolean key accepts `false` (the parse regression).
    const boolResult = await runAcp(engine.env, 'config set autoNudge false')
    assert.match(boolResult, /✓/)
    await flushRounds()
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.6)

    const resetResult = await runAcp(engine.env, 'config reset nudgeMaxContextLimitPct')
    assert.match(resetResult, /✓/)
    await flushRounds()
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.7)

    const unknown = await runAcp(engine.env, 'config set bogus 0.5')
    assert.match(unknown, /unknown key/)
    const invalid = await runAcp(engine.env, 'config set nudgeMaxContextLimitPct bogus')
    assert.match(invalid, /not a valid value/)
    const outOfRange = await runAcp(engine.env, 'config set nudgeMaxContextLimitPct 1.5')
    assert.match(outOfRange, /rejected/)
  } finally {
    await fiber.dispose()
  }
})

test('M6: settingsEnabled false is a kill switch — composition values stay, provider ignored', async () => {
  const root = new Context()
  await root.plugin(MemorySettingsProvider)
  const { fiber, engine } = await mountEngine(root, { settingsEnabled: false, nudgeMaxContextLimitPct: 0.66 })
  try {
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.66)
    assert.equal(engine.env.settingsCommand?.available, false)
    const provider = root.get('settings') as MemorySettingsProvider
    provider.publishForTest({ [ACP_SETTINGS_NAMESPACE]: { nudgeMaxContextLimitPct: 0.4 } })
    await flushRounds()
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.66)
  } finally {
    await fiber.dispose()
  }
})

test('M6: HMR-style remount of the same namespace does not hit duplicate registration (V1 gate)', async () => {
  const root = new Context()
  await root.plugin(MemorySettingsProvider)
  const first = await mountEngine(root)
  assert.equal(first.engine.env.nudgeMaxContextLimitPct, 0.7)
  await first.fiber.dispose()
  // The registration rode the disposed fiber; a fresh engine on the same
  // root must register the SAME namespace cleanly (the R3/HMR scenario).
  const second = await mountEngine(root)
  try {
    assert.equal(second.engine.env.nudgeMaxContextLimitPct, 0.7)
  } finally {
    await second.fiber.dispose()
  }
})
