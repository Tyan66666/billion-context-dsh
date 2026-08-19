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
          // REAL DSH tool-result shape (hard-won rule 10): NO
          // message.toolName / message.toolCallId — identity lives in the
          // nested 'tool-result' block's toolCallId and message.source.callId;
          // the tool name is backfilled from the assistant tool-call index.
          id: 'res-call_1',
          role: 'user',
          content: [{
            type: 'tool-result',
            toolCallId: 'call_1',
            content: [{ type: 'text', text: 'tool output' }],
          }],
          source: { kind: 'tool', callId: 'call_1' },
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
  assert.equal(msgs[3]!.toolCallId, 'call_1', 'toolCallId backfilled from the result event identity')
  assert.equal(msgs[3]!.toolName, 'bash', 'toolName backfilled from the assistant tool-call index')
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

test('M1: tool/result with no call identity stays untagged — never falls into the text bucket', () => {
  // Regression (P3-8): a tool-result whose message carries neither a nested
  // 'tool-result' toolCallId nor a source.callId must project with
  // toolName '' (the kernel then shows it under the empty-named bucket), NOT
  // undefined — `toolName ?? "text"` in the kernel would mislabel it as text.
  const msgs = eventsToCoreMessages([
    { type: 'tool/result', seq: 0, data: { turn: 1, step: 1, message: { id: 'res', role: 'user', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'orphan output' }] }] } } },
  ] as never)
  const result = msgs.find((m) => m.contentType === 'tool-result')
  assert.ok(result, 'the text projects even without a call identity')
  assert.equal(result.toolName, '', 'no key → empty tool name (not "text")')
  assert.equal(result.toolCallId, '', 'no key → empty toolCallId')
})

test('M1: tool/result preceding its assistant tool-call still resolves the name (index pre-scan)', () => {
  // The index scans ALL events up front, so log order is irrelevant (P3-9).
  const msgs = eventsToCoreMessages([
    {
      type: 'tool/result', seq: 0, data: {
        turn: 1, step: 1,
        message: { id: 'res', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_y', content: [{ type: 'text', text: 'early output' }] }], source: { kind: 'tool', callId: 'call_y' } },
      },
    },
    {
      type: 'assistant/message', seq: 1, data: {
        turn: 1, step: 1,
        message: { content: [{ type: 'text', text: 'calling' }, { type: 'tool-call', id: 'call_y', name: 'bash', arguments: '{}' }] },
      },
    },
  ] as never)
  const result = msgs.find((m) => m.contentType === 'tool-result')
  assert.ok(result)
  assert.equal(result.toolName, 'bash', 'out-of-order result still attributed via the pre-scanned index')
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
