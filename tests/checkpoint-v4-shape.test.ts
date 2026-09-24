/**
 * Issue #166 — DSH 0.1.7 checkpoint read-side gap.
 *
 * dsh-compaction ≤0.1.6 writes compaction checkpoints with source
 * `{ kind: 'plugin', plugin: 'compact', compactionId }`; the 0.1.7 line emits
 * `{ kind: 'compact-checkpoint', compactionId(, sourceCommandId) }` (verified
 * against the published dsh-compaction@0.1.7-alpha.1 tarball). On 0.1.7 the
 * host's V3→V4 migration rewrites every legacy row to the new shape when a log
 * opens, so the SAME durable log surfaces whichever shape its host speaks —
 * both must stay recognized forever.
 *
 * Fixtures follow rule 5 (real DSH structures): every event below lands in a
 * REAL dsh-session session. The devDep (0.1.5-rc.2) accepts and stores the
 * 0.1.7 source shape verbatim (probed), so one session can hold BOTH shapes —
 * exactly like a migrated log. Block 1 of the E2E fixture is written by the
 * engine's own `runCompactionTransaction` (legacy shape under the 0.1.5
 * devDep); block 2 is hand-appended with the four durable events a 0.1.7 host
 * write produces, differing only in the checkpoint node's source shape.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  checkpointCompactionIdOf,
  classifySurfaceEvent,
  isCheckpointNode,
  isRealUserTurn,
} from '../src/messages.ts'
import {
  blockIdOfKernelRef,
  blockRefForSummarySeq,
  blockRegistry,
  buildCompressibleSeqRanges,
  expandShadowedSeqs,
  rebuildBlockLedger,
  runCompactionTransaction,
  summarySeqOfKernelBlock,
} from '../src/region.ts'
import { encodeAcpBlockLedger } from '../src/block-ledger.ts'
import { appendAssistant, appendToolCall, appendToolResult, appendTurn, appendUser, buildTextSession, wholeSurfaceRangeView } from './helpers.ts'

/** The 0.1.7-line checkpoint source shape (dsh-compaction lib/types/checkpoint.js). */
function v4CheckpointSource(compactionId: string, sourceCommandId?: string) {
  return sourceCommandId === undefined
    ? { kind: 'compact-checkpoint', compactionId }
    : { kind: 'compact-checkpoint', compactionId, sourceCommandId }
}

/**
 * Hand-append ONE full compaction block (start / summary / checkpoint node /
 * end) whose checkpoint node carries the 0.1.7 source shape — the durable
 * trace a 0.1.7 host write leaves, mirroring runCompactionTransaction's four
 * events. Content framing is deliberately plain: these assertions target the
 * source shape, not the summary text.
 */
/** @returns the seq of the appended 0.1.7-shape checkpoint node. */
function appendV4Block(
  session: Session,
  opts: { compactionId: string; start: number; end: number; shadowedSeqs: readonly number[]; summaryText: string; kernelBlockId?: string; tier?: 1 | 2 | 3; parentBlockIds?: readonly string[] },
): number {
  session.append('compaction/start', { compactionId: opts.compactionId, turn: 1 })
  session.append('compaction/summary', {
    compactionId: opts.compactionId,
    summary: [{ type: 'text', text: opts.summaryText }],
    shadowedRange: { start: opts.start, end: opts.end },
    shadowedSeqs: [...opts.shadowedSeqs],
    shadowedTokenCount: 500,
    provider: 'test-provider',
    model: 'test-model',
    rawOutput: encodeAcpBlockLedger({
      tier: opts.tier ?? 1,
      ...(opts.kernelBlockId === undefined ? {} : { kernelBlockId: opts.kernelBlockId }),
      ...(opts.parentBlockIds === undefined || opts.parentBlockIds.length === 0
        ? {}
        : { parentBlockIds: [...opts.parentBlockIds] }),
    }),
  })
  const checkpointSeq = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: opts.summaryText }],
    source: v4CheckpointSource(opts.compactionId),
  }), {
    surfaceOp: { op: 'replace', startSeq: opts.start, endSeq: opts.end },
    sourceEventSeqs: [...opts.shadowedSeqs],
  }).seq
  session.append('compaction/end', { compactionId: opts.compactionId, turn: 1 })
  return checkpointSeq
}

/** Bare checkpoint-shaped user messages in a scratch session — fixture for the predicate matrix. */
function buildShapeMatrixSession(): { session: Session; legacy: number; v4: number; v4WithCommand: number; v4NoId: number; plainUser: number } {
  const session = Session.create('shape-matrix')
  appendTurn(session, 1)
  // Legacy shape: what runCompactionTransaction writes under the 0.1.5 devDep.
  const legacy = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'legacy checkpoint summary' }],
    source: { kind: 'plugin', plugin: 'compact', compactionId: 'c-legacy' },
  }), { surfaceOp: 'append' }).seq
  const v4 = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'v4 checkpoint summary' }],
    source: v4CheckpointSource('c-v4'),
  }), { surfaceOp: 'append' }).seq
  const v4WithCommand = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'v4 checkpoint summary with command id' }],
    source: v4CheckpointSource('c-v4-cmd', 'cmd-9'),
  }), { surfaceOp: 'append' }).seq
  // Malformed: the 0.1.7 marker without its compactionId — the reader must degrade, not throw.
  const v4NoId = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'v4 checkpoint summary without id' }],
    source: { kind: 'compact-checkpoint' },
  }), { surfaceOp: 'append' }).seq
  appendUser(session, 'a real user question')
  const plainUser = session.surface.nodes[session.surface.nodes.length - 1]!
  return { session, legacy, v4, v4WithCommand, v4NoId, plainUser }
}

test('#166: isCheckpointNode recognizes BOTH persisted checkpoint shapes', () => {
  const { session, legacy, v4, v4WithCommand, v4NoId, plainUser } = buildShapeMatrixSession()
  const at = (seq: number) => session.snapshotEvents()[seq]!
  assert.equal(isCheckpointNode(at(legacy)), true, 'legacy plugin:"compact" shape')
  assert.equal(isCheckpointNode(at(v4)), true, '0.1.7 kind:"compact-checkpoint" shape')
  assert.equal(isCheckpointNode(at(v4WithCommand)), true, '0.1.7 shape with sourceCommandId')
  assert.equal(isCheckpointNode(at(v4NoId)), true, 'marker without compactionId is still a checkpoint node')
  assert.equal(isCheckpointNode(at(plainUser)), false, 'plain user turns are not checkpoints')
  // Non-user events can never be checkpoints.
  assert.equal(isCheckpointNode(session.snapshotEvents()[0]!), false, 'turn/start is not a checkpoint')
})

test('#166: classifySurfaceEvent files both checkpoint shapes as checkpoint, never real', () => {
  const { session, legacy, v4, v4WithCommand, plainUser } = buildShapeMatrixSession()
  const at = (seq: number) => session.snapshotEvents()[seq]!
  assert.equal(classifySurfaceEvent(at(legacy)), 'checkpoint')
  assert.equal(classifySurfaceEvent(at(v4)), 'checkpoint')
  assert.equal(classifySurfaceEvent(at(v4WithCommand)), 'checkpoint')
  assert.equal(classifySurfaceEvent(at(plainUser)), 'real')
})

test('#166: neither checkpoint shape counts as a real user turn (protection window, issue #71 class)', () => {
  const { session, legacy, v4, plainUser } = buildShapeMatrixSession()
  const at = (seq: number) => session.snapshotEvents()[seq]!
  assert.equal(isRealUserTurn(at(legacy)), false)
  assert.equal(isRealUserTurn(at(v4)), false, 'a 0.1.7 checkpoint must not win the last-real-user protection window')
  assert.equal(isRealUserTurn(at(plainUser)), true, 'control: a real user turn still wins')
})

test('#166: checkpointCompactionIdOf reads the id from both shapes and degrades on malformed rows', () => {
  const { session, legacy, v4, v4WithCommand, v4NoId, plainUser } = buildShapeMatrixSession()
  const at = (seq: number) => session.snapshotEvents()[seq]!
  assert.equal(checkpointCompactionIdOf(at(legacy)), 'c-legacy')
  assert.equal(checkpointCompactionIdOf(at(v4)), 'c-v4')
  assert.equal(checkpointCompactionIdOf(at(v4WithCommand)), 'c-v4-cmd')
  // 合并 pr/170 时修正：本函数契约是 `string | null`（src/messages.ts:400），因为它的
  // 全部消费点（src/region.ts:563 / :1356 / :1396，均由 pr/172 写入）按 `!== null` /
  // `=== null` 判定。pr/170 原断言写 undefined —— 那是它自己分支上 `string | undefined`
  // 版本的配套断言，两个 PR 从未同时存在。若改回 undefined，三处消费点会静默失效。
  assert.equal(checkpointCompactionIdOf(at(v4NoId)), null, 'missing compactionId degrades to null')
  assert.equal(checkpointCompactionIdOf(at(plainUser)), null, 'non-checkpoint events carry no id')
})

test('#166: ledger resolves the summarySeq of a 0.1.7-shape checkpoint (core regression)', () => {
  // Surface seqs 1..10; block 1 (engine-written, legacy shape) shadows 1..4,
  // block 2 (hand-appended, 0.1.7 shape) shadows 6..9.
  const session = buildTextSession(10)
  const block1 = runCompactionTransaction(session, {
    start: 1,
    end: 4,
    shadowedSeqs: [1, 2, 3, 4],
    summary: [{ type: 'text', text: 'First block summary with plenty of detail.' }],
    shadowedTokenCount: 1000,
    provider: 'p',
    model: 'm',
    kernelBlockId: 'b1',
  })
  const v4CheckpointSeq = appendV4Block(session, {
    compactionId: 'comp-v4-block-2',
    start: 6,
    end: 9,
    shadowedSeqs: [6, 7, 8, 9],
    summaryText: 'Second block summary with plenty of detail.',
    kernelBlockId: 'b2',
  })

  const legacyCheckpointSeq = block1.seqs[2]!
  const events = session.snapshotEvents()
  const ledger = rebuildBlockLedger(events)
  assert.equal(ledger.length, 2)
  const entry1 = ledger.find((entry) => entry.blockId === block1.compactionId)!
  const entry2 = ledger.find((entry) => entry.blockId === 'comp-v4-block-2')!
  assert.equal(entry1.summarySeq, legacyCheckpointSeq, 'legacy-shape checkpoint resolves (unchanged)')
  assert.equal(entry2.summarySeq, v4CheckpointSeq, '0.1.7-shape checkpoint resolves — null before the fix')

  // Distillation entry points read the registry: both blocks active with a
  // usable checkpoint seq (the nudge tier line and acp_status Checkpoint seqs
  // row both derive from these fields).
  const registry = blockRegistry(session)
  assert.equal(registry.length, 2)
  const reg2 = registry.find((entry) => entry.blockId === 'comp-v4-block-2')!
  assert.equal(reg2.active, true)
  assert.equal(reg2.summarySeq, v4CheckpointSeq)
  assert.equal(summarySeqOfKernelBlock(session, 'b2'), v4CheckpointSeq, 'bN → checkpoint seq for the 0.1.7 block')
  assert.equal(blockIdOfKernelRef(session, 'b2'), 'comp-v4-block-2')

  // The model-facing ref map: the checkpoint seq resolves back to its bN.
  assert.equal(blockRefForSummarySeq(session, v4CheckpointSeq), 'b2', '0.1.7 checkpoint seq maps to b2 — null before the fix')
  assert.equal(blockRefForSummarySeq(session, legacyCheckpointSeq), 'b1', 'legacy control')
  const plainSeq = session.surface.nodes.find((seq) => !isCheckpointNode(events[seq]!))!
  assert.equal(blockRefForSummarySeq(session, plainSeq), null, 'non-checkpoint nodes stay unmapped')
})

test('#166: distillation expansion recurses through a 0.1.7-shape checkpoint (expandShadowedSeqs)', () => {
  // Block 1 (0.1.7 shape) shadows 1..4; block 2 is a tier-2 distillation whose
  // shadowed seqs are block 1's CHECKPOINT NODE — recovering the originals
  // requires checkpointBlockIdOf to recognize the 0.1.7 shape (pre-fix it
  // returned null and the expansion stopped at the checkpoint seq).
  const session = buildTextSession(10)
  const v4CheckpointSeq = appendV4Block(session, {
    compactionId: 'comp-v4-tier1',
    start: 1,
    end: 4,
    shadowedSeqs: [1, 2, 3, 4],
    summaryText: 'Tier-1 block summary with plenty of detail.',
    kernelBlockId: 'b1',
  })
  appendV4Block(session, {
    compactionId: 'comp-v4-tier2',
    start: v4CheckpointSeq,
    end: v4CheckpointSeq,
    shadowedSeqs: [v4CheckpointSeq],
    summaryText: 'Tier-2 distilled summary with plenty of detail.',
    kernelBlockId: 'b2',
    tier: 2,
    parentBlockIds: ['comp-v4-tier1'],
  })
  assert.deepEqual(expandShadowedSeqs(session, 'comp-v4-tier2'), [1, 2, 3, 4], 'expansion passes through the 0.1.7 checkpoint into the originals')
})

test('#166: a 0.1.7-shape checkpoint at the END of the surface cannot pin the protection window', () => {
  // The live failure mode: a session ends right after a compression, so the
  // newest checkpoint is the last surface node. `protectedSurfaceSeqs` pins
  // the last-real-user protection to exactly ONE seq — the newest row that
  // classifies as a real user turn. Before the fix the terminal 0.1.7
  // checkpoint misclassified as a real user turn and WON that window, leaving
  // the actual user turn (seq 4 here) unprotected: the table offered [1..4],
  // i.e. the user's own question was compressible while the synthetic summary
  // sat safe (issue #71 class).
  const session = Session.create('protection-window')
  appendTurn(session, 1)
  appendUser(session, 'first question about the module layout') // seq 1
  appendToolCall(session, 'work', 'c1') // seq 2
  appendToolResult(session, 'work output', 'c1') // seq 3
  appendUser(session, 'second question about the test plan') // seq 4 — the REAL last user turn
  appendAssistant(session, 'answer five') // seq 5
  appendAssistant(session, 'answer six') // seq 6
  const v4CheckpointSeq = appendV4Block(session, {
    compactionId: 'comp-v4-tail',
    start: 5,
    end: 6,
    shadowedSeqs: [5, 6],
    summaryText: 'Tail block summary with plenty of detail.',
    kernelBlockId: 'b2',
  })
  const surface = session.surface.nodes
  const events = session.snapshotEvents()
  assert.equal(surface[surface.length - 1]!, v4CheckpointSeq, 'fixture sanity: the 0.1.7 checkpoint is the LAST surface node')
  assert.deepEqual(surface.filter((seq) => !isCheckpointNode(events[seq]!)), [1, 2, 3, 4], 'fixture sanity: four plain survivors before the tail block')
  const rows = buildCompressibleSeqRanges(session, wholeSurfaceRangeView(session), { preserveRecent: 0 })
  // Content BEFORE the last real user turn is still offered — the filter layer
  // works normally.
  assert.ok(rows.some((row) => row.start <= 1 && row.end >= 3), `the span before the last user turn stays compressible (rows: ${JSON.stringify(rows)})`)
  // Regression lock: neither the real user turn nor the terminal checkpoint is
  // offered. Pre-fix the offered row was [1..4] — covering seq 4.
  for (const row of rows) {
    assert.ok(!(row.start <= 4 && row.end >= 4), `the real last user turn stays protected (offered row ${row.start}..${row.end})`)
    assert.ok(!(row.start <= v4CheckpointSeq && row.end >= v4CheckpointSeq), 'the terminal checkpoint itself is never offered')
  }
})
