/**
 * M2 — per-session ACP kernel state.
 *
 * The in-memory map holds the exact acp-kernel `CompressionState` while a
 * session is live. Durability does not rely on a sidecar file: every durable
 * compression writes a `compaction/summary` event whose shadowed range and
 * summary re-derive the block ledger (`rebuildBlockLedger` in region.ts), so a
 * restarted engine can answer decompress/search/status from the session log
 * alone — DSH's "log is the source of truth" model.
 *
 * Tier-2/3 distillation additionally requires the kernel state to KNOW the
 * blocks: `syncBlocks` deactivates a block whose consumed messages are absent
 * from the message array, and `resolveBoundaries` refuses to anchor a block
 * ref it cannot find — so on first access for a session that already has
 * durable blocks (e.g. after a server restart), the kernel blocks are
 * REHYDRATED from the ledger before use. Live updates continue through `set`.
 * @module billion-context-dsh/state
 */
import type { Session } from '@deepseek-ai/dsh-session';
import { type CompressionState } from 'acp-kernel';
export declare class AcpStateStore {
    private readonly states;
    /** Kernel state for one session, initialised on first access. */
    stateFor(session: Session): CompressionState;
    set(session: Session, state: CompressionState): void;
    delete(session: Session): void;
}
