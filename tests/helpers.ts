/**
 * Test helpers — build detached sessions with realistic message logs.
 * Uses the public `Session.create` API (no DSH runtime needed).
 */

import { Session } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

/** One message template: long enough to pass acp-kernel's 5000-char threshold. */
const LONG = 'Authentication uses JWT access tokens with 15 minute expiry and refresh tokens stored in Redis with 30 day TTL, implemented in src/auth/login.ts with sliding-window rate limiting at 10 requests per minute. '.repeat(20)

export function longText(label: string, seed: number): string {
  return `${LONG} [${label} ${seed}]`
}

export function appendTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
}

export function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

export function appendAssistant(session: Session, text: string, turn = 1, step = 1): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      provider: 'test-provider',
      model: 'test-model',
    }),
  }, { surfaceOp: 'append' })
}

export function appendToolCall(session: Session, text: string, callId: string, turn = 1, step = 1): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({
      content: [
        { type: 'text', text },
        { type: 'tool-call', id: callId, name: 'bash', arguments: '{"command":"ls"}' },
      ],
      provider: 'test-provider',
      model: 'test-model',
    }),
  }, { surfaceOp: 'append' })
}

export function appendToolResult(session: Session, text: string, callId: string, turn = 1, step = 1): void {
  session.append('tool/result', {
    turn,
    step,
    message: {
      id: `res-${callId}`,
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
      source: { kind: 'tool', callId },
    },
  }, { surfaceOp: 'append' })
}

/**
 * An assistant message carrying MULTIPLE tool-call blocks in one content list —
 * the real DSH shape whose projection yields `${seq}#${callId}` CoreMessage
 * ids (no bare `${seq}` ref, so it can never be a compress range edge).
 */
export function appendMultiToolCall(session: Session, text: string, callIds: readonly string[], turn = 1, step = 1): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({
      content: [
        { type: 'text', text },
        ...callIds.map((id) => ({ type: 'tool-call', id, name: 'bash', arguments: '{"command":"ls"}' })),
      ],
      provider: 'test-provider',
      model: 'test-model',
    }),
  }, { surfaceOp: 'append' })
}

/** A session with `count` alternating user/assistant text messages inside one open turn. */
export function buildTextSession(count: number): Session {
  const session = Session.create('test-session')
  appendTurn(session, 1)
  for (let index = 0; index < count; index += 1) {
    if (index % 2 === 0) appendUser(session, longText('msg', index))
    else appendAssistant(session, longText('reply', index), 1, index)
  }
  return session
}

/**
 * A session with `pairs` tool call/result pairs inside one open turn — a
 * tool-heavy session for the delay-guard tests (conversation nodes never
 * count toward `maxDelayToolTokens`, so a pure-text session like
 * `buildTextSession` can never trip it).
 */
export function buildToolSession(pairs: number): Session {
  const session = Session.create('test-tool-session')
  appendTurn(session, 1)
  for (let index = 0; index < pairs; index += 1) {
    appendToolCall(session, longText('call', index), `call-${index}`)
    appendToolResult(session, longText('res', index), `call-${index}`)
  }
  return session
}
