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
    stream: [],
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
    stream: [],
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
    stream: [],
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
export function buildTextSession(count: number, id: string = 'test-session'): Session {
  const session = Session.create(id)
  appendTurn(session, 1)
  for (let index = 0; index < count; index += 1) {
    if (index % 2 === 0) appendUser(session, longText('msg', index))
    else appendAssistant(session, longText('reply', index), 1, index)
  }
  return session
}

/** Short (~87-char, fixed-length) counterpart to buildTextSession: small enough that several messages fit under one decompress page's char budget, so paging/limit assertions are stable (issue #112). Callers must size the session AND compressed range to clear the kernel's compress gates — see the tools.test.ts decompress-limit test. */
export function buildShortTextSession(count: number): Session {
  const session = Session.create('test-session')
  appendTurn(session, 1)
  for (let index = 0; index < count; index += 1) {
    const line = `short line ${String(index).padStart(3, '0')} ${'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(2)}`
    if (index % 2 === 0) appendUser(session, line)
    else appendAssistant(session, line, 1, index)
  }
  return session
}

/**
 * A kernel range view that offers the WHOLE surface as one span.
 *
 * Production feeds the range table the kernel's own `compressibleRanges`
 * (translated to surface seqs through the same view type). These tests target
 * the FILTER layer on top of that geometry — instruction barriers, the
 * protected tail, checkpoints, the system node — so one spanning range isolates
 * it from how the kernel happens to group messages. The ref→seq mapping and the
 * kernel grouping have their own test (region.test.ts, kernel range source).
 *
 * The ref names are arbitrary: only the mapping through `refs.byRef` matters.
 */
export function wholeSurfaceRangeView(
  session: Session,
): { ranges: { startRef: string; endRef: string }[]; refs: { byRef: Record<string, string> } } {
  const nodes = session.surface.nodes
  const first = nodes[0]
  const last = nodes[nodes.length - 1]
  if (first === undefined || last === undefined) return { ranges: [], refs: { byRef: {} } }
  return {
    ranges: [{ startRef: 'm00001', endRef: 'm00002' }],
    refs: { byRef: { m00001: String(first), m00002: String(last) } },
  }
}
