/**
 * M4 — configurable prompts: template rendering, per-key merge + validation,
 * and byte-identical default snapshots (the anti-regression anchor for the
 * template migration — literals below were captured from the PRE-change
 * implementation, so they are independent of the new rendering code).
 * Design: docs/configurable-prompts-design.md (v4).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createCore, type CompressionCore, type NudgeDecision } from 'acp-kernel'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AcpStateStore } from '../src/state.ts'
import { buildNudge, buildNudgeText, rangeTable, type NudgeEnvironment } from '../src/nudge.ts'
import { makeTools, type ToolEnvironment } from '../src/tools.ts'
import {
  DEFAULT_PROMPTS,
  renderSystemPrompt,
  renderTemplate,
  resolvePrompts,
} from '../src/prompts.ts'
import { buildTextSession } from './helpers.ts'

function fakeAgent(session: import('@deepseek-ai/dsh-session').Session): Agent {
  return {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: new Context(),
  } as unknown as Agent
}

function makeEnv(limit: number): ToolEnvironment {
  return {
    kernel: createCore({}) as CompressionCore,
    store: new AcpStateStore(),
    modelContextLimit: limit,
  }
}

function fakeDecision(pct: number, emergency: boolean): NudgeDecision {
  return {
    shouldInject: true,
    reason: 'probe',
    compressibleRanges: [],
    tierTargetBlocks: [],
    contextUsage: pct / 100,
    tier: null,
    breakdown: {
      usage: pct / 100,
      growth: 0,
      growthReference: 0,
      effectiveThreshold: 0,
      nudgeGrowthTokens: 50000,
      growthFloor: 20000,
      hasPendingNudge: 0,
      overLimit: emergency ? 1 : 0,
      emergencyOverride: emergency ? 1 : 0,
      pendingT1: 0,
      pendingT2: 0,
      pendingT3: 0,
    },
  } as never
}

/** 快照 1:改造前 ACP_SYSTEM_PROMPT 的逐字节字面量(与实现分离,防循环论证)。 */
const SYSTEM_PROMPT_SNAPSHOT = `Active Context Pruning — model-driven context management

YOU decide whether and when to compress context. Nothing forces you: the injected "nudge" is a suggestion, not an order, and you may ignore it when compression would not help. Compress only ranges you have genuinely consumed (read tool outputs, finished explorations, superseded steps) that the current work no longer needs verbatim.

Compression Philosophy:
- All compression serves the primary task, but be frugal.
- Context capacity is precious. Save context by compressing consumed outputs, not by avoiding tools.
- Compress by need, not by percentage.
- Work from summaries, not raw tool outputs. All listed ranges (user prompts, tool outputs, code, logs, exploration, intermediate steps) should be compressed to summary format — the ONLY exceptions are protected content, content the current step is actively using, or critical content you cannot reconstruct.

Compression tools (refs are SURFACE SEQS, not ids):
- compress: replace one or more seq ranges, each with your own dense summary. Single range: compress({ content: [{ startSeq, endSeq, summary }] }). Batch multiple unrelated segments in one call (each entry becomes its own block): compress({ content: [{ startSeq: 1, endSeq: 5, summary: '...' }, { startSeq: 12, endSeq: 18, summary: '...' }] }). Keep ranges disjoint — overlapping entries in one batch are skipped. Edges are auto-balanced to tool-call/result boundaries; a trailing #callId fragment in a seq is ignored. Seq refs must be on the current surface: seqs from older nudges or earlier compresses go stale as the surface moves, so a stale span is auto-remapped to its still-live remainder (the result reports the adjusted span), a fully compressed span is reported as already compressed, and invented/other-session seqs fail with guidance.
- decompress: recover a compressed block's original content, read-only. decompress({ blockId }).
- search_context: find information inside compressed blocks BEFORE decompressing. search_context({ query }).
- acp_status: current context usage and the live compressible-range list. Run it right before compressing — the only seqs that never go stale are the ones you just read.

Tiered compression: each compressed block appears on the surface as one summary node. Compressing that node again DISTILLS the block (tier 2): the parent summary folds into your new summary and the original messages are freed. Distilling a tier-2 block yields tier 3. Distill when a summary itself is consumed — decompress on the tier-2 block recovers the full originals.

When you write a summary, it becomes the ONLY record of that range: keep file paths, signatures, exact values, decisions, and error strings verbatim so a later reader (or you, after decompress) can continue without the original. Never reuse historical seqs — the surface moves as messages land and compress; verify with acp_status.`

test('M4/prompts 1: default system prompt renders byte-identical to the pre-change literal', () => {
  assert.equal(renderSystemPrompt(resolvePrompts()), SYSTEM_PROMPT_SNAPSHOT)
})

test('M4/prompts 2: default normal nudge snapshot — zero-range session, trailing newline is part of the bytes', () => {
  const text = buildNudgeText(fakeDecision(7, false), false, buildTextSession(4))
  assert.equal(
    text,
    'Context usage is at 7%. This is a suggestion, not a requirement — you decide whether and when to compress.\n\n'
      + 'Compress by need, not by percentage: replace only ranges you have genuinely consumed, with dense self-contained summaries.\n',
  )
})

test('M4/prompts 3: default emergency nudge snapshot — ⚠️ frame, trailing newline', () => {
  const text = buildNudgeText(fakeDecision(96, true), true, buildTextSession(4))
  assert.equal(
    text,
    '⚠️ Context usage is at 96% of the window — nearly full. Consider compressing consumed ranges soon so working context stays available; the choice and timing are yours.\n\n'
      + 'Compress by need, not by percentage: replace only ranges you have genuinely consumed, with dense self-contained summaries.\n',
  )
})

test('M4/prompts 4: range table snapshot (with ranges) and zero-range early return', () => {
  assert.equal(rangeTable(buildTextSession(4)), '')
  assert.equal(
    rangeTable(buildTextSession(12)),
    `\nSurface: 12 nodes, seqs 1..12
Compressible ranges (suggestions only — compress any consumed span; refs are surface seqs):
  - seq 1..7 — 7 messages, ~7227 tokens
Compress with: compress({ content: [{ startSeq, endSeq, summary }] }) — content is an array: batch multiple unrelated segments in one call, each entry its own block. Keep ranges disjoint.
Snapshot taken at nudge time: the seqs go stale once the surface moves (a later compress shadows them), so re-run acp_status for fresh refs before compressing.`,
  )
})

test('M4/prompts 5: tool descriptions render the defaults byte-identical', () => {
  const descriptions = Object.fromEntries(makeTools(makeEnv(128000)).map((t) => [t.name, t.description]))
  assert.equal(
    descriptions['compress'],
    'Replace older conversation ranges with dense summaries you write. Each message seq is a surface reference. Single range: compress({ content: [{ startSeq, endSeq, summary }] }). Batch multiple unrelated ranges in one call (each content entry becomes its own block); keep ranges disjoint. Never compress content the current step is actively using. Seq refs must come from the CURRENT surface (acp_status or the latest nudge): a span whose edges were shadowed by an earlier compress is auto-remapped to its still-live content, a fully compressed span is reported as already compressed, and invented/other-session seqs fail with guidance.',
  )
  assert.equal(descriptions['decompress'], 'Recover the original content of a compressed block by its blockId (read-only; does not unshadow the range).')
  assert.equal(descriptions['search_context'], 'Search inside compressed blocks (summaries and original content) for information the model no longer sees in context.')
  assert.equal(descriptions['acp_status'], 'Report the ACP block ledger: compressed blocks, reclaimed tokens, and current context pressure.')
})

test('M4/prompts 6: partial overrides merge per key; key/group null falls back to default', () => {
  const merged = resolvePrompts({ nudge: { normal: '自定义 {pct}' } })
  assert.equal(merged.nudge.normal, '自定义 {pct}')
  assert.equal(merged.nudge.emergency, DEFAULT_PROMPTS.nudge.emergency)
  const keyNull = resolvePrompts({ nudge: { guidance: null } })
  assert.equal(keyNull.nudge.guidance, DEFAULT_PROMPTS.nudge.guidance)
  const groupNull = resolvePrompts({ nudge: null } as never)
  assert.equal(groupNull.nudge, DEFAULT_PROMPTS.nudge)
})

test('M4/prompts 7: nudge normal template substitutes {pct}', () => {
  const prompts = resolvePrompts({ nudge: { normal: '上下文使用率 {pct}%' } })
  const text = buildNudgeText(fakeDecision(7, false), false, buildTextSession(4), prompts)
  assert.ok(text.startsWith('上下文使用率 7%'))
})

test('M4/prompts 8: unknown placeholder throws with the slot path', () => {
  assert.throws(
    () => resolvePrompts({ nudge: { normal: '…{pctt}…' } }),
    /prompts\.nudge\.normal contains unknown placeholder \{pctt\}/,
  )
  assert.throws(
    () => resolvePrompts({ rangeTable: { line: '  - {start}..{wrong}' } }),
    /prompts\.rangeTable\.line contains unknown placeholder \{wrong\}/,
  )
  assert.throws(
    () => resolvePrompts({ systemPrompt: 'x {philosophyy} y' }),
    /prompts\.systemPrompt contains unknown placeholder \{philosophyy\}/,
  )
})

test('M4/prompts 9: renderTemplate throws on a missing value for a known placeholder', () => {
  assert.throws(
    () => renderTemplate('{tokens} tokens', {}),
    /missing value for placeholder \{tokens\}/,
  )
})

test('M4/prompts 10: empty guidance removes the line cleanly (frame + newline + table)', () => {
  const session = buildTextSession(12)
  const prompts = resolvePrompts({ nudge: { guidance: '' } })
  const frame = 'Context usage is at 7%. This is a suggestion, not a requirement — you decide whether and when to compress.'
  const text = buildNudgeText(fakeDecision(7, false), false, session, prompts)
  assert.equal(text, `${frame}\n${rangeTable(session)}`)
  assert.ok(!text.includes('Compress by need'))
})

test('M4/prompts 11: tier line renders (0 tokens) when pending is missing (B2 fallback)', () => {
  const decision: NudgeDecision = {
    shouldInject: true,
    reason: 'tier-2 distillation recommended',
    compressibleRanges: [],
    tierTargetBlocks: [{ blockId: 'b1' } as never],
    contextUsage: 0.9,
    tier: 2,
    // pendingT2 deliberately absent at runtime: NudgeBreakdown requires it
    // statically (acp-kernel types.d.ts:183-185), so cast per test convention.
    breakdown: {
      usage: 0.9,
      growth: 0,
      growthReference: 0,
      effectiveThreshold: 0,
      nudgeGrowthTokens: 50000,
      growthFloor: 20000,
      hasPendingNudge: 0,
      overLimit: 1,
      emergencyOverride: 0,
      pendingT1: 0,
      pendingT3: 0,
    } as never,
  }
  const text = buildNudgeText(decision, false, buildTextSession(12))
  assert.match(text, /Tier 2: 1 tier-1 block\(s\) distillable \(0 tokens\)/)
  assert.doesNotMatch(text, /\( tokens\)/)
})

test('M4/prompts 12: buildNudge forwards env.prompts into the injected message (B1)', () => {
  const env: NudgeEnvironment = {
    kernel: createCore({}) as CompressionCore,
    store: new AcpStateStore(),
    // ~77.5% usage for 12 messages: over-limit (>= 0.70) but below emergency
    // (0.85) → the NORMAL frame renders.
    modelContextLimit: 16000,
    prompts: resolvePrompts({ nudge: { normal: 'CUSTOM normal {pct}' } }),
  }
  const outcome = buildNudge(fakeAgent(buildTextSession(12)), env, new Map<string, number>())
  assert.ok(outcome !== null, 'over-limit nudge fires')
  assert.equal(outcome!.emergency, false)
  const text = outcome!.message.content.map((block) => (block as { text?: string }).text ?? '').join('')
  assert.ok(text.startsWith('CUSTOM normal '), 'the custom normal frame reached the injected message')
})

test('M4/prompts 13: Chinese override smoke (i18n scenario)', () => {
  const prompts = resolvePrompts({
    nudge: {
      normal: '上下文使用率 {pct}%。这是建议,不是要求 —— 是否压缩、何时压缩,由你决定。',
      emergency: '⚠️ 上下文使用率已达窗口的 {pct}% —— 几乎满了。',
      guidance: '按需压缩,而不是按百分比:只替换你真正消费过的范围。',
      tier: '第 {tier} 层:{count} 个第 {prevTier} 层块可蒸馏({tokens} tokens)。',
    },
    rangeTable: {
      header: '表面:{surface}',
      title: '可压缩范围(仅供参考):',
      line: '  - seq {start}..{end} — {count} 条消息,约 {tokens} tokens',
      footer: '用 compress 压缩;批量条目各成一个块。',
    },
    systemPrompt: '主动上下文剪枝 —— 模型驱动。\n{philosophy}\n压缩工具:compress/decompress/search_context/acp_status。',
  })
  const session = buildTextSession(12)
  const text = buildNudgeText(fakeDecision(7, false), false, session, prompts)
  assert.ok(text.includes('上下文使用率 7%'))
  assert.ok(text.includes('表面:12 nodes, seqs 1..12'))
  assert.ok(text.includes('可压缩范围(仅供参考):'))
  const emerg = buildNudgeText(fakeDecision(96, true), true, session, prompts)
  assert.ok(emerg.includes('已达窗口的 96%'))
  const sys = renderSystemPrompt(prompts)
  assert.ok(sys.includes('主动上下文剪枝'))
  assert.ok(sys.includes('Compression Philosophy:'))
  assert.ok(sys.includes('compress/decompress/search_context/acp_status'))
})
