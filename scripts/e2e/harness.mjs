import { startFakeLlm } from './fake-llm.mjs'
const ENGINE = new URL('../../dist/index.js', import.meta.url)
const filler = (spec) => Array.from({ length: spec.count }, (_, i) =>
  `Note ${i}: the ${spec.topic} section documents behavior ${i * 7} of the durable surface model.`).join(' ')
const expandText = (entry) => {
  if (typeof entry === 'string') return entry
  if (entry.filler) return filler(entry.filler)
  return entry.text
}
const expand = (entries) => entries.map((entry) => {
  if (entry.kind === 'tool' || entry.kind === 'error') return entry
  if (entry.kind === 'text') return { ...entry, text: expandText(entry) }
  return typeof entry === 'string' ? entry : expandText(entry)
})
// Bounded wait: an engine regression that leaves the agent non-idle (or a
// status event that fires before this turn's listener is registered) must
// fail the suite with a clear error, not hang the process — and therefore
// not burn a 6-hour CI timeout. The timer is unref'd so it never keeps the
// event loop alive after a successful turn.
const IDLE_TIMEOUT_MS = 60_000
const waitForIdle = async (ctx, agent) => {
  const idle = new Promise((resolve) => {
    ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') resolve()
  })
  })
  const stall = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`waitForIdle: agent never reached idle within ${IDLE_TIMEOUT_MS}ms — check the fake LLM script and the engine pre-step path`)), IDLE_TIMEOUT_MS)
    t.unref()
  })
  return await Promise.race([idle, stall])
}
const updateSeqs = (events, seqs) => {
  const counts = { users: 0, assistants: 0 }
  for (const event of events) {
  if (event.type === 'user/message') {
  counts.users = counts.users + 1
  if (!seqs['U' + counts.users]) seqs['U' + counts.users] = event.seq
  }
  if (event.type === 'assistant/message') {
  counts.assistants = counts.assistants + 1
  if (!seqs['A' + counts.assistants]) seqs['A' + counts.assistants] = event.seq
  }
  }
}
// The ≥0.2.0 adapter API has no cordis plugin entry point: resolve options
// explicitly (every default is re-judged there), build the adapter directly,
// and register it on the llm runtime the testkit mounts. baseURL is passed
// WITHOUT /v1 — messagesApiRoot appends it. thinking is disabled so no
// thinking block can appear in the wire contract at all.
const mountDirectDeepSeekAdapter = async (ctx, LlmDeepSeek, server, contextWindow) => {
  const connection = LlmDeepSeek.resolveAdapterOptions({
    baseURL: server.baseURL,
    thinking: 'disabled',
    models: [{ id: 'deepseek-v4-flash', contextWindow }]
  })
  const adapter = new LlmDeepSeek.DeepSeekAdapter({
    options: () => connection,
    resolveAuth: async () => ({ headers: { 'x-api-key': 'mock-key' } }),
    resolveUserId: () => 'e2e-harness-user',
    prepareExtensions: () => Promise.resolve({ fields: {}, accept: () => Promise.resolve() })
  })
  await ctx.llm.registerAdapter(['deepseek-official'], adapter)
}
// hooks.afterTurn({ index, ctx, agent }) runs after each turn settles — used
// by ad-hoc debugging scripts (token-meter pressure dumps) without editing scenarios.
const runScenario = async (scenario, hooks = {}) => {
  const seqs = {}
  // The DSH ≥0.2.0 line replaced dsh-llm-deepseek's cordis plugin with an
  // explicit adapter API (DeepSeekAdapter + resolveAdapterOptions); detect
  // which shape is installed so one harness serves both baselines.
  const LlmDeepSeek = await import('@deepseek-ai/dsh-llm-deepseek')
  // BOTH seam lines export resolveAdapterOptions/DeepSeekAdapter, so those
  // are NOT a discriminator — the plugin surface is: the 0.1.5 line ships
  // dsh-llm-deepseek as a cordis plugin (the namespace carries apply()), the
  // ≥0.2.0 line dropped the plugin entry point for the explicit adapter API.
  // The wire dialect follows the adapter generation: OpenAI chat completions
  // behind the legacy plugin, Anthropic Messages behind the direct adapter.
  const legacyPlugin = typeof LlmDeepSeek.apply === 'function'
  const server = await startFakeLlm({ port: 0, turns: expand(scenario.responses), seqs, dialect: legacyPlugin ? 'openai' : 'anthropic' })
  process.env.DEEPSEEK_BASE_URL = `${server.baseURL}/v1`
  process.env.DEEPSEEK_API_KEY = 'mock-key'
  const { Context } = await import('@deepseek-ai/cordis')
  const { SessionId } = await import('@deepseek-ai/dsh-session')
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const AgentLoop = (await import('@deepseek-ai/dsh-agent-loop')).default
  const { mountAgentLoopTestDependencies } = await import('@deepseek-ai/dsh-agent-loop-testkit')
  const TokenMeter = (await import('@deepseek-ai/dsh-token-meter')).default
  const AcpEngine = (await import(String(ENGINE))).default
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: scenario.persona } })
  await ctx.plugin(AgentLoop, { agents: [] })
  if (legacyPlugin) {
    await ctx.plugin(LlmDeepSeek, { models: [{ id: 'deepseek-v4-flash', contextWindow: scenario.engine.modelContextLimit }] })
  } else {
    await mountDirectDeepSeekAdapter(ctx, LlmDeepSeek, server, scenario.engine.modelContextLimit)
  }
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AcpEngine, { ...scenario.engine })
  const agent = await ctx.agentLoop.create(SessionId(scenario.name), {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash'
  })
  for (const [index, turn] of expand(scenario.userTurns).entries()) {
  await agent.followup(createUserMessage({
    content: [{ type: 'text', text: turn }],
    source: { kind: 'user' }
  }))
  await waitForIdle(ctx, agent)
  await new Promise((resolve) => { setTimeout(resolve, 100) })
  updateSeqs(agent.session.snapshotEvents(), seqs)
  if (hooks.afterTurn) await hooks.afterTurn({ index, ctx, agent })
  }
  const events = agent.session.snapshotEvents()
  const requests = server.requests
  await ctx.fiber.dispose()
  await server.close()
  return { events, requests, seqs: { ...seqs } }
}
export { runScenario }
