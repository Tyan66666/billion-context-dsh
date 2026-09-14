/**
 * Cross-version session event access.
 *
 * History: DSH `0.1.2-alpha` replaced the public `Session.events` getter with
 * explicit `snapshotEvents()` / `eventAt(seq)` methods (only rc.6 /
 * 0.1.1-rc.x had `events`). Both shapes are feature-detected here; since the
 * peer floor moved to the 0.1.5 line (`>=0.1.5-alpha.1 <0.1.6-0`, issue #136),
 * every supported seam exposes the method pair — dsh-session 0.1.5 has no
 * public `.events` getter — so the `events` fallback is defensive robustness
 * for foreign or stub handles, not a supported-host path.
 *
 * Semantics:
 *  - `snapshotEvents()` returns the current full log as a stable, cached
 *    snapshot (reused until the next append), with `seq === array index`.
 *  - indexed reads map to `eventAt(seq)` (or `events[seq]` on the legacy
 *    shape) with the same `undefined`-when-absent contract.
 * @module billion-context-dsh/session-events
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** Session surface extended with the 0.1.2-alpha read methods (optional). */
type SessionWithSnapshot = Session & {
  snapshotEvents?: () => readonly SessionEvent[]
  eventAt?: (seq: number) => SessionEvent | undefined
}

/** Session surface narrowed to the rc.6 public events getter. */
type SessionWithEvents = Session & {
  events: readonly SessionEvent[]
}

/** All events of a session in log order (seq == array index). */
export function sessionEventsOf(session: Session): readonly SessionEvent[] {
  const snapshot = (session as SessionWithSnapshot).snapshotEvents?.()
  if (snapshot !== undefined) return snapshot
  return (session as SessionWithEvents).events
}

/**
 * The event at one exact seq, or undefined when the log has no such seq.
 * Falls back through `sessionEventsOf` (snapshotEvents → events) so a
 * snapshot-only handle stays readable; yields undefined, never throws,
 * when a handle exposes neither read method.
 */
export function eventAtOf(session: Session, seq: number): SessionEvent | undefined {
  const eventAt = (session as SessionWithSnapshot).eventAt
  if (typeof eventAt === 'function') return eventAt.call(session, seq)
  return sessionEventsOf(session)?.[seq]
}
