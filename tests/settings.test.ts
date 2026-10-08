/**
 * M6 — runtime settings integration tests (phase 1, issue #75; the forms
 * line, issue #193).
 *
 * Coverage map (design doc §6):
 *  - pure units: filterSettingsEntry whitelist, engine-default mirror,
 *    schema default parity, schema boundaries (integer / inclusive pct),
 *    parseSettingValue (incl. the `false` regression), describeSettingsChange
 *    diff flags, command-surface degradation without a service, and the
 *    static Config schema contract (six volatile fields, no defaults);
 *  - E2E on BOTH supported host lines through a REAL engine on a bare cordis
 *    Context: the legacy installSection line (dsh-settings ≤0.1.6 — an
 *    in-memory provider whose publishes hot-apply to the live env) and the
 *    forms line (≥0.1.7 SettingsForms — profile-entry-id addressing, writes
 *    committed into the fiber's volatile config refs, optimistic revisions);
 *  - /acp-prune config list/set/reset round-trips on both lines; the kill
 *    switch ignores the provider;
 *  - regression locks added in review: the filtered `base` entry, the
 *    seam-to-window gate, the kernelConfigFor output, provider detach
 *    fallback, and reset preserving hand-written keys;
 *  - V1 gate: dispose-then-remount the same namespace (HMR-style reload)
 *    must not hit "settings namespace is already registered".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service, type Message } from '@deepseek-ai/cordis'
import * as dshSettings from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import type { SettingsDescriptor, SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session } from '@deepseek-ai/dsh-session'
import {
  ACP_SETTINGS_NAMESPACE,
  AcpPluginConfigSchema,
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

// ── Legacy installSection seam (dsh-settings ≤0.1.6) ─────────────────────────
// ≥0.1.7 renamed the service to SettingsForms and removed installSection /
// load / persist / publish entirely (its writes go through configEditor to
// profile files), so the in-memory provider below can only be constructed
// where the legacy base class exists at runtime. Tests that drive the
// registered seam pass `{ skip: SEAM_SKIP }`: they run in full on the ≤0.1.6
// baseline and skip with a reason on ≥0.1.7. The class body is typed against
// the documented legacy contract instead of the installed package types so
// this file compiles on both baselines; it subclasses the REAL base whenever
// that base exists (rule 5: no re-implemented seam semantics in a fake).
interface LegacySettingsBackend {
  doc: Record<string, unknown>
  load(): Promise<Record<string, unknown>>
  persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void>
  publish(doc: Record<string, unknown>, source?: string): void
}
interface MemorySettingsProvider extends LegacySettingsBackend {
  publishForTest(doc: Record<string, unknown>): void
}
const legacySettingsBase: unknown = Reflect.get(dshSettings, 'SettingsProvider')
const installSectionSeamAvailable = typeof legacySettingsBase === 'function'
/** Skip reason shared by every seam-driven test (false = run). */
const SEAM_SKIP = installSectionSeamAvailable ? false : 'dsh-settings >=0.1.7 renamed the service to SettingsForms and removed installSection — these tests exercise the legacy seam only'
let memorySettingsCtor: (new () => MemorySettingsProvider) | undefined
if (installSectionSeamAvailable) {
  const Base = legacySettingsBase as new () => LegacySettingsBackend
  /** In-memory settings provider: load/persist over a plain map; tests push external edits through publishForTest. */
  class Mem extends Base {
    static provide = 'settings'
    readonly writable = true
    private stored: Record<string, unknown> = {}

    override async load(): Promise<Record<string, unknown>> {
      return this.stored
    }

    override async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
      this.stored[String(ns)] = section
    }

    /** Simulate an external edit (someone editing settings.yaml on disk). */
    publishForTest(doc: Record<string, unknown>): void {
      this.publish(doc)
    }
  }
  memorySettingsCtor = Mem
}
/** Guarded accessor — every caller sits behind the same skip flag. */
function requireMemorySettings(): new () => MemorySettingsProvider {
  assert.ok(memorySettingsCtor, 'installSection seam is absent on this dsh-settings line')
  return memorySettingsCtor
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

// ── Issue #193: the forms line (dsh-settings ≥0.1.7 SettingsForms) ───────────────
// The loader wraps each volatile config value in a ref; SettingsForms commits
// form writes into those SAME refs between steps and emits no event the engine
// receives — so the test must hold a second handle to the cell to commit
// "form writes" exactly like the host does.

interface TestVolatileRef {
  get(): unknown
  [VOLATILE_WRITE](value: unknown): void
}

function makeVolatileRef(initial: unknown): TestVolatileRef {
  let current = initial
  return {
    get: () => current,
    [VOLATILE_WRITE]: (value: unknown) => { current = value },
  }
}

// The forms tests mount with autoNudge off, so the pre-step handler only
// touches payload.agent.session (orphan strip + settings resync) — a bare
// session holder is enough for the waterfall dispatch.
function fakeAgent(session: Session) {
  return { session }
}

/**
 * A SettingsForms-shaped host service (issue #193): profile-entry-id
 * addressing, volatile-field projection, optimistic revisions, and writes that
 * commit into the caller-supplied volatile refs IN PLACE — mirroring what the
 * real 0.2.0 line does with its fiber config (lib/index.js update/replace →
 * mergeLayers over projectForm, revision bump on change, SettingsConflictError
 * on a stale expectedRevision).
 */
class FormsSettingsService extends Service {
  static provide = 'settings'
  readonly writable = true
  private readonly knobs: Record<string, TestVolatileRef>
  /** User-layer membership: which fields a form write touched since mount. */
  private written: Record<string, boolean> = {}
  private revision = 0

  // Cordis constructs class plugins as `new callback(ctx, config)` — the knobs
  // record arrives as the config argument, exactly like a profile entry's own
  // written config on a real forms host.
  constructor(ctx: Context, knobs: Record<string, TestVolatileRef>) {
    super(ctx, 'settings')
    this.knobs = knobs
  }

  configure(): () => void {
    return () => {}
  }

  describe(): SettingsDescriptor[] {
    // Mirrors the host descriptor row: volatile fields only, projected values;
    // the user layer carries exactly the fields a form write touched since
    // mount (commands.ts derives per-key source attribution from it).
    const value: Record<string, unknown> = {}
    const user: Record<string, unknown> = {}
    for (const [key, ref] of Object.entries(this.knobs)) {
      const v = ref.get()
      if (v === undefined) continue
      value[key] = v
      if (this.written[key]) user[key] = v
    }
    return [{
      ns: ACP_SETTINGS_NAMESPACE as SettingsNamespace,
      autoGenerate: true,
      schema: AcpPluginConfigSchema,
      value,
      revision: this.revision,
      base: {},
      user,
      applies: 'live',
    }]
  }

  private assertRevision(ns: string, expectedRevision?: string | number): void {
    if (String(ns) !== ACP_SETTINGS_NAMESPACE) throw new Error(`no settings entry named ${String(ns)}`)
    // The host skips the check when no token is passed; a stale one rejects
    // before any write lands.
    if (expectedRevision !== undefined && Number(expectedRevision) !== this.revision) {
      throw new SettingsConflictError(ACP_SETTINGS_NAMESPACE, Number(expectedRevision), this.revision)
    }
  }

  async update(ns: string, patch: Record<string, unknown>, expectedRevision?: string | number): Promise<void> {
    this.assertRevision(ns, expectedRevision)
    // Host semantics: mergeLayers(projectForm(form, current), patch) — each
    // volatile field takes the patch value when present, keeps its committed
    // value otherwise. Non-volatile keys are preserved by the host, not stored
    // in a knob cell.
    let changed = false
    for (const [key, ref] of Object.entries(this.knobs)) {
      const hasKey = Object.prototype.hasOwnProperty.call(patch, key)
      const next = hasKey ? patch[key] : ref.get()
      if (next !== ref.get()) {
        ref[VOLATILE_WRITE](next)
        changed = true
      }
      if (hasKey) this.written[key] = next !== undefined
    }
    if (changed) this.revision += 1
  }

  async replace(ns: string, section: Record<string, unknown>, expectedRevision?: string | number): Promise<void> {
    this.assertRevision(ns, expectedRevision)
    // Host semantics: mergeLayers(projectForm(form, inherited), section). This
    // bare test root has no layer below the entry, so every field absent from
    // `section` lands on undefined (the engine default then applies) — unlike
    // a real profile where the composition row survives as `base`.
    let changed = false
    for (const [key, ref] of Object.entries(this.knobs)) {
      const next = Object.prototype.hasOwnProperty.call(section, key) ? section[key] : undefined
      if (next !== ref.get()) {
        ref[VOLATILE_WRITE](next)
        changed = true
      }
      this.written[key] = next !== undefined
    }
    if (changed) this.revision += 1
  }
}

/**
 * A settings-shaped service that speaks NEITHER supported API (issue #173's
 * degrade branch, now narrowed): no installSection, and not the full
 * describe/update/replace trio — e.g. a future renamed seam line or a foreign
 * implementation. Must degrade with one warn and no capture.
 */
class BareSettingsService extends Service {
  static provide = 'settings'
  readonly writable = false
  configure(_presentation?: unknown): () => void {
    return () => {}
  }
  describe(): unknown[] {
    return []
  }
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

test('M6: engine env reads LIVE settings — an external edit hot-applies', { skip: SEAM_SKIP }, async () => {
  const root = new Context()
  await root.plugin(requireMemorySettings())
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

test('M6: /acp-prune config list/set/reset round-trips through a real provider', { skip: SEAM_SKIP }, async () => {
  const root = new Context()
  await root.plugin(requireMemorySettings())
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

test('M6: settingsEnabled false is a kill switch — composition values stay, provider ignored', { skip: SEAM_SKIP }, async () => {
  const root = new Context()
  await root.plugin(requireMemorySettings())
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

test('M6: HMR-style remount of the same namespace does not hit duplicate registration (V1 gate)', { skip: SEAM_SKIP }, async () => {
  const root = new Context()
  await root.plugin(requireMemorySettings())
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

test('M6: installSection registers the FILTERED composition subset as `base`', { skip: SEAM_SKIP }, async () => {
  const root = new Context()
  await root.plugin(requireMemorySettings())
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

test('M6: a settings edit reaches kernelConfigFor, not just the env getters', { skip: SEAM_SKIP }, async () => {
  const root = new Context()
  await root.plugin(requireMemorySettings())
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

test('M6: a settings-layer autoModelContextLimit false gates the window projection', { skip: SEAM_SKIP }, async () => {
  const root = new Context()
  await root.plugin(requireMemorySettings())
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

test('M6: a detached provider falls back to the composition values', { skip: SEAM_SKIP }, async () => {
  const root = new Context()
  const providerFiber = await root.plugin(requireMemorySettings())
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

test('M6: reset keeps keys the six-key schema does not know (no silent data loss)', { skip: SEAM_SKIP }, async () => {
  const root = new Context()
  await root.plugin(requireMemorySettings())
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

// ── Issue #173 → #193: a settings-shaped service speaking NEITHER supported API ──
// Pre-#193 this branch was reached by EVERY dsh-settings >= 0.1.7 host (the
// renamed SettingsForms had no installSection); after #193 it is reachable
// only by a future renamed line or a foreign implementation — the real
// forms line now registers through its describe/update/replace surface.
test('M6: a settings service speaking neither API degrades gracefully (issue #173/#193)', async () => {
  const root = new Context()
  await root.plugin(BareSettingsService)
  // Pre-#193, construction threw `TypeError: ...installSection is not a
  // function` here and the host logged it as a startup error (dist/index.js
  // stack in #173). Construction must stay clean on any settings-shaped host.
  const logs: Message[] = []
  const { fiber, engine } = await mountEngine(root, { nudgeMaxContextLimitPct: 0.66 }, (ctx) => {
    ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push(message) } })
  })
  try {
    // No capture happened → the command surface reports unavailable and the
    // knobs keep their composition values (readSettingsSource untouched).
    assert.equal(engine.env.settingsCommand?.available, false)
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.66)
    // One warn explains the degradation; nothing logs an ERROR for what is a
    // degraded OPTIONAL section, not a broken integration.
    const warns = logs.filter((m) => m.type === 'warn' && String(m.args[0]).includes('neither installSection'))
    assert.equal(warns.length, 1, 'exactly one warn names both missing capabilities')
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

// ── Issue #193: the forms line registers and hot-applies ──────────────────────

test('M6: static Config schema exposes exactly the six knobs, all volatile, no defaults (issue #193)', () => {
  // The loader validates our composition row against this schema AND
  // SettingsForms builds its form from it — the field set IS the public
  // settings contract. A seventh key or a dropped .volatile() would silently
  // change what hosts expose.
  // schemastery exposes object fields under `.dict` (not zod's `.shape`).
  assert.deepEqual(Object.keys(AcpPluginConfigSchema.dict), [
    'modelContextLimit',
    'autoModelContextLimit',
    'nudgeMinContextLimitPct',
    'nudgeMaxContextLimitPct',
    'nudgeEmergencyThresholdPct',
    'autoNudge',
  ])
  // The volatile marker exists from the 0.2.0 line's schemastery onward; the
  // 0.1.5/0.1.6 lines ship schemastery 3.18.2, which has no `.volatile()`
  // helper at all, and calling it there throws at module load. The engine
  // therefore applies the marker only where the runtime supports it (see
  // markVolatile in src/settings.ts). Assert the marker where it can exist and
  // its deliberate absence where it cannot — on BOTH baselines this test runs
  // and asserts; neither branch silently skips. The six-key field set and the
  // missing defaults are asserted unconditionally, because those ARE the
  // public contract on every line.
  const volatileSupported = typeof (z.number() as { volatile?: unknown }).volatile === 'function'
  for (const field of Object.values(AcpPluginConfigSchema.dict)) {
    // schemastery's zod extension marks volatile fields with meta.volatile —
    // the exact flag dsh-settings' volatileForm() reads off the schema.
    const marker = (field as { meta?: { volatile?: boolean } }).meta?.volatile
    assert.equal(marker, volatileSupported ? true : undefined,
      volatileSupported
        ? 'a runtime with .volatile() support must carry the marker (SettingsForms reads it)'
        : 'a runtime without .volatile() must not carry the marker (the call would throw at load)')
    assert.equal((field as { defaultValue?: unknown }).defaultValue, undefined, 'a default here would shadow preset-filled base values')
  }
})

test('M6: forms host — a SettingsForms write commits into the volatile refs and hot-applies on the next read (issue #193)', async () => {
  const minRef = makeVolatileRef(0.5)
  const maxRef = makeVolatileRef(0.7)
  const knobs = { nudgeMinContextLimitPct: minRef, nudgeMaxContextLimitPct: maxRef }
  const root = new Context()
  await root.plugin(FormsSettingsService, knobs)
  const forms = root.get('settings') as FormsSettingsService
  assert.ok(!('installSection' in forms), 'fixture mirrors the forms line: no installSection method')
  const logs: Message[] = []
  const { fiber, engine } = await mountEngine(root, {
    nudgeMinContextLimitPct: minRef,
    nudgeMaxContextLimitPct: maxRef,
    autoNudge: false,
  }, (ctx) => {
    ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push(message) } })
  })
  try {
    // The constructor unwrapped the refs for the one-shot config snapshot...
    assert.equal(engine.config.nudgeMinContextLimitPct, 0.5)
    assert.equal(engine.config.nudgeMaxContextLimitPct, 0.7)
    // ...and the command surface captured the forms service (not degraded).
    assert.equal(engine.env.settingsCommand?.available, true)
    assert.deepEqual(logs.filter((m) => m.type === 'warn'), [], 'the engine sees its own entry row — no diagnostic warn')
    // A form write commits into the SAME ref objects the engine reads through
    // (cordis updateVolatile semantics) — via the service's own update(), the
    // way /acp-prune config set reaches the host. Every knob read goes through
    // the live-read thunk, so the committed value is visible immediately.
    await forms.update(ACP_SETTINGS_NAMESPACE, { nudgeMaxContextLimitPct: 0.62 })
    assert.equal(maxRef.get(), 0.62, 'the write landed in the shared ref cell')
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.62, 'a forms write must hot-apply through the refs')
    assert.equal(engine.env.nudgeMinContextLimitPct, 0.5, 'untouched knobs keep their composed values')
    // A step still runs the resync driver over an in-order change: it must be
    // silent (no spurious warn) and leave the values untouched.
    await root.waterfall(
      'agent/pre-step' as never,
      { agent: fakeAgent(buildTextSession(2)) } as never,
      async () => ({ kind: 'enter', messages: [] }) as never,
    )
    assert.equal(engine.env.nudgeMaxContextLimitPct, 0.62)
    assert.deepEqual(logs.filter((m) => m.type === 'warn'), [], 'an in-order single-knob change logs nothing')
  } finally {
    await fiber.dispose()
  }
})

test('M6: forms host — /acp-prune config round-trips with revision tracking (issue #193)', async () => {
  // The loader wraps EVERY volatile schema field in a ref at mount time, even
  // one the entry never wrote (min starts undefined = engine default applies).
  const minRef = makeVolatileRef(undefined)
  const maxRef = makeVolatileRef(0.5)
  const root = new Context()
  await root.plugin(FormsSettingsService, { nudgeMinContextLimitPct: minRef, nudgeMaxContextLimitPct: maxRef })
  const { fiber, engine } = await mountEngine(root, {
    nudgeMinContextLimitPct: minRef,
    nudgeMaxContextLimitPct: maxRef,
    autoNudge: false,
  })
  try {
    const setResult = await runAcp(engine.env, 'config set nudgeMinContextLimitPct 0.3')
    assert.equal(minRef.get(), 0.3, 'the write landed in the shared ref cell')
    assert.match(setResult, /✓/)
    const descriptor = engine.env.settingsCommand?.describe()
    assert.equal(descriptor?.revision, 1)
    // The env getter already sees the committed value (live ref reads); the
    // step below is a resync-driver sanity check, then list shows user attribution.
    await root.waterfall(
      'agent/pre-step' as never,
      { agent: fakeAgent(buildTextSession(2)) } as never,
      async () => ({ kind: 'enter', messages: [] }) as never,
    )
    assert.equal(engine.env.nudgeMinContextLimitPct, 0.3)
    const listText = await runAcp(engine.env, 'config')
    assert.match(listText, /nudgeMinContextLimitPct\s+0\.3\s+user/)
    const resetResult = await runAcp(engine.env, 'config reset nudgeMinContextLimitPct')
    assert.match(resetResult, /✓/)
    assert.equal(minRef.get(), undefined, 'reset drops back to the engine default')
  } finally {
    await fiber.dispose()
  }
})

test('M6: forms host — a stale revision raises SettingsConflictError (issue #193)', async () => {
  const minRef = makeVolatileRef(0.4)
  const maxRef = makeVolatileRef(0.6)
  const root = new Context()
  await root.plugin(FormsSettingsService, { nudgeMinContextLimitPct: minRef, nudgeMaxContextLimitPct: maxRef })
  const { fiber } = await mountEngine(root, {
    nudgeMinContextLimitPct: minRef,
    nudgeMaxContextLimitPct: maxRef,
    autoNudge: false,
  })
  try {
    const forms = root.get('settings') as FormsSettingsService
    // Two writers race: the first write wins and bumps the revision...
    await forms.update(ACP_SETTINGS_NAMESPACE, { nudgeMinContextLimitPct: 0.45 })
    // ...so a second writer holding the OLD token is rejected before any byte
    // lands. (The engine's own command surface refreshes its token before each
    // write, so single-writer flows never hit this — only an external stale
    // token does; the surface maps the error to guidance text.)
    await assert.rejects(
      forms.update(ACP_SETTINGS_NAMESPACE, { nudgeMinContextLimitPct: 0.42 }, 0),
      (error: unknown) => error instanceof SettingsConflictError && error.code === 'SETTINGS_CONFLICT',
    )
    assert.equal(minRef.get(), 0.45, 'the losing writer did not clobber the value')
    // A fresh token succeeds.
    await forms.update(ACP_SETTINGS_NAMESPACE, { nudgeMinContextLimitPct: 0.42 }, 1)
    assert.equal(minRef.get(), 0.42)
  } finally {
    await fiber.dispose()
  }
})

test('M6: forms host — an out-of-order pair still warns exactly once via the pre-step driver (issue #193)', async () => {
  const minRef = makeVolatileRef(0.5)
  const maxRef = makeVolatileRef(0.7)
  const root = new Context()
  await root.plugin(FormsSettingsService, { nudgeMinContextLimitPct: minRef, nudgeMaxContextLimitPct: maxRef })
  const logs: Message[] = []
  const { fiber, engine } = await mountEngine(root, {
    nudgeMinContextLimitPct: minRef,
    nudgeMaxContextLimitPct: maxRef,
    autoNudge: false,
  }, (ctx) => {
    ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push(message) } })
  })
  try {
    // Commit an out-of-order pair through the forms seam: each value passes
    // the schema (both inside [0,1]) but describeSettingsChange flags the ordering.
    await (root.get('settings') as FormsSettingsService).update(
      ACP_SETTINGS_NAMESPACE,
      { nudgeMinContextLimitPct: 0.9, nudgeMaxContextLimitPct: 0.4 },
    )
    // A forms write commits into the volatile refs and emits NO event this
    // engine receives, so nothing re-reads it until a step runs: no change
    // effect before the pre-step driver fires.
    assert.deepEqual(logs.filter((m) => m.type === 'warn'), [], 'no change effect before a step runs')
    // The pre-step driver diffs the live refs against the last synced snapshot
    // and applies the effects — on the forms line this is the ONLY trigger.
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


// ── Issue #176: a composed preset must reach the settings layer too ─────────
// Every kernel consumer reads the six scalar keys through the live settings
// source, never through `this.config` — so the preset has to be present in the
// base layer and the seeded snapshot, or it silently never fires.

test('M6: a composed preset seeds the base layer AND the live reads (issue #176)', { skip: SEAM_SKIP }, async () => {
  const root = new Context()
  await root.plugin(requireMemorySettings())
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

test('M6: /acp-prune config attributes a preset-filled key to `base`, reset returns to the preset (issue #176)', { skip: SEAM_SKIP }, async () => {
  const root = new Context()
  await root.plugin(requireMemorySettings())
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

