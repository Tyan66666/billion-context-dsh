/**
 * M2 — per-session ACP kernel state.
 *
 * The in-memory map holds the exact acp-kernel `CompressionState` while a
 * session is live. Durability does not rely on a sidecar file: every durable
 * compression writes a `compaction/summary` event whose shadowed range and
 * summary re-derive the block ledger (`rebuildBlockLedger` in region.ts), so a
 * restarted engine can answer decompress/search/status from the session log
 * alone — DSH's "log is the source of truth" model.
 * @module billion-context-dsh/state
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { createInitialState, type CompressionState } from 'acp-kernel'

export class AcpStateStore {
  private readonly states = new Map<string, CompressionState>()

  /** Kernel state for one session, initialised on first access. */
  stateFor(session: Session): CompressionState {
    const id = session.id
    const existing = this.states.get(id)
    if (existing !== undefined) return existing
    const state = createInitialState()
    this.states.set(id, state)
    return state
  }

  set(session: Session, state: CompressionState): void {
    this.states.set(session.id, state)
  }

  delete(session: Session): void {
    this.states.delete(session.id)
  }
}
