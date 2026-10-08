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
  // Wire dialect of the SUCCESS path. The DSH ≥0.2.0 DeepSeek adapter speaks
  // Anthropic Messages SSE (message_start/content_block_*/message_stop); the
  // 0.1.5-line plugin spoke OpenAI chat-completions chunks. Error responses
  // are envelope JSON in BOTH dialects, so only success framing branches.
  state.dialect = options.dialect === 'anthropic' ? 'anthropic' : 'openai'
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
    const inputTokens = inputTokensOf(parsed)
    const outputTokens = textOutputTokensOf(turn.text)
    if (state.dialect === 'anthropic') {
      // Anthropic Messages framing — the DSH ≥0.2.0 adapter's translate()
      // requires message_start → block start/delta/stop → message_delta →
      // message_stop, with usage split across the two boundary events.
      writeSse(res, { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model: 'deepseek-v4-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } })
      writeSse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      writeSse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: turn.text } })
      writeSse(res, { type: 'content_block_stop', index: 0 })
      writeSse(res, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens } })
      writeSse(res, { type: 'message_stop' })
    } else {
      writeSse(res, { choices: [{ index: 0, delta: { content: turn.text }, finish_reason: null }] })
      writeSse(res, { choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens } })
      writeDone(res)
    }
    res.end()
    state.requests.push({ kind: 'text', raw: body, body: parsed })
    return
  }
  if (turn.kind === 'tool') {
    const args = render(turn.argsTemplate, state.seqs)
    const callId = 'mock-call-' + state.index
    const half = Math.max(1, Math.floor(args.length / 2))
    openSse(res)
    if (state.dialect === 'anthropic') {
      // tool_use block: id/name ride content_block_start; the arguments JSON
      // streams as two input_json_delta fragments, mirroring the OpenAI path's
      // chunking so partial-JSON accumulation stays exercised.
      writeSse(res, { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model: 'deepseek-v4-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokensOf(parsed), output_tokens: 0 } } })
      writeSse(res, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: callId, name: turn.name, input: {} } })
      writeSse(res, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args.slice(0, half) } })
      writeSse(res, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args.slice(half) } })
      writeSse(res, { type: 'content_block_stop', index: 0 })
      writeSse(res, { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } })
      writeSse(res, { type: 'message_stop' })
    } else {
      writeSse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: turn.name, arguments: args.slice(0, half) } }] }, finish_reason: null }] })
      writeSse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] }, finish_reason: null }] })
      writeSse(res, { choices: [{ index: 0, delta: { content: '' }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: inputTokensOf(parsed), completion_tokens: 2 } })
      writeDone(res)
    }
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
const writeSse = (res, payload) => {
  res.write(sseEvent(payload))
}
const writeDone = (res) => {
  res.write('data: [DONE]\n\n')
}
// Honest usage numbers shared by BOTH dialects (rule 12's projection anchor):
// the same char/4 heuristic the host meter uses, computed from the request
// body so wire-level assertions stay meaningful.
const inputTokensOf = (parsed) => Math.ceil(JSON.stringify(parsed.messages ?? []).length / 4) + Math.ceil(JSON.stringify(parsed.tools ?? []).length / 4)
const textOutputTokensOf = (text) => Math.max(1, Math.ceil(Array.from(text).length / 4))
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
