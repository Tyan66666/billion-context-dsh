/**
 * L3 — shadow-price regression tests (issues #54 and #103, AGENTS.md rule 12).
 *
 * The host token-meter prices every appended message with a flat-4 heuristic
 * (`estimateContent`/`estimateMessage`) and the producer contract requires
 * every compaction claim to be derived from the SAME estimator. The engine's
 * old code priced claims with `defaultCountTokens` (CJK 1 char/token), which
 * overdraws the meter on CJK-heavy sessions and bricks them (live session
 * session-3aa366c3: accumulated 42,076 host-tokens, claimed 74,858 →
 * messageTokens ≈ −31K → the projection schema rejected every turn).
 *
 * Issue #103 is the SAME brick through a second channel: since DSH 0.1.2 the
 * meter's `measure()` re-prices image nodes' `tokens` with the measured
 * route's declared visual price (`route-pricing.js` `priceSurface`), while
 * the projection ledger still accumulates appends with the fixed heuristic —
 * and exposes the ledger basis as `heuristicTokens`. Summing `node.tokens`
 * for a claim overstates an image-containing range and folds `messageTokens`
 * negative exactly like #54. The claim must read `heuristicTokens` (older
 * meters expose a single `tokens` field that IS the fixed heuristic).
 *
 * These tests drive the REAL host machinery — TokenMeter + the
 * SessionProjectionRegistry with the actual contextBreakdown projection (the
 * exact fold that threw in production) — over CJK-heavy and image fixtures,
 * and assert:
 *   1. the durable claim equals the meter's own ledger-basis price of the
 *      shadowed span,
 *   2. the mirror agrees with the meter (claim == mirror == meter),
 *   3. the host projection stays non-negative and agrees with the meter,
 *   4. the OLD claims would have overdrawn the meter (the #54 and #103
 *      arithmetic reproduced in-test).
 * All three event writers are covered: the compress tool, /acp compress, and
 * the prune path.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createCore, defaultCountTokens, type CompressionCore } from 'acp-kernel'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AcpStateStore } from '../src/state.ts'
import { makeTools, type ToolEnvironment } from '../src/tools.ts'
import { acpCommand } from '../src/commands.ts'
import { stripOrphanedSurfaceToolMessages } from '../src/region.ts'
import { estimateHostContent, hostPriceEvent, shadowedHostTokens, shadowedTokensViaMeter } from '../src/host-tokens.ts'
import { extractEventText } from '../src/messages.ts'

const CJK_UNIT =
  '中文面试准备：分布式系统一致性、缓存穿透、索引失效、消息队列削峰填谷、限流熔断降级、'
  + 'CAP 与 BASE、两阶段提交与 Saga、乐观锁与悲观锁、幂等性与最终一致性、读写分离与分库分表。'

function cjkText(label: string, chars: number): string {
  const body = CJK_UNIT.repeat(Math.ceil(chars / CJK_UNIT.length))
  return body.slice(0, chars) + ` [${label}]`
}

/** A CJK-heavy session with real step/start events (the meter's measure() throws on step-less logs). */
function buildCjkPairSession(pairs: number): Session {
  const session = Session.create('cjk-session')
  session.append('turn/start', { turn: 1 })
  for (let index = 0; index < pairs; index += 1) {
    const step = index + 1
    session.append('step/start', { turn: 1, step })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: cjkText(`q${index}`, 2000) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step,
      message: createAssistantMessage({
        content: [{ type: 'text', text: cjkText(`a${index}`, 2000) }],
        provider: 'test-provider',
        model: 'test-model',
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step })
  }
  return session
}

/** Host machinery: real TokenMeter + SessionProjectionRegistry (breakdown projection included). */
async function makeHosted(): Promise<{ ctx: Context; meter: TokenMeter; env: ToolEnvironment }> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  const env: ToolEnvironment = {
    kernel: createCore({}) as CompressionCore,
    store: new AcpStateStore(),
    modelContextLimit: 128000,
    compressCallIdsToHide: new Set(),
  }
  return { ctx, meter: ctx.get('tokenMeter') as TokenMeter, env }
}

function fakeExec(session: Session, ctx: Context | { get(name: string): unknown }, callId = 'call-acp'): ToolRunContext {
  const agent = {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx,
  } as unknown as Agent
  return {
    callId,
    name: 'compress',
    arguments: {},
    signal: new AbortController().signal,
    agent,
  } as unknown as ToolRunContext
}

function lastEventOf(session: Session, type: string): { seq: number; data: { shadowedTokenCount: number } & Record<string, unknown> } | undefined {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]!
    if (event.type === type) {
      return { seq: event.seq, data: event.data as { shadowedTokenCount: number } & Record<string, unknown> }
    }
  }
  return undefined
}

function meterPriceOf(meter: TokenMeter, session: Session, seqs: readonly number[]): number {
  // The ledger basis: `heuristicTokens` on 0.1.2+ meters, the single `tokens`
  // field on older ones (cast — the pinned devDep meter exposes only tokens).
  const bySeq = new Map(meter.measure(session).nodes.map((node) => {
    const priced = node as { seq: number; tokens: number; heuristicTokens?: number }
    return [priced.seq, priced.heuristicTokens ?? priced.tokens]
  }))
  return seqs.reduce((sum, seq) => sum + (bySeq.get(seq) ?? 0), 0)
}

/** Visual tokens a routed model declares for one image occurrence (#103 stub). */
const ROUTE_IMAGE_TOKENS = 4000

/**
 * Stand-in for a DSH 0.1.2+ `measure()` under a route with declared image
 * pricing (node shape verified against dsh-token-meter 0.1.2-rc.1
 * `route-pricing.js`): every public node carries BOTH prices — `tokens` is
 * the measured route's request pressure (image occurrences re-priced with
 * the route's visual tokens), `heuristicTokens` keeps the fixed flat-4
 * heuristic the projection ledger accumulates appends with. The pinned test
 * devDep (0.1.0-rc.6) has no route pricing, so the routed meter is simulated
 * around the REAL meter's own heuristic prices (`hostPriceEvent` mirror —
 * proven equal to the meter price by the #54 tests).
 */
function routedMeterStub(imageSeqs: ReadonlySet<number>, visualTokens: number): { measure(session: Session): { nodes: ReadonlyArray<{ seq: number; tokens: number; heuristicTokens: number }> } } {
  return {
    measure(measured: Session) {
      return {
        nodes: measured.surface.nodes.map((seq) => {
          const event = measured.events[seq]
          const heuristicTokens = event === undefined ? 0 : hostPriceEvent(event)
          return {
            seq,
            tokens: imageSeqs.has(seq) ? heuristicTokens + visualTokens : heuristicTokens,
            heuristicTokens,
          }
        }),
      }
    },
  }
}

test('L3: compress tool claims the HOST price — host projection stays non-negative (issue #54)', async () => {
  const { ctx, meter, env } = await makeHosted()
  const session = buildCjkPairSession(4)
  // surface nodes: 2,3 (pair 0), 6,7 (pair 1), 10,11, 14,15
  const shadowed = [2, 3, 6, 7]
  const preTotal = meter.measure(session).surfaceTokens
  const hostClaim = meterPriceOf(meter, session, shadowed)
  // The mirror agrees with the meter on the same span.
  assert.equal(shadowedHostTokens(session, shadowed), hostClaim, 'mirror == meter price')

  const compress = makeTools(env).find((definition) => definition.name === 'compress')
  assert.ok(compress)
  // handleCompress snapshots the registry (resolveTokenCount) BEFORE the
  // transaction, so the projection cell is already folded to the pre-transaction
  // log — drive ONLY the transaction events appended after this point.
  const beforeEvents = session.events.length
  const result = await compress.execute({
    content: [{
      startSeq: 2,
      endSeq: 7,
      summary: '面试准备：分布式一致性（CAP/BASE、两阶段提交与 Saga、幂等性与最终一致性）、缓存（穿透/击穿/雪崩与索引失效）、消息队列（削峰填谷）、限流熔断降级。',
    }],
  } as never, fakeExec(session, ctx))
  assert.match((result as { text: string }).text, /Compressed 1 block/)

  const summaryEvent = lastEventOf(session, 'compaction/summary')
  assert.ok(summaryEvent, 'compaction/summary event landed')
  const claim = summaryEvent!.data.shadowedTokenCount
  // 1. The durable claim equals the meter's own price of the shadowed span.
  assert.equal(claim, hostClaim, 'claim == meter price of the shadowed span')

  // 2. The mirror reproduces the claim from the append-only log (still intact).
  assert.equal(shadowedHostTokens(session, shadowed), claim, 'mirror == claim')

  // 4. The #54 arithmetic, reproduced: the OLD defaultCountTokens claim would
  //    overdraw the meter (CJK priced 1 char/token vs the host's 4 chars/token).
  const oldClaim = shadowed.reduce((sum, seq) => sum + defaultCountTokens(extractEventText(session.events[seq]!)), 0)
  assert.ok(oldClaim > hostClaim, 'defaultCountTokens overclaims CJK vs the host price')
  assert.ok(oldClaim > preTotal, '#54: the old claim would overdraw the meter (negative messageTokens)')

  // 3. The REAL host projection (the fold that threw in production) stays
  //    non-negative and agrees with the meter — both price the same surface.
  //    The registry is event-driven (ctx.on('session/event')) and detached
  //    test sessions never emit, so drive the post-transaction events once.
  const registry = ctx.sessionProjections
  for (let index = beforeEvents; index < session.events.length; index += 1) {
    registry.drive(session, session.events[index]!)
  }
  const snap = registry.snapshot(session)
  const messageTokens = snap.values.contextBreakdown!.messageTokens
  assert.ok(messageTokens >= 0, `host projection non-negative, got ${messageTokens}`)
  assert.equal(messageTokens, meter.measure(session).surfaceTokens, 'projection and meter agree when the claim is host-priced')
})

test('L3: prune (orphan cleanup) claims the HOST price too', async () => {
  const session = Session.create('orphan')
  session.append('turn/start', { turn: 1 })
  // Orphan tool/result — no matching assistant tool-call. CJK content so the
  // old defaultCountTokens pricing would visibly overclaim.
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: 'res-orphan',
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: 'gone',
        content: [{ type: 'text', text: cjkText('orphan', 400) }],
      }],
      source: { kind: 'tool', callId: 'gone' },
    },
  }, { surfaceOp: 'append' })
  const orphanEvent = session.events[session.events.length - 1]!
  const expected = hostPriceEvent(orphanEvent)
  const oldClaim = defaultCountTokens(extractEventText(orphanEvent))

  const pruned = stripOrphanedSurfaceToolMessages(session)
  assert.equal(pruned, 1)

  const pruneEvent = lastEventOf(session, 'compaction/prune')
  assert.ok(pruneEvent, 'compaction/prune event landed')
  assert.equal(pruneEvent!.data.shadowedTokenCount, expected, 'prune claim == host price of the pruned node')
  assert.ok(oldClaim > expected, 'defaultCountTokens overclaims CJK vs the host price')
})

test('L3: /acp compress uses RESOLVED edges and prices the host vocabulary (raw-vs-resolved fix)', async () => {
  const { ctx, meter, env } = await makeHosted()
  const session = Session.create('acp-range')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: cjkText('q', 600) }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [
        { type: 'text', text: cjkText('plan', 400) },
        { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
      ],
      provider: 'test-provider',
      model: 'test-model',
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: 'res-c1',
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: cjkText('res', 300) }] }],
      source: { kind: 'tool', callId: 'c1' },
    },
  }, { surfaceOp: 'append' })
  // surface nodes: 2 user, 3 tool-call assistant, 5 tool/result.
  // Raw "3 3" (lone tool-call) EXPANDS to {3,5} — the adjustment that used to
  // make /acp compress shadow a garbage span and crash (assertProvenance).
  const hostClaim = meterPriceOf(meter, session, [3, 5])

  const agent = {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx,
  } as unknown as Agent
  const command = acpCommand(env)
  const result = await command.handler({
    commandId: 'cmd-test' as never,
    agent,
    rawInput: `compress 3 3 ${'面试要点摘要：'.repeat(20)}`,
    signal: new AbortController().signal,
  } as never)
  assert.equal(result.kind, 'success')
  assert.match((result as { text: string }).text, /Compressed seqs 3\.\.5/, 'resolved span 3..5 landed')

  const summaryEvent = lastEventOf(session, 'compaction/summary')
  assert.ok(summaryEvent)
  assert.equal(summaryEvent!.data.shadowedTokenCount, hostClaim, 'claim == meter price of the RESOLVED span')
})

test('L3: estimateHostContent mirrors the host estimator exactly (edge cases)', () => {
  // text: ceil(4/4)+4 = 5
  assert.equal(estimateHostContent([{ type: 'text', text: 'abcd' }]), 5)
  // CJK: ceil(4/4)+4 = 5 — the host prices CJK at 4 chars/token, NOT 1.
  assert.equal(estimateHostContent([{ type: 'text', text: '中文面试' }]), 5)
  // tool-call: ceil(4/4) + ceil(13/4) + 4 = 1 + 4 + 4 = 9
  assert.equal(estimateHostContent([{ type: 'tool-call', name: 'bash', arguments: '{"command":"ls"}' }]), 9)
  // tool-result with STRING content: every char falls to the default branch
  // (4 + ceil(JSON.stringify(char)/4) = 5 per unescaped char).
  assert.equal(estimateHostContent([{ type: 'tool-result', toolCallId: 'x', content: 'abc' }]), 3 * 5 + 4)
  // nested tool-result content blocks recurse.
  assert.equal(estimateHostContent([{ type: 'tool-result', toolCallId: 'x', content: [{ type: 'text', text: 'abcd' }] }]), 5 + 4)
  // unknown block: 4 + ceil(JSON.stringify/4) over the ORIGINAL object.
  const weird = { type: 'custom-block', payload: 'abcdefgh' }
  const expected = 4 + Math.ceil(JSON.stringify(weird).length / 4)
  assert.equal(estimateHostContent([weird]), expected)
  // empty content / empty string.
  assert.equal(estimateHostContent([]), 0)
  assert.equal(estimateHostContent(''), 0)
})

test('L3: hostPriceEvent projects non-surface events to 0 and empty assistant messages to 0', () => {
  const session = Session.create('projection')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: cjkText('q', 100) }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({ content: [], provider: 'p', model: 'm' }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  const byType = new Map<SessionEvent['type'], SessionEvent>()
  for (const event of session.events) byType.set(event.type, event)
  assert.equal(hostPriceEvent(byType.get('turn/start')!), 0, 'non-surface events price to 0')
  assert.equal(hostPriceEvent(byType.get('step/start')!), 0, 'non-surface events price to 0')
  assert.equal(hostPriceEvent(byType.get('step/end')!), 0, 'non-surface events price to 0')
  assert.equal(hostPriceEvent(byType.get('assistant/message')!), 0, 'empty-content assistant prices to 0 (deriveEventMessage null)')
  const user = byType.get('user/message')!
  assert.ok(hostPriceEvent(user) > 0, 'user message prices positive')
})

test('L3: image-route meters price the claim in heuristicTokens — a node.tokens claim folds the projection negative (issue #103)', async () => {
  const { ctx, meter, env } = await makeHosted()
  const session = Session.create('image-route')
  session.append('turn/start', { turn: 1 })
  // Pair 0 — the image turn (the range to compress): a real-shape image block
  // (attachment ref — the mirror and the host ledger both price it via the
  // structural default branch, a few dozen tokens) with CJK text large enough
  // for the kernel's 5000-char compressible minimum.
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', createUserMessage({
    content: [
      { type: 'text', text: cjkText('这张截图里的报错是什么原因？', 3000) },
      {
        type: 'image',
        attachment: {
          attachmentId: AttachmentId('att-shot-1'),
          mediaType: 'image/png',
          bytes: 20480,
          width: 800,
          height: 600,
        },
      },
    ],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: cjkText('报错原因是上游连接超时，重试即可恢复。', 2600) }],
      provider: 'test-provider',
      model: 'test-model',
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  // Pairs 1-3 — follow-ups sized to keep the image pair compressible while
  // still letting the routed overclaim overdraw the ledger: large enough that
  // the kernel's protected window (last 5 messages / last 5000 CJK tokens)
  // stops inside them, but tiny in the HOST's flat-4 vocabulary so the fold
  // arithmetic below visibly goes negative.
  for (const step of [2, 3, 4]) {
    session.append('step/start', { turn: 1, step })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: cjkText(`追问${step}：那要怎么避免？`, 1300) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step,
      message: createAssistantMessage({
        content: [{ type: 'text', text: cjkText(`回答${step}：加重试和熔断即可。`, 1300) }],
        provider: 'test-provider',
        model: 'test-model',
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step })
  }
  // Surface nodes: 2 (user + image), 3 (assistant), then 6,7 / 10,11 / 14,15.
  const shadowed = [2, 3]
  const stubCtx = {
    get: (name: string) => (name === 'tokenMeter' ? routedMeterStub(new Set([2]), ROUTE_IMAGE_TOKENS) : undefined),
  }

  // The ledger basis: the REAL meter's fixed-heuristic price of the span
  // (no routing), which the mirror reproduces from the log.
  const heuristicClaim = meterPriceOf(meter, session, shadowed)
  assert.equal(shadowedHostTokens(session, shadowed), heuristicClaim, 'mirror == meter price of the shadowed span')
  // The BUG's claim: summing the routed node.tokens overstates by the visual price.
  const routedClaim = heuristicClaim + ROUTE_IMAGE_TOKENS

  const compress = makeTools(env).find((definition) => definition.name === 'compress')
  assert.ok(compress)
  const beforeEvents = session.events.length
  const result = await compress.execute({
    content: [{
      startSeq: 2,
      endSeq: 3,
      summary: '用户发来一张截图询问其中的报错原因；经分析确认是上游服务连接超时所致，结论是增加重试与超时回退即可恢复，无需改动业务逻辑。',
    }],
  } as never, fakeExec(session, stubCtx))
  assert.match((result as { text: string }).text, /Compressed 1 block/)

  const summaryEvent = lastEventOf(session, 'compaction/summary')
  assert.ok(summaryEvent, 'compaction/summary event landed')
  // 1. The claim reads the FIXED-HEURISTIC basis, not the routed node.tokens.
  assert.equal(summaryEvent!.data.shadowedTokenCount, heuristicClaim, 'claim == heuristicTokens sum, not the routed node.tokens sum')

  // 2. The #103 arithmetic reproduced: the OLD routed claim would overdraw
  //    the ledger — the fold lands below zero and the projection schema
  //    rejects every turn (the "Too small: expected number to be >=0" brick).
  //    Post-transaction surface = pairs 1-3 + the summary node; the bugged
  //    fold = that total minus the visual overclaim.
  const postTotal = meter.measure(session).surfaceTokens
  assert.ok(
    postTotal - ROUTE_IMAGE_TOKENS < 0,
    `the routed claim would fold messageTokens negative: ${postTotal} - ${ROUTE_IMAGE_TOKENS}`,
  )

  // 3. The REAL host projection (the fold that threw in production) accepts
  //    the heuristic claim: non-negative and in exact agreement with the meter.
  const registry = ctx.sessionProjections
  for (let index = beforeEvents; index < session.events.length; index += 1) {
    registry.drive(session, session.events[index]!)
  }
  const snap = registry.snapshot(session)
  const messageTokens = snap.values.contextBreakdown!.messageTokens
  assert.ok(messageTokens >= 0, `host projection non-negative, got ${messageTokens}`)
  assert.equal(messageTokens, postTotal, 'projection and meter agree when the claim is heuristic-priced')
})

test('L3: pre-0.1.2 meters expose a single tokens field — the claim keeps reading it', () => {
  const session = buildCjkPairSession(1)
  const seqs = [2, 3]
  const mirror = shadowedHostTokens(session, seqs)
  // Old node shape: { seq, tokens } only, tokens IS the fixed heuristic.
  const oldShapeMeter = {
    measure(measured: Session) {
      return {
        nodes: measured.surface.nodes.map((seq) => {
          const event = measured.events[seq]
          return { seq, tokens: event === undefined ? 0 : hostPriceEvent(event) }
        }),
      }
    },
  }
  const claim = shadowedTokensViaMeter(session, seqs, {
    get: (name: string) => (name === 'tokenMeter' ? oldShapeMeter : undefined),
  })
  assert.equal(claim, mirror, 'single-tokens shape: claim == tokens sum == mirror')
})
