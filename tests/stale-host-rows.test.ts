/**
 * Stale host control rows (issue #215): per-turn injected rows (goal,
 * time-context, team-message) were filed as 'instruction' by the conservative
 * classifier default and treated as PERMANENT barriers — every copy split the
 * surface, so long agent-team sessions fragmented into sub-threshold slivers
 * and the nudge table went empty ("no compressible targets", issue #213).
 *
 * Contract under test:
 * - a STALE copy of a superseded channel folds like ordinary content: older
 *   AGENTS.md scope copies, superseded skill catalogs, old goal /
 *   time-context / team-message snapshots join normal segments and are offered
 *   in the range table;
 * - the CURRENT (newest visible) copy of every such group stays a barrier AND
 *   joins the hard-reject set (folding the current copy has no legitimate
 *   outcome);
 * - channels with no supersession notion (compact-basic, unknown plugin/kind
 *   names) keep their blanket barrier — the conservative default is untouched;
 * - /acp-prune status exposes who fragments the surface (context map).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createCore, type CompressionCore } from 'acp-kernel'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { injectionChannelOf, STALE_FOLDABLE_HOST_CHANNELS } from '../src/messages.ts'
import { buildCompressibleSeqRanges, guardedSurfaceSeqsOf, staleFoldableHostRowSeqs } from '../src/region.ts'
import { guardedRowsInSpan, makeTools, protectedRowRejectionNote, type ToolEnvironment } from '../src/tools.ts'
import { AcpStateStore } from '../src/state.ts'
import { acpCommand } from '../src/commands.ts'
import { sessionEventsOf } from '../src/session-events.ts'
import { appendAssistant, appendToolCall, appendToolResult, appendTurn, appendUser, longText, wholeSurfaceRangeView } from './helpers.ts'

/** Append one host-injected control row (arbitrary source shape) and return its surface seq. */
function appendControlRow(session: Session, source: Record<string, unknown>, text?: string): number {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: text ?? `control row (${String(source.kind ?? source.plugin)})` }],
    source,
  }), { surfaceOp: 'append' })
  return sessionEventsOf(session).length - 1
}

function makeEnv(): ToolEnvironment {
  return {
    kernel: createCore({}) as CompressionCore,
    store: new AcpStateStore(),
    modelContextLimit: 128000,
    nudgeMaxContextLimitPct: 0.7,
    nudgeEmergencyThresholdPct: 0.85,
    compressCallIdsToHide: new Set(),
  }
}

function fakeAgent(session: Session): Agent {
  return {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: new Context(),
  } as unknown as Agent
}

test('#215: injectionChannelOf recognizes control channels in both namespaces', () => {
  const ev = (source: Record<string, unknown> | undefined): string | null =>
    injectionChannelOf({ type: 'user/message', seq: 1, data: { source } } as never)
  // Direct kinds (the shape the DSH 0.2.1 line stamps).
  assert.equal(ev({ kind: 'goal' }), 'goal')
  assert.equal(ev({ kind: 'time-context' }), 'time-context')
  assert.equal(ev({ kind: 'team-message' }), 'team-message')
  // Legacy V3 wrapper and V4 producer kind spell the same channel.
  assert.equal(ev({ kind: 'plugin', plugin: 'goal' }), 'goal')
  assert.equal(ev({ kind: 'plugin:goal' }), 'goal')
  // Canonical labels survive every shape.
  assert.equal(ev({ kind: 'agent-instructions', form: 'instructions', changes: [] }), 'agent-instructions')
  assert.equal(ev({ kind: 'plugin', plugin: 'agent-instructions' }), 'agent-instructions')
  assert.equal(ev({ kind: 'skill-catalog' }), 'skill-catalog')
  assert.equal(ev({ kind: 'plugin', plugin: 'dsh-tool-skill' }), 'skill-catalog')
  // Non-supersession channels report their own name but stay OUT of the set.
  assert.equal(ev({ kind: 'compact-basic' }), 'compact-basic')
  assert.equal(ev({ kind: 'plugin', plugin: 'future-unknown' }), 'future-unknown')
  assert.ok(!STALE_FOLDABLE_HOST_CHANNELS.has('compact-basic'))
  assert.ok(!STALE_FOLDABLE_HOST_CHANNELS.has('future-unknown'))
  // Non-instruction rows: null (real turns, relays, metadata, checkpoints).
  assert.equal(injectionChannelOf({ type: 'user/message', seq: 2, data: { source: { kind: 'user' } } } as never), null)
  assert.equal(injectionChannelOf({ type: 'assistant/message', seq: 3, data: {} } as never), null)
})

test('#215: staleFoldableHostRowSeqs groups per channel — only superseded snapshots are stale', () => {
  const session = Session.create('stale-partition')
  appendTurn(session, 1)
  const goal1 = appendControlRow(session, { kind: 'goal' })
  appendUser(session, longText('q0', 0))
  const tc1 = appendControlRow(session, { kind: 'time-context' })
  const goal2 = appendControlRow(session, { kind: 'goal' })
  appendAssistant(session, longText('a0', 1), 1, 1)
  const tm1 = appendControlRow(session, { kind: 'team-message' })
  const tc2 = appendControlRow(session, { kind: 'time-context' })
  appendUser(session, longText('q1', 2))
  const cb1 = appendControlRow(session, { kind: 'compact-basic' })
  const cb2 = appendControlRow(session, { kind: 'compact-basic' })
  const unk1 = appendControlRow(session, { kind: 'plugin', plugin: 'future-unknown' })
  const unk2 = appendControlRow(session, { kind: 'unaudited-direct-kind' })

  const stale = staleFoldableHostRowSeqs(session)
  assert.ok(stale.has(goal1) && !stale.has(goal2), 'goal: the superseded snapshot is stale, the newest is current')
  assert.ok(stale.has(tc1) && !stale.has(tc2), 'time-context: same, independent group')
  assert.ok(!stale.has(tm1), 'a LONE copy is the current one — never stale')
  assert.ok(!stale.has(cb1) && !stale.has(cb2), 'compact-basic copies are NEVER stale (conservative default)')
  assert.ok(!stale.has(unk1) && !stale.has(unk2), 'unknown channel copies are NEVER stale (both namespaces)')
  assert.deepEqual([...stale].sort((a, b) => a - b), [goal1, tc1], 'exactly the two superseded snapshots — nothing else moved')
})

test('#215: agent-instructions group per scope; scope-less rows are unconditionally stale; catalogs supersede', () => {
  const session = Session.create('stale-scopes')
  appendTurn(session, 1)
  const rootV1 = appendControlRow(session, {
    kind: 'agent-instructions', form: 'instructions',
    changes: [{ action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: 'd1' }],
  }, 'root instructions v1')
  const wtV1 = appendControlRow(session, {
    kind: 'agent-instructions', form: 'instructions',
    changes: [{ action: 'set', scope: 'worktrees/wt\u0000AGENTS.md', path: 'AGENTS.md', digest: 'd1' }],
  }, 'worktree instructions v1')
  const rootV2 = appendControlRow(session, {
    kind: 'agent-instructions', form: 'instructions',
    changes: [{ action: 'update', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: 'd2' }],
  }, 'root instructions v2')
  const scopeless = appendControlRow(session, { kind: 'agent-instructions' }, 'legacy instructions without changes[]')
  const cat1 = appendControlRow(session, { kind: 'skill-catalog' }, '<available_skills>one</available_skills>')
  const cat2 = appendControlRow(session, { kind: 'skill-catalog' }, '<available_skills>two</available_skills>')

  const stale = staleFoldableHostRowSeqs(session)
  assert.ok(stale.has(rootV1), 'the superseded root-scope copy is stale')
  assert.ok(!stale.has(rootV2), 'the current root-scope copy is not stale')
  assert.ok(!stale.has(wtV1), "the worktree copy is its OWN scope's current row — different files never supersede each other")
  assert.ok(stale.has(scopeless), 'a scope-less row cannot be re-injected (no file identity for the presence gate) — unconditionally stale (S3)')
  assert.ok(stale.has(cat1) && !stale.has(cat2), 'the superseded catalog is stale, the newest is current')
})

test('#215: the range table folds ACROSS stale control rows and splits only at the newest', () => {
  const session = Session.create('stale-table')
  appendTurn(session, 1)
  appendUser(session, longText('q0', 0))             // 1
  appendAssistant(session, longText('a0', 1), 1, 1)  // 2
  const goalOld = appendControlRow(session, { kind: 'goal' }) // 3
  appendUser(session, longText('q1', 2))             // 4
  appendAssistant(session, longText('a1', 3), 1, 3)  // 5
  const goalNew = appendControlRow(session, { kind: 'goal' }) // 6
  appendUser(session, longText('q2', 4))             // 7 — last real user turn (protected tail)
  appendAssistant(session, longText('a2', 5), 1, 5)  // 8

  const ranges = buildCompressibleSeqRanges(session, wholeSurfaceRangeView(session), { preserveRecent: 0 })
  const covers = (seq: number): boolean => ranges.some((range) => range.start <= seq && seq <= range.end)
  assert.ok(covers(goalOld), `an offered span folds across the stale goal row (${goalOld}) — the fragmentation bug`)
  assert.ok(covers(goalOld + 1), 'the span carries the surrounding work messages too')
  assert.ok(!covers(goalNew), `no offered span covers the NEWEST goal row (${goalNew})`)
  assert.ok(ranges.length >= 2, 'segments still split at the current row (got the expected fragmentation)')
})

test('#215: compress REJECTS a span covering the newest control row; a stale-only span lands', async () => {
  const env = makeEnv()
  const session = Session.create('stale-reject')
  appendTurn(session, 1)
  appendUser(session, longText('q0', 0))             // 1
  appendAssistant(session, longText('a0', 1), 1, 1)  // 2
  appendControlRow(session, { kind: 'goal' })        // 3 — stale once 6 lands
  appendUser(session, longText('q1', 2))             // 4
  appendAssistant(session, longText('a1', 3), 1, 3)  // 5
  appendControlRow(session, { kind: 'goal' })        // 6 — CURRENT
  appendUser(session, longText('q2', 4))             // 7
  appendAssistant(session, longText('a2', 8), 1, 8)  // 8

  const compress = makeTools(env).find((definition) => definition.name === 'compress')
  assert.ok(compress, 'compress tool registered')
  const agent = {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: { tokenMeter: undefined },
  } as never
  const exec = { callId: 'call-acp', name: 'compress', arguments: {}, signal: new AbortController().signal, agent } as never
  const summary = 'Goal state: ship the compression fix; verification evidence recorded in tests/stale-host-rows.test.ts.'

  // A span covering the CURRENT goal row (6) is rejected before the kernel
  // sees it: nothing durable lands, the row is named, the reason is the
  // control-channel lifecycle (not the AGENTS.md story).
  const rejected = await compress.execute({ content: [{ startSeq: 1, endSeq: 7, summary }] } as never, exec)
  const rejectedText = (rejected as { text: string }).text
  assert.match(rejectedText, /Compressed 0 block/)
  assert.match(rejectedText, /seqs \d+\.\.\d+ rejected/)
  assert.match(rejectedText, /newest copy of an injected control channel/)
  assert.match(rejectedText, /seq 6/, 'the current row is named')
  assert.ok(
    !sessionEventsOf(session).some((event) => String((event as { type?: string }).type).startsWith('compaction')),
    'nothing durable landed — the kernel never saw the rejected range',
  )

  // A span covering only the STALE goal row (3) plus work lands normally:
  // removing it while the newest stays visible is the cleanup, no re-injection.
  const staleOnly = await compress.execute({ content: [{ startSeq: 1, endSeq: 5, summary }] } as never, exec)
  const staleText = (staleOnly as { text: string }).text
  assert.match(staleText, /Compressed 1 block/)
  assert.doesNotMatch(staleText, /rejected/)
})

test('#215: the rejection note explains a control-channel-only hit without the AGENTS.md story', () => {
  const session = Session.create('stale-note')
  appendTurn(session, 1)
  appendUser(session, longText('q0', 0))                     // 1
  appendAssistant(session, longText('a0', 1), 1, 1)          // 2
  appendControlRow(session, { kind: 'time-context' })        // 3 — stale
  appendUser(session, longText('q1', 2))                     // 4
  appendAssistant(session, longText('a1', 3), 1, 3)          // 5
  const tcCurrent = appendControlRow(session, { kind: 'time-context' }) // 6 — CURRENT
  appendUser(session, longText('q2', 4))                     // 7 — last real user turn, OUTSIDE the probed span
  appendAssistant(session, longText('a2', 8), 1, 8)          // 8

  const shadowed = [1, 2, 3, 4, 5, 6]
  const hits = guardedRowsInSpan(guardedSurfaceSeqsOf(session), shadowed)
  assert.deepEqual(hits, [tcCurrent], 'within this span only the current time-context row is guarded')
  const note = protectedRowRejectionNote(1, 6, hits, shadowed, session)
  assert.match(note, /newest copy of an injected control channel \(goal \/ time-context \/ team-message\)/)
  assert.doesNotMatch(note, /AGENTS\.md/, 'no AGENTS.md re-injection story for a control-channel hit')
  assert.match(note, /older\/stale copies of the same channel are fine to compress/)
})

test('#215: /acp-prune status shows the context map — injected rows by channel + compressible geometry', async () => {
  const env = makeEnv()
  const session = Session.create('stale-status')
  appendTurn(session, 1)
  appendUser(session, longText('q0', 0))             // 1
  appendAssistant(session, longText('a0', 1), 1, 1)  // 2
  appendControlRow(session, { kind: 'goal' })        // 3 — stale
  appendControlRow(session, { kind: 'goal' })        // 4 — current
  appendControlRow(session, { kind: 'time-context' })// 5 — current (lone copy)
  appendUser(session, longText('q1', 2))             // 6
  appendAssistant(session, longText('a1', 3), 1, 3)  // 7
  appendToolCall(session, longText('call0', 99), 'c0')
  appendToolResult(session, longText('res0', 100), 'c0')

  const command = acpCommand(env)
  const result = await command.handler({
    commandId: 'cmd-test' as never,
    agent: fakeAgent(session),
    rawInput: 'status',
    signal: new AbortController().signal,
  } as never)
  assert.equal(result.kind, 'success')
  const text = (result as { text: string }).text
  assert.ok(text.includes('── context map ──'), 'context map section present')
  assert.match(text, /surface: \d+ node\(s\) \(/, 'surface line with node count')
  assert.match(
    text,
    /injected rows: 3 \(\d+% of surface\) — goal 2 \(1 stale\) · time-context 1/,
    'per-channel counts with the stale/current split, largest channel first',
  )
  assert.match(text, /compressible: \d+ range\(s\), ~[\d,]+ tokens \(largest [\d,]+\)/, 'compressible geometry line')
})
