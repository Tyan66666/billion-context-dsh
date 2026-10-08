/**
 * M6 — runtime settings integration. Wires the engine's six scalar knobs into
 * the host's settings layer so edits apply to RUNNING sessions without a
 * restart. Two host shapes are supported behind one source (issues #174/#193):
 *
 * - 0.1.5/0.1.6 line — `SettingsProvider.installSection` registers the
 *   composition-row subset as the section's `base` layer under
 *   `~/.dsh/settings.yaml`; the user section overrides it.
 * - ≥0.1.7 line — `installSection` is gone; the service is `SettingsForms`,
 *   which addresses the profile ENTRY by id (same id as the bundle row,
 *   `compaction-acp`) and exposes exactly the fields the plugin's static
 *   Config schema marks `.volatile()` (`AcpPluginConfigSchema`). Writes land
 *   directly in the profile patch (there is no settings.yaml anymore — a
 *   legacy file is renamed `.imported` once and its sections fall back to
 *   same-id entries).
 *
 * The `/acp-prune config` slash command reads and writes the same namespace
 * through the `SettingsCommandSurface` built here on both lines.
 *
 * Deliberately NOT exposed through settings: `coreOverrides`, `countTokens`,
 * `autoTools`, `autoCommand`, `prompts` (object/function values or
 * construction-time registrations), and the `settingsEnabled` kill switch
 * itself (a switch that turns off its own plumbing could not be reached if
 * the plumbing broke).
 * @module billion-context-dsh/settings
 */

import z from '@deepseek-ai/schemastery'

/**
 * The host settings namespace — same id as the bundle/composition row, so "the
 * settings.yaml section" and "the cordis.patch.yml row" are one mental object.
 * A plain string literal as of the 0.1.5 line: the seam's `settingsNamespace()`
 * runtime helper is gone and the brand is applied at the call site instead
 * (`installSection`'s `Namespace & SettingsNamespaceInput<Namespace>`).
 */
export const ACP_SETTINGS_NAMESPACE = 'compaction-acp'

/** The six knobs exposed to the runtime settings layer. Order defines /acp-prune config listing order. */
export const SETTINGS_KEYS = [
  'modelContextLimit',
  'autoModelContextLimit',
  'nudgeMinContextLimitPct',
  'nudgeMaxContextLimitPct',
  'nudgeEmergencyThresholdPct',
  'autoNudge',
] as const

export type SettingsKey = (typeof SETTINGS_KEYS)[number]

/** Resolved shape of one settings snapshot — what every consumer read returns. */
export interface AcpSettings {
  /** Absent = auto-detection mode (probe the model's real window). */
  readonly modelContextLimit?: number
  readonly autoModelContextLimit: boolean
  /** Absent = the kernel's own 0.45 floor stays in effect. */
  readonly nudgeMinContextLimitPct?: number
  readonly nudgeMaxContextLimitPct: number
  readonly nudgeEmergencyThresholdPct: number
  readonly autoNudge: boolean
}

/** Input shape (everything optional — omitted keys fall back to defaults). */
export type AcpSettingsInput = Partial<AcpSettings>

/**
 * Engine defaults for the settings-exposed keys — MUST mirror
 * `DEFAULT_CONFIG` in src/index.ts (locked together by tests/settings.test.ts,
 * which compares these against the real DEFAULT_CONFIG field by field).
 */
export const SETTING_DEFAULTS = {
  autoModelContextLimit: true,
  nudgeMaxContextLimitPct: 0.7,
  nudgeEmergencyThresholdPct: 0.85,
  autoNudge: true,
} as const

/**
 * The subset of `AcpConfig` the settings layer may see. Declared structurally
 * (instead of importing AcpConfig) so this module stays dependency-free —
 * src/index.ts's `AcpConfig` satisfies it as-is.
 */
export interface AcpSettingsCompositionEntry {
  readonly modelContextLimit?: number
  readonly autoModelContextLimit?: boolean
  readonly nudgeMinContextLimitPct?: number
  readonly nudgeMaxContextLimitPct?: number
  readonly nudgeEmergencyThresholdPct?: number
  readonly autoNudge?: boolean
}

/**
 * Filter a composition-row config down to the settings-known scalar keys.
 * This filtered subset is the ONLY thing handed to the settings layer as its
 * `base`: the raw row also carries prompts/coreOverrides/countTokens — object
 * and function values that would flow into the stored resolved snapshot (the
 * settings resolver does not reject unknown keys) and pollute describe()/clone
 * paths downstream.
 */
export function filterSettingsEntry(entry: AcpSettingsCompositionEntry): AcpSettingsInput {
  return {
    ...(entry.modelContextLimit !== undefined ? { modelContextLimit: entry.modelContextLimit } : {}),
    ...(entry.autoModelContextLimit !== undefined ? { autoModelContextLimit: entry.autoModelContextLimit } : {}),
    ...(entry.nudgeMinContextLimitPct !== undefined ? { nudgeMinContextLimitPct: entry.nudgeMinContextLimitPct } : {}),
    ...(entry.nudgeMaxContextLimitPct !== undefined ? { nudgeMaxContextLimitPct: entry.nudgeMaxContextLimitPct } : {}),
    ...(entry.nudgeEmergencyThresholdPct !== undefined ? { nudgeEmergencyThresholdPct: entry.nudgeEmergencyThresholdPct } : {}),
    ...(entry.autoNudge !== undefined ? { autoNudge: entry.autoNudge } : {}),
  }
}

/**
 * Write symbol of the host's shared volatile-reference protocol
 * (@deepseek-ai/cosmokit `Volatile`). `Symbol.for` is deliberate: both sides
 * resolve to the SAME global symbol even when each realm holds its own copy
 * of cosmokit, which is what makes cross-realm detection below work.
 */
export const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** True for a host volatile config reference (`{ get(): snapshot }` carrying the write symbol). */
export function isVolatileRef(value: unknown): boolean {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/** Read one value out of (possibly ref-wrapped) config data without mutating anything. */
export function unwrapVolatile<T>(value: T | unknown): T | undefined {
  if (isVolatileRef(value)) return (value as { get(): T }).get()
  return value as T | undefined
}

/**
 * Re-read the six knobs through whatever volatile refs they are wrapped in.
 * The host loader hands the plugin its resolved config holding stable
 * references; SettingsForms commits form writes into those SAME references
 * between steps (and emits no event), so re-reading `.get()` here is how a
 * running session sees a just-saved change. Plain values pass through.
 */
export function liveSettingsFromRefs(entry: AcpSettingsInput): AcpSettingsInput {
  const out: Record<string, unknown> = {}
  for (const key of SETTINGS_KEYS) {
    const value = unwrapVolatile(entry[key])
    if (value !== undefined) out[key] = value
  }
  return out as AcpSettingsInput
}

/** Apply the engine defaults to a (possibly partial) settings input. */
export function resolveAcpSettings(input: AcpSettingsInput): AcpSettings {
  return {
    modelContextLimit: input.modelContextLimit,
    autoModelContextLimit: input.autoModelContextLimit ?? SETTING_DEFAULTS.autoModelContextLimit,
    nudgeMinContextLimitPct: input.nudgeMinContextLimitPct,
    nudgeMaxContextLimitPct: input.nudgeMaxContextLimitPct ?? SETTING_DEFAULTS.nudgeMaxContextLimitPct,
    nudgeEmergencyThresholdPct: input.nudgeEmergencyThresholdPct ?? SETTING_DEFAULTS.nudgeEmergencyThresholdPct,
    autoNudge: input.autoNudge ?? SETTING_DEFAULTS.autoNudge,
  }
}

/**
 * The settings schema. Defaults here are the ENGINE defaults (0.70/0.85),
 * not the kernel's 0.75/0.95 — an untouched namespace must reproduce exactly
 * today's behavior. Integer constraint uses `.step(1).min(1)` because
 * schemastery 3.18.x has no `.int()`/`.positive()` helpers.
 */
export const AcpSettingsSchema = z.object({
  modelContextLimit: z.number().step(1).min(1),
  autoModelContextLimit: z.boolean().default(SETTING_DEFAULTS.autoModelContextLimit),
  nudgeMinContextLimitPct: z.number().min(0).max(1),
  nudgeMaxContextLimitPct: z.number().min(0).max(1).default(SETTING_DEFAULTS.nudgeMaxContextLimitPct),
  nudgeEmergencyThresholdPct: z.number().min(0).max(1).default(SETTING_DEFAULTS.nudgeEmergencyThresholdPct),
  autoNudge: z.boolean().default(SETTING_DEFAULTS.autoNudge),
})

/**
 * The engine's static config schema — the class-level `Config` the host
 * loader validates composition rows against, and which SettingsForms (≥0.1.7
 * line) reads to build its settings form: every field marked `.volatile()`
 * becomes an editable row addressed by the profile entry id (`compaction-acp`).
 *
 * Deliberately carries NO defaults of its own: `AcpSettingsSchema` above
 * stays the single source of default values, and the explicit-value > preset >
 * engine-default layering is the preset layer's job to fill. A default here
 * would shadow a preset-filled base value in the live settings source.
 */
export const AcpPluginConfigSchema = z.object({
  modelContextLimit: z.number().step(1).min(1).volatile(),
  autoModelContextLimit: z.boolean().volatile(),
  nudgeMinContextLimitPct: z.number().min(0).max(1).volatile(),
  nudgeMaxContextLimitPct: z.number().min(0).max(1).volatile(),
  nudgeEmergencyThresholdPct: z.number().min(0).max(1).volatile(),
  autoNudge: z.boolean().volatile(),
})

/** What changed between two settings snapshots, and what the engine must do about it. */
export interface SettingsChangeEffect {
  /**
   * The per-route window cache (which also caches probe FAILURES) must be
   * dropped so the next step re-resolves windows under the new limits.
   */
  clearWindowCache: boolean
  /**
   * Re-enabling nudges clears the per-turn dedup map: entries written while
   * nudging was off must not suppress the first fresh nudge.
   */
  clearNudgeDedup: boolean
  /** Human-readable order-anomaly warnings. Accepted, not rejected — a rejected write cannot fix an externally-edited file anyway. */
  readonly warnings: readonly string[]
}

/** Pure diff used by the engine's change handler (unit-testable without a context). */
export function describeSettingsChange(prev: AcpSettings, next: AcpSettings): SettingsChangeEffect {
  const warnings: string[] = []
  // An anomaly warning is about the NEW state alone — it must not depend on
  // what the previous snapshot happened to define.
  if (
    next.nudgeMinContextLimitPct !== undefined
    && next.nudgeMinContextLimitPct >= next.nudgeMaxContextLimitPct
  ) {
    warnings.push(
      `nudgeMinContextLimitPct (${next.nudgeMinContextLimitPct}) >= nudgeMaxContextLimitPct (${next.nudgeMaxContextLimitPct}) — the lower bound never engages`,
    )
  }
  if (next.nudgeMaxContextLimitPct >= next.nudgeEmergencyThresholdPct) {
    warnings.push(
      `nudgeMaxContextLimitPct (${next.nudgeMaxContextLimitPct}) >= nudgeEmergencyThresholdPct (${next.nudgeEmergencyThresholdPct}) — the emergency tier loses its headroom`,
    )
  }
  return {
    clearWindowCache: prev.modelContextLimit !== next.modelContextLimit
      || prev.autoModelContextLimit !== next.autoModelContextLimit,
    clearNudgeDedup: prev.autoNudge === false && next.autoNudge === true,
    warnings,
  }
}

/** Result of parsing a `/acp-prune config set` value. `null` means "reset this key". */
export type ParsedSettingValue =
  | { ok: true; value: number | boolean | null }
  | { ok: false; reason: string }

/**
 * Four-step value parser for `/acp-prune config set` — deliberately NOT bare
 * JSON.parse, which rejects the most common human inputs (`.7` throws a
 * SyntaxError and the raw string would then fail schema validation; `null`
 * would silently mean "unset" only by convention). Order:
 * 1. `true` / `false` literals → booleans;
 * 2. anything Number() accepts finitely (`.7`, `2e5`, `200000`) → number;
 * 3. `null` (word) → reset-this-key sentinel;
 * 4. otherwise rejected with guidance.
 */
export function parseSettingValue(raw: string): ParsedSettingValue {
  const text = raw.trim()
  if (text === 'true') return { ok: true, value: true }
  if (text === 'false') return { ok: true, value: false }
  const num = Number(text)
  if (text !== '' && Number.isFinite(num)) return { ok: true, value: num }
  if (text === 'null') return { ok: true, value: null }
  return {
    ok: false,
    reason: `"${text}" is not a valid value — use a number (0.65), true/false, or null to reset the key`,
  }
}

/**
 * One row of the host settings service's `describe()` output, as this engine
 * consumes it. Declared structurally — no named import from
 * @deepseek-ai/dsh-settings — because the field set differs across seam lines
 * (`revision` exists only on the SettingsForms lines) and the engine must
 * compile against every line in its peer range. `ns` is `string | object`
 * because some seam lines brand it with a compile-time marker; consumers
 * compare through `String()`, never by identity.
 */
export interface AcpSettingsDescriptor {
  readonly ns: string | object
  readonly autoGenerate: boolean
  readonly value: Record<string, unknown>
  /** Present on the SettingsForms lines only; absent on the legacy line. */
  readonly revision?: string | number
  readonly base?: Record<string, unknown>
  readonly user?: Record<string, unknown>
  readonly applies?: 'live'
  readonly secrets?: ReadonlyArray<readonly string[]>
}

/** Everything `/acp-prune config` needs from the engine. Fakes in tests implement this directly. */
export interface SettingsCommandSurface {
  /** False in processes without a settings provider (plain npm-install compositions): the command degrades to advice instead of failing. */
  readonly available: boolean
  /** Current effective values (works with or without a provider). */
  snapshot(): AcpSettings
  /** Our namespace's descriptor (layers + revision), or undefined while unregistered. */
  describe(): AcpSettingsDescriptor | undefined
  /** Merge a patch into the user section and persist it. */
  update(patch: AcpSettingsInput): Promise<void>
  /** Replace the whole user section ({} resets everything to base/defaults). */
  replaceSection(section: Record<string, unknown>): Promise<void>
}

/**
 * Structural view of the host settings service surface this engine uses.
 * Declared structurally (no named import from @deepseek-ai/dsh-settings) so
 * the engine compiles against every line in its peer range: the 0.1.5 line's
 * type was `SettingsProvider`, dsh-settings ≥0.1.7 renamed the service to
 * `SettingsForms` and removed `installSection` entirely (its forms project
 * `.volatile()` Config fields instead). Which half actually runs is decided
 * at RUNTIME by the capability probe in `AcpCompactionEngine` (issue #173),
 * not by types.
 */
export interface AcpSettingsService {
  describe(options?: unknown): AcpSettingsDescriptor[]
  update(ns: string, patch: object, expectedRevision?: string | number): Promise<void>
  replace(ns: string, section: object, expectedRevision?: string | number): Promise<void>
}

/** The ≤0.1.6 lines only: the legacy settings.yaml section seam. */
export interface LegacySettingsService extends AcpSettingsService {
  installSection(
    owner: unknown,
    ns: string,
    schema: unknown,
    entry: AcpSettingsInput,
    hooks: {
      setSource(current: () => AcpSettingsInput): void
      onChange(): void
      validate?(value: AcpSettingsInput): void
    },
  ): void
}

function requireService(getService: () => AcpSettingsService | undefined): AcpSettingsService {
  const service = getService()
  if (service === undefined) {
    throw new Error('runtime settings are not available in this process')
  }
  return service
}

/**
 * Build the command surface over a lazily-captured settings service. The
 * engine captures the service through a parallel `ctx.inject(['settings'])`,
 * so the reference may legitimately be undefined for the whole process life
 * (headless/plain compositions have no settings provider).
 */
export function makeSettingsCommandSurface(
  getService: () => AcpSettingsService | undefined,
  getSnapshot: () => AcpSettings,
): SettingsCommandSurface {
  // Optimistic concurrency (SettingsForms lines): every write passes the
  // descriptor's last-seen revision, so two writers racing on the same entry
  // get a SettingsConflictError instead of a silent overwrite. Refreshed
  // right before each write (a successful write bumps the token); the legacy
  // line has no revision field and ignores the extra argument at runtime.
  let trackedRevision: string | number | undefined
  const findDescriptor = (): AcpSettingsDescriptor | undefined => {
    const service = getService()
    if (service === undefined) return undefined
    // `descriptor.ns` carries the seam's compile-time brand, which a plain
    // literal never satisfies — compare through String() instead.
    const descriptor = service.describe().find((row) => String(row.ns) === ACP_SETTINGS_NAMESPACE)
    if (descriptor?.revision !== undefined) trackedRevision = descriptor.revision
    return descriptor
  }
  return {
    get available() {
      return getService() !== undefined
    },
    snapshot: getSnapshot,
    describe: findDescriptor,
    async update(patch) {
      findDescriptor()
      await requireService(getService).update(ACP_SETTINGS_NAMESPACE, patch, trackedRevision)
    },
    async replaceSection(section) {
      findDescriptor()
      await requireService(getService).replace(ACP_SETTINGS_NAMESPACE, section, trackedRevision)
    },
  }
}
