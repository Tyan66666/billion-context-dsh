/**
 * M6 — runtime settings integration. Wires the engine's scalar knobs into the
 * host's user-settings layer (`~/.dsh/settings.yaml`, section
 * `compaction-acp`) through the official consumer seam
 * `installSettingsSection` (@deepseek-ai/dsh-settings), so editing the file
 * applies to RUNNING sessions without a restart.
 *
 * Layering (per key): schemastery schema default → composition-row subset
 * (the `base` layer, filtered by `filterSettingsEntry`) → user section.
 * The `/acp config` slash command reads and writes the same namespace
 * through the `SettingsCommandSurface` built here.
 *
 * Deliberately NOT exposed through settings: `coreOverrides`, `countTokens`,
 * `autoTools`, `autoCommand`, `prompts` (object/function values or
 * construction-time registrations), and the `settingsEnabled` kill switch
 * itself (a switch that turns off its own plumbing could not be reached if
 * the plumbing broke).
 * @module billion-context-dsh/settings
 */

import z from '@deepseek-ai/schemastery'
import {
  settingsNamespace,
  type SettingsDescriptor,
  type SettingsProvider,
} from '@deepseek-ai/dsh-settings'

/** The host settings namespace — same id as the bundle/composition row, so "the settings.yaml section" and "the cordis.patch.yml row" are one mental object. */
export const ACP_SETTINGS_NAMESPACE = settingsNamespace('compaction-acp')

/** The six knobs exposed to the runtime settings layer. Order defines /acp config listing order. */
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

/** Result of parsing a `/acp config set` value. `null` means "reset this key". */
export type ParsedSettingValue =
  | { ok: true; value: number | boolean | null }
  | { ok: false; reason: string }

/**
 * Four-step value parser for `/acp config set` — deliberately NOT bare
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

/** Everything `/acp config` needs from the engine. Fakes in tests implement this directly. */
export interface SettingsCommandSurface {
  /** False in processes without a settings provider (plain npm-install compositions): the command degrades to advice instead of failing. */
  readonly available: boolean
  /** Current effective values (works with or without a provider). */
  snapshot(): AcpSettings
  /** Our namespace's descriptor (layers + revision), or undefined while unregistered. */
  describe(): SettingsDescriptor | undefined
  /** Merge a patch into the user section and persist it. */
  update(patch: AcpSettingsInput): Promise<void>
  /** Replace the whole user section ({} resets everything to base/defaults). */
  replaceSection(section: Record<string, unknown>): Promise<void>
}

function requireService(getService: () => SettingsProvider | undefined): SettingsProvider {
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
  getService: () => SettingsProvider | undefined,
  getSnapshot: () => AcpSettings,
): SettingsCommandSurface {
  return {
    get available() {
      return getService() !== undefined
    },
    snapshot: getSnapshot,
    describe() {
      const service = getService()
      if (service === undefined) return undefined
      return service.describe().find((descriptor) => descriptor.ns === ACP_SETTINGS_NAMESPACE)
    },
    async update(patch) {
      await requireService(getService).update(ACP_SETTINGS_NAMESPACE, patch)
    },
    async replaceSection(section) {
      await requireService(getService).replace(ACP_SETTINGS_NAMESPACE, section)
    },
  }
}
