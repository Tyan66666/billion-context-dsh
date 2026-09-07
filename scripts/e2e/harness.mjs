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
  if (entry.kind === 'tool') return entry
  if (entry.kind === 'text') return { ...entry, text: expandText(entry) }
  return typeof entry === 'string' ? entry : expandText(entry)
})
const waitForIdle = async (ctx, agent) => {
  const p = new Promise((resolve) => {
    ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') resolve()
  })
  })
  return await p
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
const runScenario = async (scenario) => {
  const seqs = {}
  const server = await startFakeLlm({ port: 0, turns: expand(scenario.responses), seqs })
  process.env.DEEPSEEK_BASE_URL = `${server.baseURL}/v1`
  process.env.DEEPSEEK_API_KEY = 'mock-key'
  const { Context } = await import('@deepseek-ai/cordis')
  const { SessionId } = await import('@deepseek-ai/dsh-session')
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const AgentLoop = (await import('@deepseek-ai/dsh-agent-loop')).default
  const SessionProjectionRegistry = (await import('@deepseek-ai/dsh-session-projection')).default
  const { mountAgentLoopTestDependencies } = await import('@deepseek-ai/dsh-agent-loop-testkit')
  const LlmDeepSeek = await import('@deepseek-ai/dsh-llm-deepseek')
  const TokenMeter = (await import('@deepseek-ai/dsh-token-meter')).default
  const AcpEngine = (await import(String(ENGINE))).default
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: scenario.persona } })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmDeepSeek, { models: [{ id: 'deepseek-v4-flash', contextWindow: scenario.engine.modelContextLimit }] })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AcpEngine, { ...scenario.engine })
  const agent = await ctx.agentLoop.create(SessionId(scenario.name), {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash'
  })
  for (const turn of expand(scenario.userTurns)) {
  await agent.followup(createUserMessage({
    content: [{ type: 'text', text: turn }],
    source: { kind: 'user' }
  }))
  await waitForIdle(ctx, agent)
  await new Promise((resolve) => { setTimeout(resolve, 100) })
  updateSeqs(agent.session.events, seqs)
  }
  const events = agent.session.events
  const requests = server.requests
  await ctx.fiber.dispose()
  return { events, requests, seqs: { ...seqs } }
}
export { runScenario }
