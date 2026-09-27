/**
 * M6 — runtime settings integration tests (phase 1, issue #75; the 0.1.7
 * forms line, issue #174).
 *
 * Coverage map (design doc §6):
 *  - pure units: filterSettingsEntry whitelist, engine-default mirror,
 *    schema default parity, schema boundaries (integer / inclusive pct),
 *    parseSettingValue (incl. the `false` regression), describeSettingsChange
 *    diff flags, command-surface degradation without a service;
 *  - E2E on BOTH supported host lines through the REAL engine on a bare cordis
 *    Context: the legacy installSection line (dsh-settings <= 0.1.6 — an
 *    in-memory provider whose publishes hot-apply to the live env) and the
 *    forms line (>= 0.1.7 SettingsForms — profile-entry-id addressing, writes
 *    committed into the fiber's volatile config refs, optimistic revisions);
 *  - /acp-prune config list/set/reset round-trips on both lines; the kill
 *    switch ignores the provider;
 *  - regression locks added in review: the filtered `base` entry, the
 *    seam-to-window gate, the kernelConfigFor output, provider detach
 *    fallback, and reset preserving hand-written keys;
 *  - V1 gate: dispose-then-remount the same namespace (HMR-style reload)
 *    must not hit "settings namespace is already registered";
 *  - degrade path: a settings service speaking NEITHER API logs one warn and
 *    keeps the composition values available (issue #173).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service, type Message } from '@deepseek-ai/cordis'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session } from '@deepseek-ai/dsh-session'
import {
  ACP_SETTINGS_NAMESPACE,
  AcpSettingsSchema,
  describeSettingsChange,
  filterSettingsEntry,
  isVolatileRef,
  makeSettingsCommandSurface,
  parseSettingValue,
  resolveAcpSettings,
  SETTING_DEFAULTS,
  VOLATILE_WRITE,
} from '../src/settings.ts'
import { AcpCompactionEngine, resolveAcpConfig, type AcpConfig } from '../src/index.ts'
import { kernelConfigFor } from '../src/config.ts'
import { acpCommand } from '../src/commands.ts'
import type { ToolEnvironment } from '../src/tools.ts'
import { DEFAULT_CONTEXT_WINDOW } from '../src/window.ts'
import { buildTextSession } from './helpers.ts'

function fakeAgent(session: Session): Agent {
  return {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: new Context(),
  } as unknown as Agent
}

/**
 * Stand-in for dsh-settings <= 0.1.6's SettingsProvider. The real class has no
 * runtime value on the 0.1.7 baseline (type-only there), so the fixture is
 * standalone: it implements the installSection registration contract the
 * engine's legacy branch consumes — a LIVE schema-resolved source thunk, async
 * change notification, provider-side describe/update/replace — mirroring the
 * 0.1.5 semantics line for line (rule 5: fixtures mirror real host structures).
 */
class LegacySettingsProvider extends Service {
  static provide = 'settings'
  readonly writable = true
  private ns = ''
  private schema: ((input: Record<string, unknown>) => Record<string, unknown>) | undefined
  private entry: Record<string, unknown> = {}
  private user: Record<string, unknown> = {}
  private resolved: Record<string, unknown> = {}
  private revision = 0
  private setSourceHook: ((source: () => Record<string, unknown>) => void) | undefined
  private onChangeHook: (() => void) | undefined

  installSection(
    _ctx: unknown,
    namespace: string,
    schema: unknown,
    entry: Record<string, unknown>,
    hooks: { setSource: (source: () => Record<string, unknown>) => void; onChange: () => void },
  ): void {
    // Overwrite-on-duplicate mirrors per-fiber registration: an HMR remount
    // re-registers the same namespace cleanly instead of throwing.
    this.ns = String(namespace)
    this.schema = schema as (input: Record<string, unknown>) => Record<string, unknown>
    this.entry = entry
    this.setSourceHook = hooks.setSource
    this.onChangeHook = hooks.onChange
    this.resolved = this.schema({ ...this.entry })
    // The registered source must stay LIVE: later publishes re-resolve through
    // it, exactly like the real provider's setSource thunk.
    hooks.setSource(() => this.resolved)
    hooks.onChange()
  }

  /** Simulate an external edit (someone editing settings.yaml on disk). */
  publishForTest(doc: Record<string, unknown>): void {
    const section = doc[this.ns]
    if (typeof section !== 'object' || section === null || Array.isArray(section)) return
    this.user = section as Record<string, unknown>
    this.commit(this.resolveWith(this.user))
  }

  describe(): Array<{ ns: string; autoGenerate: boolean; schema: unknown; revision: number; value: Record<string, unknown>; base: Record<string, unknown>; user: Record<string, unknown> }> {
    if (this.ns === '') return []
    return [{ ns: this.ns, autoGenerate: false, schema: this.schema, revision: this.revision, value: this.resolved, base: this.entry, user: this.user }]
  }

  async update(ns: string, patch: Record<string, unknown>, _expectedRevision?: number): Promise<void> {
    this.assertNs(ns)
    const nextUser = { ...this.user, ...patch }
    const resolved = this.resolveWith(nextUser) // throws ValidationError before anything mutates
    this.user = nextUser
    this.commit(resolved)
  }

  async replace(ns: string, section: Record<string, unknown>, _expectedRevision?: number): Promise<void> {
    this.assertNs(ns)
    const resolved = this.resolveWith(section)
    this.user = section
    this.commit(resolved)
  }

  private assertNs(ns: string): void {
    if (String(ns) !== this.ns) throw new Error(`unknown settings namespace ${String(ns)}`)
  }

  private resolveWith(user: Record<string, unknown>): Record<string, unknown> {
    const schema = this.schema
    if (schema === undefined) throw new Error('settings section not registered')
    return schema({ ...this.entry, ...user })
  }

  private commit(next: Record<string, unknown>): void {
    const prev = this.resolved
    this.resolved = next
    if (JSON.stringify(prev) === JSON.stringify(next)) return
    this.revision += 1
    queueMicrotask(() => this.onChangeHook?.())
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
 * A volatile ref pair mirroring cosmokit's createVolatile shape: a frozen
 * object exposing get() plus the Symbol.for('cosmokit.volatile.write') write
 * key. Built with the engine's own VOLATILE_WRITE symbol so isVolatileRef is
 * guaranteed to recognize it — no cosmokit dependency in the test tree.
 */
interface TestVolatileRef {
  get(): unknown
}

function makeVolatileRef(initial: unknown): { ref: TestVolatileRef; write: (value: unknown) => void } {
  let current = initial
  const write = (value: unknown): void => {
    current = value
  }
  return { ref: Object.freeze({ get: () => current, [VOLATILE_WRITE]: write }) as TestVolatileRef, write }
}

/**
 * Stand-in for dsh-settings >= 0.1.7's SettingsForms (issue #174): addressed
 * by profile entry id, optimistic revisions, and writes committed INTO the
 * consuming fiber's config refs — the live carrier of the profile entry on
 * that line. Deliberately carries NO installSection (removed on this line,
 * issue #173). The ctor receives the entry's OWN written knobs (its
 * options.config); the inherited layers below the entry stay empty here, so a
 * field reset lands on undefined and the schema defaults take over — exactly
 * like a bare test root.
 */
class FormsSettingsService extends Service {
  static provide = 'settings'
  readonly writable = true
  private sections: Array<{ key: string; ref: TestVolatileRef; write: (value: unknown) => void; written: boolean }>
  private revision = 0

  constructor(ctx: Context, knobs: Record<string, unknown>) {
    super(ctx, 'settings')
    this.sections = Object.entries(knobs).map(([key, value]) => {
      // Production reality: the loader hands the plugin the SAME volatile refs
      // SettingsForms later commits into — wrap only plain values, or updates
      // would land in a nested cell the engine never reads.
      const cell = isVolatileRef(value)
        ? { ref: value as TestVolatileRef, write: (next: unknown): void => { (value as Record<symbol, (v: unknown) => void>)[VOLATILE_WRITE](next) } }
        : makeVolatileRef(value)
      return { ...cell, key, written: true }
    })
  }

  describe(): Array<{ ns: string; autoGenerate: boolean; schema: unknown; revision: number; value: Record<string, unknown>; base: Record<string, unknown>; user: Record<string, unknown> }> {
    const value: Record<string, unknown> = {}
    const user: Record<string, unknown> = {}
    for (const section of this.sections) {
      const current = section.ref.get()
      if (current === undefined) continue
      value[section.key] = current
      if (section.written) user[section.key] = current
    }
    return [{ ns: ACP_SETTINGS_NAMESPACE, autoGenerate: false, schema: {}, revision: this.revision, value, base: {}, user }]
  }

  async update(ns: string, patch: Record<string, unknown>, expectedRevision?: number): Promise<void> {
    this.assertNs(ns)
    this.assertRevision(expectedRevision)
    for (const [key, value] of Object.entries(patch)) {
      // Unknown keys never reach here in production: the command surface
      // validates against the six known keys before calling.
      const section = this.sections.find((candidate) => candidate.key === key)
      if (section === undefined) continue
      section.write(value)
      section.written = true
    }
    this.revision += 1
  }

  async replace(ns: string, section: Record<string, unknown>, expectedRevision?: number): Promise<void> {
    this.assertNs(ns)
    this.assertRevision(expectedRevision)
    // Reset every live field to the (empty) inherited layers, then apply the
    // replacement — mirrors the host's "reset-all-then-set" contract.
    for (const candidate of this.sections) {
      candidate.write(undefined)
      candidate.written = false
    }
    for (const [key, value] of Object.entries(section)) {
      const target = this.sections.find((candidate) => candidate.key === key)
      if (target === undefined) continue
      target.write(value)
      target.written = true
    }
    this.revision += 1
  }

  private assertNs(ns: string): void {
    if (String(ns) !== ACP_SETTINGS_NAMESPACE) throw new Error(`no profile entry named ${String(ns)}`)
  }

  private assertRevision(expected: number | undefined): void {
    if (expected !== undefined && expected !== this.revision) throw new SettingsConflictError(ACP_SETTINGS_NAMESPACE, expected, this.revision)
  }
}

/** Speaks neither the legacy installSection API nor the forms API — the degrade path (issue #173). */
class BareSettingsService extends Service {
  static provide = 'settings'
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
  await root.plugin(LegacySettingsProvider)
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
    const provider = root.get('settings') as LegacySettingsProvider
    provider.publishForTest({ [ACP_SETTINGS_NAMESPACE]: { nudgeMaxContextLimitPct: 0.6 } })
    await flushRounds()
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.6)
  } finally {
    await fiber.dispose()
  }
})

test('M6: /acp-prune config list/set/reset round-trips through a real provider', async () => {
  const root = new Context()
  await root.plugin(LegacySettingsProvider)
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
  await root.plugin(LegacySettingsProvider)
  const { fiber, engine } = await mountEngine(root, { settingsEnabled: false, nudgeMaxContextLimitPct: 0.66 })
  try {
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.66)
    assert.equal(engine.env.settingsCommand?.available, false)
    const provider = root.get('settings') as LegacySettingsProvider
    provider.publishForTest({ [ACP_SETTINGS_NAMESPACE]: { nudgeMaxContextLimitPct: 0.4 } })
    await flushRounds()
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.66)
  } finally {
    await fiber.dispose()
  }
})

test('M6: HMR-style remount of the same namespace does not hit duplicate registration (V1 gate)', async () => {
  const root = new Context()
  await root.plugin(LegacySettingsProvider)
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
  await root.plugin(LegacySettingsProvider)
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
  await root.plugin(LegacySettingsProvider)
  const { fiber, engine } = await mountEngine(root)
  try {
    assert.equal(kernelConfigFor(engine.env).nudge.maxContextLimitPct, 0.7)
    const provider = root.get('settings') as LegacySettingsProvider
    provider.publishForTest({ [ACP_SETTINGS_NAMESPACE]: { nudgeMaxContextLimitPct: 0.6 } })
    await flushRounds()
    assert.equal(kernelConfigFor(engine.env).nudge.maxContextLimitPct, 0.6)
  } finally {
    await fiber.dispose()
  }
})

test('M6: a settings-layer autoModelContextLimit false gates the window projection', async () => {
  const root = new Context()
  await root.plugin(LegacySettingsProvider)
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
    const provider = root.get('settings') as LegacySettingsProvider
    provider.publishForTest({ [ACP_SETTINGS_NAMESPACE]: { autoModelContextLimit: false } })
    await flushRounds()
    assert.notEqual((await engine.windowFor(agent)).source, 'projection')
  } finally {
    await fiber.dispose()
  }
})

test('M6: a detached provider falls back to the composition values', async () => {
  const root = new Context()
  const providerFiber = await root.plugin(LegacySettingsProvider)
  const { fiber, engine } = await mountEngine(root, { nudgeMaxContextLimitPct: 0.66 })
  try {
    const provider = root.get('settings') as LegacySettingsProvider
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
  await root.plugin(LegacySettingsProvider)
  const { fiber, engine } = await mountEngine(root)
  try {
    const provider = root.get('settings') as LegacySettingsProvider
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

// ── Issue #173: settings service speaking neither API ───────────────────────

test('M6: a settings service speaking NEITHER API degrades gracefully (issue #173)', async () => {
  const root = new Context()
  await root.plugin(BareSettingsService)
  const bare = root.get('settings') as BareSettingsService
  assert.ok(!('installSection' in bare) && typeof (bare as { describe?: unknown }).describe !== 'function', 'fixture speaks no known settings API')
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
    // One warn explains the degradation; nothing logs an ERROR for what is an
    // unsupported service shape, not a broken integration.
    const warns = logs.filter((m) => m.type === 'warn' && String(m.args[0]).includes('neither'))
    assert.equal(warns.length, 1, 'exactly one warn names the unsupported service shape')
    assert.ok(!logs.some((m) => m.type === 'error'), 'no error-level log for a degraded optional section')
    // /acp-prune config stays usable: list shows the composition values with
    // no registered layers, and writes degrade to guidance instead of hitting
    // a foreign service API.
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
  await root.plugin(LegacySettingsProvider)
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
    const provider = root.get('settings') as LegacySettingsProvider
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
// ── Issue #174: the 0.1.7 forms line (SettingsForms semantics) ───────────────

test('M6: forms host — a SettingsForms write hot-applies through the volatile refs', async () => {
  const root = new Context()
  const maxRef = makeVolatileRef(0.7)
  // Function-form factories must NOT return the instance — cordis runs a
  // returned value as an effect; capture it through the closure instead.
  let service: FormsSettingsService | undefined
  await root.plugin((ctx) => {
    service = new FormsSettingsService(ctx, { nudgeMaxContextLimitPct: maxRef.ref })
  })
  const forms = service as FormsSettingsService
  const logs: Message[] = []
  const { fiber, engine } = await mountEngine(root, { nudgeMaxContextLimitPct: maxRef.ref }, (ctx) => {
    ctx.logger.exporter({ levels: { default: 3 }, export: (message) => logs.push(message) })
  })
  try {
    assert.equal(engine.env.settingsCommand?.available, true, 'describe/update/replace present → captured')
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.7)
    const warns = logs.filter((m) => m.type === 'warn')
    assert.deepEqual(warns, [], 'the engine owns its own entry row — no diagnostic warn expected')

    await forms.update(ACP_SETTINGS_NAMESPACE, { nudgeMaxContextLimitPct: 0.6 })
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.6, 'a forms write must hot-apply through the refs')
  } finally {
    await fiber.dispose()
  }
})

test('M6: /acp-prune config attributes a preset-filled key to `base`, reset returns to the preset (issue #176)', async () => {
  const root = new Context()
  await root.plugin(LegacySettingsProvider)
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
test('M6: forms host — /acp-prune config round-trips with revision tracking', async () => {
  const root = new Context()
  const maxRef = makeVolatileRef(0.7)
  const nudgeRef = makeVolatileRef(true)
  let service: FormsSettingsService | undefined
  await root.plugin((ctx) => {
    service = new FormsSettingsService(ctx, { nudgeMaxContextLimitPct: maxRef.ref, autoNudge: nudgeRef.ref })
  })
  const forms = service as FormsSettingsService
  const { fiber, engine } = await mountEngine(root, { nudgeMaxContextLimitPct: maxRef.ref, autoNudge: nudgeRef.ref })
  try {
    assert.match(await runAcp(engine.env, 'config'), /nudgeMaxContextLimitPct\s+0\.7\s+user/)
    assert.match(await runAcp(engine.env, 'config set nudgeMaxContextLimitPct 0.6'), /✓/)
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.6)
    // A second write in the same session must not false-conflict: the command
    // surface refreshes its tracked revision between calls.
    assert.match(await runAcp(engine.env, 'config set autoNudge false'), /✓/)
    assert.match(await runAcp(engine.env, 'config reset nudgeMaxContextLimitPct'), /✓/)
    // The ref was reset to the empty inherited layer → undefined → the schema
    // default takes over again.
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.7)
    // autoNudge has no env getter; read it back through the descriptor.
    assert.equal(forms.describe()[0]?.value?.autoNudge, false)
  } finally {
    await fiber.dispose()
  }
})

test('M6: forms host — a stale revision raises SettingsConflictError', async () => {
  const root = new Context()
  let svc: FormsSettingsService | undefined
  await root.plugin((ctx) => {
    svc = new FormsSettingsService(ctx, { autoNudge: makeVolatileRef(true).ref })
  })
  const service = svc as FormsSettingsService
  await service.update(ACP_SETTINGS_NAMESPACE, { autoNudge: false })
  await assert.rejects(
    service.update(ACP_SETTINGS_NAMESPACE, { autoNudge: true }, 0),
    (error: unknown) => error instanceof SettingsConflictError,
    'a write against a superseded revision must be rejected',
  )
  await service.update(ACP_SETTINGS_NAMESPACE, { autoNudge: true }, 1)
  assert.equal(service.describe()[0]?.revision, 2)
})

test('M6: forms host — a committed write hot-applies on the NEXT pre-step (the resyncSettings driver)', async () => {
  const root = new Context()
  const minRef = makeVolatileRef(0.3)
  const maxRef = makeVolatileRef(0.7)
  let service: FormsSettingsService | undefined
  await root.plugin((ctx) => {
    service = new FormsSettingsService(ctx, {
      nudgeMinContextLimitPct: minRef.ref,
      nudgeMaxContextLimitPct: maxRef.ref,
      autoNudge: false,
    })
  })
  const forms = service as FormsSettingsService
  const logs: Message[] = []
  const { fiber, engine } = await mountEngine(
    root,
    { nudgeMinContextLimitPct: minRef.ref, nudgeMaxContextLimitPct: maxRef.ref, autoNudge: false },
    (ctx) => {
      ctx.logger.exporter({ levels: { default: 3 }, export: (message) => logs.push(message) })
    },
  )
  try {
    // Commit an out-of-order pair through the forms seam: each value passes the
    // schema (both inside [0,1]) but describeSettingsChange flags the ordering.
    await forms.update(ACP_SETTINGS_NAMESPACE, { nudgeMinContextLimitPct: 0.9, nudgeMaxContextLimitPct: 0.4 })

    // A forms write commits into the volatile refs and emits NO event this
    // engine receives, so nothing re-reads it until a step runs: no change
    // effect before the pre-step driver fires.
    assert.deepEqual(logs.filter((m) => m.type === 'warn'), [], 'no change effect before a step runs')

    // The pre-step driver diffs the live refs against the last synced snapshot
    // and applies the effects — on the forms line this is the ONLY trigger.
    // autoNudge is off so the step stays cheap and returns right after resync.
    await root.waterfall(
      'agent/pre-step' as never,
      { agent: fakeAgent(buildTextSession(2)) } as never,
      async () => ({ kind: 'enter', messages: [] }) as never,
    )

    const warns = logs.filter((m) => m.type === 'warn')
    assert.equal(warns.length, 1, 'the order-anomaly warning fired exactly once, via the pre-step driver')
    assert.match(String(warns[0]!.args[0]), /nudgeMinContextLimitPct \(0\.9\) >= nudgeMaxContextLimitPct \(0\.4\)/)
    // The committed values are visible on the live surface for the rest of the session.
    assert.equal(engine.env.nudgeMinContextLimitPct, 0.9)
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.4)
  } finally {
    await fiber.dispose()
  }
})
