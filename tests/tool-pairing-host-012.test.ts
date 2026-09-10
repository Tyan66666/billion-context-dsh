/**
 * Issue #124 regression — the host's tool-pairing balance helpers
 * (`@deepseek-ai/dsh-compaction` `toolPairingBalancedBefore/After`) used to
 * read the REMOVED `session.events` API and crash on every dsh 0.1.2 session
 * with `TypeError: Cannot read properties of undefined (reading '<seq>')`.
 * The engine therefore uses a local mirror (src/tool-pairing.ts) whose only
 * difference is reading events through the cross-version accessor. The
 * upstream fix shipped in dsh-compaction 0.1.5-alpha.2 (the helpers now read
 * `session.eventAt(seq)`); the mirror stays because the peer range still
 * admits 0.1.2-line hosts, whose own dsh-compaction would still crash.
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

test('on the 0.1.2 session shape the 0.1.5-line host helpers work via eventAt and agree with the local mirror (issue #124)', () => {
  const shape = asHost012Shape(buildPairSession())
  const nodes = shape.surface.nodes
  // dsh-compaction 0.1.5-alpha.2 shipped the #124 fix: the balance helpers now
  // read `session.eventAt(seq)` instead of the removed `session.events`, so
  // they answer on the 0.1.2-shaped session (which exposes only the accessor
  // API). This pin flips with the devDep bump — on a REAL 0.1.2-line host its
  // own dsh-compaction still reads `.events` and would crash, which is why
  // the engine keeps the local mirror for that host era.
  assert.equal(typeof hostBefore(shape, nodes[0]!), 'boolean', 'the fixed host helper answers on the 0.1.2 shape')
  assert.equal(typeof hostAfter(shape, nodes[0]!), 'boolean', 'the fixed host helper answers on the 0.1.2 shape')
  // The local mirror reads through the cross-version accessor and agrees with
  // the fixed host helpers on every cut of the shape.
  for (const seq of nodes) {
    assert.equal(localBefore(shape, seq), hostBefore(shape, seq), `mirror disagrees with the fixed host helper before seq ${seq}`)
    assert.equal(localAfter(shape, seq), hostAfter(shape, seq), `mirror disagrees with the fixed host helper after seq ${seq}`)
  }
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
