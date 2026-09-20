/**
 * Cross-checkpoint spans (billion-context-dsh#155 review follow-up: "跨 checkpoint
 * 的 span 是否 barrier").
 *
 * Two contracts are pinned here:
 *
 * 1. (permanent) The resolver + ref layer never hand a CHECKPOINT ref to a range
 *    edge the model did not name. A ref-less node can sit immediately before a
 *    checkpoint (an empty tool result, e.g.), so this is measured over every range
 *    the resolver accepts, not argued. `resolveSurfaceRange` only accepts a START
 *    edge whose cut is tool-pairing-BALANCED, and a tool/result can only sit at a
 *    balanced-before cut when no call is open there — impossible for a real result
 *    (one result per call; true orphans are pruned first) — while empty user /
 *    call-less empty assistant nodes are not anchorable at all. The tier-3 walk in
 *    `edgeRefForSeq` therefore never walks forward into a later checkpoint.
 *
 * 2. (CHARACTERIZATION — flips when the upstream fix lands) A PLAIN range whose
 *    span crosses a checkpoint folds that checkpoint message like any other
 *    message: the kernel's summary filter is `isSummaryMessageId` (the
 *    `acp_summary_*` prefix of summaries the kernel renders itself), and a
 *    host-carried checkpoint is a plain `user/message` whose CoreMessage id is its
 *    surface seq, so nothing recognizes it as a summary. The behavior stays
 *    coherent (the superseded block is recorded as a parent, the tier is reported,
 *    the originals stay recoverable from the log) but the absorbed summary text
 *    silently leaves the visible surface.
 *
 *    UPSTREAM: ranxianglei/acp-kernel#335 (filed 2026-09-20) — a
 *    host-carried summary should be recognizable so a plain range (neither edge a
 *    block ref) skips it, while a block-ref boundary keeps distilling (tier 2/3,
 *    covered by tests/tools.test.ts). When that lands: flip the assertion in
 *    `folds it like any other message` to `does NOT fold it`, keep the parent/tier
 *    assertions, and delete this marker (AGENTS.md rule 11 discipline).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createCore, type CompressionCore } from 'acp-kernel'
import { Session } from '@deepseek-ai/dsh-session'
import { allLogMessages } from '../src/messages.ts'
import { kernelConfigFor } from '../src/config.ts'
import { AcpStateStore } from '../src/state.ts'
import { blockRefForSummarySeq, rebuildBlockLedger, resolveSurfaceRange, shadowedSeqsOf } from '../src/region.ts'
import { edgeRefForSeq, makeTools, type ToolEnvironment } from '../src/tools.ts'
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
 * The adversarial shape: a multi-call assistant (sub-id refs, no bare ref) followed
 * by an EMPTY tool result (no ref at all), so ref-less live nodes sit right where a
 * checkpoint later lands, with a second multi-call + empty result pair behind it.
 */
function crossCheckpointFixture(id: string): Session {
  const session = Session.create(id)
  appendTurn(session, 1)
  appendUser(session, bigText('u1', 1))                        // seq 1 — ref 1
  appendMultiToolCall(session, bigText('a2', 2), ['c1', 'c2']) // seq 2 — refs 2#c1, 2#c2
  appendToolResult(session, bigText('r3', 3), 'c1')            // seq 3 — ref 3
  appendEmptyToolResult(session, 'c2')                         // seq 4 — NO ref
  appendUser(session, bigText('u5', 5))                        // seq 5 — ref 5
  appendMultiToolCall(session, bigText('a6', 6), ['c3', 'c4']) // seq 6 — refs 6#c3, 6#c4
  appendEmptyToolResult(session, 'c3')                         // seq 7 — NO ref
  appendToolResult(session, bigText('r8', 8), 'c4')            // seq 8 — ref 8
  appendUser(session, bigText('u9', 9))                        // seq 9
  appendAssistant(session, bigText('a10', 10))                 // seq 10
  appendUser(session, bigText('u11', 11))                      // seq 11
  appendAssistant(session, bigText('a12', 12))                 // seq 12
  return session
}

/** The live ref map the kernel assigns on this surface. */
function kernelRefs(env: ToolEnvironment, session: Session): Record<string, string> {
  const turn = env.kernel.processTurn({
    messages: allLogMessages(session),
    state: env.store.stateFor(session),
    config: kernelConfigFor({ modelContextLimit: 128000 }),
    tokenCount: 300000,
  })
  return (turn.state.messageRefs?.byRaw ?? {}) as Record<string, string>
}

/** Surface seqs of the block checkpoint nodes the engine wrote into the log. */
function checkpointSeqs(session: Session): number[] {
  const seqs: number[] = []
  for (const event of session.snapshotEvents()) {
    const record = event as { type?: string; seq?: number; data?: { source?: { plugin?: string } } }
    if (record.type === 'user/message' && record.data?.source?.plugin === 'compact') seqs.push(Number(record.seq))
  }
  return seqs
}

/** Append fresh turns so an older checkpoint leaves the protected recent/last-user window. */
function appendTraffic(session: Session, fromSeq: number, turns: number): void {
  for (let index = 0; index < turns; index += 1) {
    const base = fromSeq + index * 2
    appendTurn(session, base)
    appendUser(session, bigText(`u${base}`, base))
    appendAssistant(session, bigText(`a${base + 1}`, base + 1))
  }
}

test('cross-checkpoint span: no range edge ever takes a checkpoint ref the model did not name', async () => {
  const env = makeEnv()
  const session = crossCheckpointFixture('checkpoint-edges')
  const compress = tool(env, 'compress')
  const exec = execStub(session, 'call-checkpoint-edges')

  // A MIDDLE range compresses first, so the checkpoint lands between live nodes
  // (leftmost position would hide it behind the surface head).
  const first = await compress.execute({ content: [{ startSeq: 6, endSeq: 9, summary: SUMMARY }] } as never, exec)
  assert.match((first as { text: string }).text, /Compressed 1 block/)

  const checkpoints = checkpointSeqs(session)
  assert.equal(checkpoints.length, 1, 'exactly one checkpoint was written')
  const checkpointSeq = checkpoints[0]!
  const byRaw = kernelRefs(env, session)
  const checkpointRef = byRaw[String(checkpointSeq)]
  assert.ok(checkpointRef, 'the checkpoint carries a ref (the kernel sees it as a message)')

  const nodes = [...session.surface.nodes]
  const ckIndex = nodes.indexOf(checkpointSeq as never)
  assert.ok(ckIndex > 0, 'the checkpoint sits inside the surface, not at an edge')

  let accepted = 0
  let straddling = 0
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      let resolved: { start: number; end: number }
      try {
        resolved = resolveSurfaceRange(session, nodes[i]!, nodes[j]!)
      } catch {
        continue // unbalanced / unanchorable edges are rejected — not this test's subject
      }
      accepted += 1
      const span = shadowedSeqsOf(session, resolved.start, resolved.end)
      const startIdx = nodes.indexOf(resolved.start as never)
      const endIdx = nodes.indexOf(resolved.end as never)
      if (startIdx < ckIndex && ckIndex < endIdx) straddling += 1

      const startRef = blockRefForSummarySeq(session, resolved.start)
        ?? edgeRefForSeq(session, byRaw, resolved.start, 'start', resolved.end)
      const endRef = blockRefForSummarySeq(session, resolved.end)
        ?? edgeRefForSeq(session, byRaw, resolved.end, 'end', resolved.start)

      // Every accepted range must also be NAMABLE — handleCompress throws
      // "has no assigned ref" when an edge yields nothing, so the resolver's
      // accepted set must never contain such an edge.
      assert.ok(startRef !== undefined, `start edge seq ${resolved.start} has no ref`)
      assert.ok(endRef !== undefined, `end edge seq ${resolved.end} has no ref`)
      // An edge that IS the checkpoint is the legitimate distillation call (the
      // model named it, and `blockRefForSummarySeq` maps it to the block ref bN).
      // Any OTHER edge taking the checkpoint's ref would silently distill a block
      // the model never targeted.
      assert.notEqual(
        startRef,
        checkpointRef,
        `start edge seq ${resolved.start} took the checkpoint ref (model never named seq ${checkpointSeq})`,
      )
      assert.notEqual(
        endRef,
        checkpointRef,
        `end edge seq ${resolved.end} took the checkpoint ref (model never named seq ${checkpointSeq})`,
      )
      void span
    }
  }

  assert.ok(accepted > 20, `the fixture must offer plenty of ranges (got ${accepted})`)
  assert.ok(
    straddling > 0,
    'the fixture must actually produce spans whose positional slice covers the checkpoint — '
    + 'otherwise this test proves nothing about the checkpoint geometry',
  )
})

test('cross-checkpoint span: a PLAIN range folds the checkpoint like any other message (characterization)', async () => {
  const env = makeEnv()
  const session = crossCheckpointFixture('checkpoint-plain-range')
  const compress = tool(env, 'compress')
  const exec = execStub(session, 'call-checkpoint-plain')
  const summary = SUMMARY

  const first = await compress.execute({ content: [{ startSeq: 6, endSeq: 9, summary }] } as never, exec)
  assert.match((first as { text: string }).text, /Compressed 1 block/)

  const checkpointSeq = checkpointSeqs(session)[0]!
  // Push the checkpoint out of the protected recent/last-user window, otherwise the
  // host-side protection (not a kernel barrier) hides it from the fold.
  appendTraffic(session, 17, 8)
  const lastSeq = session.surface.nodes[session.surface.nodes.length - 1]!

  const second = await compress.execute(
    { content: [{ startSeq: 1, endSeq: lastSeq, summary: `${summary} Whole span.` }] } as never,
    execStub(session, 'call-checkpoint-plain-2'),
  )
  const text = (second as { text: string }).text
  assert.match(text, /Compressed 1 block/)
  // Neither edge is a block ref, so the kernel reports a plain fold: no tier upgrade.
  assert.match(text, /tier 1/)

  const ledger = rebuildBlockLedger(session.snapshotEvents())
  assert.equal(ledger.length, 2, 'two blocks: the first fold and the range that swallowed it')
  const newest = ledger[ledger.length - 1]!
  const folded = newest.effectiveMessageIds ?? []

  // CHARACTERIZATION (see the file header): the checkpoint message is folded.
  assert.ok(
    folded.includes(String(checkpointSeq)),
    `current behavior: the crossed checkpoint (seq ${checkpointSeq}) is folded into the new block; `
    + `effective ids = ${folded.join(',')}`,
  )
  // Coherence that must hold in either world:
  assert.deepEqual(newest.parentBlockIds, [ledger[0]!.blockId], 'the superseded block is recorded as a parent')
  assert.equal(newest.tier, 1, 'a plain (non-block-boundary) range does not upgrade the tier')
  assert.ok(
    newest.shadowedSeqs.includes(checkpointSeq),
    'the shadowed slice names the checkpoint, so the transaction is internally consistent',
  )

  // Nothing is lost: the superseded block still decompresses from the log.
  const decompress = tool(env, 'decompress')
  const recovered = await decompress.execute({ blockId: ledger[0]!.blockId, inline: true } as never, exec)
  const recoveredText = (recovered as { text: string }).text
  assert.match(recoveredText, /a6|r8/, 'the superseded block\'s originals are still recoverable')
})

test('cross-checkpoint span: while the checkpoint is inside the protection window it is not folded', async () => {
  const env = makeEnv()
  const session = crossCheckpointFixture('checkpoint-protected')
  const compress = tool(env, 'compress')

  const first = await compress.execute(
    { content: [{ startSeq: 6, endSeq: 9, summary: SUMMARY }] } as never,
    execStub(session, 'call-checkpoint-protected'),
  )
  assert.match((first as { text: string }).text, /Compressed 1 block/)
  const checkpointSeq = checkpointSeqs(session)[0]!

  // No fresh traffic: the checkpoint is still within the recent zone, so the
  // protected-message filter removes it from the fold (this is host protection,
  // NOT a kernel checkpoint barrier — see the test above for the other side).
  const lastSeq = session.surface.nodes[session.surface.nodes.length - 1]!
  const second = await compress.execute(
    { content: [{ startSeq: 1, endSeq: lastSeq, summary: `${SUMMARY} Whole span.` }] } as never,
    execStub(session, 'call-checkpoint-protected-2'),
  )
  assert.match((second as { text: string }).text, /Compressed 1 block/)

  const ledger = rebuildBlockLedger(session.snapshotEvents())
  const folded = ledger[ledger.length - 1]!.effectiveMessageIds ?? []
  assert.ok(
    !folded.includes(String(checkpointSeq)),
    `inside the protection window the checkpoint is excluded from the fold (seq ${checkpointSeq})`,
  )
})
