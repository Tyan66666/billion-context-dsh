import { createServer } from 'node:http'
// Scripted LLM speaking the DeepSeek Messages (Anthropic-style) SSE wire
// format that dsh-llm-deepseek >= 0.2.0 parses (parseSse + translate):
// message_start -> content_block_{start,delta,stop}* -> message_delta ->
// message_stop, each frame carrying both an `event:` name and a matching
// `type` field in the data JSON (the adapter rejects mismatches). The
// 0.1.5 line spoke OpenAI `choices` deltas; the port moved here when the
// e2e baseline moved to 0.2.0 (issue #192).
const state = { turns: [], index: 0, seqs: {}, requests: [] }
const sseEvent = (name, payload) => {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
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
// Usage is derived from the request size so rule 12's projection anchor
// (honest usage on every turn) keeps scaling with what the engine sent.
const promptTokensOf = (parsed) => Math.ceil(JSON.stringify(parsed.messages ?? []).length / 4) + Math.ceil(JSON.stringify(parsed.system ?? '').length / 4) + Math.ceil(JSON.stringify(parsed.tools ?? []).length / 4)
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
  const msgId = 'msg_mock_' + state.index
  if (turn.kind === 'text') {
    openSse(res)
    writeSse(res, 'message_start', { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model: parsed.model ?? 'deepseek-v4-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: promptTokensOf(parsed) } } })
    writeSse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: turn.text } })
    writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
    writeSse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: Math.max(1, Math.ceil(Array.from(turn.text).length / 4)) } })
    writeSse(res, 'message_stop', { type: 'message_stop' })
    res.end()
    state.requests.push({ kind: 'text', raw: body, body: parsed })
    return
  }
  if (turn.kind === 'tool') {
  // Args are split across two input_json_delta frames, as before: the
  // scenarios exercise incremental argument accumulation in the adapter.
  const args = render(turn.argsTemplate, state.seqs)
  const callId = 'mock-call-' + state.index
  openSse(res)
  writeSse(res, 'message_start', { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model: parsed.model ?? 'deepseek-v4-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: promptTokensOf(parsed) } } })
  writeSse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: callId, name: turn.name, input: {} } })
  writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args.slice(0, Math.max(1, Math.floor(args.length / 2))) } })
  writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args.slice(Math.max(1, Math.floor(args.length / 2))) } })
  writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
  writeSse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } })
  writeSse(res, 'message_stop', { type: 'message_stop' })
  res.end()
  state.requests.push({ kind: 'tool', name: turn.name, raw: body, body: parsed })
  return
  }
  if (turn.kind === 'error') {
  // A scripted provider failure: HTTP 400 with DeepSeek's context-length
  // overflow wording, which dsh-llm-deepseek normalizes to the
  // CONTEXT_WINDOW_EXCEEDED code the engine's agent/request-error listener
  // recovers from.
  res.writeHead(turn.status ?? 400, { 'content-type': 'application/json' })
  res.end(JSON.stringify(turn.body ?? {
    error: {
      message: "This model's maximum context length is 2000 tokens. However, you requested more tokens in the input. Please reduce the length of the messages.",
      type: 'invalid_request_error',
      code: 'invalid_request_error'
    }
  }))
  state.requests.push({ kind: 'error', status: turn.status ?? 400, raw: body, body: parsed })
  return
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
const writeSse = (res, name, payload) => {
  res.write(sseEvent(name, payload))
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
