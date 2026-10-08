/**
 * M6 — runtime settings integration. Exposes the engine's scalar knobs in the
 * host's per-profile settings layer under the section `compaction-acp`, so
 * editing it applies to RUNNING sessions without a restart.
 *
 * On the 0.2.0 line the section is projected from each plugin's OWN
 * `static Config` schema by dsh-settings' `SettingsForms` (ctx.settings) —
 * there is no consumer-side installSection anymore. This engine declares no
 * static Config yet (tracked follow-up: authoring the full AcpConfig schema
 * against cosmokit's validation strictness), so the service handle is never
 * captured on this line and `/acp-prune config` degrades to advice; the pure
 * helpers below keep feeding the live snapshot every knob consumer reads.
 *
 * Layering (per key): schemastery schema default → composition-row subset
 * (the `base` layer, filtered by `filterSettingsEntry`) → user section.
 * The `/acp-prune config` slash command reads and writes the same namespace
 * through the `SettingsCommandSurface` built here.
 *
 * Deliberately NOT exposed through settings: `coreOverrides`, `countTokens`,
 * `autoTools`, `autoCommand`, `prompts` (object/function values or
 * construction-time registrations), and the `settingsEnabled` kill switch
 * itself (a switch that turns off its own plumbing could not be reached if
 * the plumbing broke).
 * @module billion-context-dsh/settings
 */
import z from '@deepseek-ai/schemastery';
import type { SettingsDescriptor } from '@deepseek-ai/dsh-settings';
/**
 * The slice of the host's settings service this engine drives. Structural on
 * purpose: the 0.2.0 line satisfies it with `SettingsForms` (ctx.settings),
 * whose describe()/update()/replace() signatures match exactly, and test
 * fakes need only these three methods.
 */
export interface AcpSettingsService {
    describe(options?: {
        redactSecrets?: boolean;
    }): readonly SettingsDescriptor[];
    update(ns: string, patch: object, expectedRevision?: number): Promise<void>;
    replace(ns: string, section: object, expectedRevision?: number): Promise<void>;
}
/**
 * The host settings namespace — same id as the bundle/composition row, so "the
 * profile patch section" and "the cordis.patch.yml row" are one mental object.
 * A plain string: SettingsForms' write methods take the unbranded entry id.
 */
export declare const ACP_SETTINGS_NAMESPACE = "compaction-acp";
/** The six knobs exposed to the runtime settings layer. Order defines /acp-prune config listing order. */
export declare const SETTINGS_KEYS: readonly ['modelContextLimit', 'autoModelContextLimit', 'nudgeMinContextLimitPct', 'nudgeMaxContextLimitPct', 'nudgeEmergencyThresholdPct', 'autoNudge'];
export type SettingsKey = (typeof SETTINGS_KEYS)[number];
/** Resolved shape of one settings snapshot — what every consumer read returns. */
export interface AcpSettings {
    /** Absent = auto-detection mode (probe the model's real window). */
    readonly modelContextLimit?: number;
    readonly autoModelContextLimit: boolean;
    /** Absent = the kernel's own 0.45 floor stays in effect. */
    readonly nudgeMinContextLimitPct?: number;
    readonly nudgeMaxContextLimitPct: number;
    readonly nudgeEmergencyThresholdPct: number;
    readonly autoNudge: boolean;
}
/** Input shape (everything optional — omitted keys fall back to defaults). */
export type AcpSettingsInput = Partial<AcpSettings>;
/**
 * Engine defaults for the settings-exposed keys — MUST mirror
 * `DEFAULT_CONFIG` in src/index.ts (locked together by tests/settings.test.ts,
 * which compares these against the real DEFAULT_CONFIG field by field).
 */
export declare const SETTING_DEFAULTS: {
    readonly autoModelContextLimit: true;
    readonly nudgeMaxContextLimitPct: 0.7;
    readonly nudgeEmergencyThresholdPct: 0.85;
    readonly autoNudge: true;
};
/**
 * The subset of `AcpConfig` the settings layer may see. Declared structurally
 * (instead of importing AcpConfig) so this module stays dependency-free —
 * src/index.ts's `AcpConfig` satisfies it as-is.
 */
export interface AcpSettingsCompositionEntry {
    readonly modelContextLimit?: number;
    readonly autoModelContextLimit?: boolean;
    readonly nudgeMinContextLimitPct?: number;
    readonly nudgeMaxContextLimitPct?: number;
    readonly nudgeEmergencyThresholdPct?: number;
    readonly autoNudge?: boolean;
}
/**
 * Filter a composition-row config down to the settings-known scalar keys.
 * This filtered subset is the ONLY thing handed to the settings layer as its
 * `base`: the raw row also carries prompts/coreOverrides/countTokens — object
 * and function values that would flow into the stored resolved snapshot (the
 * settings resolver does not reject unknown keys) and pollute describe()/clone
 * paths downstream.
 */
export declare function filterSettingsEntry(entry: AcpSettingsCompositionEntry): AcpSettingsInput;
/** Apply the engine defaults to a (possibly partial) settings input. */
export declare function resolveAcpSettings(input: AcpSettingsInput): AcpSettings;
/**
 * The settings schema. Defaults here are the ENGINE defaults (0.70/0.85),
 * not the kernel's 0.75/0.95 — an untouched namespace must reproduce exactly
 * today's behavior. Integer constraint uses `.step(1).min(1)` because
 * schemastery 3.18.x has no `.int()`/`.positive()` helpers.
 */
export declare const AcpSettingsSchema: z<Schemastery.ObjectS<NoInfer<{
    modelContextLimit: z<number, number, "plain">;
    autoModelContextLimit: z<boolean, boolean, "defined">;
    nudgeMinContextLimitPct: z<number, number, "plain">;
    nudgeMaxContextLimitPct: z<number, number, "defined">;
    nudgeEmergencyThresholdPct: z<number, number, "defined">;
    autoNudge: z<boolean, boolean, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    modelContextLimit: z<number, number, "plain">;
    autoModelContextLimit: z<boolean, boolean, "defined">;
    nudgeMinContextLimitPct: z<number, number, "plain">;
    nudgeMaxContextLimitPct: z<number, number, "defined">;
    nudgeEmergencyThresholdPct: z<number, number, "defined">;
    autoNudge: z<boolean, boolean, "defined">;
}>>, "plain">;
/** What changed between two settings snapshots, and what the engine must do about it. */
export interface SettingsChangeEffect {
    /**
     * The per-route window cache (which also caches probe FAILURES) must be
     * dropped so the next step re-resolves windows under the new limits.
     */
    clearWindowCache: boolean;
    /**
     * Re-enabling nudges clears the per-turn dedup map: entries written while
     * nudging was off must not suppress the first fresh nudge.
     */
    clearNudgeDedup: boolean;
    /** Human-readable order-anomaly warnings. Accepted, not rejected — a rejected write cannot fix an externally-edited file anyway. */
    readonly warnings: readonly string[];
}
/** Pure diff used by the engine's change handler (unit-testable without a context). */
export declare function describeSettingsChange(prev: AcpSettings, next: AcpSettings): SettingsChangeEffect;
/** Result of parsing a `/acp-prune config set` value. `null` means "reset this key". */
export type ParsedSettingValue = {
    ok: true;
    value: number | boolean | null;
} | {
    ok: false;
    reason: string;
};
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
export declare function parseSettingValue(raw: string): ParsedSettingValue;
/** Everything `/acp-prune config` needs from the engine. Fakes in tests implement this directly. */
export interface SettingsCommandSurface {
    /** False in processes without a settings provider (plain npm-install compositions): the command degrades to advice instead of failing. */
    readonly available: boolean;
    /** Current effective values (works with or without a provider). */
    snapshot(): AcpSettings;
    /** Our namespace's descriptor (layers + revision), or undefined while unregistered. */
    describe(): SettingsDescriptor | undefined;
    /** Merge a patch into the user section and persist it. */
    update(patch: AcpSettingsInput): Promise<void>;
    /** Replace the whole user section ({} resets everything to base/defaults). */
    replaceSection(section: Record<string, unknown>): Promise<void>;
}
/**
 * Build the command surface over a lazily-captured settings service. The
 * reference is undefined for the whole process life until the host registers
 * our section (on the 0.2.0 line that requires the engine's own `static
 * Config` schema); while it is, the surface reports unavailable and the
 * command degrades to advice.
 */
export declare function makeSettingsCommandSurface(getService: () => AcpSettingsService | undefined, getSnapshot: () => AcpSettings): SettingsCommandSurface;
