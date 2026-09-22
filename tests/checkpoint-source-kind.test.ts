/**
 * Checkpoint source dual-shape compatibility (billion-context-dsh#168).
 *
 * DSH 0.1.7 changed what the host stamps on checkpoint summary nodes:
 * `@deepseek-ai/dsh-compaction@0.1.7-alpha.1`'s `compactCheckpointSource()`
 * returns `{ kind: 'compact-checkpoint', compactionId }` (+ optional
 * `sourceCommandId`) instead of the ≤0.1.6 wrapper
 * `{ kind: 'plugin', plugin: 'compact', compactionId }` (verified against
 * the published artifact: the marker object is exactly
 * `{ kind: 'compact-checkpoint' }`). The 0.1.7 V3→V4 migration rewrites
 * pre-0.1.7 sessions to the new shape, so BOTH shapes coexist on one surface
 * and the read side must recognize both.
 *
 * The engine writes whatever the host's `compactCheckpointSource()` returns
 * verbatim (src/region.ts runCompactionTransaction), so the write side is
 * version-adaptive by construction. The read side was not: four sites still
 * keyed on `source.plugin === 'compact'` alone, which made a 0.1.7-written
 * checkpoint classify as `real`:
 *   1. acp_status double-counted its summary text (visible text AND block
 *      summary — the rule-9 exclusion filter missed the node);
 *   2. the protected-tail scan could anchor the last-real-user window on the
 *      checkpoint row instead of the real user turn (issue #71 bug class);
 *   3. the ledger index (`summarySeqIndex`) found no seq, so the acp_status
 *      `Checkpoint seqs` row — the model's ONLY route into T2/T3
 *      distillation — was missing for 0.1.7-written blocks;
 *   4. two further sites degraded silently: `blockRefForSummarySeq` stopped
 *      resolving a compress edge sitting on a new-shape checkpoint to its
 *      bN (distillation read as a plain fold), and `checkpointBlockIdOf`
 *      broke the `expandShadowedSeqs` recursion, so decompressing a tier-2
 *      block whose parent checkpoint is new-shape returned the summary text
 *      instead of the originals (content loss).
 *
 * Fix: `isCheckpointNode` accepts both shapes and a single shared extractor
 * (`checkpointCompactionIdOf`, src/messages.ts) feeds all three region.ts
 * sites. These tests pin every one of the four failures against REAL 0.1.7
 * fixtures. The test-baseline host (dsh-session/dsh-compaction 0.1.5) can
 * only WRITE the legacy shape, so a simulated 0.1.7 write appends the same
 * four transaction events the engine writes, stamped with the new-shape
 * source the 0.1.7 host would produce.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createCore, type CompressionCore } from 'acp-kernel'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session } from '@deepseek-ai/dsh-session'
import { AcpStateStore } from '../src/state.ts'
import {
  classifySurfaceEvent,
  checkpointCompactionIdOf,
  isCheckpointNode,
  isRealUserTurn,
} from '../src/messages.ts'
import { blockRefForSummarySeq, expandShadowedSeqs, rebuildBlockLedger } from '../src/region.ts'
import { encodeAcpBlockLedger } from '../src/block-ledger.ts'
import { makeTools, type ToolEnvironment } from '../src/tools.ts'
import { appendAssistant, appendTurn, appendUser, longText } from './helpers.ts'

const NEW_SHAPE_ID = 'id-new-shape-0001'
const OLD_SHAPE_ID = 'id-old-shape-0002'

/** The exact shape dsh-compaction@0.1.7-alpha.1's compactCheckpointSource() emits. */
function newShapeSource(compactionId: string): object {
  return { kind: 'compact-checkpoint', compactionId }
}

/** The ≤0.1.6 wrapper shape the 0.1.5 test-baseline host still writes. */
function oldShapeSource(compactionId: string): object {
  return { kind: 'plugin', plugin: 'compact', compactionId }
}

/** One checkpoint summary text, shared by both shapes so twins stay byte-comparable. */
const CHECKPOINT_SUMMARY = 'Auth: JWT access tokens 15 min expiry, refresh tokens in Redis 30 day TTL, login in src/auth/login.ts, rate limit 10 req/min/IP, bcrypt cost 12. '
  .repeat(3)

interface ManualTransactionOptions {
  readonly compactionId: string
  readonly turn: number
  readonly startSeq: number
  readonly endSeq: number
  readonly shadowedSeqs: readonly number[]
  readonly source: object
  /** rawOutput member carrying the embedded ledger fields (tier/lineage), issue #141. */
  readonly rawOutput?: ReturnType<typeof encodeAcpBlockLedger>
}

/**
 * Append one durable compression transaction manually, mirroring
 * runCompactionTransaction's event order (compaction/start,
 * compaction/summary, replace user/message, compaction/end) and payload
 * fields. Returns the checkpoint node's surface seq.
 */
function appendManualTransaction(session: Session, opts: ManualTransactionOptions): number {
  session.append('compaction/start', { compactionId: opts.compactionId, turn: opts.turn })
  session.append('compaction/summary', {
    compactionId: opts.compactionId,
    summary: [{ type: 'text', text: CHECKPOINT_SUMMARY }],
    shadowedRange: { start: opts.startSeq, end: opts.endSeq },
    shadowedSeqs: [...opts.shadowedSeqs],
    shadowedTokenCount: 900,
    provider: 'test-provider',
    model: 'test-model',
    ...(opts.rawOutput === undefined ? {} : { rawOutput: opts.rawOutput }),
  })
  const ckSeq = session.append('user/message', {
    id: `checkpoint-${opts.compactionId}`,
    role: 'user',
    content: [{ type: 'text', text: CHECKPOINT_SUMMARY }],
    source: opts.source,
  } as never, {
    surfaceOp: { op: 'replace', startSeq: opts.startSeq, endSeq: opts.endSeq },
    sourceEventSeqs: [...opts.shadowedSeqs],
  }).seq
  session.append('compaction/end', { compactionId: opts.compactionId, turn: opts.turn })
  return Number(ckSeq)
}

/**
 * Mixed-shape surface: one transaction written in the requested shape (the
 * simulated 0.1.7 write when `firstShape === 'new'`) and one in the legacy
 * shape — exactly the coexistence the V3→V4 migration produces.
 *
 *   seq 0:  turn/start
 *   seq 1:  user q0 (plain)
 *   seq 2:  assistant a1
 *   seq 3:  user q1
 *   seq 4..7: transaction T1 (replace 2..3) → checkpoint at seq 6
 *   seq 8:  user q2 (plain)
 *   seq 9:  assistant a3
 *   seq 10..13: transaction T2 (replace 8..9, legacy shape) → checkpoint at seq 12
 *   seq 14: user q3 (plain — the last real user turn)
 */
function mixedShapeFixture(name: string, firstShape: 'new' | 'old'): Session {
  const session = Session.create(name)
  appendTurn(session, 1)
  appendUser(session, longText('q0', 0))
  appendAssistant(session, longText('a1', 1), 1, 1)
  appendUser(session, longText('q1', 2))
  const ckFirst = appendManualTransaction(session, {
    compactionId: NEW_SHAPE_ID,
    turn: 1,
    startSeq: 2,
    endSeq: 3,
    shadowedSeqs: [2, 3],
    source: firstShape === 'new' ? newShapeSource(NEW_SHAPE_ID) : oldShapeSource(NEW_SHAPE_ID),
  })
  assert.equal(ckFirst, 6, 'first checkpoint lands at seq 6')
  appendUser(session, longText('q2', 3))
  appendAssistant(session, longText('a3', 4), 1, 2)
  const ckSecond = appendManualTransaction(session, {
    compactionId: OLD_SHAPE_ID,
    turn: 1,
    startSeq: 8,
    endSeq: 9,
    shadowedSeqs: [8, 9],
    source: oldShapeSource(OLD_SHAPE_ID),
  })
  assert.equal(ckSecond, 12, 'second checkpoint lands at seq 12')
  appendUser(session, longText('q3', 5))
  return session
}

test('#168: isCheckpointNode recognizes both host shapes and nothing else', () => {
  const session = mixedShapeFixture('ckpt-shapes', 'new')
  const events = session.snapshotEvents()
  assert.equal(isCheckpointNode(events[6]!), true, 'new-shape row (kind: compact-checkpoint)')
  assert.equal(isCheckpointNode(events[12]!), true, 'legacy-shape row (plugin: compact)')
  assert.equal(isCheckpointNode(events[1]!), false, 'plain user turn')
  assert.equal(isCheckpointNode(events[14]!), false, 'last plain user turn')
  // A malformed new-shape row (no id) must STILL classify as a checkpoint —
  // it must never fall through to `real` and become compressible content.
  const malformed = {
    seq: 99,
    time: '',
    type: 'user/message',
    data: { id: 'x', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'compact-checkpoint' } },
  } as never
  assert.equal(isCheckpointNode(malformed), true, 'malformed new-shape row stays a checkpoint')
})

test('#168: checkpointCompactionIdOf extracts the id from both shapes', () => {
  const session = mixedShapeFixture('ckpt-id-extract', 'new')
  const events = session.snapshotEvents()
  assert.equal(checkpointCompactionIdOf(events[6]!), NEW_SHAPE_ID, 'new shape carries the id')
  assert.equal(checkpointCompactionIdOf(events[12]!), OLD_SHAPE_ID, 'legacy shape carries the id')
  assert.equal(checkpointCompactionIdOf(events[1]!), null, 'plain user turn has no id')
})

test('#168: classifier files both shapes under checkpoint and keeps the protection window honest', () => {
  const session = mixedShapeFixture('ckpt-classify', 'new')
  const events = session.snapshotEvents()
  assert.equal(classifySurfaceEvent(events[6]!), 'checkpoint', 'new shape → checkpoint class')
  assert.equal(classifySurfaceEvent(events[12]!), 'checkpoint', 'legacy shape → checkpoint class')
  assert.equal(classifySurfaceEvent(events[14]!), 'real', 'plain user turn → real class')
  // Impact #2: a new-shape checkpoint is a user/message — if it classified as
  // real it would steal the protected-tail window from the actual last user
  // turn (the issue #71 bug class). Only the plain turn may win it.
  assert.equal(isRealUserTurn(events[6]!), false, 'new-shape checkpoint never wins tail protection')
  assert.equal(isRealUserTurn(events[12]!), false, 'legacy-shape checkpoint never wins tail protection')
  assert.equal(isRealUserTurn(events[14]!), true, 'the real last user turn keeps its window')
})

test('#168: ledger finds the checkpoint seq of BOTH shapes (summarySeqIndex)', () => {
  const session = mixedShapeFixture('ckpt-ledger', 'new')
  const ledger = rebuildBlockLedger(session.snapshotEvents())
  assert.equal(ledger.length, 2)
  const byId = new Map(ledger.map((entry) => [entry.blockId, entry]))
  assert.equal(byId.get(NEW_SHAPE_ID)?.summarySeq, 6, 'new-shape block maps to its checkpoint seq')
  assert.equal(byId.get(OLD_SHAPE_ID)?.summarySeq, 12, 'legacy-shape block maps to its checkpoint seq')
})

function makeEnv(): ToolEnvironment {
  return {
    kernel: createCore({}) as CompressionCore,
    store: new AcpStateStore(),
    modelContextLimit: 128000,
    compressCallIdsToHide: new Set(),
  }
}

function fakeExec(session: Session): ToolRunContext {
  const agent = {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: new Context(),
  } as unknown as Agent
  return {
    callId: 'call-acp',
    name: 'acp_status',
    arguments: {},
    signal: new AbortController().signal,
    agent,
  } as unknown as ToolRunContext
}

function statusText(env: ToolEnvironment, session: Session): Promise<string> {
  const status = makeTools(env).find((definition) => definition.name === 'acp_status')
  assert.ok(status, 'acp_status registered')
  return status.execute({}, fakeExec(session)).then((result) => (result as { text: string }).text)
}

test('#168: acp_status lists the new-shape block\'s checkpoint seq (distill entry point)', async () => {
  const session = mixedShapeFixture('ckpt-status-seqs', 'new')
  const text = await statusText(makeEnv(), session)
  assert.match(
    text,
    /Checkpoint seqs \(active blocks — compress a checkpoint seq to distill it\): b1 → seq 6, b2 → seq 12/,
    'both blocks map their kernel ref to the checkpoint seq — the T2/T3 distill route',
  )
})

test('#168: acp_status does not double-count a new-shape checkpoint summary', async () => {
  // Twin sessions with byte-identical surfaces except the first checkpoint's
  // source shape. After the fix both exclude the checkpoint node from the
  // visible messages, so the context breakdown must be identical. Before the
  // fix the new-shape node leaked into the visible text and inflated the
  // breakdown (its summary counted twice: once as text, once as summaries).
  const fresh = await statusText(makeEnv(), mixedShapeFixture('ckpt-status-twin-fresh', 'new'))
  const legacy = await statusText(makeEnv(), mixedShapeFixture('ckpt-status-twin-legacy', 'old'))
  const breakdownOf = (report: string): string => report.match(/CONTEXT BREAKDOWN\n  (.+)/)?.[1] ?? '<missing>'
  assert.equal(breakdownOf(fresh), breakdownOf(legacy), 'new-shape and legacy-shape surfaces break down identically')
  assert.match(fresh, /[\d.]+K? summaries \(\d+%\)/, 'the summary counts as summaries, not text')
})

test('#168: a compress edge on a new-shape checkpoint resolves to its block ref (distill, not fold)', async () => {
  const session = mixedShapeFixture('ckpt-edge-ref', 'new')
  assert.equal(blockRefForSummarySeq(session, 6), 'b1', 'new-shape checkpoint resolves to its bN')
  assert.equal(blockRefForSummarySeq(session, 12), 'b2', 'legacy-shape checkpoint resolves to its bN')
  assert.equal(blockRefForSummarySeq(session, 14), null, 'a plain user turn is not a distill edge')
  // The bN is usable as a compress edge end-to-end: distilling it upgrades
  // the block instead of folding the summary text as plain content.
  const env = makeEnv()
  const compress = makeTools(env).find((definition) => definition.name === 'compress')
  assert.ok(compress, 'compress registered')
  const result = await compress.execute({
    content: [{ startSeq: 1, endSeq: 6, summary: 'Distilled auth material: JWT rotation, Redis TTL, rate limits.' }],
  } as never, fakeExec(session))
  assert.match((result as { text: string }).text, /tier 2/, 'edge on the new-shape checkpoint distills (tier 2)')
})

test('#168: decompressing a tier-2 block recurses through a new-shape parent checkpoint to the originals', () => {
  // Tier-2 stack: T1 shadows the originals (new shape), T2 distills T1's
  // checkpoint node (also new shape — a 0.1.7-host session). Recovery of T2's
  // originals MUST recurse through the parent checkpoint into the original
  // seqs; before the fix the recursion failed to recognize the new-shape
  // parent and reported the checkpoint node itself as the "original".
  const session = Session.create('ckpt-tier2-recursion')
  appendTurn(session, 1)
  appendUser(session, longText('u1', 0))                    // seq 1
  appendAssistant(session, longText('a2', 1), 1, 1)         // seq 2
  appendUser(session, longText('u3', 2))                    // seq 3
  appendAssistant(session, longText('a4', 3), 1, 2)         // seq 4
  const ck1 = appendManualTransaction(session, {
    compactionId: 'id-tier1-new',
    turn: 1,
    startSeq: 1,
    endSeq: 4,
    shadowedSeqs: [1, 2, 3, 4],
    source: newShapeSource('id-tier1-new'),
  })
  assert.equal(ck1, 7, 'tier-1 checkpoint lands at seq 7')
  appendUser(session, longText('u5', 4))                    // seq 9
  appendAssistant(session, longText('a6', 5), 1, 3)         // seq 10
  const ck2 = appendManualTransaction(session, {
    compactionId: 'id-tier2-new',
    turn: 1,
    startSeq: ck1,
    endSeq: ck1,
    shadowedSeqs: [ck1],
    source: newShapeSource('id-tier2-new'),
    rawOutput: encodeAcpBlockLedger({ tier: 2, parentBlockIds: ['id-tier1-new'] }),
  })
  assert.equal(ck2, 13, 'tier-2 checkpoint lands at seq 13')

  const ledger = rebuildBlockLedger(session.snapshotEvents())
  const tier2 = ledger.find((entry) => entry.blockId === 'id-tier2-new')
  assert.equal(tier2?.tier, 2, 'embedded tier rides the rawOutput ledger')
  assert.deepEqual(tier2?.parentBlockIds, ['id-tier1-new'])

  assert.deepEqual(expandShadowedSeqs(session, 'id-tier2-new'), [1, 2, 3, 4], 'recursion crosses the new-shape parent into the originals')
  assert.deepEqual(expandShadowedSeqs(session, 'id-tier1-new'), [1, 2, 3, 4], 'tier-1 recovery unchanged')
})
