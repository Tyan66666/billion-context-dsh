import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session } from '@deepseek-ai/dsh-session'
import AcpCompactionEngine from '../src/index.ts'
import { DEFAULT_CONTEXT_WINDOW, detectContextWindow } from '../src/window.ts'

interface FakeLlm {
  resolveModelInfo: (provider: string, model: string) => Promise<{ context?: { contextWindow?: number } }>
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
