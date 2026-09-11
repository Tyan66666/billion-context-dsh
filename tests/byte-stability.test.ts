import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { eventsToCoreMessages, surfaceEventsOf } from '../src/messages.ts'
import { appendTurn, appendUser, appendAssistant, buildTextSession, longText } from './helpers.ts'

// issue #111: pin provider prompt-cache safety at the unit level.
//
// The messages a provider can cache are the ones the agent loop puts on the wire:
// `session.deriveMessages()` — built at `@deepseek-ai/dsh-agent-loop/lib/index.js:1204`
// (`boundaryMessages`) and handed to the provider at `:1213` inside `buildRequest`.
// NOT the engine's own `eventsToCoreMessages(surfaceEventsOf(session))` projection:
// that is the shape the KERNEL consumes, one hop earlier, and it is a different
// object (`{id, role, contentType, toolName?, toolCallId?, text}` vs the raw event
// data `{id, role, content, source, …}`). Asserting on the projection proves nothing
// about the request bytes — an earlier version of this file made exactly that
// mistake (`outboundJson` serialized the projection).
//
// Pinned HERE: determinism of the outbound view, and append-only prefix stability.
// NOT pinned here: the request envelope (tools array / headers) and the engine's real
// surface writes (orphan pruning, compaction replace) — those need the host loop, and
// `npm run test:e2e` now checks them at the wire level.

/** The messages the host puts on the wire — what a prompt cache can key on. */
function outboundJson(session: Session): string {
  return JSON.stringify(session.deriveMessages())
}

test('byte-stability: deriving an unchanged session is deterministic (issue #111)', () => {
  const session = buildTextSession(6)
  const first = outboundJson(session)
  const second = outboundJson(session)
  assert.ok(first.length > 0, 'seeded session has a non-empty outbound view')
  assert.equal(second, first, 're-deriving the same session must be byte-identical')
})

test('byte-stability: an append-only turn preserves every previously-sent byte (issue #111)', () => {
  const session = Session.create('cache-session')
  appendTurn(session, 1)
  for (let index = 0; index < 4; index += 1) {
    if (index % 2 === 0) appendUser(session, longText('u', index))
    else appendAssistant(session, longText('a', index), 1, index + 1)
  }

  const before = session.deriveMessages()
  assert.ok(before.length > 0, 'seeded session has a non-empty outbound view')
  appendUser(session, longText('u-new', 90))
  appendAssistant(session, longText('a-new', 91), 1, 5)

  const after = session.deriveMessages()
  assert.ok(after.length > before.length, 'the appended turn grew the outbound view')

  for (let index = 0; index < before.length; index += 1) {
    assert.equal(
      JSON.stringify(after[index]),
      JSON.stringify(before[index]),
      `outbound message ${index} changed after an append-only turn — provider prompt-cache prefix broken`,
    )
  }
})

test('byte-stability: the kernel-facing projection stays deterministic too (not the cache boundary)', () => {
  // Deliberately a separate test from the two above, and named for what it is: this
  // is the shape the KERNEL sees. A regression here is a real bug, but it is not
  // evidence about the provider prefix — do not let the two blur together again.
  const session = buildTextSession(6)
  const first = JSON.stringify(eventsToCoreMessages(surfaceEventsOf(session)))
  const second = JSON.stringify(eventsToCoreMessages(surfaceEventsOf(session)))
  assert.ok(first.length > 0, 'seeded session has a non-empty kernel view')
  assert.equal(second, first, 're-projecting the same session must be byte-identical')
})
