/**
 * Issue #124 follow-through (removed in the #136 peer-floor move) — the engine
 * previously carried a local mirror of the host's tool-pairing balance helpers
 * (src/tool-pairing.ts) because dsh 0.1.2-era hosts were reported to hand out
 * sessions without the `events` array those helpers read. That workaround is
 * gone: the peer range now floors at dsh-session 0.1.5-alpha.1, where the
 * published `@deepseek-ai/dsh-compaction` helpers read through
 * `snapshotEvents()` / `eventAt(seq)` and work on real session objects. This
 * file pins the RESTORED state so a regression to broken host helpers (or a
 * silent re-mirror) fails loudly.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Session } from '@deepseek-ai/dsh-session'
import {
  toolPairingBalancedAfter as hostAfter,
  toolPairingBalancedBefore as hostBefore,
} from '@deepseek-ai/dsh-compaction'
import { resolveSurfaceRange } from '../src/region.ts'
import { appendToolCall, appendToolResult, appendTurn, appendUser, longText } from './helpers.ts'

/** Battle-report fixture: surface [1 user, 2 tool-call, 3 tool/result, 4 user]. */
function buildPairSession(): Session {
  const session = Session.create('tool-pair-124')
  appendTurn(session, 1)
  appendUser(session, longText('q1', 1))
  appendToolCall(session, 'checking the docs', 'call_1')
  appendToolResult(session, 'done', 'call_1')
  appendUser(session, longText('q2', 2))
  return session
}

test('the host balance helpers work directly on real 0.1.5 sessions', () => {
  const session = buildPairSession()
  const nodes = session.surface.nodes
  assert.ok(nodes.length >= 4, 'fixture must expose the full user/call/result/user surface')
  for (const seq of nodes) {
    // No TypeError, no local accessor shim: the host helper answers straight
    // away for every current-surface node.
    assert.equal(typeof hostBefore(session, seq), 'boolean')
    assert.equal(typeof hostAfter(session, seq), 'boolean')
  }
  // Spot-check the balance semantics themselves: cutting between the call and
  // its result is unbalanced in both directions; the outer cuts are balanced.
  assert.equal(hostAfter(session, nodes[0]!), true)
  assert.equal(hostAfter(session, nodes[1]!), false, 'cut after an unanswered call is unbalanced')
  assert.equal(hostBefore(session, nodes[2]!), false, 'cut before its result is unbalanced')
  assert.equal(hostAfter(session, nodes[2]!), true)
})

test('resolveSurfaceRange stays fully functional on real sessions through the host helpers', () => {
  const session = buildPairSession()
  // A cut inside the pair shrinks back to the nearest balanced boundary.
  assert.deepEqual(resolveSurfaceRange(session, 1, 2), { start: 1, end: 1 })
  // A complete call/result pair is balanced and unchanged.
  assert.deepEqual(resolveSurfaceRange(session, 2, 3), { start: 2, end: 3 })
  assert.deepEqual(resolveSurfaceRange(session, 1, 3), { start: 1, end: 3 })
  // A lone tool message expands outward to its balanced pair.
  assert.deepEqual(resolveSurfaceRange(session, 2, 2), { start: 2, end: 3 })
})

test('the engine imports the host helpers and the local mirror stays deleted', () => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const region = readFileSync(`${here}../src/region.ts`, 'utf8')
  const compactionImport = region.match(/import \{[^}]*\} from '@deepseek-ai\/dsh-compaction'/)
  assert.ok(compactionImport, 'region.ts must have a dsh-compaction import block')
  // Both balance helpers must come from the host package once the peer floor
  // guarantees they work on every supported session version.
  assert.match(compactionImport[0], /toolPairingBalancedBefore/)
  assert.match(compactionImport[0], /toolPairingBalancedAfter/)
  assert.doesNotMatch(region, /from '\.\/tool-pairing\.ts'/, 'region.ts must not re-mirror the helpers')
  assert.equal(existsSync(`${here}../src/tool-pairing.ts`), false, 'the local mirror must stay deleted')
})
