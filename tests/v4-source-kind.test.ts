/**
 * V4 source-shape compatibility (issue #163): DSH 0.1.7's V4 admission
 * (dsh-session-persistence-jsonl, from session-format-v3-to-v4) rejects any
 * durable row whose source uses the legacy wrapper shape
 * `{ kind: 'plugin', plugin: '<name>' }` — "format v4 message requires a
 * producer-owned source kind" — which wedged the write batch and failed the
 * NEXT turn. The canonical shape for unregistered plugins is the V4 producer
 * kind `'plugin:<name>'` (what the host's own V3→V4 migration emits); DSH
 * 0.1.5 sessions accept it too (probe-verified), so the engine writes only
 * the new shape while the surface classifier reads BOTH:
 * - every pre-0.1.7 session log stays legacy-shaped on disk until migrated,
 *   and a session opened on 0.1.7 comes back with rewritten rows — both
 *   shapes coexist on one live surface;
 * - misclassifying a migrated row as 'real' would break metadata/instruction
 *   classification AND let host content rows win the last-real-user
 *   protection window (the issue #71 bug class).
 *
 * Covered here:
 * - sourcePluginOf dual-shape parsing (unit matrix incl. malformed inputs);
 * - classifySurfaceEvent / isRealUserTurn / isAgentInstructionsRow agree on
 *   BOTH shapes for every known plugin name (regression: old-shape behavior
 *   is unchanged byte-for-byte, new shape gets identical buckets);
 * - the two durable write sites emit exactly the new shape: buildNudge's
 *   returned message (the engine appends it verbatim, src/index.ts enter
 *   decision) and the prune tombstone stripOrphanedSurfaceToolMessages
 *   persists into a real session log.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createCore, type CompressionCore } from 'acp-kernel'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { classifySurfaceEvent, isAgentInstructionsRow, isRealUserTurn, sourcePluginOf } from '../src/messages.ts'
import { sessionEventsOf } from '../src/session-events.ts'
import { AcpStateStore } from '../src/state.ts'
import { buildNudge } from '../src/nudge.ts'
import { PRUNE_NOTE, stripOrphanedSurfaceToolMessages } from '../src/region.ts'
import { appendToolCall, appendToolResult, appendTurn, appendUser, buildTextSession, longText } from './helpers.ts'

/** Append a user/message row with an arbitrary source payload; return its event. */
function appendWithSource(session: Session, source: Record<string, unknown>): number {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `row with source ${JSON.stringify(source)}` }],
    source,
  }), { surfaceOp: 'append' })
  return sessionEventsOf(session).length - 1
}

test('sourcePluginOf parses both durable source shapes, conservatively', () => {
  // Legacy V3 wrapper.
  assert.equal(sourcePluginOf({ kind: 'plugin', plugin: 'acp-nudge' }), 'acp-nudge')
  assert.equal(sourcePluginOf({ kind: 'plugin', plugin: 'agent-instructions' }), 'agent-instructions')
  // Malformed wrappers fall back to undefined (callers keep conservative paths).
  assert.equal(sourcePluginOf({ kind: 'plugin' }), undefined)
  assert.equal(sourcePluginOf({ kind: 'plugin', plugin: '' }), undefined)
  assert.equal(sourcePluginOf({ kind: 'plugin', plugin: 42 }), undefined)
  // V4 producer kind.
  assert.equal(sourcePluginOf({ kind: 'plugin:billion-context-dsh' }), 'billion-context-dsh')
  assert.equal(sourcePluginOf({ kind: 'plugin:@deepseek-ai/dsh-system-prompt' }), '@deepseek-ai/dsh-system-prompt')
  assert.equal(sourcePluginOf({ kind: 'plugin:' }), undefined)
  // Unrelated kinds carry no plugin name.
  assert.equal(sourcePluginOf({ kind: 'user' }), undefined)
  assert.equal(sourcePluginOf({ kind: 'agent-instructions' }), undefined)
  assert.equal(sourcePluginOf(undefined), undefined)
})

test('classifySurfaceEvent: engine metadata rows bucket identically in both shapes', () => {
  const session = Session.create('v4-meta')
  const seqs = [
    appendWithSource(session, { kind: 'plugin', plugin: 'acp-nudge' }),
    appendWithSource(session, { kind: 'plugin:acp-nudge' }),
    appendWithSource(session, { kind: 'plugin', plugin: 'billion-context-dsh' }),
    appendWithSource(session, { kind: 'plugin:billion-context-dsh' }),
  ]
  for (const seq of seqs) {
    assert.equal(classifySurfaceEvent(sessionEventsOf(session)[seq]!), 'metadata', `seq ${seq}`)
    assert.equal(isRealUserTurn(sessionEventsOf(session)[seq]!), false, `seq ${seq}`)
  }
})

test('classifySurfaceEvent: host real-content rows bucket identically in both shapes', () => {
  const session = Session.create('v4-real')
  const names = ['@deepseek-ai/dsh-system-prompt', 'user-approval', 'tools-ptc']
  const seqs = names.flatMap((plugin) => [
    appendWithSource(session, { kind: 'plugin', plugin }),
    appendWithSource(session, { kind: `plugin:${plugin}` }),
  ])
  for (const seq of seqs) {
    assert.equal(classifySurfaceEvent(sessionEventsOf(session)[seq]!), 'real', `seq ${seq}`)
    // Foldable content, but never the last-real-user protection winner.
    assert.equal(isRealUserTurn(sessionEventsOf(session)[seq]!), false, `seq ${seq}`)
  }
})

test('classifySurfaceEvent: unknown plugin names stay instruction barriers in both shapes', () => {
  const session = Session.create('v4-unknown')
  const seqs = [
    appendWithSource(session, { kind: 'plugin', plugin: 'future-injection' }),
    appendWithSource(session, { kind: 'plugin:future-injection' }),
    // Malformed legacy wrapper without a parseable name: unchanged behavior.
    appendWithSource(session, { kind: 'plugin' }),
  ]
  for (const seq of seqs) {
    assert.equal(classifySurfaceEvent(sessionEventsOf(session)[seq]!), 'instruction', `seq ${seq}`)
    assert.equal(isRealUserTurn(sessionEventsOf(session)[seq]!), false, `seq ${seq}`)
  }
})

test('isAgentInstructionsRow recognizes all three AGENTS.md shapes', () => {
  const session = Session.create('v4-agents')
  const hook = appendWithSource(session, { kind: 'agent-instructions', form: 'instructions', changes: [{ action: 'set', scope: '/w', path: 'AGENTS.md', digest: 'd1' }] })
  const legacy = appendWithSource(session, { kind: 'plugin', plugin: 'agent-instructions' })
  const v4 = appendWithSource(session, { kind: 'plugin:agent-instructions' })
  const other = appendWithSource(session, { kind: 'plugin:skill-catalog' })
  const events = sessionEventsOf(session)
  assert.equal(isAgentInstructionsRow(events[hook]!), true, 'hook shape')
  assert.equal(isAgentInstructionsRow(events[legacy]!), true, 'legacy wrapper shape')
  assert.equal(isAgentInstructionsRow(events[v4]!), true, 'V4 producer kind (migrated row keeps its newest-row pin)')
  assert.equal(isAgentInstructionsRow(events[other]!), false, 'unrelated plugin row')
  // The classifier agrees: all three are instruction barriers, never 'real'.
  for (const seq of [hook, legacy, v4]) {
    assert.equal(classifySurfaceEvent(events[seq]!), 'instruction', `seq ${seq}`)
  }
})

test('isRealUserTurn: plain user turns keep winning protection, engine rows do not', () => {
  const session = Session.create('v4-turn')
  const userSeq = appendWithSource(session, { kind: 'user' })
  const nudgeSeq = appendWithSource(session, { kind: 'plugin:acp-nudge' })
  const events = sessionEventsOf(session)
  assert.equal(isRealUserTurn(events[userSeq]!), true, 'kind user is a real turn')
  assert.equal(isRealUserTurn(events[nudgeSeq]!), false, 'nudge echo row is not the user speaking')
})

function fakeAgent(session: Session): Agent {
  return {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: new Context(),
  } as unknown as Agent
}

test('buildNudge writes the V4 producer kind on its durable nudge row', () => {
  // Small window + long history → the kernel recommends compression.
  const env = { kernel: createCore({}) as CompressionCore, store: new AcpStateStore(), modelContextLimit: 4000 }
  const session = buildTextSession(12)
  const outcome = buildNudge(fakeAgent(session), env, new Map(), new Map())
  assert.ok(outcome !== null, 'a nudge is produced under pressure')
  // The engine appends this message verbatim (src/index.ts enter decision), so
  // its source IS the durable row's source.
  assert.deepEqual(outcome!.message.source, { kind: 'plugin:acp-nudge' })
  // Round trip: the persisted row classifies back to metadata, not real.
  session.append('user/message', outcome!.message, { surfaceOp: 'append' })
  const events = sessionEventsOf(session)
  const row = events[events.length - 1]!
  assert.equal(classifySurfaceEvent(row), 'metadata')
  assert.equal(isRealUserTurn(row), false)
})

test('the prune tombstone persists with the V4 producer kind', () => {
  const session = Session.create('v4-prune')
  appendTurn(session, 1)
  appendUser(session, longText('q0', 0))
  appendToolResult(session, 'orphan result', 'result-orphan') // orphan → pruned
  const hidden = stripOrphanedSurfaceToolMessages(session)
  assert.equal(hidden, 1, 'the orphan result is pruned')
  const events = sessionEventsOf(session)
  // A user/message event's data IS the message (content/source at top level).
  const tombstones = events.filter((event) =>
    event.type === 'user/message'
    && Array.isArray((event.data as { content?: unknown[] }).content)
    && (event.data as { content: unknown[] }).content.some(
      (block) => (block as { type?: string }).type === 'text' && (block as { text?: string }).text === PRUNE_NOTE,
    ),
  )
  assert.equal(tombstones.length, 1, 'one prune-note row was written')
  for (const tombstone of tombstones) {
    assert.deepEqual((tombstone.data as { source?: unknown }).source, { kind: 'plugin:billion-context-dsh' })
    assert.equal(classifySurfaceEvent(tombstone), 'metadata')
    assert.equal(isRealUserTurn(tombstone), false)
  }
})
