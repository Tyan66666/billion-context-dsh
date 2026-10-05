import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCore, createInitialState, defaultConfig, defaultCountTokens, type CoreMessage } from 'acp-kernel'

// Characterization lock on the kernel's BUILT-IN token counter (issue #152 calibration audit).
//
// When a host does not configure `config.countTokens`, src/index.ts builds the core with an
// EMPTY ports object (`createCore({})`), so every kernel-internal estimation (compressible-range
// geometry, growth arithmetic, tier pending counts, min-benefit gate) runs on the kernel's own
// fallback counter. The engine's rule-1 contract (CJK-aware counting everywhere) therefore
// depends on that fallback being `defaultCountTokens` rather than the flat chars/4 heuristic —
// a flat-4 fallback would silently reprice every CJK-heavy session by up to 4×, exactly the
// estimator-drift class this issue audits.
//
// Verified on acp-kernel@0.0.63: the fallback IS `defaultCountTokens` (bundled source:
// `ports.countTokens ?? defaultCountTokens` inside `createCore`). This test pins that through
// the public pipeline instead of trusting the bundle text: on a CJK-heavy fixture the empty-port
// core must price ranges identically to an explicit-`defaultCountTokens` core, diverge from
// flat-4 pricing, and clear the kernel's min-benefit gate (flat-4 pricing of the same content
// cannot). If a future kernel bump flips the built-in default, or our wiring stops passing the
// configured port, one of these asserts goes red during the §4b bump review.
//
// The two flat-4 defaults that DO exist in the bundle are unreachable on our paths:
// `computeContextBreakdown`'s optional parameter is shadowed because buildNudge overrides
// `nudge.contextBreakdown` with `computeSurfaceBreakdown` (src/nudge.ts) before any rendering,
// and no engine path calls `renderWithSnapshot` or consumes `processTurn`'s rendered messages
// (all five call sites read only `turn.state` / `turn.nudge`).

// Sized so twelve consumed rounds clear the kernel's min-benefit gate (~2.2× margin)
// under CJK-aware pricing — the second test asserts exactly that. If a future kernel
// bump changes the gate or range-splitting arithmetic, re-verify per §4b before editing.
const CJK = '这是一段中文测试文本，用于验证内核默认计数口径。'.repeat(40)
const FLAT4 = (text: string): number => (text ? Math.ceil(text.length / 4) : 0)

/** Twelve consumed tool rounds (CJK-heavy results) plus a fresh user turn and reply. */
function makeMessages(rounds: number): CoreMessage[] {
	const messages: CoreMessage[] = []
	let seq = 0
	const nextId = (): string => `m${String(++seq).padStart(5, '0')}`
	for (let round = 0; round < rounds; round++) {
		messages.push({ id: nextId(), role: 'user', contentType: 'text', text: `第${round}步：请继续分析下面的内容。` })
		messages.push({ id: nextId(), role: 'assistant', contentType: 'tool-call', text: '', toolName: 'bash', toolCallId: `call-${round}` })
		messages.push({ id: nextId(), role: 'user', contentType: 'tool-result', text: CJK, toolName: 'bash', toolCallId: `call-${round}` })
	}
	messages.push({ id: nextId(), role: 'user', contentType: 'text', text: '好的，最后请总结一下结果，谢谢。' })
	messages.push({ id: nextId(), role: 'assistant', contentType: 'text', text: '总结如下：' + CJK })
	return messages
}

interface Observation {
	injects: boolean
	rangeCount: number
	totalTokens: number
}

function observe(ports: { countTokens?: (text: string) => number }): Observation {
	const core = createCore(ports)
	const state = createInitialState()
	const turn = core.processTurn({ messages: makeMessages(12), state, config: defaultConfig(200000), tokenCount: 150000 })
	const ranges = turn.nudge?.compressibleRanges ?? []
	return {
		injects: turn.nudge?.shouldInject === true,
		rangeCount: ranges.length,
		totalTokens: ranges.reduce((sum, range) => sum + range.tokens, 0),
	}
}

test('empty-ports kernel prices CJK content like defaultCountTokens, not flat chars/4', () => {
	// Exactly what src/index.ts builds when config.countTokens is unset.
	const shipped = observe({})
	const cjkAware = observe({ countTokens: defaultCountTokens })
	const flat4 = observe({ countTokens: FLAT4 })

	assert.ok(shipped.rangeCount > 0, 'fixture sanity: the consumed rounds must yield compressible ranges')
	assert.equal(shipped.totalTokens, cjkAware.totalTokens, 'empty ports must price identically to explicit defaultCountTokens')
	assert.ok(shipped.totalTokens > flat4.totalTokens, 'the CJK fixture must discriminate: CJK-aware price exceeds flat chars/4')
})

test('empty-ports kernel clears the min-benefit gate on CJK content', () => {
	// Under flat-4 pricing the same fixture prices ~3.8× smaller and the kernel's
	// min-benefit gate suppresses the nudge entirely — so a regression of the built-in
	// default would surface here as missing nudges on CJK-heavy sessions.
	const shipped = observe({})
	assert.equal(shipped.injects, true, 'a CJK-heavy session at 75% usage must receive a nudge under the shipped default')
})
