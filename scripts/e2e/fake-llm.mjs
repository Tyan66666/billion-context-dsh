import { createServer } from 'node:http'
const state = { turns: [], index: 0, seqs: {}, requests: [] }
const sseEvent = (payload) => {
  return 'data: ' + JSON.stringify(payload) + '\n\n'
}
const startFakeLlm = async (options) => {
  state.turns = options.turns
  state.seqs = options.seqs
  state.index = 0
  state.requests = []
  const server = await createServer(handler)
  await listen(server, options.port ?? 0)
  return {
    port: server.address().port,
    baseURL: `http://127.0.0.1:${server.address().port}`,
    requests: state.requests,
    close: async () => {
    const done = new Promise((resolve) => { server.close(() => resolve()) })
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    await done
  }
}
}
const listen = async (server, port) => {
  const p = new Promise((resolve) => {
    server.listen(port, () => resolve())
  })
  return await p
}
const handler = (req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('error', () => {})
  req.on('end', () => {
  const body = Buffer.concat(chunks).toString('utf8')
  const parsed = JSON.parse(body)
  const turn = state.turns[state.index++]
  if (!turn) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'fake script exhausted', type: 'MOCK_EXHAUSTED', code: 'exhausted' } }))
    state.requests.push({ type: 'error', path: req.url })
    return
  }
  if (turn.kind === 'text') {
    openSse(res)
    writeSse(res, { choices: [{ index: 0, delta: { content: turn.text }, finish_reason: null }] })
    const usage = { prompt_tokens: Math.ceil(JSON.stringify(parsed.messages ?? []).length / 4) + Math.ceil(JSON.stringify(parsed.tools ?? []).length / 4), completion_tokens: Math.max(1, Math.ceil(Array.from(turn.text).length / 4)) }
  writeSse(res, { choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }], usage })
    writeDone(res)
    res.end()
    state.requests.push({ kind: 'text', body: JSON.parse(body) })
    return
  }
  if (turn.kind === 'tool') {
  const args = render(turn.argsTemplate, state.seqs)
  const callId = 'mock-call-' + state.index
  openSse(res)
  writeSse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: turn.name, arguments: args.slice(0, Math.max(1, Math.floor(args.length / 2))) } }] }, finish_reason: null }] })
  writeSse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(Math.max(1, Math.floor(args.length / 2))) } }] }, finish_reason: null }] })
  writeSse(res, { choices: [{ index: 0, delta: { content: '' }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: Math.ceil(JSON.stringify(parsed.messages ?? []).length / 4) + Math.ceil(JSON.stringify(parsed.tools ?? []).length / 4), completion_tokens: 2 } })
  writeDone(res)
  res.end()
  state.requests.push({ kind: 'tool', name: turn.name, body: JSON.parse(body) })
}
})
}
const openSse = (res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  res.flushHeaders()
}
const writeSse = (res, payload) => {
  res.write(sseEvent(payload))
}
const writeDone = (res) => {
  res.write('data: [DONE]\n\n')
}
// Unknown placeholders throw instead of degrading to a literal: a scenario
// typo ({{U9}}) must fail the suite on the spot, not surface later as a
// confusing "startSeq: MISSING" deep in the engine's error chain.
const render = (template, seqs) => {
  const found = template.replace(/\{\{(\w+)\}\}/g, (m, k) => {
  if (!(k in seqs)) throw new Error(`unknown seq placeholder {{"${k}"}} — recorded seqs: ${Object.keys(seqs).join(', ') || '(none)'}`)
  return String(seqs[k])
})
return found
}
export { startFakeLlm }
