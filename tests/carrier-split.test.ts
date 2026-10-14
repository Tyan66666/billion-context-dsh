/**
 * Carrier-span policy (billion-context-dsh#214): a PLAIN compress span that
 * crosses a live block's checkpoint carrier is, by default, SPLIT — each side
 * around a carrier is compressed separately with the model's own summary and
 * every carrier stays visible; `carrierSpans: 'reject'` restores the original
 * hard reject.
 *
 * Root cause pinned here: acp_status's ranges view feeds the kernel a surface
 * with checkpoint nodes filtered out (breakdown double-counting guard, rule 9),
 * so the two sides of a carrier merge into ONE row. The model names exactly
 * that cross-carrier span, gets rejected, looks at the same listing again, and
 * retries the same span verbatim — while the nudge table (which flushes at
 * carriers) never offers such a row. Since #214 the two sources agree: the
 * gate splits what the listing shows, and the listing names the boundary.
 *
 * Contracts pinned:
 * 1. split is the default: both sides land as their own tier-1 blocks, every
 *    carrier stays on the surface, and the result names the kept seqs.
 * 2. A span crossing N carriers yields one side-span per gap (adjacent
 *    carriers share a single flush).
 * 3. `carrierSpans: 'reject'` keeps the original behavior: nothing lands, and
 *    the note now hands back executable side spans in addition to the block ids.
 * 4. Guarded rows still beat the split: a span that also covers the newest
 *    real user turn is rejected whole — no side lands.
 * 5. Side-spans share the call's dedup map: an explicitly requested sub-range
 *    is not compressed twice when the crossing span splits onto it.
 * 6. `/acp-prune compress` runs the same policy (shared path, both policies).
 * 7. acp_status's ranges view names the carrier boundaries + the policy in
 *    force (append-only — the report body stays kernel-owned text).
 * 8. Config validation: default 'split', 'reject' round-trips, unknown values
 *    throw, an explicit undefined reads as the default.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createCore, type CompressionCore } from 'acp-kernel'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session } from '@deepseek-ai/dsh-session'
import { isCheckpointNode } from '../src/messages.ts'
import { AcpStateStore } from '../src/state.ts'
import { rebuildBlockLedger } from '../src/region.ts'
import { makeTools, type ToolEnvironment } from '../src/tools.ts'
import { acpCommand } from '../src/commands.ts'
import { resolveAcpConfig } from '../src/index.ts'
import {
  appendAssistant,
  appendEmptyToolResult,
  appendMultiToolCall,
  appendToolResult,
  appendTurn,
  appendUser,
  longText,
} from './helpers.ts'

/** Two stacked longText copies — one message alone clears the kernel's 5000-char floor. */
const bigText = (label: string, seed: number): string => longText(label, seed) + longText(`${label}b`, seed + 100)

const SUMMARY = 'Auth: JWT access tokens 15 min expiry, refresh tokens in Redis 30 day TTL, '
  + 'login in src/auth/login.ts, rate limit 10 req/min/IP, bcrypt cost 12.'

function makeEnv(): ToolEnvironment {
  return {
    kernel: createCore({}) as CompressionCore,
    store: new AcpStateStore(),
    modelContextLimit: 128000,
    compressCallIdsToHide: new Set(),
  }
}

function execStub(session: Session, callId: string): never {
  const agent = {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: { tokenMeter: undefined },
  }
  return {
    callId,
    name: 'compress',
    arguments: {},
    signal: new AbortController().signal,
    agent,
  } as never
}

function tool(env: ToolEnvironment, name: string) {
  const definition = makeTools(env).find((candidate) => candidate.name === name)
  assert.ok(definition, `${name} tool registered`)
  return definition
}

/**
 * Same adversarial shape as tests/checkpoint-span.test.ts: multi-call assistants
 * (sub-id refs) and EMPTY tool results (no ref at all) sit where checkpoints land.
 * Surface seqs: 1 u1 · 2 a2[c1,c2] · 3 r3(c1) · 4 empty(c2) · 5 u5 · 6 a6[c3,c4]
 * · 7 empty(c3) · 8 r8(c4) · 9 u9 · 10 a10 · 11 u11 · 12 a12.
 */
function crossCheckpointFixture(id: string): Session {
  const session = Session.create(id)
  appendTurn(session, 1)
  appendUser(session, bigText('u1', 1))                        // seq 1
  appendMultiToolCall(session, bigText('a2', 2), ['c1', 'c2']) // seq 2
  appendToolResult(session, bigText('r3', 3), 'c1')            // seq 3
  appendEmptyToolResult(session, 'c2')                         // seq 4 — NO ref
  appendUser(session, bigText('u5', 5))                        // seq 5
  appendMultiToolCall(session, bigText('a6', 6), ['c3', 'c4']) // seq 6
  appendEmptyToolResult(session, 'c3')                         // seq 7 — NO ref
  appendToolResult(session, bigText('r8', 8), 'c4')            // seq 8
  appendUser(session, bigText('u9', 9))                        // seq 9
  appendAssistant(session, bigText('a10', 10))                 // seq 10
  appendUser(session, bigText('u11', 11))                      // seq 11
  appendAssistant(session, bigText('a12', 12))                 // seq 12
  return session
}

/** Surface seqs of the block checkpoint nodes the engine wrote into the log. */
function checkpointSeqs(session: Session): number[] {
  const seqs: number[] = []
  for (const event of session.snapshotEvents()) {
    if (isCheckpointNode(event)) seqs.push(Number((event as { seq?: number }).seq))
  }
  return seqs
}

/** Append fresh turns so older content leaves the protected recent/last-user window. */
function appendTraffic(session: Session, fromSeq: number, turns: number): void {
  for (let index = 0; index < turns; index += 1) {
    const base = fromSeq + index * 2
    appendTurn(session, base)
    appendUser(session, bigText(`u${base}`, base))
    appendAssistant(session, bigText(`a${base + 1}`, base + 1))
  }
}

/** Compress the middle range [6..9] so a live checkpoint sits between live nodes. */
async function plantCheckpoint(env: ToolEnvironment, session: Session, callId: string): Promise<number> {
  const compress = tool(env, 'compress')
  const first = await compress.execute({ content: [{ startSeq: 6, endSeq: 9, summary: SUMMARY }] } as never, execStub(session, callId))
  assert.match((first as { text: string }).text, /Compressed 1 block/)
  const checkpoints = checkpointSeqs(session)
  assert.equal(checkpoints.length, 1, 'exactly one checkpoint was written')
  return checkpoints[0]!
}

test('#214 split is the default: a crossing span lands both sides, the carrier stays visible', async () => {
  const env = makeEnv() // no carrierSpans → the engine default ('split')
  const session = crossCheckpointFixture('split-default')
  const compress = tool(env, 'compress')
  const checkpointSeq = await plantCheckpoint(env, session, 'call-split-default')
  appendTraffic(session, 17, 8)
  const lastSeq = session.surface.nodes[session.surface.nodes.length - 1]!
  // End two nodes early: since issue #196 the newest real user turn is guarded.
  const second = await compress.execute(
    { content: [{ startSeq: 1, endSeq: lastSeq - 2, summary: `${SUMMARY} Whole span.` }] } as never,
    execStub(session, 'call-split-default-2'),
  )
  const text = (second as { text: string }).text
  assert.match(text, /Compressed 2 block/, 'both side-spans landed')
  assert.ok(text.includes(`seq ${checkpointSeq} (b1)`), 'the result names the kept carrier')
  assert.match(text, /stay visible/, 'the result says the carrier stays visible')

  const ledger = rebuildBlockLedger(session.snapshotEvents())
  assert.equal(ledger.length, 3, 'original block + one block per side')
  for (const block of ledger) assert.equal(block.tier, 1, 'plain folds stay tier 1')
  assert.ok(
    session.surface.nodes.includes(checkpointSeq as never),
    `the live carrier stays on the surface (seq ${checkpointSeq})`,
  )
})

test('#214 a span crossing two carriers yields one side-span per gap, both carriers stay', async () => {
  const env = makeEnv()
  const session = crossCheckpointFixture('split-two-carriers')
  const compress = tool(env, 'compress')
  const checkpointSeq = await plantCheckpoint(env, session, 'call-two-carriers')
  appendTraffic(session, 17, 8)
  // A second middle compression → a second live checkpoint, adjacent to the first
  // on the surface (both sit between u5 and u11).
  const third = await compress.execute(
    { content: [{ startSeq: 10, endSeq: 10, summary: `${SUMMARY} Assistant a10.` }] } as never,
    execStub(session, 'call-two-carriers-3'),
  )
  assert.match((third as { text: string }).text, /Compressed 1 block/)
  const checkpointsAfterTwo = checkpointSeqs(session)
  assert.equal(checkpointsAfterTwo.length, 2)
  const secondCheckpointSeq = checkpointsAfterTwo.find((seq) => seq !== checkpointSeq)!
  appendTraffic(session, 33, 2)

  const lastSeq = session.surface.nodes[session.surface.nodes.length - 1]!
  const fourth = await compress.execute(
    { content: [{ startSeq: 1, endSeq: lastSeq - 2, summary: `${SUMMARY} Whole span.` }] } as never,
    execStub(session, 'call-two-carriers-4'),
  )
  const text = (fourth as { text: string }).text
  assert.match(text, /Compressed 2 block/, 'two gaps → two side-spans (adjacent carriers share a flush)')
  assert.ok(text.includes(`seq ${checkpointSeq} (b1)`), 'names the first kept carrier')
  assert.ok(text.includes(`seq ${secondCheckpointSeq} (b2)`), 'names the second kept carrier')

  const ledger = rebuildBlockLedger(session.snapshotEvents())
  assert.equal(ledger.length, 4)
  assert.ok(session.surface.nodes.includes(checkpointSeq as never), 'first carrier stays visible')
  assert.ok(session.surface.nodes.includes(secondCheckpointSeq as never), 'second carrier stays visible')
})

test('#214 carrierSpans: \'reject\' keeps the original behavior, with executable side advice', async () => {
  const env = { ...makeEnv(), carrierSpans: 'reject' as const }
  const session = crossCheckpointFixture('split-reject-policy')
  const compress = tool(env, 'compress')
  const checkpointSeq = await plantCheckpoint(env, session, 'call-reject-policy')
  appendTraffic(session, 17, 8)
  const lastSeq = session.surface.nodes[session.surface.nodes.length - 1]!
  const second = await compress.execute(
    { content: [{ startSeq: 1, endSeq: lastSeq - 2, summary: `${SUMMARY} Whole span.` }] } as never,
    execStub(session, 'call-reject-policy-2'),
  )
  const text = (second as { text: string }).text
  assert.match(text, /Compressed 0 block/)
  assert.match(text, /still-active block/, 'the reject names the reason')
  assert.match(text, /startSeq: "b1"/, 'the reject still hands back the block-id distill call')
  // The pre-#214 note said "cut the span around those seqs" — a direction. Now
  // it names the exact compressible side spans, which is what stops the retry.
  assert.match(text, /or compress the sides separately \(seq \d+\.\.\d+ and \d+\.\.\d+\)/)

  assert.equal(rebuildBlockLedger(session.snapshotEvents()).length, 1, 'nothing landed')
  assert.ok(session.surface.nodes.includes(checkpointSeq as never), 'the carrier stays visible')
})

test('#214 guarded rows beat the split: a span over the active user turn is rejected whole', async () => {
  const env = makeEnv()
  const session = crossCheckpointFixture('split-guard-priority')
  const compress = tool(env, 'compress')
  const checkpointSeq = await plantCheckpoint(env, session, 'call-guard-priority')
  // No fresh traffic: u11 is still the newest real user turn, and the span ends
  // ON it — the guard must win over the carrier split.
  const second = await compress.execute(
    { content: [{ startSeq: 1, endSeq: 11, summary: `${SUMMARY} Whole span.` }] } as never,
    execStub(session, 'call-guard-priority-2'),
  )
  const text = (second as { text: string }).text
  assert.match(text, /Compressed 0 block/)
  assert.match(text, /must stay live/, 'the user-turn guard explains the rejection')
  assert.ok(!text.includes('side-span'), 'no split happened')
  assert.equal(rebuildBlockLedger(session.snapshotEvents()).length, 1, 'no side landed')
  assert.ok(session.surface.nodes.includes(checkpointSeq as never), 'the carrier stays visible')
})

test('#214 side-spans share the call dedup map: an explicit sub-range is not compressed twice', async () => {
  const env = makeEnv()
  const session = crossCheckpointFixture('split-dedup')
  const compress = tool(env, 'compress')
  const checkpointSeq = await plantCheckpoint(env, session, 'call-dedup')
  appendTraffic(session, 17, 8)
  const lastSeq = session.surface.nodes[session.surface.nodes.length - 1]!
  // One call: the crossing span (which splits onto [1..5]) plus [1..5] asked
  // explicitly. Exactly ONE block may cover [1..5].
  const second = await compress.execute({
    content: [
      { startSeq: 1, endSeq: lastSeq - 2, summary: `${SUMMARY} Whole span.` },
      { startSeq: 1, endSeq: 5, summary: `${SUMMARY} Left side only.` },
    ],
  } as never, execStub(session, 'call-dedup-2'))
  const text = (second as { text: string }).text
  assert.match(text, /Compressed 2 block/, 'left side once + right side once')
  assert.match(text, /resolve to the same span as an earlier range/, 'the duplicate is reported')

  const ledger = rebuildBlockLedger(session.snapshotEvents())
  assert.equal(ledger.length, 3, 'no phantom second block for the left side')
  assert.ok(session.surface.nodes.includes(checkpointSeq as never), 'the carrier stays visible')
})

test('#214 /acp-prune compress shares the policy: split folds the sides, reject refuses', async () => {
  const envSplit = makeEnv()
  const sessionSplit = crossCheckpointFixture('command-split')
  const checkpointSeqSplit = await plantCheckpoint(envSplit, sessionSplit, 'call-command-split')
  appendTraffic(sessionSplit, 17, 8)
  const lastSeqSplit = sessionSplit.surface.nodes[sessionSplit.surface.nodes.length - 1]!
  const agentSplit = {
    id: sessionSplit.id,
    session: sessionSplit,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: new Context(),
  } as unknown as Agent
  const splitResult = await acpCommand(envSplit).handler({
    commandId: 'cmd-test' as never,
    agent: agentSplit,
    rawInput: `compress 1 ${lastSeqSplit - 2} side fold summary`,
    signal: new AbortController().signal,
  } as never)
  assert.equal(splitResult.kind, 'success')
  const splitText = (splitResult as { text: string }).text
  assert.match(splitText, /Compressed 2 side-span\(s\) around live checkpoint carrier\(s\) seq \d+ \(b1\)/)
  assert.match(splitText, /stay visible/)
  assert.equal(rebuildBlockLedger(sessionSplit.snapshotEvents()).length, 3)
  assert.ok(sessionSplit.surface.nodes.includes(checkpointSeqSplit as never), 'the carrier stays visible')

  const envReject = { ...makeEnv(), carrierSpans: 'reject' as const }
  const sessionReject = crossCheckpointFixture('command-reject')
  const checkpointSeqReject = await plantCheckpoint(envReject, sessionReject, 'call-command-reject')
  appendTraffic(sessionReject, 17, 8)
  const lastSeqReject = sessionReject.surface.nodes[sessionReject.surface.nodes.length - 1]!
  const agentReject = {
    id: sessionReject.id,
    session: sessionReject,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: new Context(),
  } as unknown as Agent
  const rejectResult = await acpCommand(envReject).handler({
    commandId: 'cmd-test' as never,
    agent: agentReject,
    rawInput: `compress 1 ${lastSeqReject - 2} side fold summary`,
    signal: new AbortController().signal,
  } as never)
  assert.equal(rejectResult.kind, 'success')
  const rejectText = (rejectResult as { text: string }).text
  assert.match(rejectText, /still-active block/)
  assert.match(rejectText, /or compress the sides separately \(seq \d+\.\.\d+ and \d+\.\.\d+\)/)
  assert.equal(rebuildBlockLedger(sessionReject.snapshotEvents()).length, 1, 'nothing landed')
  assert.ok(sessionReject.surface.nodes.includes(checkpointSeqReject as never), 'the carrier stays visible')
})

test('#214 acp_status ranges view names the carrier boundaries and the policy in force', async () => {
  const envSplit = makeEnv()
  const sessionSplit = crossCheckpointFixture('status-boundaries')
  const checkpointSeqSplit = await plantCheckpoint(envSplit, sessionSplit, 'call-status-split')
  appendTraffic(sessionSplit, 17, 8)
  const statusSplit = tool(envSplit, 'acp_status')
  const outSplit = await statusSplit.execute({ scope: 'uncompressed' } as never, execStub(sessionSplit, 'call-status-split-2'))
  const splitText = (outSplit as { text: string }).text
  assert.ok(splitText.includes(`Carrier boundaries: seq ${checkpointSeqSplit} (b1)`))
  assert.match(splitText, /split around it; the carrier stays visible/)

  const envReject = { ...makeEnv(), carrierSpans: 'reject' as const }
  const sessionReject = crossCheckpointFixture('status-boundaries-reject')
  await plantCheckpoint(envReject, sessionReject, 'call-status-reject')
  appendTraffic(sessionReject, 17, 8)
  const statusReject = tool(envReject, 'acp_status')
  const outReject = await statusReject.execute({ scope: 'uncompressed' } as never, execStub(sessionReject, 'call-status-reject-2'))
  const rejectText = (outReject as { text: string }).text
  assert.match(rejectText, /Carrier boundaries: seq \d+ \(b1\)/)
  assert.match(rejectText, /is rejected; cut around those seqs or distill with the block ids/)
})

test('#214 config validation: default split, reject round-trips, unknown throws, explicit undefined is the default', () => {
  assert.equal(resolveAcpConfig().carrierSpans, 'split', 'default is split')
  assert.equal(resolveAcpConfig({ carrierSpans: 'reject' }).carrierSpans, 'reject')
  assert.equal(resolveAcpConfig({ carrierSpans: undefined }).carrierSpans, 'split', 'an explicit undefined must not read as a value')
  assert.throws(() => resolveAcpConfig({ carrierSpans: 'bogus' as never }), /carrierSpans must be/)
})
