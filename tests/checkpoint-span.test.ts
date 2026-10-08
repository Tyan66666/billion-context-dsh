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
 * 2. (CONTRACT since the acp-kernel 0.0.101 pin) A PLAIN range whose span
 *    crosses a live block's checkpoint carrier is REJECTED, and every carrier is
 *    marked for the kernel. The kernel recognizes a host-carried summary through
 *    `CoreMessage.summaryOfBlockId` (upstream #335, fixed by acp-kernel #338): for
 *    a plain message-ref range it keeps such a carrier visible and reports the
 *    exclusion in its warning list, while block-ref boundaries (bN..bM, tier 2/3)
 *    still fold it. Our projection attaches that marker
 *    (`kernelBlockIdByCompactionId` → `projectEvent`), and because the host
 *    transaction replaces the whole span in ONE `surfaceOp` — which would hide
 *    the carrier the kernel just kept — the compress path (and
 *    `/acp-prune compress`) refuses the span and hands back the block-id call
 *    instead. Before the pin the crossed checkpoint was folded silently: the
 *    superseded block's summary left the visible surface with no signal.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createCore, type CompressionCore } from 'acp-kernel'
import { Session } from '@deepseek-ai/dsh-session'
import { allLogMessages, eventsToCoreMessages, isCheckpointNode } from '../src/messages.ts'
import { kernelConfigFor } from '../src/config.ts'
import { AcpStateStore } from '../src/state.ts'
import { blockRegistry, blockRefForSummarySeq, rebuildBlockLedger, resolveSurfaceRange, shadowedSeqsOf } from '../src/region.ts'
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
    // ONE shared classifier (the engine's own predicate, never a local copy):
    // the stored source shape follows the installed dsh-compaction line — the
    // legacy {kind:'plugin',plugin:'compact'} wrapper (measured on the
    // 0.1.5-rc.2 closure) vs the {kind:'compact-checkpoint'} producer kind
    // (measured on 0.2.0-rc.2).
    if (isCheckpointNode(event)) seqs.push(Number((event as { seq?: number }).seq))
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

test('cross-checkpoint span: a PLAIN range that crosses a live checkpoint carrier is rejected', async () => {
  const env = makeEnv()
  const session = crossCheckpointFixture('checkpoint-plain-range')
  const compress = tool(env, 'compress')
  const exec = execStub(session, 'call-checkpoint-plain')
  const summary = SUMMARY

  const first = await compress.execute({ content: [{ startSeq: 6, endSeq: 9, summary }] } as never, exec)
  assert.match((first as { text: string }).text, /Compressed 1 block/)

  const checkpointSeq = checkpointSeqs(session)[0]!
  // Push the checkpoint out of the protected recent/last-user window: this test is
  // about the carrier guard, not about host-side protection.
  appendTraffic(session, 17, 8)
  const lastSeq = session.surface.nodes[session.surface.nodes.length - 1]!
  // End two nodes early: since issue #196 the newest real user turn (lastSeq - 1)
  // is hard-guarded engine-side. The span still crosses the checkpoint.
  const second = await compress.execute(
    { content: [{ startSeq: 1, endSeq: lastSeq - 2, summary: `${summary} Whole span.` }] } as never,
    execStub(session, 'call-checkpoint-plain-2'),
  )
  const text = (second as { text: string }).text
  assert.match(text, /Compressed 0 block/)
  assert.match(text, /still-active block/, 'the reject names the reason')
  assert.match(text, /startId: "b1"/, 'the reject hands back the block-id call')

  const ledger = rebuildBlockLedger(session.snapshotEvents())
  assert.equal(ledger.length, 1, 'no second block: the crossing span never landed')
  assert.ok(
    session.surface.nodes.includes(checkpointSeq as never),
    `the live carrier stays visible on the surface (seq ${checkpointSeq})`,
  )

  // The projection marks the carrier with its kernel block id — the datum the
  // kernel's exclusion rests on. Pinned against `blockRegistry` so the two
  // mappings (projection vs ledger rebuild) cannot drift apart.
  const projected = eventsToCoreMessages(session.snapshotEvents()).find((message) => message.id === String(checkpointSeq))
  assert.equal(
    projected?.summaryOfBlockId,
    blockRegistry(session)[0]!.kernelBlockId,
    'the checkpoint carrier carries its kernel block id',
  )

  // Nothing is lost: the block still decompresses from the log.
  const decompress = tool(env, 'decompress')
  const recovered = await decompress.execute({ blockId: ledger[0]!.blockId, inline: true } as never, exec)
  const recoveredText = (recovered as { text: string }).text
  assert.match(recoveredText, /a6|r8/, 'the superseded block\'s originals are still recoverable')
})

test('cross-checkpoint span: the carrier guard holds while the checkpoint is inside the protection window too', async () => {
  const env = makeEnv()
  const session = crossCheckpointFixture('checkpoint-protected')
  const compress = tool(env, 'compress')

  const first = await compress.execute(
    { content: [{ startSeq: 6, endSeq: 9, summary: SUMMARY }] } as never,
    execStub(session, 'call-checkpoint-protected'),
  )
  assert.match((first as { text: string }).text, /Compressed 1 block/)
  const checkpointSeq = checkpointSeqs(session)[0]!

  // No fresh traffic: the checkpoint is still within the recent zone. Inside the
  // window the kernel protects the carrier from folding, and outside it the
  // kernel's #335 exclusion does — in BOTH worlds a plain span that crosses the
  // carrier is refused rather than folded (the single-op replace below would hide
  // what the kernel kept visible either way).
  // The span ends two nodes early: since issue #196 the newest real user turn
  // (lastSeq - 1) is hard-guarded; the span still crosses the checkpoint.
  const lastSeq = session.surface.nodes[session.surface.nodes.length - 1]!
  const second = await compress.execute(
    { content: [{ startSeq: 1, endSeq: lastSeq - 2, summary: `${SUMMARY} Whole span.` }] } as never,
    execStub(session, 'call-checkpoint-protected-2'),
  )
  const text = (second as { text: string }).text
  assert.match(text, /Compressed 0 block/)
  assert.match(text, /still-active block/, 'host protection and the carrier guard agree: refused, not folded')

  const ledger = rebuildBlockLedger(session.snapshotEvents())
  assert.equal(ledger.length, 1, 'the crossing span never landed')
  assert.ok(
    session.surface.nodes.includes(checkpointSeq as never),
    `the carrier is still visible (seq ${checkpointSeq})`,
  )
})
