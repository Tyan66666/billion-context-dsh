/**
 * M6 — acp-index per-message numbering directory (issue #71).
 * Fixtures mirror the REAL DSH shapes (tests/helpers.ts): nested
 * `{ type:'tool-result', toolCallId, content }` blocks and `source.plugin`
 * markers — a faked flat shape passes while production breaks (rule 5).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createCore, defaultCountTokens, type CompressionCore } from 'acp-kernel'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { AcpStateStore } from '../src/state.ts'
import { makeTools, type ToolEnvironment } from '../src/tools.ts'
import { buildCompressibleSeqRanges } from '../src/region.ts'
import {
  buildIndexMessage,
  collectIndexEntries,
  indexWatermarkOf,
  pendingTextTokenTotal,
  pendingToolTokenTotal,
  resolveMessageIndexConfig,
  truncateToTokenBudget,
  type ResolvedMessageIndexConfig,
} from '../src/message-index.ts'
import { INDEX_PLUGIN, isCheckpointNode, isIndexMarkerEvent } from '../src/messages.ts'
import { appendTurn, appendUser, appendAssistant, appendToolCall, appendToolResult, buildTextSession, longText } from './helpers.ts'

function fakeExec(session: Session): ToolRunContext {
  const agent = {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: new Context(),
  } as unknown as Agent
  return {
    callId: 'call-acp',
    name: 'compress',
    arguments: {},
    signal: new AbortController().signal,
    agent,
  } as unknown as ToolRunContext
}

function makeEnv(): ToolEnvironment {
  return {
    kernel: createCore({}) as CompressionCore,
    store: new AcpStateStore(),
    modelContextLimit: 128000,
    compressCallIdsToHide: new Set(),
  }
}

// The shipped default is OFF (opt-in in early releases) — these unit tests
// exercise the ENABLED path, so they resolve an explicitly-on config.
const INDEX_ON = resolveMessageIndexConfig({ enabled: true })

function toolOf(env: ToolEnvironment, name: string) {
  const tool = makeTools(env).find((definition) => definition.name === name)
  assert.ok(tool, `tool ${name} registered`)
  return tool
}

function textOf(message: { content: ReadonlyArray<{ type?: string; text?: string }> }): string {
  return message.content.map((block) => (block.type === 'text' ? block.text ?? '' : '')).join('')
}

/** Append an index marker EXACTLY the way the host driver persists an enter-decision message: a plain durable append of the UserMessage (src/index.ts appends extras verbatim). */
function appendMarker(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: INDEX_PLUGIN },
  }), { surfaceOp: 'append' })
}

/** Append a user message with an explicit host-style source shape. */
function appendSourced(session: Session, text: string, source: { kind?: string; plugin?: string; form?: string }): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source,
  }), { surfaceOp: 'append' })
}

test('M6: entries number every new surface node with kind labels and previews', () => {
  const session = Session.create('m6-labels')
  appendTurn(session, 1)
  appendUser(session, '帮我跑下测试')
  appendAssistant(session, '先看配置文件', 1, 1)
  appendToolCall(session, '', 'call-1', 1, 2)
  appendToolResult(session, 'ok, 2 passed', 'call-1', 1, 2)

  const entries = collectIndexEntries(session, 0, 24)
  // The turn/start event is not a surface node — only the four messages are.
  assert.equal(entries.length, 4)
  assert.deepEqual(entries.map((entry) => entry.label), ['user', 'asst', 'tool bash', 'result bash'])
  assert.equal(entries[0]!.preview, '帮我跑下测试')
  assert.equal(entries[1]!.preview, '先看配置文件')
  // A bare tool-call carries no text: the entry stays (the seq must be
  // numbered) but renders without a preview.
  assert.equal(entries[2]!.preview, '')
  assert.equal(entries[3]!.preview, 'ok, 2 passed')
  const seqs = entries.map((entry) => entry.seq)
  assert.ok(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]!), 'seqs strictly increase')
})

test('M6: previews respect a token budget (CJK-safe), flattened and quote-mapped', () => {
  // 200 CJK chars = 200 tokens under defaultCountTokens (1 char/token) — a
  // character-based cap would cost ~8× the stated budget here.
  const cjk = truncateToTokenBudget('压缩测试文本'.repeat(40), 24)
  assert.ok(defaultCountTokens(cjk) <= 24, `CJK preview over budget: ${defaultCountTokens(cjk)}`)
  assert.ok(cjk.endsWith('…'), 'truncated previews announce themselves')
  const ascii = truncateToTokenBudget('a'.repeat(400), 24)
  assert.ok(defaultCountTokens(ascii) <= 24)

  const flat = truncateToTokenBudget('行一\n\n行二\t制\u0000表 「引用」 "quoted"', 100)
  assert.equal(flat.includes('\n'), false)
  assert.equal(flat.includes('\t'), false)
  assert.equal(flat.includes('\u0000'), false, 'control characters are stripped')
  assert.equal(flat, "行一 行二 制 表 '引用' 'quoted'")
})

test('M6: the watermark advances with each durable index message; nothing is re-indexed', () => {
  const session = Session.create('m6-watermark')
  appendTurn(session, 1)
  appendUser(session, longText('msg', 0))
  appendAssistant(session, longText('reply', 1), 1, 1)

  assert.equal(indexWatermarkOf(session), 0, 'no marker yet')
  const first = buildIndexMessage(session, INDEX_ON)
  assert.ok(first !== null, 'first batch indexes both nodes')
  assert.match(textOf(first!), /\[acp-index\] \d+·user「/)
  assert.match(textOf(first!), /\d+·asst「/)

  // Persist exactly what the pre-step listener would append.
  session.append('user/message', first!, { surfaceOp: 'append' })
  assert.equal(indexWatermarkOf(session), session.events.length - 1, 'the newest marker seq IS the watermark')
  assert.equal(buildIndexMessage(session, INDEX_ON), null, 'nothing new → no message')

  appendUser(session, 'fresh follow-up question')
  const second = buildIndexMessage(session, INDEX_ON)
  assert.ok(second !== null)
  const secondText = textOf(second!)
  assert.match(secondText, /fresh follow-up question/)
  assert.doesNotMatch(secondText, /msg 0/, 'earlier indexed content is never repeated')
})

test('M6: checkpoint summaries and prior index lines are skipped, disabled config emits nothing', () => {
  const session = Session.create('m6-skip')
  appendTurn(session, 1)
  appendUser(session, 'real turn')
  // A compaction checkpoint node mirrors the durable shape region.ts reads.
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'summary of compressed work' }],
    source: { kind: 'plugin', plugin: 'compact' },
  }), { surfaceOp: 'append' })
  appendMarker(session, '[acp-index] earlier batch')

  const entries = collectIndexEntries(session, 0, 24)
  assert.equal(entries.length, 1, 'checkpoint and own marker are not indexable')
  assert.equal(entries[0]!.label, 'user')
  const checkpointSeq = session.events.findIndex((event) => event !== undefined && isCheckpointNode(event))
  assert.ok(checkpointSeq > 0, 'fixture sanity: a checkpoint exists in the log')
  assert.equal(entries.some((entry) => entry.seq === checkpointSeq), false, 'the checkpoint node is never listed')

  assert.equal(buildIndexMessage(session, { enabled: false, previewTokens: 24 }), null)
  assert.equal(resolveMessageIndexConfig({}).enabled, false, 'the index is opt-in in early releases (default disabled)')
  assert.deepEqual(resolveMessageIndexConfig({ enabled: false }), { enabled: false, previewTokens: 16, backlogLimit: 100, maxDelayToolTokens: 8192, maxDelayTextTokens: 0 }, 'partial config keeps defaults')
  assert.equal(resolveMessageIndexConfig({ previewTokens: -3 }).previewTokens, 0, 'a negative budget clamps to 0 (bare entries) instead of misbehaving')
  assert.equal(resolveMessageIndexConfig({ previewTokens: 7.9 }).previewTokens, 7, 'fractional budgets floor')
  assert.equal(resolveMessageIndexConfig({ backlogLimit: 5 }).backlogLimit, 5)
  assert.equal(resolveMessageIndexConfig({ backlogLimit: -1 }).backlogLimit, 100, 'an invalid backlog limit keeps the default')
  assert.equal(resolveMessageIndexConfig({ maxDelayToolTokens: 4096 }).maxDelayToolTokens, 4096)
  assert.equal(resolveMessageIndexConfig({ maxDelayToolTokens: 0 }).maxDelayToolTokens, 0, '0 disables the TOOL delay counter (per-turn cadence only)')
  assert.equal(resolveMessageIndexConfig({ maxDelayToolTokens: -1 }).maxDelayToolTokens, 8192, 'a negative tool delay keeps the default')
  assert.equal(resolveMessageIndexConfig({ maxDelayToolTokens: Number.NaN }).maxDelayToolTokens, 8192, 'a non-finite tool delay keeps the default')
  assert.equal(resolveMessageIndexConfig({ maxDelayTextTokens: 2048 }).maxDelayTextTokens, 2048)
  assert.equal(resolveMessageIndexConfig({ maxDelayTextTokens: 0 }).maxDelayTextTokens, 0, '0 is the default: conversation never triggers')
  assert.equal(resolveMessageIndexConfig({ maxDelayTextTokens: -1 }).maxDelayTextTokens, 0, 'a negative text delay keeps the default (0)')
  assert.equal(resolveMessageIndexConfig({ maxDelayTextTokens: Number.NaN }).maxDelayTextTokens, 0, 'a non-finite text delay keeps the default (0)')
})

test('M6: pending token totals split by kind — tool nodes feed maxDelayToolTokens, conversation nodes maxDelayTextTokens', () => {
  const session = Session.create('m6-pending-kinds')
  appendTurn(session, 1)
  appendUser(session, longText('a', 0))
  appendMarker(session, '[acp-index] batch')
  // A nudge echo (engine metadata) above the marker must NOT feed either
  // counter — it is plumbing text, not un-indexed content (issue #71 v2: the
  // skip set aligns with classifySurfaceEvent's metadata bucket).
  appendSourced(session, longText('nudge-echo', 1), { kind: 'plugin', plugin: 'acp-nudge' })
  // Above the newest marker: one user message, one tool call, one tool result.
  appendUser(session, longText('b', 1))
  appendToolCall(session, longText('call', 2), 'call-1')
  appendToolResult(session, longText('res', 3), 'call-1')
  // A compaction checkpoint node mirrors the durable shape region.ts reads.
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'summary of compressed work' }],
    source: { kind: 'plugin', plugin: 'compact' },
  }), { surfaceOp: 'append' })

  // Each counter sees only its own kind ABOVE the newest marker: never a,
  // never the checkpoint, never the marker itself — the same skip set as
  // collectIndexEntries (the pre-step guard must agree with what the
  // directory would actually index). Tool text is BLOCK-LEVEL: a tool-call
  // node counts only its `arguments` (its prose block is conversation, not
  // tool output), a tool-result counts its full nested content.
  const callArgsTokens = defaultCountTokens('{"command":"ls"}')
  const markerSeq = indexWatermarkOf(session)
  assert.equal(
    pendingToolTokenTotal(session, markerSeq),
    callArgsTokens + defaultCountTokens(longText('res', 3)),
    'tool counter sees the call arguments + the result content above the watermark',
  )
  assert.equal(
    pendingTextTokenTotal(session, markerSeq),
    defaultCountTokens(longText('b', 1)),
    'text counter sees only conversation nodes above the watermark',
  )
  // The mixed text+tool-call node's prose is conversation, not tool output —
  // the tool total above already excludes it (it counts `{"command":"ls"}`
  // arguments, not the 1K-token prose longText('call', 2)).

  // A watermark BELOW the marker must still exclude it from BOTH counters:
  // the skip set is position-independent (the isIndexMarkerEvent branch, not
  // a seq range).
  assert.equal(
    pendingToolTokenTotal(session, 0),
    callArgsTokens + defaultCountTokens(longText('res', 3)),
    'tool counter skips the marker even when the watermark lies below it',
  )
  assert.equal(
    pendingTextTokenTotal(session, 0),
    defaultCountTokens(longText('a', 0)) + defaultCountTokens(longText('b', 1)),
    'text counter skips the marker and never counts tool nodes',
  )

  // With no marker at all, every surfaced node counts toward its own kind.
  const fresh = Session.create('m6-pending-fresh')
  appendTurn(fresh, 1)
  appendUser(fresh, longText('x', 0))
  appendToolCall(fresh, longText('y', 1), 'call-2')
  appendToolResult(fresh, longText('z', 2), 'call-2')
  assert.equal(
    pendingToolTokenTotal(fresh, 0),
    callArgsTokens + defaultCountTokens(longText('z', 2)),
    'a fresh session counts every tool node (call arguments + result content)',
  )
  assert.equal(
    pendingTextTokenTotal(fresh, 0),
    defaultCountTokens(longText('x', 0)),
    'a fresh session counts every conversation node and no tool node',
  )
  // A finite cap short-circuits the sum: the guard only needs to know whether
  // the pending total CROSSED the threshold, never the exact number — without
  // this a single multi-megabyte CJK tool dump would cost a full tokenization
  // pass (~1.3s measured) on every pre-step (red-team MAJOR-2).
  const fullToolTotal = callArgsTokens + defaultCountTokens(longText('z', 2))
  const capped = pendingToolTokenTotal(fresh, 0, 1)
  assert.ok(capped >= 1 && capped <= fullToolTotal, 'a tiny cap stops the tool sum at the first crossing')
  assert.equal(
    pendingToolTokenTotal(fresh, 0, fullToolTotal),
    fullToolTotal,
    'a cap at or above the total returns the exact sum (no early exit needed)',
  )
  // A single node longer than 4× the remaining budget is tokenized only
  // through the shortest prefix that proves the crossing — the return is
  // capped at/above `cap`, never the full multi-megabyte text.
  const giant = Session.create('m6-pending-giant')
  appendTurn(giant, 1)
  appendToolResult(giant, '压'.repeat(500000), 'call-giant')
  const giantCount = pendingToolTokenTotal(giant, 0, 8192)
  assert.ok(giantCount >= 8192, 'a giant CJK dump still crosses the cap')
  assert.ok(giantCount <= 8192 + 4096, 'the count is bounded near the cap, never O(text)')
  // The watermark itself gates the sum: re-measuring after a marker advances
  // the pending set to zero for content already indexed.
  appendMarker(fresh, '[acp-index] indexed x y z')
  assert.equal(pendingToolTokenTotal(fresh, indexWatermarkOf(fresh)), 0, 'indexed tool content is no longer pending')
  assert.equal(pendingTextTokenTotal(fresh, indexWatermarkOf(fresh)), 0, 'indexed conversation content is no longer pending')
})

test('M6: after a real compression the watermark survives in the log and numbering continues', async () => {
  const env = makeEnv()
  const session = buildTextSession(6)
  const firstNodeSeq = session.surface.nodes[0]!

  const first = buildIndexMessage(session, INDEX_ON)
  assert.ok(first !== null)
  session.append('user/message', first!, { surfaceOp: 'append' })
  const markerSeq = session.events.length - 1

  // Compress EVERYTHING including the marker itself — the surface loses the
  // watermark, the log must still have it.
  const compress = toolOf(env, 'compress')
  await compress.execute({ content: [{ startSeq: firstNodeSeq, endSeq: markerSeq, summary: '早期工作摘要 [msg 0]..[reply 5] 已归档' }] } as never, fakeExec(session))

  appendUser(session, 'fresh question after compression')
  const next = buildIndexMessage(session, INDEX_ON)
  assert.ok(next !== null, 'new content still gets numbered after compression')
  const nextText = textOf(next!)
  assert.match(nextText, /fresh question after compression/)
  assert.doesNotMatch(nextText, /msg 0/, 'shadowed content is not re-indexed')
  assert.doesNotMatch(nextText, /\[acp-index\].*\[acp-index\]/, 'exactly one header')
  const entries = collectIndexEntries(session, indexWatermarkOf(session), 24)
  assert.equal(entries.length, 1, 'only the post-compression node is outstanding')
})

test('M6: the protected-tail scan treats index lines as plugin output, not the last user turn', () => {
  const session = buildTextSession(12)
  appendMarker(session, '[acp-index] tail batch')

  // Last REAL user message — mirrors the src/region.ts buildCompressibleSeqRanges
  // tail-scan predicate (isRealUserTurn: a real user turn is classify 'real'
  // and never a sub-agent relay); kept inline so this test pins the scan even
  // if region.ts refactors around it.
  let lastRealUserSeq = 0
  for (let index = session.surface.nodes.length - 1; index >= 0; index -= 1) {
    const seq = session.surface.nodes[index]!
    const event = session.events[seq]
    const kind = (event?.data as { source?: { kind?: string } }).source?.kind
    if (
      event !== undefined &&
      event.type === 'user/message' &&
      !isIndexMarkerEvent(event) &&
      !isCheckpointNode(event) &&
      kind !== 'subagent-report' &&
      kind !== 'subagent-settled'
    ) {
      lastRealUserSeq = seq
      break
    }
  }
  assert.ok(lastRealUserSeq > 0, 'fixture sanity: a real user message exists')

  // preserveRecent 0 isolates the scan under test: the ONLY protection left
  // is the last-user rule, so the assertion pins exactly the fixed behavior.
  const ranges = buildCompressibleSeqRanges(session, { preserveRecent: 0 })
  assert.ok(ranges.length > 0, 'fixture sanity: compressible ranges exist (a solver regression to [] must not fake-pass)')
  const leaked = ranges.filter((range) => range.start <= lastRealUserSeq && lastRealUserSeq <= range.end)
  assert.equal(leaked.length, 0, 'the real last user message must stay protected when the marker trails it')
})

test('M6: with several durable markers the watermark is the NEWEST one (backward scan)', () => {
  const session = Session.create('m6-multi-marker')
  appendTurn(session, 1)
  appendUser(session, longText('early', 0))
  appendMarker(session, '[acp-index] first batch')
  appendUser(session, longText('middle', 1))
  appendMarker(session, '[acp-index] second batch')

  assert.equal(indexWatermarkOf(session), session.events.length - 1, 'watermark = newest marker seq, never the oldest')
  appendUser(session, 'only content after the last marker')
  const next = buildIndexMessage(session, INDEX_ON)
  assert.ok(next !== null)
  const text = textOf(next!)
  assert.match(text, /only content after the last marker/)
  assert.doesNotMatch(text, /early 0/, 'content under the first marker stays indexed')
  assert.doesNotMatch(text, /middle 1/, 'content between the markers is never re-indexed')
})

test('M6: a steady-state batch under backlogLimit numbers EVERY node in one message', () => {
  const session = buildTextSession(60)
  const seqs = [...session.surface.nodes]
  const message = buildIndexMessage(session, INDEX_ON)
  assert.ok(message !== null)
  const text = textOf(message!)
  assert.equal(text.split('[acp-index]').length - 1, 1, 'exactly one header')
  for (const seq of seqs) {
    assert.ok(text.includes(`${seq}·`), `node ${seq} must be numbered — dropping entries orphans the seq forever`)
  }
})

test('M6: a backlog over backlogLimit collapses into ONE placeholder marker that becomes the watermark', () => {
  const session = Session.create('m6-backlog')
  appendTurn(session, 1)
  for (let index = 0; index < 120; index += 1) appendUser(session, longText('bulk', index))

  const placeholder = buildIndexMessage(session, INDEX_ON)
  assert.ok(placeholder !== null)
  const text = textOf(placeholder!)
  assert.match(text, /^\[acp-index\] \d+\.\.\d+ — 120 earlier messages/, 'placeholder names the skipped span and count')
  assert.equal(text.includes('·'), false, 'no per-entry lines survive the collapse')

  session.append('user/message', placeholder!, { surfaceOp: 'append' })
  assert.equal(indexWatermarkOf(session), session.events.length - 1, 'the placeholder IS an acp-index marker — its own seq is the watermark')
  assert.equal(buildIndexMessage(session, INDEX_ON), null, 'steady state resumes: nothing new → nothing emitted')

  appendUser(session, 'post-collapse question')
  const next = buildIndexMessage(session, INDEX_ON)
  assert.ok(next !== null)
  const nextText = textOf(next!)
  assert.match(nextText, /post-collapse question/)
  assert.doesNotMatch(nextText, /bulk 0/, 'collapsed content is never re-indexed')
})

test('M6: preview budget boundaries — 0 disables, 1 fits a token, exact fits stay whole, pairs never split', () => {
  assert.equal(truncateToTokenBudget('anything at all', 0), '')
  const one = truncateToTokenBudget('hello world', 1)
  assert.ok(defaultCountTokens(one) <= 1, 'budget 1 still bounds the result')
  assert.ok(one.endsWith('…'))
  assert.equal(truncateToTokenBudget('压缩测试', 4), '压缩测试', 'an exact fit returns unchanged, no ellipsis')
  assert.equal(truncateToTokenBudget('压缩测试', 3), '压缩…', 'one token over budget trims to the largest prefix that fits WITH the ellipsis')
  const paired = truncateToTokenBudget('😀😀😀😀', 3)
  assert.equal(paired.includes('\uFFFD'), false, 'a cut never lands inside a surrogate pair')
  const mapped = truncateToTokenBudget('他说‘hi’·然后', 100)
  assert.equal(mapped, "他说'hi',然后", 'curly quotes map to ASCII and the middle dot cannot fake an entry delimiter')
})

test('M6: degraded labels stay neutral and the marker declares form catalog', () => {
  const session = Session.create('m6-degraded')
  appendTurn(session, 1)
  appendToolCall(session, '', 'call-named', 1, 2)
  // A tool-call whose model omitted the name: bare `tool`, never raw internals.
  session.append('assistant/message', {
    turn: 1,
    step: 3,
    message: createAssistantMessage({
      content: [{ type: 'tool-call', id: 'call-anon', name: '', arguments: '{}' }],
      provider: 'test-provider',
      model: 'test-model',
    }),
  }, { surfaceOp: 'append' })
  // A result whose callId matches NO assistant call: bare `result`.
  appendToolResult(session, 'orphan output', 'call-unknown', 1, 4)

  const entries = collectIndexEntries(session, 0, 24)
  assert.deepEqual(entries.map((entry) => entry.label), ['tool bash', 'tool', 'result'])
  assert.equal(entries[2]!.preview, 'orphan output')

  const message = buildIndexMessage(session, INDEX_ON)
  assert.ok(message !== null)
  const source = message as unknown as { source?: { kind?: string; plugin?: string; form?: string } }
  assert.equal(source.source?.kind, 'plugin')
  assert.equal(source.source?.plugin, 'acp-index')
  assert.equal(source.source?.form, 'catalog', 'hosts may render catalog-form rows collapsed')
})

test('M6: search_context never ranks shadowed acp-index rows over real hits', async () => {
  const env = makeEnv()
  // The fixture must push the real hit AND the marker OUT of the protected tail
  // (last 5 surface nodes) — otherwise compress refuses the whole range
  // ("entirely within the protected zone"), no block lands, and the search
  // assertions pass/fail for the wrong reason. Five tail nodes after the marker
  // keep both inside the compressed span.
  const session = buildTextSession(12)
  appendUser(session, 'deploy ERROR traceback happened here')
  appendMarker(session, '[acp-index] error error error tail batch')
  const markerSeq = session.events.length - 1
  appendUser(session, 'tail one')
  appendAssistant(session, 'tail reply one', 2, 1)
  appendUser(session, 'tail two')
  appendAssistant(session, 'tail reply two', 2, 2)
  appendUser(session, 'tail three')
  // Compress up to the marker: the five tail nodes behind it form the protected
  // tail, so this span survives shrink-then-expand with both targets inside.
  const endSeq = markerSeq

  const compress = toolOf(env, 'compress')
  await compress.execute({ content: [{ startSeq: session.surface.nodes[0]!, endSeq, summary: 'Archived early conversation batch: alternating user/assistant turns plus one deploy incident record; the directory row is part of this span (inspect via acp_status).' }] } as never, fakeExec(session))

  const search = toolOf(env, 'search_context')
  const out = await search.execute({ query: 'ERROR' } as never, fakeExec(session)) as { text: string }
  assert.match(out.text, /deploy ERROR traceback/, 'the real hit surfaces')
  assert.equal(out.text.includes('[acp-index]'), false, 'synthetic directory rows are excluded from the search doc set')
})

test('M6: search_context excludes ALL shadowed metadata and instruction rows, not just markers', async () => {
  const env = makeEnv()
  // The metadata fold now puts nudge echoes into compressible segments; the
  // search doc set must exclude them AND host instruction rows even when a
  // direct compress span happens to cover them (adapter-layer defense).
  const session = buildTextSession(12)
  appendUser(session, 'deploy ERROR traceback happened here')
  appendSourced(session, 'nudge echo: range table seq tokens compress', { kind: 'plugin', plugin: 'acp-nudge' })
  appendSourced(session, 'skill catalog entries list', { kind: 'skill-catalog', form: 'catalog', entries: [] })
  appendMarker(session, '[acp-index] error error tail batch')
  const markerSeq = session.events.length - 1
  appendUser(session, 'tail one')
  appendAssistant(session, 'tail reply one', 2, 1)
  appendUser(session, 'tail two')
  appendAssistant(session, 'tail reply two', 2, 2)
  appendUser(session, 'tail three')

  const compress = toolOf(env, 'compress')
  await compress.execute({ content: [{ startSeq: session.surface.nodes[0]!, endSeq: markerSeq, summary: 'Archived early conversation batch: alternating turns plus one deploy incident; folded nudge echo and skill catalog rows ride along (inspect via acp_status).' }] } as never, fakeExec(session))

  const search = toolOf(env, 'search_context')
  const out = await search.execute({ query: 'ERROR' } as never, fakeExec(session)) as { text: string }
  assert.match(out.text, /deploy ERROR traceback/, 'the real hit surfaces')
  assert.equal(out.text.includes('[acp-index]'), false, 'marker rows are excluded from the search doc set')
  assert.equal(out.text.includes('nudge echo'), false, 'nudge echo rows are excluded from the search doc set')
  assert.equal(out.text.includes('skill catalog'), false, 'instruction rows are excluded from the search doc set')
})

test('M6: entries at or above the large-entry threshold carry a [N tok] marker; smaller ones stay bare', () => {
  const session = Session.create('m6-large-tokens')
  appendTurn(session, 1)
  // 6000 ASCII chars = ceil(6000/4) = 1500 tokens → [1.5K tok]
  appendUser(session, 'a'.repeat(6000))
  // 900 chars = 225 tokens → NO marker
  appendUser(session, 'b'.repeat(900))
  // exactly the 512-token threshold (2048 ASCII chars) → [512 tok]
  appendUser(session, 'c'.repeat(2048))
  // CJK counts 1 char/token: 512 chars = 512 tokens → [512 tok]
  appendUser(session, '压'.repeat(512))
  // a bare tool-call has no text → 0 tokens, no marker
  appendToolCall(session, '', 'call-big', 1, 1)

  const entries = collectIndexEntries(session, 0, 24)
  assert.deepEqual(entries.map((entry) => entry.tokens), [1500, 225, 512, 512, 0], 'token sizes are defaultCountTokens of the node text')

  const message = buildIndexMessage(session, INDEX_ON)
  assert.ok(message !== null)
  const text = textOf(message)
  assert.match(text, /\[1\.5K tok\]/, 'the 1500-token dump shows the K shorthand')
  assert.match(text, /\[512 tok\]/, 'threshold-exact entries show the plain count')
  assert.equal(text.match(/\[\d+(\.\d+)?K? tok\]/g)?.length ?? 0, 3, 'only the three large entries are marked')
  assert.equal(text.includes('[225 tok]'), false, 'sub-threshold entries carry no marker')
  // The bare tool-call entry renders without a preview AND without a marker.
  assert.match(text, /·tool bash(?!「)/, 'bare entry stays bare')
  assert.equal(text.includes('K tok'), true, 'marker suffix present')
})

test('M6: delay thresholds are silent for missing keys and warn before flooring fractions', () => {
  const captureWarns = (run: () => unknown): { value: unknown; warns: string[] } => {
    const warns: string[] = []
    const original = console.warn
    console.warn = (message: unknown) => { warns.push(String(message)) }
    try {
      return { value: run(), warns }
    } finally {
      console.warn = original
    }
  }
  // The common `{ enabled: true }` opt-in must not spam warnings: missing
  // delay keys keep their defaults silently (test-quality M1 regression).
  const silent = captureWarns(() => resolveMessageIndexConfig({ enabled: true }))
  assert.equal((silent.value as ResolvedMessageIndexConfig).maxDelayToolTokens, 8192)
  assert.equal((silent.value as ResolvedMessageIndexConfig).maxDelayTextTokens, 0)
  assert.deepEqual(silent.warns, [], 'missing delay keys never warn')
  const silentAll = captureWarns(() => resolveMessageIndexConfig({}))
  assert.deepEqual(silentAll.warns, [], 'fully-default config never warns')
  // Fractions floor, and floor(0.5) → 0 must not silently disable a counter.
  const floored = captureWarns(() => resolveMessageIndexConfig({ maxDelayToolTokens: 8192.9, maxDelayTextTokens: 0.5 }))
  assert.equal((floored.value as ResolvedMessageIndexConfig).maxDelayToolTokens, 8192)
  assert.equal((floored.value as ResolvedMessageIndexConfig).maxDelayTextTokens, 0)
  assert.equal(floored.warns.length, 2, 'fractional thresholds warn before flooring')
})

test('M6: a bare-string tool-result content array and pure tool-call arguments both count toward tool tokens', () => {
  // A real host variant (rule 12): tool-result content as a bare string array.
  const stringy = Session.create('m6-string-result')
  appendTurn(stringy, 1)
  const rawText = 'raw string output '.repeat(200)
  stringy.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: 'res-str',
      role: 'user',
      content: [rawText],
      source: { kind: 'tool', callId: 'call-str' },
    },
  }, { surfaceOp: 'append' })
  assert.equal(pendingToolTokenTotal(stringy, 0), defaultCountTokens(rawText), 'bare string blocks count toward tool tokens')

  // A pure tool-call node (no prose block) counts its arguments, never zero.
  const callOnly = Session.create('m6-call-args')
  appendTurn(callOnly, 1)
  const argsText = '{"command":"ls -la"}\n{"pattern":"error"}'
  callOnly.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [
        { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls -la"}' },
        { type: 'tool-call', id: 'c2', name: 'grep', arguments: '{"pattern":"error"}' },
      ],
      provider: 'test-provider',
      model: 'test-model',
    }),
  }, { surfaceOp: 'append' })
  assert.equal(pendingToolTokenTotal(callOnly, 0), defaultCountTokens(argsText), 'every call block arguments count')
  assert.equal(pendingTextTokenTotal(callOnly, 0), 0, 'a tool-call node is never conversation')
})
