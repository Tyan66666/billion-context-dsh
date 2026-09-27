import { createServer } from 'node:http'
// Scripted DeepSeek Messages-compatible SSE server (FIFO turns).
//
// The 0.1.7 dsh-llm-deepseek adapter speaks the native Messages protocol
// (issue #174 seam migration): every SSE frame is a typed event
// (message_start / content_block_start / content_block_delta /
// content_block_stop / message_delta / message_stop) whose payload carries a
// `type` field matching the frame name. The pre-0.1.7 OpenAI chat-completions
// shape (`choices[].delta`) is rejected with MALFORMED_RESPONSE
// ("DeepSeek Messages SSE event type mismatch"), so this server emits the
// Messages vocabulary directly.
const state = { turns: [], index: 0, seqs: {}, requests: [] }
const sseFrame = (res, payload) => {
  res.write('data: ' + JSON.stringify(payload) + '\n\n')
}
const openSse = (res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  res.flushHeaders()
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
// Honest usage anchored to the exact request bytes the host sent (rule 12:
// the nudge projection anchors on reported input tokens).
const usageOf = (parsed) => {
  const chars = JSON.stringify(parsed.messages ?? []).length + JSON.stringify(parsed.tools ?? []).length
  return { input_tokens: Math.ceil(chars / 4), output_tokens: 2 }
}
const sendTextTurn = (res, parsed, text) => {
  openSse(res)
  sseFrame(res, { type: 'message_start', message: { id: 'msg-mock', model: parsed.model ?? 'deepseek-v4-flash', usage: usageOf(parsed) } })
  sseFrame(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  sseFrame(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
  sseFrame(res, { type: 'content_block_stop', index: 0 })
  sseFrame(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' } })
  sseFrame(res, { type: 'message_stop' })
  res.end()
}
const sendToolTurn = (res, parsed, name, args) => {
  const callId = 'mock-call-' + state.index
  openSse(res)
  sseFrame(res, { type: 'message_start', message: { id: 'msg-mock', model: parsed.model ?? 'deepseek-v4-flash', usage: usageOf(parsed) } })
  sseFrame(res, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: callId, name, input: {} } })
  // Split the arguments across two deltas so streaming argument accumulation
  // stays exercised (same intent as the old OpenAI-shape two-chunk split).
  const half = Math.max(1, Math.floor(args.length / 2))
  sseFrame(res, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args.slice(0, half) } })
  sseFrame(res, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args.slice(half) } })
  sseFrame(res, { type: 'content_block_stop', index: 0 })
  sseFrame(res, { type: 'message_delta', delta: { stop_reason: 'tool_use' } })
  sseFrame(res, { type: 'message_stop' })
  res.end()
  state.requests.push({ kind: 'tool', name, raw: parsed._raw, body: parsed })
}
const handler = (req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('error', () => {})
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8')
    const parsed = JSON.parse(rawBody)
    parsed._raw = rawBody
    const turn = state.turns[state.index++]
    if (!turn) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'fake script exhausted', type: 'MOCK_EXHAUSTED', code: 'exhausted' } }))
      state.requests.push({ type: 'error', path: req.url })
      return
    }
    if (turn.kind === 'text') {
      sendTextTurn(res, parsed, turn.text)
      state.requests.push({ kind: 'text', raw: rawBody, body: parsed })
    } else if (turn.kind === 'tool') {
      const args = render(turn.argsTemplate, state.seqs)
      sendToolTurn(res, parsed, turn.name, args)
    } else {
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
      state.requests.push({ kind: 'error', status: turn.status ?? 400, raw: rawBody, body: parsed })
    }
  })
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
