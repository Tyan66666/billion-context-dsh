/**
 * Local tool-pairing balance checks over the session surface.
 *
 * UPSTREAM: `@deepseek-ai/dsh-compaction@0.1.2-rc.1` reads the REMOVED
 * `session.events` API in its balance cache — `extendCache` does
 * `const events = session.events` and `eventForSeq` does `events[seq]`, so on
 * every dsh 0.1.2 host the official `toolPairingBalancedBefore/After` helpers
 * throw `TypeError: Cannot read properties of undefined (reading '<seq>')`.
 * The host's API docs require compaction backends to use these helpers for
 * edge checks, and the host's own `dsh-compaction-basic` calls them too, so
 * ALL compaction on a 0.1.2-rc.1 host crashes (reproduced offline and pinned
 * in issue #124; tracked in docs/dsh-porting-verification.md).
 *
 * This module mirrors the host's algorithm line for line (per-session cache
 * keyed by `surface.replaceGeneration`, the `cutBalanced` fold, identical
 * error messages) with ONE deliberate difference: events are read through the
 * cross-version accessor `eventAtOf` (src/session-events.ts), which works on
 * both the 0.1.0/0.1.1 lines (`events[seq]`) and 0.1.2+ (`eventAt(seq)`).
 * DELETE this module and switch `src/region.ts` back to
 * `@deepseek-ai/dsh-compaction`'s helpers the moment the host fix ships.
 */
import type { Session } from '@deepseek-ai/dsh-session';
/**
 * Whether the cut immediately before a current surface sequence is tool-pairing balanced.
 * @param session - session whose surface is checked.
 * @param seq - event sequence whose leading cut is checked.
 * @returns true when no unanswered tool call crosses the cut.
 */
export declare function toolPairingBalancedBefore(session: Session, seq: number): boolean;
/**
 * Whether the cut immediately after a current surface sequence is tool-pairing balanced.
 * @param session - session whose surface is checked.
 * @param seq - event sequence whose trailing cut is checked.
 * @returns true when no unanswered tool call crosses the cut.
 */
export declare function toolPairingBalancedAfter(session: Session, seq: number): boolean;
