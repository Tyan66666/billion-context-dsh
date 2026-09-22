/**
 * DSH >= 0.1.7 renames host rows OUT of the plugin namespace into DIRECT
 * kinds without any plugin field (the V3→V4 migration's rename map, audited
 * from @deepseek-ai/dsh-session-persistence-jsonl 0.1.7-alpha.1's worker):
 *
 *   '@deepseek-ai/dsh-system-prompt' -> 'runtime-context'
 *   'tools-ptc' / 'tools-code-mode'  -> 'ptc-mode'
 *   'dsh-compaction-basic'           -> 'compact-basic'
 *
 * Pre-migration logs keep the legacy plugin shape, so both spellings must
 * classify identically (issue #169). Without a direct-kind table a renamed
 * row carries no `source.plugin` to match against: it fell through the
 * classifier as generic real content AND won "last real user message"
 * protection — the issue #71 bug class recurring on the 0.1.7 shapes.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { classifySurfaceEvent, isRealUserTurn } from '../src/messages.ts'
import { buildCompressibleSeqRanges } from '../src/region.ts'
import { sessionEventsOf } from '../src/session-events.ts'
import { appendAssistant, appendTurn, appendUser, longText, wholeSurfaceRangeView } from './helpers.ts'

/** One fake surface event with an arbitrary source payload (unit level). */
function ev(source: Record<string, unknown> | undefined): never {
  return { type: 'user/message', seq: 1, data: { source } } as never
}

/** Append a user/message row with an arbitrary source payload; return its seq. */
function appendWithSource(session: Session, source: Record<string, unknown>): number {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: longText('host-row', 0) }],
    source,
  }), { surfaceOp: 'append' })
  return sessionEventsOf(session).length - 1
}

/**
 * Two turns of real conversation, then a trailing host row of the given
 * source shape. Returns the session, the seq of the REAL last user turn, and
 * the trailing row's seq — the exact layout where the protection window used
 * to anchor to the injected row instead of the user's words (issue #71 PR1,
 * now the 0.1.7 direct-kind shapes).
 */
function sessionWithTrailingRow(source: Record<string, unknown>): { session: Session; realLastUser: number; trailing: number } {
  const session = Session.create('v4-direct-kind-tail')
  appendTurn(session, 1)
  appendUser(session, longText('q0', 0))              // seq 1
  appendAssistant(session, longText('a0', 1), 1, 1)   // seq 2
  const realLastUser = sessionEventsOf(session).length
  appendUser(session, longText('q1', 2))              // seq 3 — the real last user turn
  appendAssistant(session, longText('a1', 3), 1, 3)   // seq 4
  const trailing = appendWithSource(session, source)  // seq 5
  return { session, realLastUser, trailing }
}

test('renamed host content channels (direct kinds) are real content, never the user turn', () => {
  for (const kind of ['runtime-context', 'ptc-mode']) {
    assert.equal(classifySurfaceEvent(ev({ kind })), 'real', `${kind}: foldable content`)
    assert.equal(isRealUserTurn(ev({ kind })), false, `${kind}: must not win protection`)
  }
})

test('compact-basic (host compaction summary row) is a barrier, like its legacy unknown-plugin shape', () => {
  const e = ev({ kind: 'compact-basic' })
  assert.equal(classifySurfaceEvent(e), 'instruction')
  assert.equal(isRealUserTurn(e), false)
})

test('an unaudited direct kind is a barrier until proven otherwise', () => {
  const e = ev({ kind: 'some-future-host-channel' })
  assert.equal(classifySurfaceEvent(e), 'instruction')
  assert.equal(isRealUserTurn(e), false)
})

test('legacy plugin shapes keep their pre-0.1.7 classification (rename parity)', () => {
  // The renamed channels under their OLD names still classify the same way.
  assert.equal(classifySurfaceEvent(ev({ kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' })), 'real')
  assert.equal(classifySurfaceEvent(ev({ kind: 'plugin', plugin: 'tools-ptc' })), 'real')
  assert.equal(classifySurfaceEvent(ev({ kind: 'plugin', plugin: 'user-approval' })), 'real')
  assert.equal(isRealUserTurn(ev({ kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' })), false)
  // dsh-compaction-basic was never whitelisted: unknown plugin -> instruction.
  assert.equal(classifySurfaceEvent(ev({ kind: 'plugin', plugin: 'dsh-compaction-basic' })), 'instruction')
  // Unrelated pins: user turns, source-less rows, and kind-less sources are unchanged.
  assert.equal(classifySurfaceEvent(ev({ kind: 'user' })), 'real')
  assert.equal(isRealUserTurn(ev({ kind: 'user' })), true)
  assert.equal(classifySurfaceEvent(ev(undefined)), 'real')
  assert.equal(isRealUserTurn(ev(undefined)), true)
  assert.equal(classifySurfaceEvent(ev({})), 'real')
  assert.equal(isRealUserTurn(ev({})), true)
  assert.equal(classifySurfaceEvent(ev({ kind: 'subagent-report' })), 'real')
  assert.equal(isRealUserTurn(ev({ kind: 'subagent-report' })), false)
})

test('a trailing runtime-context snapshot row does not win last-real-user protection', () => {
  const { session, realLastUser, trailing } = sessionWithTrailingRow({ kind: 'runtime-context' })
  const ranges = buildCompressibleSeqRanges(session, wholeSurfaceRangeView(session), { preserveRecent: 0 })
  const covers = (seq: number) => ranges.some((r) => r.start <= seq && seq <= r.end)
  assert.equal(covers(realLastUser), false, 'the real last user turn stays protected')
  assert.equal(covers(trailing), true, 'the snapshot row is foldable content, not a barrier')
})

test('a trailing ptc-mode row is foldable and does not win protection', () => {
  const { session, realLastUser, trailing } = sessionWithTrailingRow({ kind: 'ptc-mode' })
  const ranges = buildCompressibleSeqRanges(session, wholeSurfaceRangeView(session), { preserveRecent: 0 })
  const covers = (seq: number) => ranges.some((r) => r.start <= seq && seq <= r.end)
  assert.equal(covers(realLastUser), false, 'the real last user turn stays protected')
  assert.equal(covers(trailing), true, 'deferred tool context folds like its legacy tools-ptc rows')
})

test('a trailing compact-basic row is a barrier and does not win protection', () => {
  const { session, realLastUser, trailing } = sessionWithTrailingRow({ kind: 'compact-basic' })
  const ranges = buildCompressibleSeqRanges(session, wholeSurfaceRangeView(session), { preserveRecent: 0 })
  const covers = (seq: number) => ranges.some((r) => r.start <= seq && seq <= r.end)
  assert.equal(covers(realLastUser), false, 'the real last user turn stays protected')
  assert.equal(covers(trailing), false, 'the barrier row is never offered')
})

test('legacy-shape snapshot rows behave identically (pre-migration parity)', () => {
  const { session, realLastUser, trailing } = sessionWithTrailingRow({
    kind: 'plugin',
    plugin: '@deepseek-ai/dsh-system-prompt',
  })
  const ranges = buildCompressibleSeqRanges(session, wholeSurfaceRangeView(session), { preserveRecent: 0 })
  const covers = (seq: number) => ranges.some((r) => r.start <= seq && seq <= r.end)
  assert.equal(covers(realLastUser), false, 'the real last user turn stays protected')
  assert.equal(covers(trailing), true, 'both spellings of the channel classify identically')
})
