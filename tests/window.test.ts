import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session } from '@deepseek-ai/dsh-session'
import AcpCompactionEngine from '../src/index.ts'
import { DEFAULT_CONTEXT_WINDOW, detectContextWindow, projectedContextWindow } from '../src/window.ts'

interface FakeLlm {
  resolveModelInfo: (provider: string, model: string) => Promise<{ context?: { contextWindow?: number } }>
}

interface FakeProjections {
  snapshot: (session: unknown) => { values?: { contextPressure?: { contextWindow?: number } } }
}

function fakeAgent(ctx: Context, provider = 'test-provider', model = 'test-model'): Agent {
  return {
    id: 'test-session',
    session: Session.create('test-session'),
    options: { provider, model },
    ctx,
  } as unknown as Agent
}

function llmContext(llm: FakeLlm): Context {
  const ctx = new Context()
  ctx.provide('llm', llm)
  return ctx
}

function projectionContext(projections: FakeProjections): Context {
  const ctx = new Context()
  ctx.provide('sessionProjections', projections)
  return ctx
}

test('window: detectContextWindow probes the model context window from the llm service', async () => {
  const agent = fakeAgent(llmContext({
    resolveModelInfo: async () => ({ context: { contextWindow: 1000000 } }),
  }))
  assert.equal(await detectContextWindow(agent, 'test-provider', 'test-model'), 1000000)
})

test('window: detectContextWindow returns null when the probe throws', async () => {
  const agent = fakeAgent(llmContext({
    resolveModelInfo: async () => { throw new Error('adapter exploded') },
  }))
  assert.equal(await detectContextWindow(agent, 'p', 'm'), null)
})

test('window: detectContextWindow returns null when the context window is not disclosed', async () => {
  const agent = fakeAgent(llmContext({ resolveModelInfo: async () => ({}) }))
  assert.equal(await detectContextWindow(agent, 'p', 'm'), null)
  const agent2 = fakeAgent(llmContext({
    resolveModelInfo: async () => ({ context: {} }),
  }))
  assert.equal(await detectContextWindow(agent2, 'p', 'm'), null)
})

test('window: detectContextWindow rejects non-positive or non-integer windows', async () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const agent = fakeAgent(llmContext({
      resolveModelInfo: async () => ({ context: { contextWindow: bad as number } }),
    }))
    assert.equal(await detectContextWindow(agent, 'p', 'm'), null, `window ${String(bad)} rejected`)
  }
})

test('window: detectContextWindow returns null without an llm service or resolver', async () => {
  const bare = fakeAgent(new Context())
  assert.equal(await detectContextWindow(bare, 'p', 'm'), null)
  const noResolver = fakeAgent(llmContext({ resolveModelInfo: undefined as unknown as FakeLlm['resolveModelInfo'] }))
  assert.equal(await detectContextWindow(noResolver, 'p', 'm'), null)
})

test('window: explicit modelContextLimit wins and never probes', async () => {
  let calls = 0
  const engine = new AcpCompactionEngine(new Context(), { modelContextLimit: 50000 })
  const agent = fakeAgent(llmContext({
    resolveModelInfo: async () => { calls += 1; return { context: { contextWindow: 1000000 } } },
  }))
  const window = await engine.windowFor(agent)
  assert.deepEqual(window, { limit: 50000, source: 'explicit' })
  assert.equal(calls, 0, 'explicit config disables the probe')
})

test('window: projectedContextWindow reads the live window from the session projection', async () => {
  const agent = fakeAgent(projectionContext({
    snapshot: () => ({ values: { contextPressure: { contextWindow: 1000000 } } }),
  }))
  assert.equal(await projectedContextWindow(agent), 1000000)
})

test('window: projectedContextWindow returns null without projection or window', async () => {
  const bare = fakeAgent(new Context())
  assert.equal(await projectedContextWindow(bare), null)
  const noWindow = fakeAgent(projectionContext({
    snapshot: () => ({ values: {} }),
  }))
  assert.equal(await projectedContextWindow(noWindow), null)
  const badWindow = fakeAgent(projectionContext({
    snapshot: () => ({ values: { contextPressure: { contextWindow: 0 } } }),
  }))
  assert.equal(await projectedContextWindow(badWindow), null)
})

test('window: projection wins over the llm probe (stale agent.options after a model switch)', async () => {
  // The session switched models mid-way: agent.options still says the OLD
  // route (hm/Qwen3.8-27B → 96K) while the live projection carries the new
  // route's 1M window. The old code probed agent.options and raised false
  // EMERGENCY nudges at ~300% usage; the projection must win.
  let probeCalls = 0
  const ctx = new Context()
  ctx.provide('sessionProjections', {
    snapshot: () => ({ values: { contextPressure: { contextWindow: 1000000 } } }),
  })
  ctx.provide('llm', {
    resolveModelInfo: async () => { probeCalls += 1; return { context: { contextWindow: 96000 } } },
  })
  const engine = new AcpCompactionEngine(new Context())
  const agent = fakeAgent(ctx, 'hm', 'Qwen3.8-27B')
  const window = await engine.windowFor(agent)
  assert.equal(window.limit, 1000000, 'projection window wins over the stale-route probe')
  assert.equal(window.source, 'projection')
  assert.equal(probeCalls, 0, 'the probe is not even consulted while the projection discloses a window')
})

test('window: projection is not cached — a later model switch is picked up immediately', async () => {
  // The projection refreshes on every request; caching the window in
  // windowCache would freeze the pre-switch value for the process lifetime.
  let projected = 96000
  const engine = new AcpCompactionEngine(new Context())
  const agent = fakeAgent(projectionContext({
    snapshot: () => ({ values: { contextPressure: { contextWindow: projected } } }),
  }))
  await engine.windowFor(agent)
  projected = 1000000 // simulate a live mid-session model switch refreshing the projection
  const window = await engine.windowFor(agent)
  assert.equal(window.limit, 1000000, 'second windowFor reflects the refreshed projection')
  assert.equal(window.source, 'projection')
})

test('window: falls back to the probe chain when the projection discloses no window', async () => {
  const engine = new AcpCompactionEngine(new Context())
  let calls = 0
  const ctx = new Context()
  ctx.provide('sessionProjections', {
    snapshot: () => ({ values: {} }),
  })
  ctx.provide('llm', {
    resolveModelInfo: async () => { calls += 1; return { context: { contextWindow: 64000 } } },
  })
  const agent = fakeAgent(ctx)
  const window = await engine.windowFor(agent)
  assert.equal(window.limit, 64000, 'probe answers when the projection is silent')
  assert.equal(window.source, 'auto')
  assert.equal(calls, 1)
})

test('window: auto detection resolves the real context window', async () => {
  const engine = new AcpCompactionEngine(new Context())
  const agent = fakeAgent(llmContext({
    resolveModelInfo: async () => ({ context: { contextWindow: 1000000 } }),
  }))
  const window = await engine.windowFor(agent)
  assert.equal(window.limit, 1000000)
  assert.equal(window.source, 'auto')
  assert.equal(window.provider, 'test-provider')
  assert.equal(window.model, 'test-model')
})

test('window: auto detection falls back to the default window when the probe fails', async () => {
  const engine = new AcpCompactionEngine(new Context())
  const throwing = fakeAgent(llmContext({
    resolveModelInfo: async () => { throw new Error('no window') },
  }))
  const window = await engine.windowFor(throwing)
  assert.deepEqual(window, {
    limit: DEFAULT_CONTEXT_WINDOW,
    source: 'default',
    provider: 'test-provider',
    model: 'test-model',
    probeFailed: true,
  })
  const undisclosed = fakeAgent(new Context())
  const window2 = await engine.windowFor(undisclosed)
  assert.deepEqual(window2, {
    limit: DEFAULT_CONTEXT_WINDOW,
    source: 'default',
    provider: 'test-provider',
    model: 'test-model',
    probeFailed: true,
  })
})

test('window: probes are cached per provider/model route', async () => {
  let calls = 0
  const engine = new AcpCompactionEngine(new Context())
  const agent = fakeAgent(llmContext({
    resolveModelInfo: async () => { calls += 1; return { context: { contextWindow: 1000000 } } },
  }))
  await engine.windowFor(agent)
  await engine.windowFor(agent)
  assert.equal(calls, 1, 'second windowFor reuses the cache')
  const other = fakeAgent(llmContext({
    resolveModelInfo: async () => { calls += 1; return { context: { contextWindow: 64000 } } },
  }), 'other-provider', 'other-model')
  const window = await engine.windowFor(other)
  assert.equal(calls, 2, 'a different route probes again')
  assert.equal(window.limit, 64000)
})

test('window: autoModelContextLimit false skips the probe', async () => {
  let calls = 0
  const engine = new AcpCompactionEngine(new Context(), { autoModelContextLimit: false })
  const agent = fakeAgent(llmContext({
    resolveModelInfo: async () => { calls += 1; return { context: { contextWindow: 1000000 } } },
  }))
  const window = await engine.windowFor(agent)
  assert.deepEqual(window, {
    limit: DEFAULT_CONTEXT_WINDOW,
    source: 'default',
    provider: 'test-provider',
    model: 'test-model',
  })
  assert.equal(calls, 0, 'no probe when auto detection is disabled')
})

test('window: autoModelContextLimit false skips the projection too (even when it discloses a window)', async () => {
  // The projection sits behind the SAME auto-detection gate as the probe: with
  // autoModelContextLimit disabled the effective window must be the default,
  // never a projection value — otherwise the operator's explicit choice to
  // disable auto-detection would still be overridden by live projections, and
  // removing the gate in windowFor would pass every other test silently.
  let calls = 0
  const ctx = new Context()
  ctx.provide('sessionProjections', {
    snapshot: () => ({ values: { contextPressure: { contextWindow: 1000000 } } }),
  })
  ctx.provide('llm', {
    resolveModelInfo: async () => { calls += 1; return { context: { contextWindow: 1000000 } } },
  })
  const engine = new AcpCompactionEngine(new Context(), { autoModelContextLimit: false })
  const agent = fakeAgent(ctx)
  const window = await engine.windowFor(agent)
  assert.deepEqual(window, {
    limit: DEFAULT_CONTEXT_WINDOW,
    source: 'default',
    provider: 'test-provider',
    model: 'test-model',
  })
  assert.equal(calls, 0, 'the probe is skipped as well')
})
