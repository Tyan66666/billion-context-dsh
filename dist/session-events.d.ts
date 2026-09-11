/**
 * Cross-version session event access.
 *
 * DSH `0.1.2-alpha` replaced the public `Session.events` getter with explicit
 * `snapshotEvents()` / `eventAt(seq)` methods; rc.6 / 0.1.1-rc.x still expose
 * `events`. Both shapes are feature-detected here so a single build runs on
 * either seam (the engine's peer range keeps `^0.1.0-rc.6 || ^0.1.1-rc.1`).
 *
 * Semantics match on both sides:
 *  - `events` (rc.6) and `snapshotEvents()` (0.1.2-alpha) both return the
 *    current full log as a stable, cached snapshot (reused until the next
 *    append), with `seq === array index`.
 *  - indexed reads map to `events[seq]` / `eventAt(seq)` with the same
 *    `undefined`-when-absent contract.
 * @module billion-context-dsh/session-events
 */
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
/** All events of a session in log order (seq == array index). */
export declare function sessionEventsOf(session: Session): readonly SessionEvent[];
/** The event at one exact seq, or undefined when the log has no such seq. */
export declare function eventAtOf(session: Session, seq: number): SessionEvent | undefined;
