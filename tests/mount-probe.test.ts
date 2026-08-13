import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AcpCompactionEngine, { AcpCompactionEngine as Named } from '../src/index.ts'
import { eventsToCoreMessages, projectEvent } from '../src/messages.ts'

test('M0: AcpCompactionEngine mounts on a bare Cordis context', async () => {
  const ctx = new Context()
  ctx.plugin(AcpCompactionEngine as never)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const engine = ctx.compaction as Named
  assert.ok(engine instanceof Named, 'ctx.compaction resolves to the engine')
  assert.ok(engine.kernel, 'acp-kernel core is alive inside the engine')
  const result = await engine.compactIfNeeded(
    { session: undefined as never, options: {} },
    'pressure',
    new AbortController().signal,
  )
  assert.equal(result, null, 'skeleton never auto-compacts (pure model-driven)')
})

test('M1: DSH surface events project to acp-kernel CoreMessage', () => {
  const events = [
    {
      type: 'user/message',
      seq: 0,
      data: { content: [{ type: 'text', text: 'hello' }] },
    },
    {
      type: 'assistant/message',
      seq: 1,
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: 'plain assistant reply' }] },
      },
    },
    {
      type: 'assistant/message',
      seq: 2,
      data: {
        turn: 1,
        step: 2,
        message: {
          content: [
            { type: 'text', text: 'calling bash' },
            { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' },
          ],
        },
      },
    },
    {
      type: 'tool/result',
      seq: 3,
      data: {
        turn: 1,
        step: 2,
        message: {
          content: [{ type: 'text', text: 'tool output' }],
          toolName: 'bash',
          toolCallId: 'call_1',
        },
      },
    },
  ] as never[]

  const msgs = eventsToCoreMessages(events as never)
  assert.equal(msgs.length, 4)
  assert.deepEqual(
    { role: msgs[0]!.role, contentType: msgs[0]!.contentType, text: msgs[0]!.text },
    { role: 'user', contentType: 'text', text: 'hello' },
  )
  assert.equal(msgs[2]!.contentType, 'tool-call')
  assert.equal(msgs[2]!.toolName, 'bash')
  assert.ok(msgs[2]!.text!.includes('ls'), 'tool-call arguments ride the text body')
  assert.equal(msgs[3]!.contentType, 'tool-result')
  assert.equal(msgs[3]!.toolCallId, 'call_1')
  assert.equal(msgs[3]!.role, 'tool')
})

test('M1: non-surface events project to nothing', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'assistant/chunk', seq: 1, data: { turn: 1, step: 1, chunk: { type: 'text', text: 'x' } } },
  ] as never[]
  const projected = events.map((event) => projectEvent(event as never))
  assert.deepEqual(projected, [[], []])
})
