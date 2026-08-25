/**
 * Regression tests: `coreOverrides.nudge` must survive the engine's own pct
 * defaults AND land last in the merge order. The engine always ships
 * `nudgeMaxContextLimitPct` / `nudgeEmergencyThresholdPct` (0.70/0.85, see
 * DEFAULT_CONFIG in src/index.ts), so the pct patch is never empty — a plain
 * replace of `overrides.nudge` discarded every user growth knob
 * (growthFloor/growthCap/minGrowthFloor/…), making the documented coreOverrides
 * escape hatch dead on arrival.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { defaultConfig } from 'acp-kernel'

import { kernelConfigFor } from '../src/config.ts'

test('coreOverrides.nudge wins over engine pct defaults and kernel base', () => {
  const config = kernelConfigFor({
    modelContextLimit: 1000000,
    nudgeMaxContextLimitPct: 0.7,
    nudgeEmergencyThresholdPct: 0.85,
    coreOverrides: {
      nudge: { growthFloor: 300000, growthCap: 300000, minGrowthFloor: 150000 },
    },
  })
  assert.equal(config.nudge.growthFloor, 300000)
  assert.equal(config.nudge.growthCap, 300000)
  assert.equal(config.nudge.minGrowthFloor, 150000)
  // pct knobs still land (engine defaults pass through untouched).
  assert.equal(config.nudge.maxContextLimitPct, 0.7)
  assert.equal(config.nudge.emergencyThresholdPct, 0.85)
})

test('same-key conflict: coreOverrides.nudge wins over explicit top-level pct knobs', () => {
  // Pins the load-bearing merge order ("user overrides land LAST"). The two
  // tests above keep pct keys and growth keys disjoint, so flipping the spread
  // order back to patch-last (the pre-fix bug) would leave them green — this
  // conflict case is what actually fails if that order regresses.
  const config = kernelConfigFor({
    modelContextLimit: 128000,
    nudgeMaxContextLimitPct: 0.6,
    nudgeEmergencyThresholdPct: 0.8,
    coreOverrides: { nudge: { maxContextLimitPct: 0.9, emergencyThresholdPct: 0.95 } },
  })
  assert.equal(config.nudge.maxContextLimitPct, 0.9)
  assert.equal(config.nudge.emergencyThresholdPct, 0.95)
})

test('coreOverrides.nudge alone (no pct knobs) still reaches the kernel', () => {
  // Exercises the `|| input.coreOverrides?.nudge` branch: pct patch empty,
  // user section present. A direct call carries no engine defaults, so the
  // untouched pct keys keep the KERNEL defaults here (0.75/0.95).
  const config = kernelConfigFor({
    modelContextLimit: 128000,
    coreOverrides: { nudge: { growthFloor: 300000 } },
  })
  assert.equal(config.nudge.growthFloor, 300000)
  assert.equal(config.nudge.maxContextLimitPct, 0.75)
  assert.equal(config.nudge.emergencyThresholdPct, 0.95)
})

test('without coreOverrides the pct patch still applies over kernel defaults', () => {
  const config = kernelConfigFor({
    modelContextLimit: 128000,
    nudgeMaxContextLimitPct: 0.7,
    nudgeEmergencyThresholdPct: 0.85,
  })
  assert.equal(config.nudge.maxContextLimitPct, 0.7)
  assert.equal(config.nudge.emergencyThresholdPct, 0.85)
  // Untouched growth knobs keep the kernel defaults — referenced via
  // defaultConfig rather than pinned literals so the merge behavior under test
  // stays decoupled from any one acp-kernel version's constant.
  assert.equal(config.nudge.growthFloor, defaultConfig(128000).nudge.growthFloor)
  assert.equal(config.nudge.growthCap, defaultConfig(128000).nudge.growthCap)
})
