/**
 * M6 — runtime settings integration tests (phase 1, issue #75).
 *
 * Coverage map (design doc §6):
 *  - pure units: filterSettingsEntry whitelist, engine-default mirror,
 *    schema default parity, schema boundaries (integer / inclusive pct),
 *    parseSettingValue (incl. the `false` regression), describeSettingsChange
 *    diff flags, command-surface degradation without a service;
 *  - E2E: a REAL engine on a bare cordis Context with an in-memory settings
 *    provider — external edits hot-apply to the live env, /acp-prune config
 *    list/set/reset round-trips, the kill switch ignores the provider;
 *  - regression locks added in review: the filtered `base` entry, the
 *    seam-to-window gate, the kernelConfigFor output, provider detach
 *    fallback, and reset preserving hand-written keys;
 *  - V1 gate: dispose-then-remount the same namespace (HMR-style reload)
 *    must not hit "settings namespace is already registered".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service, type Message } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
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

/**
 * Stand-in for dsh-settings >= 0.1.7 (issue #173): the service was renamed to
 * SettingsForms and `installSection` removed; its section API keys off profile
 * entry ids instead of plugin namespaces. Registered under the same `settings`
 * name so the engine's inject fires exactly like on a real 0.1.7 host. The
 * fixture mirrors the 0.1.7 public surface (configure/describe/update/replace/
 * mutate) and deliberately carries NO installSection — a fixture that grew the
 * method back would make the regression test vacuous (rule 5: fixtures mirror
 * real host structures).
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
  await assert.rejects(surface.update({ autoNudge: false }), /not available/)
})

// ── E2E with a real engine + in-memory provider ───────────────────────────

test('M6: engine env reads LIVE settings — an external edit hot-applies', async () => {
  const root = new Context()
  await root.plugin(MemorySettingsProvider)
  // Cordis drops warn-level messages at its default threshold, so capture them
  // through an explicit-level exporter registered before construction.
  const logs: Message[] = []
  const { fiber, engine } = await mountEngine(root, {}, (ctx) => {
    ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push(message) } })
  })
  try {
    assert.equal(engine.env.modelContextLimit, DEFAULT_CONTEXT_WINDOW)
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.7)
    // The capability probe must stay silent on a supported host (issue #173).
    assert.ok(
      !logs.some((m) => m.type === 'warn' && String(m.args[0]).includes('installSection')),
      'no spurious installSection warn on a supported host',
    )
    const provider = root.get('settings') as MemorySettingsProvider
    provider.publishForTest({ [ACP_SETTINGS_NAMESPACE]: { nudgeMaxContextLimitPct: 0.6 } })
    await flushRounds()
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.6)
  } finally {
    await fiber.dispose()
  }
})

test('M6: /acp-prune config list/set/reset round-trips through a real provider', async () => {
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

// ── Locks for the merge-review findings ───────────────────────────────────

test('M6: installSection registers the FILTERED composition subset as `base`', async () => {
  const root = new Context()
  await root.plugin(MemorySettingsProvider)
  const { fiber, engine } = await mountEngine(root, { nudgeMaxContextLimitPct: 0.66 })
  try {
    const descriptor = engine.env.settingsCommand?.describe()
    assert.ok(descriptor !== undefined, 'the settings surface is available')
    // Registering the RESOLVED snapshot instead would make every untouched key
    // look composed (`source: base`), so /acp-prune config reset would report a
    // composition value the operator never wrote.
    assert.deepEqual(descriptor.base, filterSettingsEntry({ nudgeMaxContextLimitPct: 0.66 }))
    const list = await runAcp(engine.env, 'config')
    assert.match(list, /nudgeMaxContextLimitPct[^\n]*base/)
    assert.match(list, /nudgeEmergencyThresholdPct[^\n]*default/)
  } finally {
    await fiber.dispose()
  }
})

test('M6: a settings edit reaches kernelConfigFor, not just the env getters', async () => {
  const root = new Context()
  await root.plugin(MemorySettingsProvider)
  const { fiber, engine } = await mountEngine(root)
  try {
    assert.equal(kernelConfigFor(engine.env).nudge.maxContextLimitPct, 0.7)
    const provider = root.get('settings') as MemorySettingsProvider
    provider.publishForTest({ [ACP_SETTINGS_NAMESPACE]: { nudgeMaxContextLimitPct: 0.6 } })
    await flushRounds()
    assert.equal(kernelConfigFor(engine.env).nudge.maxContextLimitPct, 0.6)
  } finally {
    await fiber.dispose()
  }
})

test('M6: a settings-layer autoModelContextLimit false gates the window projection', async () => {
  const root = new Context()
  await root.plugin(MemorySettingsProvider)
  // Composition keeps auto detection ON — only the settings layer turns it off.
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
    // Reading the COMPOSITION value at the gate would keep consulting the
    // projection even though the user disabled auto detection.
    assert.equal((await engine.windowFor(agent)).source, 'projection')
    const provider = root.get('settings') as MemorySettingsProvider
    provider.publishForTest({ [ACP_SETTINGS_NAMESPACE]: { autoModelContextLimit: false } })
    await flushRounds()
    assert.notEqual((await engine.windowFor(agent)).source, 'projection')
  } finally {
    await fiber.dispose()
  }
})

test('M6: a detached provider falls back to the composition values', async () => {
  const root = new Context()
  const providerFiber = await root.plugin(MemorySettingsProvider)
  const { fiber, engine } = await mountEngine(root, { nudgeMaxContextLimitPct: 0.66 })
  try {
    const provider = root.get('settings') as MemorySettingsProvider
    provider.publishForTest({ [ACP_SETTINGS_NAMESPACE]: { nudgeMaxContextLimitPct: 0.4 } })
    await flushRounds()
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.4)
    assert.equal(engine.env.settingsCommand?.available, true)

    await providerFiber.dispose()
    await flushRounds()

    // Without a disposer the engine holds the dead thunk: the command would
    // still report available and the pct would freeze at 0.4.
    assert.equal(engine.env.settingsCommand?.available, false)
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.66)
  } finally {
    await fiber.dispose()
  }
})

test('M6: reset keeps keys the six-key schema does not know (no silent data loss)', async () => {
  const root = new Context()
  await root.plugin(MemorySettingsProvider)
  const { fiber, engine } = await mountEngine(root)
  try {
    const provider = root.get('settings') as MemorySettingsProvider
    provider.publishForTest({
      [ACP_SETTINGS_NAMESPACE]: { nudgeMaxContextLimitPct: 0.6, handWritten: 'keep-me' },
    })
    await flushRounds()

    const reset = await runAcp(engine.env, 'config reset nudgeMaxContextLimitPct')
    assert.match(reset, /✓/)
    await flushRounds()

    // The settings layer does not whitelist keys, so rebuilding the section
    // from SETTING_KEYS alone would delete the operator's own entry.
    const user = engine.env.settingsCommand?.describe()?.user
    assert.equal(user?.handWritten, 'keep-me')
    assert.equal(user?.nudgeMaxContextLimitPct, undefined)
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.7)
  } finally {
    await fiber.dispose()
  }
})

// ── Issue #173: host settings service without installSection (dsh-settings >= 0.1.7) ───────────────────

test('M6: a settings service WITHOUT installSection degrades gracefully (issue #173)', async () => {
  const root = new Context()
  await root.plugin(FormsLikeSettingsService)
  const forms = root.get('settings') as FormsLikeSettingsService
  assert.ok(!('installSection' in forms), 'fixture mirrors 0.1.7: no installSection method')
  // Pre-fix, construction threw `TypeError: ...installSection is not a function`
  // here and the host logged it as a startup error (dist/index.js stack in #173).
  const logs: Message[] = []
  const { fiber, engine } = await mountEngine(root, { nudgeMaxContextLimitPct: 0.66 }, (ctx) => {
    ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push(message) } })
  })
  try {
    // No registration happened → the command surface reports unavailable and
    // the knobs keep their composition values (readSettingsSource untouched).
    assert.equal(engine.env.settingsCommand?.available, false)
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.66)
    // One warn explains the degradation; nothing logs an ERROR for what is a
    // supported out-of-range host line, not a broken integration.
    const warns = logs.filter((m) => m.type === 'warn' && String(m.args[0]).includes('installSection'))
    assert.equal(warns.length, 1, 'exactly one warn names the missing capability')
    assert.ok(!logs.some((m) => m.type === 'error'), 'no error-level log for a degraded optional section')
    // /acp-prune config stays usable: list shows the composition values with
    // no registered layers, and writes degrade to guidance instead of hitting
    // the foreign service API (whose updates would throw entry-id errors).
    const list = await runAcp(engine.env, 'config')
    assert.match(list, /nudgeMaxContextLimitPct\s+0\.66\s+default/)
    const setResult = await runAcp(engine.env, 'config set nudgeMaxContextLimitPct 0.5')
    assert.match(setResult, /no settings provider/)
  } finally {
    await fiber.dispose()
  }
})


// ── Issue #176: a composed preset must reach the settings layer too ─────────
// Every kernel consumer reads the six scalar keys through the live settings
// source, never through `this.config` — so the preset has to be present in the
// base layer and the seeded snapshot, or it silently never fires.

test('M6: a composed preset seeds the base layer AND the live reads (issue #176)', async () => {
  const root = new Context()
  await root.plugin(MemorySettingsProvider)
  const { fiber, engine } = await mountEngine(root, { preset: 'aggressive' })
  try {
    // Exactly the three preset-filled threshold keys — not the full resolved
    // snapshot (that would over-attribute untouched keys as composed) and not
    // the empty raw-row subset (the bug: schema defaults won over the preset).
    assert.deepEqual(engine.env.settingsCommand?.describe()?.base, {
      nudgeMinContextLimitPct: 0.3,
      nudgeMaxContextLimitPct: 0.5,
      nudgeEmergencyThresholdPct: 0.7,
    })
    // And every kernel-facing read sees them — env getters and kernelConfigFor.
    assert.equal(engine.env.nudgeMinContextLimitPct, 0.3)
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.5)
    assert.equal(engine.env.nudgeEmergencyThresholdPct, 0.7)
    assert.equal(kernelConfigFor(engine.env).nudge.maxContextLimitPct, 0.5)
    // A runtime override still wins over the composed preset...
    const provider = root.get('settings') as MemorySettingsProvider
    provider.publishForTest({ [ACP_SETTINGS_NAMESPACE]: { nudgeMaxContextLimitPct: 0.55 } })
    await flushRounds()
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.55)
    // ...and the other two keys stay at their preset values.
    assert.equal(engine.env.nudgeMinContextLimitPct, 0.3)
    assert.equal(engine.env.nudgeEmergencyThresholdPct, 0.7)
  } finally {
    await fiber.dispose()
  }
})

test('M6: /acp-prune config attributes a preset-filled key to `base`, reset returns to the preset (issue #176)', async () => {
  const root = new Context()
  await root.plugin(MemorySettingsProvider)
  const { fiber, engine } = await mountEngine(root, { preset: 'aggressive' })
  try {
    const list = await runAcp(engine.env, 'config')
    assert.match(list, /nudgeMaxContextLimitPct[^\n]*base/)
    // A key the composition did NOT preset still attributes to the default...
    assert.match(list, /autoNudge[^\n]*default/)

    const setResult = await runAcp(engine.env, 'config set nudgeMaxContextLimitPct 0.55')
    assert.match(setResult, /✓/)
    await flushRounds()
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.55)

    // Resetting drops back to the COMPOSED preset value, not the engine default
    // (a runtime reset restores what the composition chose).
    const resetResult = await runAcp(engine.env, 'config reset nudgeMaxContextLimitPct')
    assert.match(resetResult, /composition value 0\.5/)
    await flushRounds()
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.5)
  } finally {
    await fiber.dispose()
  }
})

