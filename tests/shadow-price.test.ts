/**
 * L3 — shadow-price regression tests (issue #54, AGENTS.md rule 12).
 *
 * The host token-meter prices every appended message with a flat-4 heuristic
 * (`estimateContent`/`estimateMessage`) and the producer contract requires
 * every compaction claim to be derived from the SAME estimator. The engine's
 * old code priced claims with `defaultCountTokens` (CJK 1 char/token), which
 * overdraws the meter on CJK-heavy sessions and bricks them (live session
 * session-3aa366c3: accumulated 42,076 host-tokens, claimed 74,858 →
 * messageTokens ≈ −31K → the projection schema rejected every turn).
 *
 * These tests drive the REAL host machinery — TokenMeter + the
 * SessionProjectionRegistry with the actual contextBreakdown projection (the
 * exact fold that threw in production) — over CJK-heavy fixtures, and assert:
 *   1. the durable claim equals the meter's own price of the shadowed span,
 *   2. the mirror agrees with the meter (claim == mirror == meter),
 *   3. the host projection stays non-negative and agrees with the meter,
 *   4. the OLD `defaultCountTokens` claim would have overdraw the meter (the
 *      #54 arithmetic reproduced in-test).
 * All three event writers are covered: the compress tool, /acp compress, and
 * the prune path.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { createCore, defaultCountTokens, type CompressionCore } from 'acp-kernel'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AcpStateStore } from '../src/state.ts'
import { makeTools, type ToolEnvironment } from '../src/tools.ts'
import { acpCommand } from '../src/commands.ts'
import { stripOrphanedSurfaceToolMessages } from '../src/region.ts'
import { estimateHostContent, hostPriceEvent, shadowedHostTokens } from '../src/host-tokens.ts'
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

function fakeExec(session: Session, ctx: Context, callId = 'call-acp'): ToolRunContext {
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
  const bySeq = new Map(meter.measure(session).nodes.map((node) => [node.seq, node.tokens]))
  return seqs.reduce((sum, seq) => sum + (bySeq.get(seq) ?? 0), 0)
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
