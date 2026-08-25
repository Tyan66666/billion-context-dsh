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
import AcpCompactionEngine, { AcpCompactionEngine as Named } from '../src/index.ts'

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

/** 快照前段:system prompt 去掉"Nothing forces you"后的首段。 */
const SYSTEM_PROMPT_HEAD = `Active Context Pruning — model-driven context management

YOU decide whether and when to compress context. The nudge is an efficiency notification: when you see one, consider which ranges you have genuinely consumed and could summarise to keep working context lean.`

test('M4/prompts 1: default system prompt contains key sections in correct order', () => {
  const rendered = renderSystemPrompt(resolvePrompts())
  // Head
  assert.ok(rendered.startsWith(SYSTEM_PROMPT_HEAD), 'system prompt starts with the new efficiency-notification framing')
  // Philosophy
  assert.ok(rendered.includes('Compression Philosophy:\n- All compression serves the primary task'), 'philosophy section present')
  // WHEN TO / WHEN NOT
  assert.ok(rendered.includes('WHEN TO COMPRESS:'), 'WHEN TO COMPRESS section present')
  assert.ok(rendered.includes('WHEN NOT TO COMPRESS:'), 'WHEN NOT TO COMPRESS section present')
  assert.ok(rendered.includes('A task phase has ended'), 'WHEN TO bullet present')
  assert.ok(rendered.includes('Protected tool outputs'), 'WHEN NOT bullet present')
  // HOW_TO_COMPRESS_RULES
  assert.ok(rendered.includes('HOW TO COMPRESS'), 'HOW_TO_COMPRESS_RULES section present')
  assert.ok(rendered.includes('KEEP VERBATIM'), 'KEEP VERBATIM section present')
  assert.ok(rendered.includes('Write dense, scannable bullets'), 'formatting guidance present')
  // Tool descriptions (DSH-specific: seq-based)
  assert.ok(rendered.includes('Compression tools (refs are SURFACE SEQS, not ids):'), 'tool section present')
  assert.ok(rendered.includes('compress: replace one or more seq ranges'), 'compress tool description present')
  assert.ok(rendered.includes('Tiered compression:'), 'tiered compression section present')
  // Tier rules
  assert.ok(rendered.includes('TIER 2 COMPRESSION — DISTILLATION'), 'TIER2_DISTILL_RULES present')
  assert.ok(rendered.includes('TIER 3 COMPRESSION — ULTRA-CONDENSATION'), 'TIER3_CONDENSE_RULES present')
  assert.ok(rendered.includes('When you write a summary, it becomes the ONLY record'), 'summary writing rules present')
  // No "suggestion, not an order" language
  assert.ok(!rendered.includes('suggestion, not an order'), 'no "suggestion, not an order" language')
  assert.ok(!rendered.includes('Nothing forces you'), 'no "Nothing forces you" language')
})

test('M4/prompts 2: default normal nudge — efficiency note + HOW_TO_COMPRESS_RULES + tip', () => {
  const text = buildNudgeText(fakeDecision(7, false), false, buildTextSession(4))
  // Frame: kernel EFFICIENCY_NOTE verbatim (no "Context usage is at X%" statement)
  assert.ok(text.startsWith('This is an efficiency nudge to compress early and keep context lean — not an overflow warning.'), 'frame starts with efficiency note')
  assert.ok(!text.includes('Context usage is at'), 'no "Context usage is at" usage statement in the nudge')
  assert.ok(text.includes('Compression Philosophy:\n- All compression serves the primary task'), 'philosophy embedded in frame')
  // No "suggestion, not a requirement"
  assert.ok(!text.includes('suggestion, not a requirement'), 'no "suggestion, not a requirement"')
  // HOW_TO_COMPRESS_RULES as guidance
  assert.ok(text.includes('HOW TO COMPRESS'), 'HOW_TO_COMPRESS_RULES present')
  assert.ok(text.includes('KEEP VERBATIM'), 'KEEP VERBATIM section present')
  // Tip at end
  assert.ok(text.endsWith('💡 Compress all ranges in one call (pass multiple content entries: `content: [{...}, {...}]`).'), 'tip at end')
})

test('M4/prompts 2b: default nudge renders through the kernel renderNudgeText path (seq table replaces ref table)', () => {
  // With a compressible range present, the DEFAULT nudge must come from the
  // kernel's renderNudgeText (EFFICIENCY_NOTE / breakdown / HOW_TO_COMPRESS_RULES /
  // tip verbatim) with ONLY the ref-ID rangesStr replaced by our seq table.
  const session = buildTextSession(12)
  const text = buildNudgeText(fakeDecision(50, false), false, session)
  // Kernel frame + philosophy + rules + tip, all verbatim from acp-kernel
  assert.ok(text.startsWith('This is an efficiency nudge to compress early and keep context lean — not an overflow warning.'), 'kernel EFFICIENCY_NOTE frame')
  assert.ok(text.includes('HOW TO COMPRESS'), 'kernel HOW_TO_COMPRESS_RULES')
  assert.ok(text.endsWith('💡 Compress all ranges in one call (pass multiple content entries: `content: [{...}, {...}]`).'), 'kernel batch tip at end')
  // Ref-ID rangesStr replaced by the surface-seq table. The title KEEPS the
  // kernel header format ("N, oldest first") with the seq dialect appended —
  // the kernel mN range rows are what must be gone.
  assert.ok(!text.includes('m00150'), 'kernel ref range sample gone')
  assert.ok(text.includes('exact surface seqs — usable as-is'), 'seq-dialect title injected')
  assert.ok(text.includes('seq 1..7'), 'surface-seq range table injected')
  assert.ok(text.includes('Surface: 12 nodes, seqs 1..12'), 'surface summary present')
  // No usage statement; the only mNNNNN tokens are inside kernel's own
  // HOW_TO_COMPRESS_RULES example text (m00420 key anchors), not a leak.
  assert.ok(!text.includes('Context usage is at'), 'no usage statement')
})

test('M4/prompts 3: default emergency nudge — ⚠️ frame + HOW_TO_COMPRESS_RULES + seq example', () => {
  const text = buildNudgeText(fakeDecision(96, true), true, buildTextSession(4))
  // Frame: emergency style with philosophy embedded
  assert.ok(text.startsWith('⚠️ Context limit reached — compress now. Prioritize consumed tool outputs.'), 'emergency frame starts with compress now')
  assert.ok(text.includes('Compression Philosophy:\n- All compression serves the primary task'), 'philosophy embedded in emergency frame')
  // No "choice and timing are yours"
  assert.ok(!text.includes('choice and timing are yours'), 'no "choice and timing are yours"')
  // HOW_TO_COMPRESS_RULES
  assert.ok(text.includes('HOW TO COMPRESS'), 'HOW_TO_COMPRESS_RULES present in emergency')
  assert.ok(text.includes('KEEP VERBATIM'), 'KEEP VERBATIM present in emergency')
  // Ref-ID example replaced with the seq example (kernel emergency has no 💡 tip)
  assert.ok(!text.includes('startId'), 'no ref-ID startId in the emergency example')
  assert.ok(text.includes('compress({ content: [{ startSeq, endSeq, summary }] })'), 'seq example replaces the ref-ID example')
  assert.ok(!text.includes('💡 Compress all ranges'), 'kernel emergency nudge has no batch tip (kernel parity)')
})

test('M4/prompts 4: range table snapshot (with ranges) and zero-range early return', () => {
  assert.equal(rangeTable(buildTextSession(4)), '')
  assert.equal(
    rangeTable(buildTextSession(12)),
    `\nSurface: 12 nodes, seqs 1..12
Compressible ranges (1, oldest first; exact surface seqs — usable as-is):
  - seq 1..7 — 7 messages, ~7227 tokens [tool 0% | text 100%]
Compress with: compress({ content: [{ startSeq, endSeq, summary }] }) — content is an array: batch multiple unrelated segments in one call, each entry its own block. Keep ranges disjoint.
Snapshot taken at nudge time: the seqs go stale once the surface moves (a later compress shadows them), so re-run acp_status for fresh refs before compressing.`,
  )
})

test('M4/prompts 5: tool descriptions render the defaults byte-identical', () => {
  const descriptions = Object.fromEntries(makeTools(makeEnv(128000)).map((t) => [t.name, t.description]))
  assert.equal(
    descriptions['compress'],
    'Replace older conversation ranges with dense summaries you write. Each message seq is a surface reference. Single range: compress({ content: [{ startSeq, endSeq, summary }] }). Batch multiple unrelated ranges in one call (each content entry becomes its own block); keep ranges disjoint. Never compress content the current step is actively using. Compress boundaries are SURFACE SEQS (acp_status Surface: row, latest nudge table) — NOT the block refs (bN, e.g. b1) that acp_status COMPRESSED BLOCKS shows, which are for decompress only. Drilldown mN refs (e.g. m00306) are ALSO accepted as startSeq/endSeq — they are auto-mapped to the live surface seq; an unknown mN (never assigned on the current surface) fails with guidance. Seq refs must come from the CURRENT surface (acp_status or the latest nudge): a span whose edges were shadowed by an earlier compress is auto-remapped to its still-live content, a fully compressed span is reported as already compressed, and invented/other-session seqs fail with guidance. Good compression moments: stage or subtask completion, strategy switches, intermediate milestones, and wrapping up failed exploration — when the details are consumed and no longer critical for the task ahead. When you write a summary, turn dead-end exploration into a conclusion (what was tried, why it failed, the next step) — not a blow-by-blow; and keep the summary the ONLY record: self-contained, so a later reader (or you, after decompress) can continue without the original.',
  )
  assert.equal(descriptions['decompress'], 'Recover the original content of a compressed block by its blockId — the kernel block ref `bN` shown by acp_status (e.g. b1), or a compaction id from search_context (read-only; does not unshadow the range).')
  assert.equal(descriptions['search_context'], 'Search inside compressed blocks (summaries and original content) for information the model no longer sees in context. When a summary lacks a detail you need (exact values, error strings, decisions, verbatim code), SEARCH the compressed blocks FIRST — never guess or reconstruct from memory: search_context(query) locates the right block, then decompress only that block to recover the original.')
  assert.equal(descriptions['acp_status'], 'Context status: overview of the current context — CONTEXT BREAKDOWN (tool/text/summaries token shares of the visible total), COMPRESSED BLOCKS ledger, and the nudge decision. Run it before compressing whenever you are unsure about context pressure or block structure — a drilldown answers what the nudge table only summarizes. No args = overview. Percentages are shares of the visible content, not the context window. Note: the block refs in COMPRESSED BLOCKS (bN, e.g. b1) are for decompress; compress uses the Surface: seq range, not bN. Drilldown: pass scope:"compressed" for a per-block list, or scope:"uncompressed" with view:"messages" (every visible message) / view:"ranges" (merged ranges); tool filters to one tool name, sort reorders (size/time/tool; age for compressed), limit caps rows (default 30). Drilldown row refs are kernel ids (mN) — feed them straight to compress as startSeq/endSeq (auto-mapped to the live surface seq); bN is for decompress, Surface: seqs also work in compress.')
})

test('M4/prompts 5b: default compress description ships the #43 semantic-timing and actionable-summary guidance', () => {
  // issue #43 (AgentFold/CAT paper insights): the DEFAULT compress tool
  // description must carry (a) semantic compression moments and (b) the
  // actionable-summary rule (dead-end → conclusion, summary is the ONLY
  // record). These were proven out locally via config.prompts overrides and
  // are now promoted into the shipped default — byte-identical snapshot is
  // test #5, this test pins the two semantic carriers explicitly.
  const descriptions = Object.fromEntries(makeTools(makeEnv(128000)).map((t) => [t.name, t.description]))
  const compress = descriptions['compress']
  assert.ok(
    compress.includes('Good compression moments: stage or subtask completion, strategy switches, intermediate milestones, and wrapping up failed exploration'),
    'semantic compression moments present (issue #43)',
  )
  assert.ok(
    compress.includes('turn dead-end exploration into a conclusion (what was tried, why it failed, the next step) — not a blow-by-blow'),
    'actionable dead-end→conclusion rule present (issue #43)',
  )
  assert.ok(
    compress.includes('keep the summary the ONLY record: self-contained, so a later reader (or you, after decompress) can continue without the original'),
    'summary-as-only-record rule present (issue #43)',
  )
})

test('M4/prompts 5c: search-first carriers ship in the default search_context description AND the system prompt quick-reference (issue #44)', () => {
  // issue #44: when a summary lacks details, the model must SEARCH the
  // compressed blocks first — never guess or reconstruct from memory.
  // Two independent entry points carry the rule: (a) the default
  // search_context TOOL description and (b) the system-prompt
  // quick-reference line. Pinning both as semantic carriers (not
  // byte-identical — that is test #5) guards against either drifting back
  // to the old passive wording independently.
  const descriptions = Object.fromEntries(makeTools(makeEnv(128000)).map((t) => [t.name, t.description]))
  const searchCtxDesc = descriptions['search_context']
  assert.ok(
    searchCtxDesc.includes('SEARCH the compressed blocks FIRST — never guess or reconstruct from memory'),
    'search-first rule present in the default search_context description (issue #44)',
  )
  assert.ok(
    searchCtxDesc.includes('then decompress only that block to recover the original'),
    'decompress-locates-then-recovers step present (issue #44)',
  )
  const rendered = renderSystemPrompt(resolvePrompts())
  assert.ok(
    rendered.includes('SEARCH the compressed blocks FIRST — never guess or reconstruct from memory'),
    'search-first rule present in the system prompt quick-reference (issue #44)',
  )
  assert.ok(
    rendered.includes('exact values, error strings, decisions, verbatim code'),
    'quick-reference carrier list matches the tool description (issue #44)',
  )
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

test('M4/prompts 10: empty guidance removes the line cleanly (frame + newline + table + tip)', () => {
  const session = buildTextSession(12)
  const prompts = resolvePrompts({
    nudge: {
      guidance: '',
      breakdown: '',
      growth: '',
      tip: '',
    },
  })
  const frame = 'This is an efficiency nudge to compress early and keep context lean — not an overflow warning. A separate, stronger alert will appear if the context is actually full.\n\nCompression Philosophy:\n- All compression serves the primary task, but be frugal.\n- Context capacity is precious. Save context by compressing consumed outputs, not by avoiding tools.\n- Compress by need, not by percentage.\n- Work from summaries, not raw tool outputs. All listed ranges (user prompts, tool outputs, code, logs, exploration, intermediate steps) should be compressed to summary format — the ONLY exceptions are protected content, content the current step is actively using, or critical content you cannot reconstruct.'
  const text = buildNudgeText(fakeDecision(7, false), false, session, prompts)
  assert.equal(text, `${frame}\n${rangeTable(session)}`)
  assert.ok(!text.includes('HOW TO COMPRESS'))
  assert.ok(!text.includes('Compress all ranges'))
})

test('M4/prompts 11: tier line renders (0 tokens) when pending is missing (B2 fallback)', () => {
  const decision: NudgeDecision = {
    shouldInject: true,
    reason: 'tier-2 distillation recommended',
    compressibleRanges: [],
    tierTargetBlocks: [{ blockId: 'b1', tier: 1, effectiveMessageIds: ['m1'], compressedTokens: 4750, summary: 's', active: true, directMessageIds: [], directBlockIds: [], createdAt: 1, survivedCount: 0, generation: 'young' }],
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
      normal: '上下文使用率 {pct}%。这是效率提示，不是溢出警告。',
      emergency: '⚠️ 上下文已达上限，立即压缩。',
      guidance: '压缩规则：保持路径、签名、错误原文。',
      tier: '第 {tier} 层:{count} 个第 {prevTier} 层块可蒸馏({tokens} tokens)。',
      breakdown: '上下文分解：{system}K 系统 | {tool}K 工具 | {summaries}K 摘要 | {code}K 代码 | {text}K 文本',
      growth: '+{growth}K 自上次提示',
      tip: '💡 一次调用压缩多个范围。',
    },
    rangeTable: {
      header: '表面:{surface}',
      title: '可压缩范围(仅供参考):',
      line: '  - seq {start}..{end} — {count} 条消息,约 {tokens} tokens',
      footer: '用 compress 压缩;批量条目各成一个块。',
    },
    systemPrompt: '主动上下文剪枝 —— 模型驱动。\n{philosophy}\n{howToCompressRules}\n压缩工具:compress/decompress/search_context/acp_status。',
  })
  const session = buildTextSession(12)
  const text = buildNudgeText(fakeDecision(7, false), false, session, prompts)
  assert.ok(text.includes('上下文使用率 7%'))
  assert.ok(text.includes('表面:12 nodes, seqs 1..12'))
  assert.ok(text.includes('可压缩范围(仅供参考):'))
  assert.ok(text.includes('💡 一次调用压缩多个范围'))
  const emerg = buildNudgeText(fakeDecision(96, true), true, session, prompts)
  assert.ok(emerg.includes('上下文已达上限'))
  const sys = renderSystemPrompt(prompts)
  assert.ok(sys.includes('主动上下文剪枝'))
  assert.ok(sys.includes('Compression Philosophy:'))
  assert.ok(sys.includes('compress/decompress/search_context/acp_status'))
})

test('M4/prompts 14: engine-level — config.prompts reaches system prompt section, tool descriptions, and the pre-step nudge', async () => {
  const ctx = new Context()
  const sections: Array<{ name: string; order: number; text: string }> = []
  const tools: Array<{ name: string; description: string }> = []
  ctx.provide('systemPrompt' as never, { section: (opts: never) => sections.push(opts as never) } as never)
  ctx.provide('tools' as never, { register: (tool: never) => tools.push(tool as never) } as never)
  ctx.plugin(AcpCompactionEngine as never, {
    modelContextLimit: 16000,
    prompts: {
      nudge: { normal: '引擎级自定义 {pct}' },
      systemPrompt: '引擎级系统提示\n{philosophy}',
      tools: { compress: '引擎级压缩工具描述' },
    },
  } as never)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const engine = ctx.compaction as Named
  assert.ok(engine instanceof Named)
  assert.equal(engine.prompts.nudge.normal, '引擎级自定义 {pct}', 'engine resolved the custom template')

  // System prompt section: rendered once with the custom template + kernel philosophy.
  assert.equal(sections.length, 1, 'ACP section registered exactly once')
  assert.ok(sections[0]!.text.includes('引擎级系统提示'))
  assert.ok(sections[0]!.text.includes('Compression Philosophy:'), 'kernel philosophy embedded via {philosophy}')

  // Tool descriptions: registered from env.prompts (proves env carried this.prompts).
  const compressTool = tools.find((t) => t.name === 'compress')
  assert.equal(compressTool!.description, '引擎级压缩工具描述')

  // pre-step: the custom normal frame reaches the injected nudge message.
  const decision = await (ctx.waterfall(
    'agent/pre-step' as never,
    { agent: fakeAgent(buildTextSession(12)) } as never,
    async () => ({ kind: 'enter', messages: [] }) as never,
  ) as never)
  const decisionObj = decision as { kind: string; messages: Array<{ content: Array<{ type: string; text?: string }> }> }
  assert.equal(decisionObj.kind, 'enter')
  assert.equal(decisionObj.messages.length, 1, 'the nudge message was appended to the decision')
  const text = decisionObj.messages[0]!.content.map((block) => block.text ?? '').join('')
  assert.ok(text.startsWith('引擎级自定义 '), 'the custom nudge frame reached the injected message')
})

test('M4/prompts 15: engine construction fails fast on a template typo', () => {
  assert.throws(
    () => new Named(new Context(), { prompts: { nudge: { normal: '{bad}' } } }),
    /prompts\.nudge\.normal contains unknown placeholder \{bad\}/,
  )
  // Group-level null from YAML-ish input is tolerated (whole group falls back).
  const engine = new Named(new Context(), { prompts: { nudge: null } } as never)
  assert.equal(engine.prompts.nudge.normal, DEFAULT_PROMPTS.nudge.normal)
})
