/**
 * Locks the acp-kernel built-in token counter as CJK-aware (issue #203, part of
 * the issue #152 calibration audit).
 *
 * Background — why this file exists. The #152 audit raised the suspicion that
 * an UNCONFIGURED engine (no `config.countTokens`) runs the kernel on a flat
 * chars/4 counter while every model-visible face (nudge breakdown, range table,
 * acp_status) prices with the CJK-aware `defaultCountTokens` — which would
 * misprice CJK-heavy sessions by up to 4×. On v0.2.26 with the pinned
 * acp-kernel@0.0.63 the suspicion does NOT hold: `createCore` resolves
 * `ports.countTokens ?? defaultCountTokens` (verified in the bundled source),
 * so the empty ports object src/index.ts builds when unconfigured already lands
 * on the CJK-aware counter, and the two flat-4 defaults inside the bundle
 * (`computeContextBreakdown`'s shadowed parameter, `renderWithSnapshot`'s
 * default argument) are unreachable on every engine path. What was missing is
 * a guard for the invariant the whole audit depends on — that is this file.
 *
 * The fixture is driven through the engine's own feeding pattern
 * (`allLogMessages` projection + `kernelConfigFor` config, the same inputs the
 * pre-step path hands to `processTurn`), so a future kernel bump that flips
 * the built-in default — or any change to how ranges are priced — turns these
 * asserts red during the §4b bump review instead of drifting silently.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createCore, createInitialState, defaultCountTokens } from 'acp-kernel'
import { Session } from '@deepseek-ai/dsh-session'
import { allLogMessages } from '../src/messages.ts'
import { kernelConfigFor } from '../src/config.ts'
import { appendAssistant, appendToolCall, appendToolResult, appendTurn, appendUser } from './helpers.ts'

// A realistic CJK work paragraph (the project's own subject matter); repeated
// to size each message. Deliberately dense in \u4e00-\u9fff characters so the
// two counters separate maximally: CJK-aware counts 1 char/token there, flat
// chars/4 counts 0.25.
const SENTENCE =
  '上下文压缩需要在保留关键细节的同时回收上下文空间让长任务持续稳定地推进而不会耗尽模型的窗口容量这是一个反复出现的工程问题'

function cjkText(seed: string, totalChars: number): string {
  const base = `${SENTENCE}第${seed}段记录了一次完整的压缩决策过程包括边界选择摘要书写和校验读取。`
  let out = ''
  while (out.length < totalChars) out += base
  return out.slice(0, totalChars)
}

/** Six CJK-heavy work turns (user / assistant / tool call / tool result each). */
function buildCjkSession(): Session {
  const session = Session.create('cjk-count-tokens')
  const sizes = { u: 600, a: 900, c: 300, r: 1500 }
  for (let turn = 1; turn <= 6; turn += 1) {
    appendTurn(session, turn)
    appendUser(session, cjkText(`u${turn}`, sizes.u))
    appendAssistant(session, cjkText(`a${turn}`, sizes.a), turn, 1)
    appendToolCall(session, cjkText(`c${turn}`, sizes.c), `call_${turn}`, turn, 2)
    appendToolResult(session, cjkText(`r${turn}`, sizes.r), `call_${turn}`, turn, 3)
  }
  return session
}

interface NudgeProbe {
  readonly rangeTokens: number[]
  readonly total: number
  readonly shouldInject: boolean
  readonly tier: number | null
  readonly reason: string
  readonly minPressureBenefit: number
  readonly pendingT1: number
}

/**
 * Run one kernel over the CJK fixture exactly the way the engine feeds it.
 * `tokenCount` is an independent processTurn input (in production the host
 * meter reports the WHOLE session, not just the log slice being fed); 100000
 * puts usage at 78% of the 128K window — over the shipped 0.70 OVER-LIMIT
 * line and under the 0.85 emergency line — so the pressure path, where the
 * min-benefit gate lives, is actually exercised.
 */
function probeWith(ports: Record<string, unknown>, label: string): NudgeProbe {
  const kernel = createCore(ports)
  const turn = kernel.processTurn({
    messages: allLogMessages(buildCjkSession()),
    state: createInitialState(),
    // The engine's shipped defaults: 128K window plus the 0.70/0.85 nudge
    // thresholds DEFAULT_CONFIG carries when nothing is configured (src/index.ts).
    config: kernelConfigFor({ modelContextLimit: 128000, nudgeMaxContextLimitPct: 0.7, nudgeEmergencyThresholdPct: 0.85 }),
    tokenCount: 100000,
  })
  const nudge = turn.nudge
  assert.ok(nudge, `${label}: the pipeline always produces a nudge decision`)
  const ranges = nudge.compressibleRanges
  return {
    rangeTokens: ranges.map((range) => range.tokens),
    total: ranges.reduce((sum, range) => sum + range.tokens, 0),
    shouldInject: nudge.shouldInject,
    tier: nudge.tier,
    reason: nudge.reason,
    minPressureBenefit: nudge.breakdown.minPressureBenefit,
    pendingT1: nudge.breakdown.pendingT1,
  }
}

test('an unconfigured engine core prices CJK content with the CJK-aware counter, not flat chars/4', () => {
  // `createCore({})` is exactly what src/index.ts builds when `config.countTokens`
  // is unset. Its range pricing must be byte-for-byte the CJK-aware counter's,
  // and clearly apart from flat chars/4 — both the counter identity and the
  // fixture's discriminating power pinned at once.
  const emptyPorts = probeWith({}, 'empty ports')
  const explicit = probeWith({ countTokens: defaultCountTokens }, 'explicit defaultCountTokens')
  const flatFour = probeWith({ countTokens: (text: string) => Math.ceil(text.length / 4) }, 'flat chars/4')

  assert.ok(emptyPorts.rangeTokens.length > 0, 'the fixture offers compressible ranges')
  assert.ok(emptyPorts.total > 0, 'the offered ranges carry tokens')
  assert.deepEqual(
    emptyPorts.rangeTokens,
    explicit.rangeTokens,
    'the empty-port core must price every compressible range identically to an explicit defaultCountTokens core',
  )
  assert.notDeepEqual(
    flatFour.rangeTokens,
    emptyPorts.rangeTokens,
    'flat chars/4 pricing must diverge from the built-in default on this CJK fixture',
  )
  assert.ok(
    emptyPorts.total >= 2 * flatFour.total,
    `the fixture must discriminate strongly between the counters (CJK-aware ${emptyPorts.total} vs flat ${flatFour.total})`,
  )
})

test('the CJK fixture clears the kernel min-benefit gate under shipped defaults; flat chars/4 gets no nudge', () => {
  // The user-visible consequence of the counter choice: at 78% usage the
  // pressure path arms the OVER-LIMIT nudge only when the pending compressible
  // tokens clear minPressureBenefit (max(5000, 1% of window)). The CJK-aware
  // counter clears it with margin (measured ≈2.5× on this fixture); flat
  // chars/4 underprices the same content below the floor and the nudge is
  // suppressed — a CJK-heavy session would go un-nudged.
  const cjk = probeWith({}, 'CJK-aware')
  assert.equal(cjk.shouldInject, true, `expected an OVER-LIMIT T1 nudge, got: ${cjk.reason}`)
  assert.equal(cjk.tier, 1, 'the pressure nudge targets tier-1 compression')
  assert.match(cjk.reason, /OVER-LIMIT/, 'the nudge fires through the over-limit pressure path')
  assert.ok(
    cjk.pendingT1 >= 2 * cjk.minPressureBenefit,
    `pending T1 (${cjk.pendingT1}) must clear the min-benefit floor (${cjk.minPressureBenefit}) with margin`,
  )

  const flatFour = probeWith({ countTokens: (text: string) => Math.ceil(text.length / 4) }, 'flat chars/4')
  assert.equal(flatFour.shouldInject, false, 'flat chars/4 pricing must receive no nudge on this fixture')
  assert.match(
    flatFour.reason,
    /min benefit/,
    `suppression must come from the min-benefit gate itself, got: ${flatFour.reason}`,
  )
})
