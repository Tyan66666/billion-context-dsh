/**
 * Issue #124 regression — the host's tool-pairing balance helpers
 * (`@deepseek-ai/dsh-compaction` `toolPairingBalancedBefore/After`) read the
 * REMOVED `session.events` API and crash on every dsh 0.1.2 session with
 * `TypeError: Cannot read properties of undefined (reading '<seq>')`. The
 * engine therefore uses a local mirror (src/tool-pairing.ts) whose only
 * difference is reading events through the cross-version accessor.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  toolPairingBalancedAfter as hostAfter,
  toolPairingBalancedBefore as hostBefore,
} from '@deepseek-ai/dsh-compaction'
import { resolveSurfaceRange } from '../src/region.ts'
import {
  toolPairingBalancedAfter as localAfter,
  toolPairingBalancedBefore as localBefore,
} from '../src/tool-pairing.ts'
import { sessionEventsOf } from '../src/session-events.ts'
import { appendToolCall, appendToolResult, appendTurn, appendUser, longText } from './helpers.ts'

/** Mirrors the battle-report fixture in region.test.ts: surface [1 user, 2 tool-call, 3 tool/result, 4 user]. */
function buildPairSession(): Session {
  const session = Session.create('tool-pair-124')
  appendTurn(session, 1)
  appendUser(session, longText('q1', 1))
  appendToolCall(session, 'checking the docs', 'call_1')
  appendToolResult(session, 'done', 'call_1')
  appendUser(session, longText('q2', 2))
  return session
}

/**
 * Re-shape a real session into what dsh 0.1.2 hands out: explicit
 * `snapshotEvents()` / `eventAt(seq)` accessors and a surface, with NO
 * `events` property at all (the removed API the host helper still reads).
 */
function asHost012Shape(session: Session): Session {
  const events = sessionEventsOf(session)
  const shape = {
    snapshotEvents: () => events,
    eventAt: (seq: number): SessionEvent | undefined =>
      seq >= 0 && seq < events.length ? events[seq] : undefined,
    surface: session.surface,
  }
  return shape as unknown as Session
}

test('local balance checks agree with the host helpers wherever the host helpers work (rc.6 line)', () => {
  const session = buildPairSession()
  const nodes = session.surface.nodes
  assert.ok(nodes.length >= 4, 'fixture must expose the full user/call/result/user surface')
  for (const seq of nodes) {
    assert.equal(
      localBefore(session, seq),
      hostBefore(session, seq),
      `toolPairingBalancedBefore disagrees with the host helper at seq ${seq}`,
    )
    assert.equal(
      localAfter(session, seq),
      hostAfter(session, seq),
      `toolPairingBalancedAfter disagrees with the host helper at seq ${seq}`,
    )
  }
})

test('on the 0.1.2 session shape the host helpers crash and the local mirror works (issue #124)', () => {
  const shape = asHost012Shape(buildPairSession())
  const nodes = shape.surface.nodes
  // The host helper reads the removed `session.events` — pinned so its return
  // to service (post host fix) is a deliberate, visible change.
  assert.throws(() => hostBefore(shape, nodes[0]!), TypeError)
  assert.throws(() => hostAfter(shape, nodes[0]!), TypeError)
  // The local mirror reads through the cross-version accessor and answers.
  assert.equal(typeof localBefore(shape, nodes[0]!), 'boolean')
  assert.equal(typeof localAfter(shape, nodes[0]!), 'boolean')
})

test('resolveSurfaceRange stays fully functional on the 0.1.2 session shape', () => {
  const shape = asHost012Shape(buildPairSession())
  // A cut inside the pair shrinks back to the nearest balanced boundary.
  assert.deepEqual(resolveSurfaceRange(shape, 1, 2), { start: 1, end: 1 })
  // A complete call/result pair is balanced and unchanged.
  assert.deepEqual(resolveSurfaceRange(shape, 2, 3), { start: 2, end: 3 })
  assert.deepEqual(resolveSurfaceRange(shape, 1, 3), { start: 1, end: 3 })
  // A lone tool message expands outward to its balanced pair.
  assert.deepEqual(resolveSurfaceRange(shape, 2, 2), { start: 2, end: 3 })
})

test('the workaround stays labeled and the host import stays swapped out until the host fix ships', () => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const mirror = readFileSync(`${here}../src/tool-pairing.ts`, 'utf8')
  assert.match(mirror, /UPSTREAM:/, 'src/tool-pairing.ts must keep its UPSTREAM label')
  const region = readFileSync(`${here}../src/region.ts`, 'utf8')
  assert.doesNotMatch(
    region,
    /toolPairingBalanced(Before|After)[^}]*from '@deepseek-ai\/dsh-compaction'/,
    'region.ts must not use the broken host helpers (see issue #124)',
  )
  assert.match(region, /from '\.\/tool-pairing\.ts'/, 'region.ts must use the local mirror')
})
