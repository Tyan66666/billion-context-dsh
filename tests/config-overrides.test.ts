/**
 * Regression test: `coreOverrides.nudge` must survive the engine's own pct
 * defaults. The engine always ships `nudgeMaxContextLimitPct` /
 * `nudgeEmergencyThresholdPct` (0.70/0.85, see DEFAULT_CONFIG in src/index.ts),
 * so the pct patch is never empty — a plain replace of `overrides.nudge`
 * discarded every user growth knob (growthFloor/growthCap/minGrowthFloor/…),
 * making the documented coreOverrides escape hatch dead on arrival.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

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

test('without coreOverrides the pct patch still applies over kernel defaults', () => {
  const config = kernelConfigFor({
    modelContextLimit: 128000,
    nudgeMaxContextLimitPct: 0.7,
    nudgeEmergencyThresholdPct: 0.85,
  })
  assert.equal(config.nudge.maxContextLimitPct, 0.7)
  assert.equal(config.nudge.emergencyThresholdPct, 0.85)
  // Untouched growth knobs keep the kernel defaults.
  assert.equal(config.nudge.growthFloor, 50000)
  assert.equal(config.nudge.growthCap, 50000)
})
