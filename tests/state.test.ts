/**
 * M2 — kernel-state rehydration tests: a restarted engine must rebuild the
 * acp-kernel CompressionState from the durable log (tier, kernel block ids,
 * and — the BLOCKER fix — the ORIGINAL message coverage of distilled blocks),
 * and rehydrated blocks must stay anchorable for further distillation.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createCore, type CompressionCore } from 'acp-kernel'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AcpStateStore } from '../src/state.ts'
import { makeTools, type ToolEnvironment } from '../src/tools.ts'
import { rebuildBlockLedger } from '../src/region.ts'
import { buildTextSession } from './helpers.ts'

function makeEnv(limit = 128000): ToolEnvironment {
  return {
    kernel: createCore({}) as CompressionCore,
    store: new AcpStateStore(),
    modelContextLimit: limit,
  }
}

function fakeExec(session: import('@deepseek-ai/dsh-session').Session, overrides: Partial<ToolRunContext> = {}): ToolRunContext {
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
    ...overrides,
  } as unknown as ToolRunContext
}

function toolOf(env: ToolEnvironment, name: string) {
  const tool = makeTools(env).find((definition) => definition.name === name)
  assert.ok(tool, `tool ${name} registered`)
  return tool
}

const TIER_SUMMARY = 'Tiered distillation test summary covering the authentication subsystem, the refresh-token lifecycle, the login flow, the rate-limiting strategy, the bcrypt cost factor, the session revocation rules, the deployment pipeline, the kubernetes canary rollout, and the health-check probe configuration with all critical file paths and decisions preserved verbatim for later recovery. '.repeat(50)

test('M2: kernel blocks rehydrate from the log with tier and original coverage', async () => {
  const env = makeEnv()
  const session = buildTextSession(12)
  const compress = toolOf(env, 'compress')
  await compress.execute({ content: [{ startSeq: 1, endSeq: 5, summary: TIER_SUMMARY }] } as never, fakeExec(session))
  const summarySeq = rebuildBlockLedger(session.events)[0]!.summarySeq!
  await compress.execute({ content: [{ startSeq: summarySeq, endSeq: summarySeq, summary: TIER_SUMMARY }] } as never, fakeExec(session))

  // A FRESH store (restarted engine) rebuilds the kernel state from the log.
  const fresh = new AcpStateStore()
  const state = fresh.stateFor(session)
  assert.equal(state.blocks.length, 2)
  const b1 = state.blocks.find((block) => block.blockId === 'b1')
  const b2 = state.blocks.find((block) => block.blockId === 'b2')
  assert.ok(b1 !== undefined && b2 !== undefined, 'synthesised/recorded kernel block ids survive')
  assert.equal(b1.tier, 1)
  assert.equal(b2.tier, 2)
  assert.ok(b2.effectiveMessageIds.includes('1'), 'rehydrated tier-2 coverage is the parents ORIGINALS, not the checkpoint node')
  assert.ok(b2.directBlockIds.includes('b1'), 'the distilled parent kernel ref is rehydrated')
  assert.equal(b1.active, false, 'the distilled parent is inactive')
  assert.equal(b2.active, true)
  assert.equal(state.nextBlockId, 3, 'next kernel block id continues after the rehydrated max')
})

test('M2: rehydrated blocks stay anchorable — tier 3 works after a restart', async () => {
  const env = makeEnv()
  const session = buildTextSession(12)
  const compress = toolOf(env, 'compress')
  await compress.execute({ content: [{ startSeq: 1, endSeq: 5, summary: TIER_SUMMARY }] } as never, fakeExec(session))
  const summarySeq = rebuildBlockLedger(session.events)[0]!.summarySeq!
  await compress.execute({ content: [{ startSeq: summarySeq, endSeq: summarySeq, summary: TIER_SUMMARY }] } as never, fakeExec(session))
  const ledger2 = rebuildBlockLedger(session.events)
  const tier2Seq = ledger2[1]!.summarySeq!
  assert.equal(ledger2[1]!.tier, 2)

  // "Restart": a brand-new store AND kernel (a fresh engine process) serve the
  // same durable session log; the tier-2 checkpoint must still anchor.
  const restarted = makeEnv()
  const result = await toolOf(restarted, 'compress').execute({
    content: [{ startSeq: tier2Seq, endSeq: tier2Seq, summary: TIER_SUMMARY }],
  } as never, fakeExec(session))
  assert.match((result as { text: string }).text, /tier 3/, 'the rehydrated tier-2 block anchors after a restart')

  const after = rebuildBlockLedger(session.events)
  assert.equal(after.length, 3)
  assert.equal(after[2]!.tier, 3)
  assert.deepEqual(after[2]!.parentBlockIds, [ledger2[1]!.blockId])
  assert.equal(after[2]!.kernelBlockId, 'b3', 'the post-restart kernel block id is recorded too')
})
