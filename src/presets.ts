/**
 * Named presets for the nudge thresholds — how eagerly the model is asked to
 * compress, in one word instead of three hand-tuned percentages (issue #105).
 *
 * A preset is a bundle of the three first-class nudge-threshold knobs
 * (`nudgeMinContextLimitPct` / `nudgeMaxContextLimitPct` /
 * `nudgeEmergencyThresholdPct`). It does NOT touch any other knob: `modelContextLimit`,
 * `autoNudge`, prompts, and the `coreOverrides` escape hatch all stay exactly as
 * configured. The individual thresholds remain fully available and win over the
 * preset when both are set — precedence is explicit value > preset > engine
 * default (applied in `resolveAcpConfig`, src/index.ts), so a partial override
 * on top of a preset is honored.
 *
 * The five tiers form a monotonic spectrum from least to most aggressive
 * compression. `balanced` reproduces the current out-of-the-box engine defaults
 * exactly (min 0.45 = kernel default, max 0.70, emergency 0.85), so choosing it
 * changes nothing relative to today's behavior.
 *
 * Presets are set at composition time (`config: { preset: 'efficient' }`).
 * Runtime hot-reload of the underlying keys rides on issue #75 Phase 1
 * (`settings.yaml` + `/acp config`); surfacing the `preset` alias through that
 * same channel is the small follow-up once Phase 1 lands. The two knobs named in
 * the original request that are NOT first-class engine knobs today — `growthRatio`
 * (exists in acp-kernel as `nudge.growthRatio`, reachable via `coreOverrides`) and
 * `protectedLastMessages` (≈ kernel `preserveRecentMessages`) — are deliberately
 * out of scope here; adopting them as named knobs is an owner decision, not a
 * preset detail.
 * @module billion-context-dsh/presets
 */

/** The five preset tier names. */
export type PresetName = 'preserve' | 'relaxed' | 'balanced' | 'efficient' | 'aggressive'

/** The preset tiers ordered least → most aggressive (for help text / display). */
export const PRESET_NAMES: readonly PresetName[] = [
  'preserve',
  'relaxed',
  'balanced',
  'efficient',
  'aggressive',
] as const

/** One preset tier: a human label plus the three nudge-threshold values it sets. */
export interface NudgePreset {
  /** Plain-language one-liner describing the tier's trade-off. */
  readonly label: string
  /** Nudge window lower bound (usage fraction; the threshold gate floor). */
  readonly nudgeMinContextLimitPct: number
  /** Over-limit guarantee line — above this the nudge fires regardless of growth. */
  readonly nudgeMaxContextLimitPct: number
  /** Emergency nudge threshold (bypasses the per-turn dedup). */
  readonly nudgeEmergencyThresholdPct: number
}

/**
 * The five tiers. Every row satisfies the kernel invariant
 * `min ≤ max ≤ emergency` (acp-kernel `validateConfig` rejects the reverse), and
 * all three values move monotonically toward "compress sooner" as you go down
 * the list. Values are fractions of the context window, not token counts.
 */
export const PRESETS: Readonly<Record<PresetName, NudgePreset>> = {
  preserve: {
    label: 'keep context as long as possible — nudge only close to the limit',
    nudgeMinContextLimitPct: 0.55,
    nudgeMaxContextLimitPct: 0.78,
    nudgeEmergencyThresholdPct: 0.93,
  },
  relaxed: {
    label: 'light-touch compression — nudges a little earlier than preserve',
    nudgeMinContextLimitPct: 0.5,
    nudgeMaxContextLimitPct: 0.75,
    nudgeEmergencyThresholdPct: 0.9,
  },
  balanced: {
    // == the current out-of-the-box engine defaults (kernel min 0.45, engine
    // max 0.70, engine emergency 0.85): choosing this changes nothing vs today.
    label: 'default balance — the same thresholds the plugin ships with',
    nudgeMinContextLimitPct: 0.45,
    nudgeMaxContextLimitPct: 0.7,
    nudgeEmergencyThresholdPct: 0.85,
  },
  efficient: {
    label: 'trim more often — favors low token usage over keeping full history',
    nudgeMinContextLimitPct: 0.4,
    nudgeMaxContextLimitPct: 0.6,
    nudgeEmergencyThresholdPct: 0.78,
  },
  aggressive: {
    label: 'lean context — compresses early and frequently',
    nudgeMinContextLimitPct: 0.3,
    nudgeMaxContextLimitPct: 0.5,
    nudgeEmergencyThresholdPct: 0.7,
  },
}

/** Type guard: true when `value` is one of the five preset names. */
export function isPresetName(value: unknown): value is PresetName {
  return typeof value === 'string' && (PRESET_NAMES as readonly string[]).includes(value)
}

/**
 * Resolve a preset name to its tier. Throws on an unknown name so a typo in the
 * composition config fails engine construction loudly (the same fail-fast
 * contract as prompt-template validation) rather than silently falling back to
 * the engine defaults.
 */
export function resolvePreset(name: string): NudgePreset {
  if (!isPresetName(name)) {
    throw new Error(`unknown preset "${name}" — valid presets: ${PRESET_NAMES.join(', ')}`)
  }
  return PRESETS[name]
}
