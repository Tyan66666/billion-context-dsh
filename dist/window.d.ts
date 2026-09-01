/**
 * Auto context-window detection — resolve the model's real context window
 * from the host LLM runtime instead of trusting a hardcoded config default.
 *
 * `agent.ctx.llm` (the cordis `LlmRuntime` service) exposes
 * `resolveModelInfo(provider, model)` → `{ context: { contextWindow } }`, the
 * exact-route capacity the adapter learned from the provider API (pi-ai reads
 * `context_window`/`context_length` during discovery). Probing is a standalone
 * capability query — no request is sent.
 * @module billion-context-dsh/window
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
/** Fallback window when auto-detection is unavailable. Same default as acp-kernel's `defaultConfig`. */
export declare const DEFAULT_CONTEXT_WINDOW = 128000;
/** The effective context window plus where it came from. */
export interface AcpWindow {
    /** Effective context window in tokens. */
    readonly limit: number;
    /** Where the limit came from. */
    readonly source: 'explicit' | 'auto' | 'projection' | 'default';
    /**
     * Route the window was resolved for. 'auto' reports the probed route;
     * 'projection' returns also set it, mirroring agent.options — which can be
     * stale after a mid-session model switch (inert today: windowSourceLabel
     * never reads these fields for the projection source).
     */
    readonly provider?: string;
    readonly model?: string;
    /**
     * True only when auto-detection was ATTEMPTED and failed (the probe threw or
     * the model API disclosed no window), so the fallback limit is in use. Not
     * set for explicit config, a successful probe, or disabled auto-detection —
     * those must not look like a failure (issue #63: a misconfigured gateway
     * silently fell back to 128K and produced false emergency nudges).
     */
    readonly probeFailed?: boolean;
}
/** Human label for an AcpWindow's source (used by /acp status). */
export declare function windowSourceLabel(window: AcpWindow): string;
/**
 * Read the live context window from the host session projection
 * (`contextPressure.contextWindow` — the newest recorded route capacity).
 * This tracks the session's CURRENT route: after a mid-session model switch
 * `agent.options.provider/model` stays a stale snapshot, so probing THAT route
 * yields the previous model's window (a 1M-window session read as ~96K →
 * false EMERGENCY nudges at 300%+ usage). The projection is refreshed by the
 * host on every request, so it follows the real model without any config.
 * Returns null when the host exposes no projection or disclosed no window.
 */
export declare function projectedContextWindow(agent: Agent): number | null;
/**
 * Probe the model's real context window. Returns null when the host provides
 * no llm service, the adapter discloses no window, or the probe throws —
 * callers fall back to DEFAULT_CONTEXT_WINDOW. Never throws.
 */
export declare function detectContextWindow(agent: Agent, provider: string, model: string): Promise<number | null>;
