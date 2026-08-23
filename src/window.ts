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

import type { Agent } from '@deepseek-ai/dsh-agent'

/** Fallback window when auto-detection is unavailable. Same default as acp-kernel's `defaultConfig`. */
export const DEFAULT_CONTEXT_WINDOW = 128000

/** The effective context window plus where it came from. */
export interface AcpWindow {
  /** Effective context window in tokens. */
  readonly limit: number
  /** Where the limit came from. */
  readonly source: 'explicit' | 'auto' | 'default'
  /** Route the auto window was resolved for (auto source only). */
  readonly provider?: string
  readonly model?: string
  /**
   * True only when auto-detection was ATTEMPTED and failed (the probe threw or
   * the model API disclosed no window), so the fallback limit is in use. Not
   * set for explicit config, a successful probe, or disabled auto-detection —
   * those must not look like a failure (issue #63: a misconfigured gateway
   * silently fell back to 128K and produced false emergency nudges).
   */
  readonly probeFailed?: boolean
}

/** Human label for an AcpWindow's source (used by /acp status). */
export function windowSourceLabel(window: AcpWindow): string {
  if (window.source === 'explicit') return 'configured'
  if (window.source === 'auto') {
    return `auto-detected from ${window.provider ?? '?'}/${window.model ?? '?'}`
  }
  if (window.probeFailed === true) return 'default (auto-detection failed — restart to re-probe)'
  return 'default (auto-detection unavailable)'
}

/** The minimal LlmRuntime surface the probe needs (structural — no as any). */
interface LlmProbe {
  resolveModelInfo?: (
    provider: string,
    model: string,
    signal?: AbortSignal,
  ) => Promise<{ context?: { contextWindow?: number } }>
}

/**
 * Probe the model's real context window. Returns null when the host provides
 * no llm service, the adapter discloses no window, or the probe throws —
 * callers fall back to DEFAULT_CONTEXT_WINDOW. Never throws.
 */
export async function detectContextWindow(
  agent: Agent,
  provider: string,
  model: string,
): Promise<number | null> {
  const llm = agent.ctx?.get?.('llm') as LlmProbe | undefined
  if (llm?.resolveModelInfo === undefined) return null
  try {
    const info = await llm.resolveModelInfo(provider, model)
    const window = info?.context?.contextWindow
    if (typeof window === 'number' && Number.isInteger(window) && window > 0) return window
    return null
  } catch {
    return null
  }
}
