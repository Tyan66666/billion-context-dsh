/**
 * g5-governance.test — B3 止损依据结构化 + B6 nudge 瘦身
 * （2026-09-08 过度工程治理方案 §4 B3/B6；六例）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { runCompactionTransaction, readCompactionSummary, verifiedReadingsOf } from '../src/region.ts'
import { compressParameters } from '../src/tools.ts'
import { buildNudgeText, stripNudgeGuidance } from '../src/nudge.ts'
import { COMPRESS_PHILOSOPHY, HOW_TO_COMPRESS_RULES } from 'acp-kernel'
import type { NudgeDecision } from 'acp-kernel'
import { ACP_SYSTEM_PROMPT } from '../src/system-prompt.ts'
import { DEFAULT_PROMPTS, resolvePrompts } from '../src/prompts.ts'
import { buildTextSession } from './helpers.ts'

const tx = (session: Session, extra: Record<string, unknown> = {}) => runCompactionTransaction(session, {
  start: 1,
  end: 4,
  shadowedSeqs: [1, 2, 3, 4],
  summary: [{ type: 'text', text: 'Summary with enough detail.' }],
  shadowedTokenCount: 100,
  provider: 'p',
  model: 'm',
  ...extra,
} as never)

test('B3-1 已绿验收读数结构化落盘：compaction/summary 事件带 verifiedReadings', () => {
  const session = buildTextSession(6)
  const { seqs } = tx(session, { verifiedReadings: ['t0-fastpath 8/8 绿', '闭环侧 400/400 绿'] })
  const event = session.events[seqs[1]!]!
  assert.equal(event.type, 'compaction/summary')
  assert.deepEqual([...verifiedReadingsOf(event)], ['t0-fastpath 8/8 绿', '闭环侧 400/400 绿'])
  assert.deepEqual([...(readCompactionSummary(event).verifiedReadings ?? [])], ['t0-fastpath 8/8 绿', '闭环侧 400/400 绿'])
})

test('B3-2 缺位=不写键、读面空数组（绝不抛）', () => {
  const session = buildTextSession(6)
  const { seqs } = tx(session)
  const event = session.events[seqs[1]!]!
  assert.equal('verifiedReadings' in (event.data as Record<string, unknown>), false, '缺位不写键（round-trip 纪律）')
  assert.deepEqual(verifiedReadingsOf(event), [])
})

test('B3-3 非摘要事件读面防御：空数组而非抛', () => {
  const session = buildTextSession(2)
  const nonSummary = session.events[0]!
  assert.deepEqual(verifiedReadingsOf(nonSummary), [])
})

test('B6-1 nudge 正文（不含范围表）≤300 B', () => {
  const session = buildTextSession(12)
  const decision: NudgeDecision = {
    shouldInject: true,
    reason: 'probe',
    compressibleRanges: [],
    tierTargetBlocks: [],
    contextUsage: 0.5,
    tier: null,
    breakdown: { usage: 0.5, growth: 0, growthReference: 0, effectiveThreshold: 0, nudgeGrowthTokens: 50000, growthFloor: 20000, currentTokens: 50000, referenceTokens: 50000 } as never,
    contextBreakdown: { system: 1000, tool: 2000, summaries: 0, code: 0, text: 3000 },
  } as never
  const text = buildNudgeText(decision, false, session)
  const body = text.split('Surface:')[0]!.trim()
  assert.ok(Buffer.byteLength(body, 'utf8') <= 300, `正文=${Buffer.byteLength(body, 'utf8')}B ≤ 300B`)
  assert.match(body, /efficiency nudge|Efficiency nudge/, '仍保留「该压缩了」的框')
})

test('B6-2 哲学段与规则段仍在系统提示里（移出≠删除）', () => {
  assert.ok(ACP_SYSTEM_PROMPT.includes('Compression Philosophy:'), '系统提示保留哲学段')
  assert.ok(ACP_SYSTEM_PROMPT.includes('HOW TO COMPRESS'), '系统提示保留压缩规则')
  const stripped = stripNudgeGuidance(`FRAME\n\n${COMPRESS_PHILOSOPHY}\n\n${HOW_TO_COMPRESS_RULES}\n\nTAIL`)
  assert.equal(stripped.includes('Compression Philosophy'), false)
  assert.equal(stripped.includes('HOW TO COMPRESS'), false)
  assert.match(stripped, /FRAME[\s\S]*TAIL/, '只摘指引段，框与尾保留')
})

test('B6-4 模板路径（宿主覆盖任一 nudge 槽）同样摘指引段（独立复核发现的软缺口）', () => {
  const session = buildTextSession(12)
  const prompts = resolvePrompts({ nudge: { tip: '自定义尾注' } })
  const text = buildNudgeText({ shouldInject: true, reason: 'probe', compressibleRanges: [], tierTargetBlocks: [], contextUsage: 0.5, tier: null, contextBreakdown: { system: 1000, tool: 2000, summaries: 0, code: 0, text: 3000 } } as never, false, session, prompts)
  const body = text.split('Surface:')[0]!.trim()
  assert.equal(text.includes('Compression Philosophy:'), false, '模板路径也不含哲学段')
  assert.equal(text.includes('HOW TO COMPRESS'), false, '模板路径也不含规则段')
  assert.ok(Buffer.byteLength(body, 'utf8') <= 300, `模板路径正文=${Buffer.byteLength(body, 'utf8')}B ≤ 300B`)
  assert.ok(text.includes('自定义尾注'), '宿主自定义槽位仍生效')
})

test('B6-3 默认模板不再内嵌 {philosophy}，但 systemPrompt 覆盖通道仍认它', () => {
  assert.equal(DEFAULT_PROMPTS.nudge.normal.includes('{philosophy}'), false, 'nudge 正文模板不含 {philosophy}')
  assert.equal(DEFAULT_PROMPTS.nudge.emergency.includes('{philosophy}'), false)
  const custom = resolvePrompts({ systemPrompt: '自定义提示\n{philosophy}' })
  assert.ok(custom.systemPromptTemplate.includes('{philosophy}'), 'systemPrompt 的 {philosophy} 占位仍合法（覆盖能力不回收）')
})

// 独立复核（2026-09-08 重载后活体核验）发现：B3-1/B3-2 只经 region.ts 的
// runCompactionTransaction 验证，绕过了工具的参数 schema 闸。而
// compressParameters.content.items 声明了 additionalProperties:false 却没列出
// verifiedReadings → 实调用被 schema 闸拒收
// （`invalid arguments: "content[0].verifiedReadings" is not a declared property`），
// 结构化字段在模型工具面上不可达。此例锁住「声明面必须暴露该字段」，
// 同时锁住 additionalProperties 仍为 false（不放宽未知字段）。
test('B3-4 工具面可达：compress 参数 schema 必须声明 verifiedReadings', () => {
  const items = compressParameters.content.items
  assert.equal(items.additionalProperties, false, '未知字段仍应被拒（不靠放宽 additionalProperties 修）')
  const prop = items.properties.verifiedReadings
  assert.ok(prop, 'content[].verifiedReadings 必须在声明里，否则 schema 闸会拒收合法调用')
  assert.equal(prop.type, 'array')
  assert.equal(prop.items.type, 'string')
  assert.ok(prop.description.length > 0, '声明面需带说明，模型才知道该字段存在')
  assert.ok(DEFAULT_PROMPTS.tools.compress.includes('verifiedReadings'), '工具描述同样要提到该字段')
})
