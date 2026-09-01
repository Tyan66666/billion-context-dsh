/**
 * Instruction-row hygiene (issue #71, PR1): the compress range table must
 * never offer CURRENT copies of injected policy files (AGENTS.md etc.) —
 * folding one makes the host re-inject it, so a model that follows the nudge
 * loops compress → re-inject → compress forever (live-measured: 20 of 43
 * compressions in a long session re-triggered an injection within 7 events;
 * reproduced live in session-8c15904e seq 8 → 53191).
 *
 * Fix pieces under test:
 * - classifySurfaceEvent buckets host policy rows as 'instruction'
 *   (src/messages.ts) — the barrier's classifier.
 * - buildCompressibleSeqRanges flushes at instruction rows and fixes the
 *   protected-tail scan, which used to protect the injected row itself while
 *   leaving the REAL last user message compressible (src/region.ts).
 * - newestInstructionSeqsOf groups rows per scope (source.changes[].scope =
 *   one file), so only the CURRENT copy of each file is guarded.
 * - handleCompress HARD-REJECTS a manual range that covers a current row
 *   (supersedes the F7 warn-only draft — the owner reversed it during PR1
 *   review: compressing a current row has no legitimate outcome, the host
 *   re-injects unconditionally). Stale copies stay compressible — that is
 *   the actual cleanup, and it triggers no re-injection.
 *
 * Fixtures use the REAL host injection shape audited from live session logs:
 * source { kind: 'agent-instructions', form: 'instructions', baseline,
 * baselineIdentity, changes: [{ action, scope, path, digest }] }.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCore, type CompressionCore } from 'acp-kernel'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { classifySurfaceEvent, isRealUserTurn } from '../src/messages.ts'
import { acpCommand } from '../src/commands.ts'
import { buildCompressibleSeqRanges, newestInstructionSeqsOf, guardedSurfaceSeqsOf } from '../src/region.ts'
import { makeTools, currentInstructionRowsInSpan, protectedRowRejectionNote, type ToolEnvironment } from '../src/tools.ts'
import { AcpStateStore } from '../src/state.ts'
import { appendTurn, appendUser, appendAssistant, appendToolCall, appendToolResult, buildTextSession, longText } from './helpers.ts'

/** The exact source shape the host stamps on injected AGENTS.md rows. */
function instructionSource(scope: string, version: string): Record<string, unknown> {
  return {
    kind: 'agent-instructions',
    form: 'instructions',
    baseline: true,
    baselineIdentity: { projectRoot: '', projectRootMarkers: ['.git'], maxBytes: 65536 },
    changes: [{ action: 'set', scope, path: 'AGENTS.md', digest: `digest-${version}` }],
  }
}

/** Append a host instruction row (real shape) and return its surface seq. */
function appendInstruction(session: Session, scope: string, version: string): number {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `Instructions for ${scope} (${version}): keep tests green; docs in sync.` }],
    source: instructionSource(scope, version),
  }), { surfaceOp: 'append' })
  return session.events.length - 1
}

/** A legacy instruction row without changes[] — no file identity at all. */
function appendInstructionNoChanges(session: Session): number {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Instructions (legacy shape, no changes[]).' }],
    source: { kind: 'agent-instructions' },
  }), { surfaceOp: 'append' })
  return session.events.length - 1
}

/** Any other host-injected policy row (e.g. the skill catalog). */
function appendPluginRow(session: Session, source: Record<string, unknown>): number {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'injected policy row' }],
    source,
  }), { surfaceOp: 'append' })
  return session.events.length - 1
}

function makeEnv(): ToolEnvironment {
  return {
    kernel: createCore({}) as CompressionCore,
    store: new AcpStateStore(),
    modelContextLimit: 128000,
    compressCallIdsToHide: new Set(),
  }
}

test('PR1: classifySurfaceEvent buckets host policy rows; real content stays real', () => {
  const ev = (source: Record<string, unknown> | undefined): ReturnType<typeof classifySurfaceEvent> =>
    classifySurfaceEvent({ type: 'user/message', seq: 1, data: { source } } as never)
  const evOther = (type: string): ReturnType<typeof classifySurfaceEvent> =>
    classifySurfaceEvent({ type, seq: 2, data: {} } as never)

  // Real content must never be reclassified.
  assert.equal(ev({ kind: 'user' }), 'real')
  assert.equal(ev(undefined), 'real', 'source-less user turn is real content')
  assert.equal(evOther('tool/result'), 'real')
  assert.equal(evOther('assistant/message'), 'real')
  assert.equal(ev({ kind: 'subagent-report' }), 'real', 'sub-agent relay is real content')

  // The engine's own metadata rows stay metadata (foldable, like main).
  assert.equal(ev({ kind: 'plugin', plugin: 'acp-nudge' }), 'metadata')
  assert.equal(ev({ kind: 'plugin', plugin: 'billion-context-dsh' }), 'metadata')

  // Compaction checkpoints.
  assert.equal(ev({ kind: 'plugin', plugin: 'compact' }), 'checkpoint')

  // Instruction rows: AGENTS.md in both audited host shapes, skill catalogs,
  // and unknown plugin rows (a future host injection must never silently
  // become compressible real content).
  assert.equal(ev(instructionSource('.\u0000AGENTS.md', 'v1')), 'instruction', 'kind agent-instructions shape')
  assert.equal(ev({ kind: 'plugin', plugin: 'agent-instructions' }), 'instruction', 'legacy kind-plugin shape')
  assert.equal(ev({ kind: 'skill-catalog' }), 'instruction')
  assert.equal(ev({ kind: 'plugin', plugin: 'runtime-context' }), 'instruction')
  assert.equal(ev({ kind: 'plugin', plugin: 'future-unknown' }), 'instruction')

  // isRealUserTurn: only real user turns win last-user protection; injected
  // rows and relays never do (the old tail-scan bug protected those instead).
  assert.equal(isRealUserTurn({ type: 'user/message', seq: 1, data: { source: { kind: 'user' } } } as never), true)
  assert.equal(isRealUserTurn({ type: 'user/message', seq: 2, data: { source: instructionSource('.\u0000AGENTS.md', 'v1') } } as never), false)
  assert.equal(isRealUserTurn({ type: 'user/message', seq: 3, data: { source: { kind: 'subagent-report' } } } as never), false)
  assert.equal(isRealUserTurn({ type: 'tool/result', seq: 4, data: {} } as never), false)
})

test('PR1: the range table splits at instruction rows — no offered range contains one', () => {
  const session = Session.create('barrier')
  appendTurn(session, 1)
  appendUser(session, longText('q0', 0))            // seq 1 — before the barrier
  appendAssistant(session, longText('a0', 1), 1, 1) // seq 2
  const barrierSeq = appendInstruction(session, '.\u0000AGENTS.md', 'v1') // barrier
  appendUser(session, longText('q1', 2))            // after the barrier
  appendAssistant(session, longText('a1', 3), 1, 3)
  appendUser(session, longText('q2', 4))
  appendAssistant(session, longText('a2', 5), 1, 5)

  const ranges = buildCompressibleSeqRanges(session, { preserveRecent: 0 })
  assert.ok(ranges.length >= 2, `segments split at the instruction row (got ${ranges.length})`)
  for (const range of ranges) {
    assert.ok(range.start > barrierSeq || range.end < barrierSeq, `range ${range.start}..${range.end} must not contain barrier seq ${barrierSeq}`)
  }
  const covers = (seq: number): boolean => ranges.some((range) => range.start <= seq && seq <= range.end)
  assert.ok(covers(1), 'the pre-barrier segment is still offered')
  assert.ok(covers(4), 'the post-barrier segment is still offered')
})

test('PR1: tail-scan regression — the REAL last user message is protected, not the injected row', () => {
  const session = Session.create('tail-scan')
  appendTurn(session, 1)
  appendUser(session, longText('q0', 0))            // seq 1 — real, first
  appendAssistant(session, longText('a0', 1), 1, 1) // seq 2
  const realLastUser = session.events.length // next append's seq
  appendUser(session, longText('q1', 2))            // real last user turn
  appendAssistant(session, longText('a1', 3), 1, 3)
  appendInstruction(session, '.\u0000AGENTS.md', 'v1') // LAST user/message on the surface

  // The OLD scan walked backward for "the last user/message that is not a
  // checkpoint" — on this surface that is the injected row, so the injected
  // row sat protected while the real user message stayed compressible.
  const ranges = buildCompressibleSeqRanges(session, { preserveRecent: 0 })
  const covers = (seq: number): boolean => ranges.some((range) => range.start <= seq && seq <= range.end)
  assert.ok(!covers(realLastUser), `the real last user turn (seq ${realLastUser}) must be protected`)
  for (const range of ranges) {
    assert.ok(range.start > 5 || range.end < 5, 'the injected row (last user/message) must not be offered either')
  }
  assert.ok(covers(1), 'the first real user turn stays compressible')
})

test('PR1: newestInstructionSeqsOf groups per scope — one newest per file, worktrees tracked separately', () => {
  const session = Session.create('scopes')
  appendTurn(session, 1)
  const rootV1 = appendInstruction(session, '.\u0000AGENTS.md', 'v1')
  const wtV1 = appendInstruction(session, 'worktrees/feat-x\u0000AGENTS.md', 'v1')
  const rootV2 = appendInstruction(session, '.\u0000AGENTS.md', 'v2')
  const wtV2 = appendInstruction(session, 'worktrees/feat-x\u0000AGENTS.md', 'v2')
  const legacy = appendInstructionNoChanges(session)

  const newest = newestInstructionSeqsOf(session)
  assert.ok(!newest.has(rootV1), 'a newer copy of the same file supersedes the old one')
  assert.ok(!newest.has(wtV1), 'superseded per worktree scope too (scope key is file-level, not session-level)')
  assert.ok(newest.has(rootV2), 'root AGENTS.md newest row guarded')
  assert.ok(newest.has(wtV2), 'worktree AGENTS.md newest row guarded independently')
  assert.ok(newest.has(legacy), 'a row without changes[] has no file identity — conservatively never superseded')
})

test('PR1: guardedSurfaceSeqsOf keeps only CURRENT agent-instructions rows', () => {
  const session = Session.create('guarded')
  appendTurn(session, 1)
  appendUser(session, longText('q0', 0))
  const stale = appendInstruction(session, '.\u0000AGENTS.md', 'v1')
  const current = appendInstruction(session, '.\u0000AGENTS.md', 'v2')
  const catalog = appendPluginRow(session, { kind: 'skill-catalog' })

  const guarded = guardedSurfaceSeqsOf(session)
  assert.ok(guarded.has(current), 'the current copy is guarded')
  assert.ok(!guarded.has(stale), 'a stale copy of the same file is NOT guarded (compression-safe)')
  assert.ok(!guarded.has(catalog), 'non-agent-instructions policy rows stay outside the advisory set (F4 narrowing)')
})

test('PR1: current-instruction-row gate — pure helpers pin the rejection', () => {
  const guarded = new Set([5, 6])
  assert.deepEqual(currentInstructionRowsInSpan(guarded, 1, 3), [], 'no overlap — no rejection')
  assert.deepEqual(currentInstructionRowsInSpan(new Set(), 5, 9), [], 'empty guarded set — no rejection')
  assert.deepEqual(currentInstructionRowsInSpan(guarded, 1, 5), [5], 'boundary-inclusive hit')
  assert.deepEqual(currentInstructionRowsInSpan(new Set([7, 5]), 1, 9), [5, 7], 'hits come back sorted')

  const one = protectedRowRejectionNote(1, 6, [5])
  assert.match(one, /seqs 1\.\.6 rejected/)
  assert.match(one, /1 CURRENT injected instruction row\(s\) \(seq 5\)/)
  assert.match(one, /re-injects the newest AGENTS\.md copy/)
  assert.match(one, /stale copies/, 'the model is pointed at the stale-copy escape')

  const many = protectedRowRejectionNote(1, 9, [5, 6, 7, 8, 9])
  assert.match(many, /5 CURRENT injected instruction row\(s\) \(seq 5, 6, 7, 8 \+1 more\)/)
})

test('PR1: handleCompress REJECTS a manual range covering a current instruction row; stale copies still compress', async () => {
  const env = makeEnv()
  const session = Session.create('wiring')
  appendTurn(session, 1)
  appendUser(session, longText('q0', 0))            // seq 1
  appendAssistant(session, longText('a0', 1), 1, 1) // seq 2
  appendUser(session, longText('q1', 2))            // seq 3
  appendAssistant(session, longText('a1', 3), 1, 3) // seq 4
  appendInstruction(session, '.\u0000AGENTS.md', 'v1') // seq 5 — STALE once v2 lands
  appendInstruction(session, '.\u0000AGENTS.md', 'v2') // seq 6 — CURRENT
  appendUser(session, longText('q2', 5))            // seq 7
  appendUser(session, longText('q3', 6))
  appendAssistant(session, longText('a3', 8), 1, 8)
  appendUser(session, longText('q4', 9))
  appendAssistant(session, longText('a4', 10), 1, 10)

  const compress = makeTools(env).find((definition) => definition.name === 'compress')
  assert.ok(compress, 'compress tool registered')
  const agent = {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: { tokenMeter: undefined },
  } as never
  const exec = { callId: 'call-acp', name: 'compress', arguments: {}, signal: new AbortController().signal, agent } as never
  const summary = 'Authentication system: JWT access tokens with 15 minute expiry, refresh tokens in Redis with 30 day TTL, login flow in src/auth/login.ts with sliding-window rate limiting at 10 requests per minute.'

  // A span covering the CURRENT row (seq 6) is rejected before the kernel
  // sees it: nothing lands, the seq is named, and the stale-copy escape is
  // offered so the model can re-cut instead of retrying the same call.
  const result = await compress.execute({ content: [{ startSeq: 1, endSeq: 7, summary }] } as never, exec)
  const text = (result as { text: string }).text
  assert.match(text, /Compressed 0 block/)
  assert.match(text, /seqs \d+\.\.\d+ rejected/)
  assert.match(text, /seq 6/, 'the current row is named')
  assert.ok(
    !session.events.some((event) => String((event as { type?: string }).type).startsWith('compaction')),
    'nothing durable landed — the kernel never saw the rejected range',
  )

  // A span covering only the STALE copy of the same file (seq 5, superseded
  // by v2 at seq 6) compresses normally: removing it while the newest stays
  // visible is the real cleanup and triggers no re-injection.
  const staleOnly = await compress.execute({ content: [{ startSeq: 1, endSeq: 5, summary }] } as never, exec)
  const staleText = (staleOnly as { text: string }).text
  assert.match(staleText, /Compressed 1 block/)
  assert.doesNotMatch(staleText, /rejected|current instruction row/)

  // Negative: a plain session without any instruction rows — the gate never
  // fires (guards against false positives from the gate itself).
  const plain = Session.create('wiring-plain')
  appendTurn(plain, 1)
  for (let index = 0; index < 12; index += 1) {
    if (index % 2 === 0) appendUser(plain, longText('msg', index))
    else appendAssistant(plain, longText('reply', index), 1, index)
  }
  appendToolCall(plain, longText('call0', 99), 'c0')
  appendToolResult(plain, longText('res0', 100), 'c0')
  const env2 = makeEnv()
  const compress2 = makeTools(env2).find((definition) => definition.name === 'compress')
  assert.ok(compress2)
  const agent2 = {
    id: plain.id,
    session: plain,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: { tokenMeter: undefined },
  } as never
  const exec2 = { callId: 'call-acp-2', name: 'compress', arguments: {}, signal: new AbortController().signal, agent: agent2 } as never
  const result2 = await compress2.execute({
    content: [{
      startSeq: 1,
      endSeq: 5,
      summary,
    }],
  } as never, exec2)
  assert.doesNotMatch((result2 as { text: string }).text, /rejected|current instruction row/, 'no instruction rows in span — no rejection')
})

test('PR1: /acp compress rejects a current instruction row exactly like the tool; stale copies still compress', async () => {
  const env = makeEnv()
  const session = Session.create('command-gate')
  appendTurn(session, 1)
  appendUser(session, longText('q0', 0))            // seq 1
  appendAssistant(session, longText('a0', 1), 1, 1) // seq 2
  appendUser(session, longText('q1', 2))            // seq 3
  appendAssistant(session, longText('a1', 3), 1, 3) // seq 4
  appendInstruction(session, '.\u0000AGENTS.md', 'v1') // seq 5 — STALE once v2 lands
  appendInstruction(session, '.\u0000AGENTS.md', 'v2') // seq 6 — CURRENT
  appendUser(session, longText('q2', 5))            // seq 7
  appendAssistant(session, longText('a2', 7), 1, 7) // seq 8

  const agent = {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: { tokenMeter: undefined },
  } as never
  const command = acpCommand(env)
  const run = (rawInput: string) => command.handler({
    commandId: 'cmd-test' as never,
    agent,
    rawInput,
    signal: new AbortController().signal,
  } as never) as Promise<{ kind: string; text: string }>

  const summary = 'login flow, JWT access tokens with 15 minute expiry, refresh tokens in Redis with 30 day TTL, sliding-window rate limiting in src/auth/login.ts.'

  // The human path is gated by the SAME arithmetic as the model tool: a span
  // covering the CURRENT row (seq 6) is refused before anything durable lands.
  const rejected = await run(`compress 1 7 ${summary}`)
  assert.equal(rejected.kind, 'success')
  assert.match(rejected.text, /rejected/)
  assert.match(rejected.text, /seq 6/, 'the current row is named')
  assert.ok(
    !session.events.some((event) => String((event as { type?: string }).type).startsWith('compaction')),
    'nothing durable landed — the human command cannot bypass the gate',
  )

  // A span covering only the STALE copy compresses normally.
  const staleOnly = await run(`compress 1 5 ${summary}`)
  assert.equal(staleOnly.kind, 'success')
  assert.match(staleOnly.text, /Compressed seqs 1\.\.5/, 'a stale-copy span compresses normally')
})
