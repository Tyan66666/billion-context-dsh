import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import {
  DEGENERATION_RECOVERY_NOTE,
  detectDegeneration,
  findDegenerateRuns,
  resolveDegenerationGuard,
  type DegenerationGuardConfig,
} from '../src/degeneration.ts'
import { sessionEventsOf } from '../src/session-events.ts'
import { hideSurfaceSeqs } from '../src/region.ts'
import { appendTurn } from './helpers.ts'

type Block =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }

function makeSession(id = 'deg-session'): Session {
  return Session.create(id)
}

function appendAssistantRaw(session: Session, content: Block[], turn = 1, step = 1): void {
  session.append('assistant/message', {
    turn,
    step,
    stream: [],
    message: createAssistantMessage({ content, provider: 'test-provider', model: 'test-model' }),
  }, { surfaceOp: 'append' })
}

type Resolved = ReturnType<typeof resolveDegenerationGuard>
const observe = (): Resolved => resolveDegenerationGuard({ mode: 'observe' })

test('findDegenerateRuns: nothing below minRun', () => {
  assert.deepEqual(findDegenerateRuns('abcabc', 4), [])
  assert.deepEqual(findDegenerateRuns('x'.repeat(199), 200), [])
})

test('findDegenerateRuns: maximal single-codepoint run at/above minRun', () => {
  const runs = findDegenerateRuns('ab' + 'x'.repeat(200) + 'cd', 200)
  assert.equal(runs.length, 1)
  assert.equal(runs[0]!.char, 'x')
  assert.equal(runs[0]!.count, 200)
})

test('findDegenerateRuns: surrogate pair counts as ONE codepoint', () => {
  const runs = findDegenerateRuns('\u{1F600}'.repeat(150), 100)
  assert.equal(runs.length, 1)
  assert.equal(runs[0]!.count, 150)
  assert.equal(runs[0]!.char, '\u{1F600}')
})

test('findDegenerateRuns: minRun < 2 short-circuits to empty', () => {
  assert.deepEqual(findDegenerateRuns('aaaaaa', 1), [])
})

test('resolveDegenerationGuard: defaults (observe / 200 / 2 / no phrases)', () => {
  const r = resolveDegenerationGuard()
  assert.equal(r.mode, 'observe')
  assert.equal(r.minRun, 200)
  assert.equal(r.foldMinConsecutiveRounds, 2)
  assert.deepEqual([...r.selfAbortPhrases], [])
})

test('resolveDegenerationGuard: minRun clamped up to floor 8, kept above', () => {
  assert.equal(resolveDegenerationGuard({ minRun: 3 }).minRun, 8)
  assert.equal(resolveDegenerationGuard({ minRun: 500 }).minRun, 500)
})

test('resolveDegenerationGuard: invalid minRun falls back to the default 200', () => {
  assert.equal(resolveDegenerationGuard({ minRun: 1 }).minRun, 200)
  assert.equal(resolveDegenerationGuard({ minRun: Number.NaN }).minRun, 200)
})

test('resolveDegenerationGuard: foldMinConsecutiveRounds floors at 2', () => {
  assert.equal(resolveDegenerationGuard({ foldMinConsecutiveRounds: 1 }).foldMinConsecutiveRounds, 2)
  assert.equal(resolveDegenerationGuard({ foldMinConsecutiveRounds: 5 }).foldMinConsecutiveRounds, 5)
})

test('resolveDegenerationGuard: a mistyped mode degrades to observe, never fold', () => {
  // The value arrives from YAML at runtime; a one-character typo must not
  // silently enable automatic surface folding (the consumer treats anything
  // that is not exactly 'off'/'observe' as fold).
  const bad = { mode: 'Fold' } as unknown as DegenerationGuardConfig
  assert.equal(resolveDegenerationGuard(bad).mode, 'observe')
})

test('detectDegeneration: off returns nothing even for a degenerate tail', () => {
  const s = makeSession()
  appendTurn(s, 1)
  appendAssistantRaw(s, [{ type: 'reasoning', text: 'x'.repeat(300) }])
  assert.deepEqual(detectDegeneration(sessionEventsOf(s), resolveDegenerationGuard({ mode: 'off' })), [])
})

test('detectDegeneration: run-length catches a >=minRun run in reasoning, detail carries no sample', () => {
  const s = makeSession()
  appendTurn(s, 1)
  appendAssistantRaw(s, [{ type: 'text', text: 'ok' }, { type: 'reasoning', text: 'y'.repeat(250) }])
  const findings = detectDegeneration(sessionEventsOf(s), observe())
  const rl = findings.find((f) => f.kind === 'run-length')
  assert.ok(rl, 'expected a run-length finding')
  assert.equal(rl.seqs.length, 1)
  assert.ok(!rl.detail.includes('y'.repeat(20)), 'detail must not embed the repeated sample')
})

test('detectDegeneration: run-length skips nodes that carry tool calls', () => {
  const s = makeSession()
  appendTurn(s, 1)
  appendAssistantRaw(s, [
    { type: 'text', text: 'z'.repeat(300) },
    { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
  ])
  const findings = detectDegeneration(sessionEventsOf(s), observe())
  assert.equal(findings.find((f) => f.kind === 'run-length'), undefined)
})

test('detectDegeneration: structural requires >=2 consecutive stuck rounds', () => {
  const s = makeSession()
  appendTurn(s, 1)
  appendAssistantRaw(s, [{ type: 'reasoning', text: 'I need to call the tool now' }], 1, 1)
  let findings = detectDegeneration(sessionEventsOf(s), observe())
  assert.equal(findings.find((f) => f.kind === 'structural'), undefined, 'a single stuck round is not enough')

  appendAssistantRaw(s, [{ type: 'reasoning', text: 'preparing to send' }], 1, 2)
  findings = detectDegeneration(sessionEventsOf(s), observe())
  const st = findings.find((f) => f.kind === 'structural')
  assert.ok(st, 'two consecutive stuck rounds must produce a structural finding')
  assert.equal(st.seqs.length, 2)
  assert.ok(st.seqs[0]! < st.seqs[1]!, 'oldest-first ordering')
})

test('detectDegeneration: a healthy visible turn breaks the structural streak', () => {
  const s = makeSession()
  appendTurn(s, 1)
  appendAssistantRaw(s, [{ type: 'reasoning', text: 'thinking about it' }], 1, 1)
  appendAssistantRaw(s, [{ type: 'text', text: 'here is my real answer body' }], 1, 2)
  const findings = detectDegeneration(sessionEventsOf(s), observe())
  assert.equal(findings.find((f) => f.kind === 'structural'), undefined)
})

test('detectDegeneration: selfAbortPhrases tighten the gate when configured', () => {
  const guard = resolveDegenerationGuard({ selfAbortPhrases: ['stop it'] })
  const s1 = makeSession()
  appendTurn(s1, 1)
  appendAssistantRaw(s1, [{ type: 'reasoning', text: 'thinking a' }], 1, 1)
  appendAssistantRaw(s1, [{ type: 'reasoning', text: 'thinking b' }], 1, 2)
  assert.equal(detectDegeneration(sessionEventsOf(s1), guard).find((f) => f.kind === 'structural'), undefined,
    'without the configured phrase the structural gate must stay closed')

  const s2 = makeSession()
  appendTurn(s2, 1)
  appendAssistantRaw(s2, [{ type: 'reasoning', text: 'this is going wrong, stop it' }], 1, 1)
  appendAssistantRaw(s2, [{ type: 'reasoning', text: 'resuming' }], 1, 2)
  assert.ok(detectDegeneration(sessionEventsOf(s2), guard).find((f) => f.kind === 'structural'),
    'a stuck streak containing the phrase must fire')
})

test('DEGENERATION_RECOVERY_NOTE is non-empty and carries no repeated sample', () => {
  assert.ok(DEGENERATION_RECOVERY_NOTE.length > 0)
  assert.ok(!/(\S)\1{7,}/.test(DEGENERATION_RECOVERY_NOTE), 'note must not embed a repeated-char sample')
})

test('fold path: hideSurfaceSeqs durably removes a degenerate node, one prune per node', () => {
  const s = makeSession('fold-session')
  appendTurn(s, 1)
  appendAssistantRaw(s, [{ type: 'reasoning', text: 'preparing to send' }], 1, 1)
  appendAssistantRaw(s, [{ type: 'reasoning', text: 'about to emit' }], 1, 2)

  const findings = detectDegeneration(sessionEventsOf(s), resolveDegenerationGuard({ mode: 'fold' }))
  const st = findings.find((f) => f.kind === 'structural')
  assert.ok(st, 'need a structural finding to fold')

  for (const seq of [...st.seqs].reverse()) hideSurfaceSeqs(s, [seq], DEGENERATION_RECOVERY_NOTE)

  const prunes = s.snapshotEvents().filter((event) => event.type === 'compaction/prune')
  assert.equal(prunes.length, st.seqs.length, 'one compaction/prune per folded node')
  const shadowed = prunes.map((p) => (p.data as { shadowedSeqs: number[] }).shadowedSeqs[0]!)
  assert.deepEqual(shadowed.sort((a, b) => a - b), [...st.seqs].sort((a, b) => a - b))
})

test('detectDegeneration: already-shadowed nodes do not re-fire (liveness filter)', () => {
  const s = makeSession('deg-live')
  appendTurn(s, 1)
  appendAssistantRaw(s, [{ type: 'reasoning', text: 'stuck one' }], 1, 1)
  appendAssistantRaw(s, [{ type: 'reasoning', text: 'stuck two' }], 1, 2)
  const cfg = resolveDegenerationGuard({ mode: 'fold' })
  const isLive = () => new Set<number>(s.surface.nodes)

  // Both stuck turns are live: the structural finding fires.
  const first = detectDegeneration(sessionEventsOf(s), cfg, (seq) => isLive().has(seq))
  const st = first.find((f) => f.kind === 'structural')
  assert.ok(st, 'two consecutive live stuck turns must fire')

  // Fold them away exactly as applyDegenerationGuard does: they leave the
  // surface but remain in the durable log forever.
  for (const seq of [...st!.seqs].reverse()) hideSurfaceSeqs(s, [seq], DEGENERATION_RECOVERY_NOTE)

  // With the liveness filter (what index.ts passes) the log-resident originals
  // must not re-fire on the next step...
  assert.deepEqual(detectDegeneration(sessionEventsOf(s), cfg, (seq) => isLive().has(seq)), [],
    'shadowed originals must not re-fire from the log')
  // ...while the unfiltered detector still sees them — proof the filter, not
  // coincidence, is what suppresses the repeat.
  assert.ok(detectDegeneration(sessionEventsOf(s), cfg).find((f) => f.kind === 'structural'),
    'the unfiltered detector still matches the log-resident episode (the trap the filter prevents)')
})

test('detectDegeneration: a single new stuck turn after a folded episode does not refire', () => {
  const s = makeSession('deg-retry')
  appendTurn(s, 1)
  appendAssistantRaw(s, [{ type: 'reasoning', text: 'stuck a' }], 1, 1)
  appendAssistantRaw(s, [{ type: 'reasoning', text: 'stuck b' }], 1, 2)
  const cfg = resolveDegenerationGuard({ mode: 'fold' })
  const isLive = () => new Set<number>(s.surface.nodes)

  const first = detectDegeneration(sessionEventsOf(s), cfg, (seq) => isLive().has(seq))
  const st = first.find((f) => f.kind === 'structural')!
  for (const seq of [...st.seqs].reverse()) hideSurfaceSeqs(s, [seq], DEGENERATION_RECOVERY_NOTE)

  // One more stuck turn lands AFTER the recovery note was delivered. The
  // shadowed turns break the streak (conservative by design): one live stuck
  // turn alone must not trigger another fold before the note gets its chance.
  appendAssistantRaw(s, [{ type: 'reasoning', text: 'stuck c' }], 1, 3)
  const second = detectDegeneration(sessionEventsOf(s), cfg, (seq) => isLive().has(seq))
  assert.equal(second.find((f) => f.kind === 'structural'), undefined,
    'the recovery note must get one full turn to work before the guard acts again')
})
