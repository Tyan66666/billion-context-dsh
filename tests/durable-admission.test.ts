/**
 * Issue #183 regression net — durable-row admission coverage (part 1).
 *
 * Why this exists: #163 and #181 were both admission-level defects that sailed
 * through a fully green suite. The e2e harness runs on an in-memory store, so no
 * test in this repo ever passed engine-written durable rows through the released
 * persistence codec — the bugs only surfaced when a real host session wedged on
 * its next write batch ("format v4 message requires a producer-owned source
 * kind"). This file pins, on the CURRENT devDep line (0.1.5), that every durable
 * row shape the engine writes survives a full round-trip through the real
 * released JSONL writer (`@deepseek-ai/dsh-session-persistence-jsonl`): accepted
 * at append time and readable back byte-identically under the storage contract
 * our declared peer range ships.
 *
 * Anatomy — why the round-trip has teeth on this line:
 * - The 0.1.5 writer's APPEND path is identity serialization
 *   (`encodeEventBatch` = plain JSONL lines); it never admits or rejects a row
 *   at write time.
 * - The READ path validates every stored row fail-closed (dsh-session's
 *   stored-event validation + `assertV3RowAdmission` + `validateStoredEvents`):
 *   message identity, assistant model source, tool-result callId matching,
 *   header keys, seq contiguity. A row that violates any of these bricks the
 *   host when it reopens its own session file — the same failure class as
 *   #163/#181.
 * - The 0.1.7-line V4 writer adds one more gate this line lacks: it rejects the
 *   retired `{ kind: 'plugin', plugin: '<name>' }` wrapper source shape (the
 *   exact #163/#181 rejection). That line is covered by the follow-up
 *   0.1.7-seam e2e (issue #183 part 2); until then, the wrapper-shape invariant
 *   below keeps every engine-authored row V4-admissible.
 *
 * Fixture realism: unlike tests/helpers.ts (whose sessions never touch disk),
 * persisted rows must satisfy dsh-session's stored-event validation — assistant
 * messages carry `source: { kind: 'model', provider, model }` ON THE MESSAGE,
 * and tool results carry an `id` plus a `{ kind: 'tool', callId }` source.
 * Those are the shapes the real host writes; the builders below mirror them.
 *
 * Node floor: the released codec statically imports node:zlib's zstd API
 * (`createZstdCompress` & co.), which exists only from Node 22.15 on — on an
 * older Node the module fails at LINK time, which would take down this whole
 * file, including the wrapper-shape test below that needs no persistence at
 * all. So the codec is imported dynamically and its absence degrades to an
 * explicit skip of the two round-trip tests; CI runs the suite on Node 22
 * (ci.yml), where all three run.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
// Deliberately dynamic: a static import would fail at link time on Node < 22.15
// (the codec's own static node:zlib zstd import) and kill every test in this
// file, including the one below that never touches the persistence stack.
let JsonlSessionPersistence: typeof import('@deepseek-ai/dsh-session-persistence-jsonl').default | undefined
try {
  JsonlSessionPersistence = (await import('@deepseek-ai/dsh-session-persistence-jsonl')).default
} catch {
  // Older Node without node:zlib zstd — round-trip tests skip with a reason.
}
const persistenceSkipReason =
  JsonlSessionPersistence === undefined
    ? 'released JSONL codec needs node:zlib zstd (Node >= 22.15); running on an older Node'
    : false
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { hideCompressToolPair, runCompactionTransaction } from '../src/region.ts'
import { SUMMARY_FRAME_PREFIX } from '../src/messages.ts'

const PROVIDER = 'test-provider'
const MODEL = 'test-model'

// --- Fixture builders: realistic persisted shapes --------------------------

function appendTurnStart(session: Session): void {
  session.append('turn/start', { turn: 1 })
}

function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function appendAssistantText(session: Session, text: string, step = 1): void {
  session.append('assistant/message', {
    turn: 1,
    step,
    stream: [],
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      provider: PROVIDER,
      model: MODEL,
      source: { kind: 'model', provider: PROVIDER, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
}

function appendCompressCall(session: Session, callId: string): void {
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: createAssistantMessage({
      content: [{ type: 'tool-call', id: callId, name: 'compress', arguments: '{"content":[]}' }],
      provider: PROVIDER,
      model: MODEL,
      source: { kind: 'model', provider: PROVIDER, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
}

function appendToolResult(session: Session, text: string, callId: string): void {
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: `res-${callId}`,
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
      source: { kind: 'tool', callId },
    },
  }, { surfaceOp: 'append' })
}

/**
 * One realistic mid-turn compress cycle, driven through the engine's REAL
 * durable writers (no hand-built compaction events):
 *
 *   0 turn/start               5 compaction/start
 *   1 user q0                  6 compaction/summary
 *   2 assistant a1             7 checkpoint user/message (replaces 1..3)
 *   3 user q1                  8 compaction/end
 *   4 assistant compress-call c1
 *   9 tool/result c1           → hideCompressToolPair hides 4..9:
 *  10 compaction/prune        11 tombstone user/message (result-text body)
 *  12 nudge echo user/message (mirrors src/nudge.ts, producer kind only)
 */
function buildEngineLog(): Session {
  const session = Session.create('durable-admission')
  appendTurnStart(session)            // 0
  appendUser(session, 'q0 warm-up content') // 1
  appendAssistantText(session, 'a1 warm-up answer', 1) // 2
  appendUser(session, 'q1 please compress the earlier exchange') // 3
  appendCompressCall(session, 'c1')   // 4
  runCompactionTransaction(session, {
    start: 1,
    end: 3,
    shadowedSeqs: [1, 2, 3],
    summary: [{ type: 'text', text: 'The user warmed up, the assistant answered, then asked for compression.' }],
    shadowedTokenCount: 120,
    provider: PROVIDER,
    model: MODEL,
    topic: 'warm-up exchange',
    tier: 1,
    kernelBlockId: 'b1',
  })                                  // 5..8
  appendToolResult(session, 'compressed 3 messages into b1', 'c1') // 9
  const hidden = hideCompressToolPair(session, 'c1')
  assert.ok(hidden, 'hideCompressToolPair must find the adjacent compress pair')
  // Nudge echo — mirrors src/nudge.ts exactly (createUserMessage + producer
  // kind `plugin:acp-nudge`, issue #163); the host appends this row, so the
  // test does the appending.
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '[ACP context nudge] …range table…' }],
    source: { kind: 'plugin:acp-nudge' },
  }), { surfaceOp: 'append' })         // 12
  return session
}

// --- Persistence round-trip --------------------------------------------------

/**
 * Persist `rows` through the real released JSONL writer (default compression,
 * i.e. production mode) and read them back. Throws if the storage contract
 * rejects any row at append or read time.
 */
async function persistAndReadBack(rows: readonly SessionEvent[], id: string): Promise<readonly SessionEvent[]> {
  const Store = JsonlSessionPersistence
  assert.ok(Store !== undefined, 'persistence codec must have loaded to run the round-trip')
  const root = mkdtempSync(join(tmpdir(), 'durable-admission-'))
  try {
    const store = new Store(new Context(), { root })
    const handle = await store.create({
      version: 3,
      id,
      cwd: root,
      createdAt: Date.now(),
      isSeeded: false,
      delegationDepth: 0,
    })
    try {
      await handle.append([...rows])
      await handle.flush()
      return (await handle.read(0)).events
    } finally {
      await handle.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function rowAt(rows: readonly SessionEvent[], seq: number, type: string): SessionEvent {
  const row = rows[seq]
  assert.ok(row !== undefined && row.type === type, `seq ${seq}: expected ${type}, got ${row?.type}`)
  return row
}

type UserSource = { kind?: string; plugin?: string }
type TextBlock = { type: string; text?: string }
function userSource(row: SessionEvent): UserSource | undefined {
  return (row.data as { source?: UserSource }).source
}

// --- Tests -------------------------------------------------------------------

test('engine-written durable rows round-trip through the released JSONL codec', { skip: persistenceSkipReason }, async () => {
  const rows = buildEngineLog().snapshotEvents()

  // Structural pin of what the engine wrote (the shapes under audit).
  assert.deepEqual(
    rows.map((r) => r.type),
    [
      'turn/start',
      'user/message', 'assistant/message', 'user/message', 'assistant/message',
      'compaction/start', 'compaction/summary', 'user/message', 'compaction/end',
      'tool/result',
      'compaction/prune', 'user/message',
      'user/message',
    ],
  )
  const summaryData = rowAt(rows, 6, 'compaction/summary').data as {
    compactionId: string
    summary: readonly TextBlock[]
    shadowedRange: { start: number; end: number }
    shadowedSeqs: readonly number[]
    rawOutput?: string
  }
  assert.equal(summaryData.shadowedRange.start, 1)
  assert.equal(summaryData.shadowedRange.end, 3)
  assert.deepEqual(summaryData.shadowedSeqs, [1, 2, 3])
  // Rule 18: model-written summaries are framed once at creation.
  assert.ok(summaryData.summary[0]?.text?.startsWith(SUMMARY_FRAME_PREFIX))
  // The checkpoint node carries the host helper's source VERBATIM and the same
  // framed text — event/node divergence would split decompress from projection.
  const checkpoint = rowAt(rows, 7, 'user/message')
  assert.deepEqual(userSource(checkpoint), compactCheckpointSource(summaryData.compactionId))
  assert.deepEqual(
    (checkpoint.data as { content: readonly TextBlock[] }).content,
    summaryData.summary,
  )
  // Prune claim + tombstone (rule 12 currency is priced upstream of here; the
  // admission-relevant facts are the range and the producer-kind source).
  const pruneData = rowAt(rows, 10, 'compaction/prune').data as { shadowedSeqs: readonly number[] }
  assert.deepEqual(pruneData.shadowedSeqs, [4, 9])
  const tombstone = rowAt(rows, 11, 'user/message')
  assert.deepEqual(userSource(tombstone), { kind: 'plugin:billion-context-dsh' })
  assert.deepEqual((tombstone.surfaceOp ?? null), { op: 'replace', startSeq: 4, endSeq: 9 })
  assert.deepEqual(userSource(rowAt(rows, 12, 'user/message')), { kind: 'plugin:acp-nudge' })

  // The point of the file: the released writer accepts every row and reads it
  // back byte-identically.
  const back = await persistAndReadBack(rows, 'durable-admission-main')
  assert.deepEqual(back, rows)
})

test('round-trip rejects structurally invalid rows (the net has teeth)', { skip: persistenceSkipReason }, async () => {
  const base = buildEngineLog().snapshotEvents()

  // (a) An assistant message without its model source is exactly what a
  // host-written log never contains — the read path must refuse it.
  const noModelSource = base.map((r) => structuredClone(r))
  delete (noModelSource[2]!.data as { message: { source?: unknown } }).message.source
  await assert.rejects(persistAndReadBack(noModelSource, 'neg-no-model-source'), /message has invalid source/)

  // (b) A tool result whose callId disagrees with its source is corrupt pairing
  // data — refused as well.
  const mismatchedCall = base.map((r) => structuredClone(r))
  ;(mismatchedCall[9]!.data as { message: { content: readonly { toolCallId?: string }[] } })
    .message.content[0]!.toolCallId = 'not-c1'
  await assert.rejects(persistAndReadBack(mismatchedCall, 'neg-mismatched-call'), /mismatched tool call ids/)

  // (c) A seq gap breaks the append-only contract at append time.
  const gapped = base.filter((_, i) => i !== 5)
  await assert.rejects(persistAndReadBack(gapped, 'neg-seq-gap'), /append seq mismatch/)
})

test('engine-authored metadata rows never use the retired wrapper source shape (#163 invariant)', () => {
  const rows = buildEngineLog().snapshotEvents()
  for (const row of rows) {
    if (row.type !== 'user/message') continue
    const source = userSource(row)
    if (source === undefined || typeof source.kind !== 'string') continue
    if (source.kind !== 'plugin' || typeof source.plugin !== 'string') continue
    // The ONLY wrapper-shaped row allowed in an engine-written log is the
    // checkpoint node, whose source comes verbatim from the host's
    // compactCheckpointSource() (version-adaptive: legacy wrapper on the 0.1.5
    // line, producer kind on 0.1.7+). Every OTHER wrapper-shaped row would be
    // rejected by the 0.1.7 V4 writer — the #163/#181 wedge.
    assert.equal(source.plugin, 'compact', `wrapper-shaped row at seq ${row.seq} is not a host checkpoint`)
  }
})
