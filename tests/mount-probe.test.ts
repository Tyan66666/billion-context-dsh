import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import AcpCompactionEngine, { AcpCompactionEngine as Named } from '../src/index.ts'
import { ACP_SYSTEM_PROMPT } from '../src/system-prompt.ts'
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
          // Real DSH ToolResultBlock: nested content array inside a
          // 'tool-result' block. Regression: extractText must recurse or the
          // result projects to empty text and its seq never gets a ref.
          content: [{
            type: 'tool-result',
            toolCallId: 'call_1',
            content: [{ type: 'text', text: 'tool output' }],
          }],
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
  assert.equal(msgs[3]!.text, 'tool output', 'nested tool-result text must project')
})

test('M1: non-surface events project to nothing', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'assistant/chunk', seq: 1, data: { turn: 1, step: 1, chunk: { type: 'text', text: 'x' } } },
  ] as never[]
  const projected = events.map((event) => projectEvent(event as never))
  assert.deepEqual(projected, [[], []])
})

// Regression: issue #5 — ACP systemPrompt section must not be silently dropped
// on cold start when the engine activates before the systemPrompt service.
// Verifies the `internal/service` retry listener registers the section once
// the service appears later.
test('M4: ACP system prompt section registers when systemPrompt service appears after engine', async () => {
  const ctx = new Context()
  // Mount the engine FIRST — systemPrompt is not yet available, so the retry
  // listener is registered in the else branch.
  ctx.plugin(AcpCompactionEngine as never)
  await new Promise((resolve) => setTimeout(resolve, 20))

  // Confirm engine mounted and systemPrompt is still absent.
  const engine = ctx.compaction as Named
  assert.ok(engine instanceof Named, 'engine mounted before systemPrompt')
  assert.equal(ctx.get('systemPrompt'), undefined, 'systemPrompt not yet available')

  // Now mount the systemPrompt service — this should trigger internal/service
  // and the retry listener should register the ACP section.
  ctx.plugin(SystemPrompt, {})
  await new Promise((resolve) => setTimeout(resolve, 20))

  // Verify the section is registered by assembling the prompt.
  const sp = ctx.get('systemPrompt')
  assert.ok(sp !== undefined, 'systemPrompt is now available')
  const assembly = await sp.assemble()
  assert.ok(assembly.sections.length >= 1, 'at least one section in the assembly')
  const acpSection = assembly.sections.find((s) => s.name === 'billion-context-dsh')
  assert.ok(acpSection !== undefined, 'ACP section "billion-context-dsh" is present in the assembly')
  assert.ok(acpSection!.text.includes('Active Context Pruning'), 'ACP section text is the real guidance prompt')
  assert.ok(acpSection!.text === ACP_SYSTEM_PROMPT, 'ACP section text matches the exported constant')
})
