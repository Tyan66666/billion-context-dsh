/**
 * Issue #141 regression guard — `compaction/summary` must carry the six ACP
 * tier/lineage fields inside the admitted `rawOutput` member, never as top-level
 * members.
 *
 * Why this exists: the frozen released-v0 reader
 * (`@deepseek-ai/dsh-session-format-v0-to-v1`) validates every `compaction/summary`
 * payload against an exact member allow-list and throws on the FIRST member
 * outside it. Pre-fix engines wrote `tier`/`kernelBlockId`/`topic`/
 * `parentBlockIds`/`directMessageIds`/`effectiveMessageIds` as top-level members,
 * so every log written before a host upgrade became impossible to open afterwards
 * (the reader rejected them at restore time, not write time). This test pins two
 * things: (1) the codec round-trips losslessly and degrades — never throws — on
 * garbage; (2) a real engine-written `compaction/summary` carries none of those six
 * fields at the top level AND passes the real frozen reader, while re-adding any one
 * of them makes the reader throw the exact error that bricked pre-fix logs.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { assertReleasedEventPayload } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { runCompactionTransaction, rebuildBlockLedger } from '../src/region.ts'
import {
  ACP_BLOCK_LEDGER_MARKER,
  encodeAcpBlockLedger,
  decodeAcpBlockLedger,
  type AcpBlockLedgerPayload,
} from '../src/block-ledger.ts'
import { appendToolCall, appendToolResult, appendTurn, appendUser, longText } from './helpers.ts'

/** The six fields that must NOT appear as top-level `compaction/summary` members. */
const LEDGER_FIELDS = [
  'tier',
  'kernelBlockId',
  'topic',
  'parentBlockIds',
  'directMessageIds',
  'effectiveMessageIds',
] as const

/** Parse back the single namespaced JSON object our encoder always emits. */
function encodedObject(payload: AcpBlockLedgerPayload): Record<string, unknown> {
  const blocks = encodeAcpBlockLedger(payload)
  assert.equal(blocks.length, 1, 'the encoder emits exactly one text content block')
  const block = blocks[0]! as { type: string; text: string }
  assert.equal(block.type, 'text')
  return JSON.parse(block.text) as Record<string, unknown>
}

// --- codec: encoding ---------------------------------------------------------

test('encode namespaces under the marker and emits only the present fields', () => {
  const full = encodedObject({
    tier: 3,
    kernelBlockId: 'b7',
    topic: 'auth work',
    parentBlockIds: ['c1', 'c2'],
    directMessageIds: ['m1'],
    effectiveMessageIds: ['m1', 'm2'],
  })
  assert.equal(full[ACP_BLOCK_LEDGER_MARKER], 1, 'marker + version are always present')
  assert.deepEqual(full, {
    [ACP_BLOCK_LEDGER_MARKER]: 1,
    tier: 3,
    kernelBlockId: 'b7',
    topic: 'auth work',
    parentBlockIds: ['c1', 'c2'],
    directMessageIds: ['m1'],
    effectiveMessageIds: ['m1', 'm2'],
  })
  // Absent fields stay out; an empty parentBlockIds list is dropped entirely.
  assert.deepEqual(encodedObject({ tier: 2, parentBlockIds: [] }), {
    [ACP_BLOCK_LEDGER_MARKER]: 1,
    tier: 2,
  })
})

// --- codec: decoding ---------------------------------------------------------

test('decode round-trips whatever encode emitted', () => {
  const samples: AcpBlockLedgerPayload[] = [
    {},
    { tier: 1 },
    { tier: 2, kernelBlockId: 'b1' },
    { tier: 3, topic: 'x', parentBlockIds: ['a'], directMessageIds: ['m1'], effectiveMessageIds: ['m1', 'm2'] },
  ]
  for (const sample of samples) {
    assert.deepEqual(decodeAcpBlockLedger(encodeAcpBlockLedger(sample)), sample)
  }
})

test('decode degrades to {} (never throws) on every kind of garbage', () => {
  const garbage: unknown[] = [
    undefined,
    null,
    42,
    'not an array',
    { notBlocks: true },
    [],
    [{ type: 'image', url: 'x' }], // non-text block
    [{ type: 'text', text: 'not json' }], // non-JSON text
    [{ type: 'text', text: '[1,2]' }], // JSON array, not object
    [{ type: 'text', text: '"a string"' }], // JSON scalar
    [{ type: 'text', text: '{"other":1}' }], // no marker
    [{ type: 'text', text: `{"${ACP_BLOCK_LEDGER_MARKER}":99}` }], // wrong version
    [{ type: 'text', text: `{"${ACP_BLOCK_LEDGER_MARKER}":1,"tier":7}` }], // bad tier
    [{ type: 'text', text: `{"${ACP_BLOCK_LEDGER_MARKER}":1,"topic":123}` }], // bad topic type
    [{ type: 'text', text: `{"${ACP_BLOCK_LEDGER_MARKER}":1,"parentBlockIds":"no"}` }], // bad array type
    [{ type: 'text', text: `{"${ACP_BLOCK_LEDGER_MARKER}":1,"parentBlockIds":[1,2]}` }], // non-string items
  ]
  for (const g of garbage) {
    assert.deepEqual(decodeAcpBlockLedger(g), {}, `decode(${JSON.stringify(g)}) must degrade to {}`)
  }
})

// --- the actual #141 brick, reproduced against the real frozen reader --------

test('issue #141: a real compaction/summary carries no top-level ledger fields and survives the v0 reader', () => {
  const session = Session.create('block-ledger-141')
  appendTurn(session, 1)
  appendUser(session, longText('q1', 1)) // seq 1
  appendToolCall(session, 'checking the docs', 'call_1') // seq 2
  appendToolResult(session, 'done', 'call_1') // seq 3
  appendUser(session, longText('q2', 2)) // seq 4

  const { seqs } = runCompactionTransaction(session, {
    start: 2,
    end: 3,
    shadowedSeqs: [2, 3],
    summary: [{ type: 'text', text: 'Tool round summary with enough detail.' }],
    shadowedTokenCount: 500,
    provider: 'p',
    model: 'm',
    tier: 2,
    kernelBlockId: 'b1',
    topic: 'tool round',
    parentBlockIds: ['c-parent'],
    directMessageIds: ['dm1'],
    effectiveMessageIds: ['em1', 'em2'],
  })

  const events = session.snapshotEvents()
  const summaryEvent = events[seqs[1]!]!
  assert.equal(summaryEvent.type, 'compaction/summary')
  const data = summaryEvent.data as Record<string, unknown>

  // THE core guard: none of the six fields may be a top-level member.
  for (const field of LEDGER_FIELDS) {
    assert.ok(!(field in data), `top-level "${field}" would brick the log on host upgrade`)
  }

  // ...and the real frozen released-v0 reader accepts exactly what we wrote.
  assert.doesNotThrow(() =>
    assertReleasedEventPayload({ type: summaryEvent.type, seq: summaryEvent.seq, time: 0, data }, 0),
  )

  // Counterfactual: re-add ANY one of the six at the top level and the same
  // reader throws the "unexpected member" error that bricked pre-fix logs.
  assert.throws(
    () =>
      assertReleasedEventPayload(
        { type: summaryEvent.type, seq: summaryEvent.seq, time: 0, data: { ...data, tier: 2 } },
        0,
      ),
    /unexpected member "tier"/,
  )

  // The embedded payload round-trips back through the ledger read path.
  const [entry] = rebuildBlockLedger(events)
  assert.ok(entry, 'the block ledger rebuilds from the durable log')
  assert.equal(entry.tier, 2)
  assert.equal(entry.kernelBlockId, 'b1')
  assert.equal(entry.topic, 'tool round')
  assert.deepEqual([...entry.parentBlockIds], ['c-parent'])
  assert.deepEqual([...entry.directMessageIds!], ['dm1'])
  assert.deepEqual([...entry.effectiveMessageIds!], ['em1', 'em2'])
})
