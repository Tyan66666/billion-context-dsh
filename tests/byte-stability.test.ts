import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { eventsToCoreMessages, surfaceEventsOf } from '../src/messages.ts'
import { appendTurn, appendUser, appendAssistant, buildTextSession, longText } from './helpers.ts'

// issue #111: pin provider prompt-cache safety at the unit level — the model-visible
// payload eventsToCoreMessages(surfaceEventsOf(session)) must be deterministic for an
// unchanged session, and an append-only turn must leave every earlier sent message
// byte-identical. Compression rewrites the surface by design, so it is intentionally not
// asserted here (the e2e harness in issue #120 covers host round-trips).

function outboundJson(session: Session): string {
  return JSON.stringify(eventsToCoreMessages(surfaceEventsOf(session)))
}

test('byte-stability: projecting an unchanged session is deterministic (issue #111)', () => {
  const session = buildTextSession(6)
  const first = outboundJson(session)
  const second = outboundJson(session)
  assert.ok(first.length > 0, 'seeded session has a non-empty sent view')
  assert.equal(second, first, 're-projecting the same session must be byte-identical')
})

test('byte-stability: an append-only turn preserves every previously-sent byte (issue #111)', () => {
  const session = Session.create('cache-session')
  appendTurn(session, 1)
  for (let index = 0; index < 4; index += 1) {
    if (index % 2 === 0) appendUser(session, longText('u', index))
    else appendAssistant(session, longText('a', index), 1, index + 1)
  }

  const before = eventsToCoreMessages(surfaceEventsOf(session))
  assert.ok(before.length > 0, 'seeded session has a non-empty sent view')
  appendUser(session, longText('u-new', 90))
  appendAssistant(session, longText('a-new', 91), 1, 5)

  const after = eventsToCoreMessages(surfaceEventsOf(session))
  assert.ok(after.length > before.length, 'the appended turn grew the sent view')

  for (let index = 0; index < before.length; index += 1) {
    assert.equal(
      JSON.stringify(after[index]),
      JSON.stringify(before[index]),
      `sent message ${index} changed after an append-only turn — provider prompt-cache prefix broken`,
    )
  }
})
