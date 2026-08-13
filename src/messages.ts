/**
 * M1 — session-log projection: DSH surface events → acp-kernel CoreMessage.
 *
 * The ACP kernel is message-array based; DSH is event-log based. This module
 * is the bridge in the direction the engine needs (projectEvent /
 * eventsToCoreMessages). The reverse direction (CoreMessage[] → session
 * appends) is the M5 region transaction's job.
 * Mirrors billion-context-pi's `projectMessage`/`entriesToCoreMessages`
 * against DSH event shapes (see V-verification: SurfaceEventType =
 * 'user/message' | 'assistant/message' | 'tool/result').
 * @module billion-context-pi-dsh/messages
 */

import type { CoreMessage } from 'acp-kernel'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Extract plain text from a DSH content block array or string. */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

interface ToolCallBlock {
  type: 'tool-call'
  id?: string
  name?: string
  arguments?: unknown
}

function toolCallsOf(content: unknown): ToolCallBlock[] {
  if (!Array.isArray(content)) return []
  return content.filter((b): b is ToolCallBlock => (b as { type?: string }).type === 'tool-call')
}

function stringifyArgs(args: unknown): string {
  if (!args) return ''
  if (typeof args === 'string') return args
  try {
    return JSON.stringify(args)
  } catch {
    return String(args)
  }
}

/**
 * Project one surface message event into CoreMessage(s).
 *  - user/message      → user text (verbatim content)
 *  - assistant/message → assistant text, or one CoreMessage per tool-call
 *  - tool/result       → tool result (toolName/toolCallId, role 'tool')
 * Non-surface events project to nothing.
 */
export function projectEvent(event: SessionEvent): CoreMessage[] {
  switch (event.type) {
    case 'user/message': {
      const text = extractText((event.data as { content?: unknown }).content)
      return text.length > 0 ? [{ id: String(event.seq), role: 'user', contentType: 'text', text }] : []
    }
    case 'assistant/message': {
      const content = (event.data as { message?: { content?: unknown } }).message?.content
      const calls = toolCallsOf(content)
      const text = extractText(content)
      if (calls.length === 0) {
        return text.trim().length > 0
          ? [{ id: String(event.seq), role: 'assistant', contentType: 'text', text }]
          : []
      }
      if (calls.length === 1) {
        const call = calls[0]!
        const argStr = stringifyArgs(call.arguments)
        const body = argStr && text ? `${text}\n${argStr}` : argStr || text
        return [{
          id: String(event.seq),
          role: 'assistant',
          contentType: 'tool-call',
          toolName: call.name ?? '',
          toolCallId: call.id ?? '',
          text: body,
        }]
      }
      return calls.map((call) => ({
        id: `${event.seq}#${call.id ?? ''}`,
        role: 'assistant' as const,
        contentType: 'tool-call' as const,
        toolName: call.name ?? '',
        toolCallId: call.id ?? '',
        text: stringifyArgs(call.arguments) || text,
      }))
    }
    case 'tool/result': {
      const message = (event.data as {
        message?: { content?: unknown; toolName?: string; toolCallId?: string }
      }).message
      const text = extractText(message?.content)
      if (text.length === 0) return []
      return [{
        id: String(event.seq),
        role: 'tool',
        contentType: 'tool-result',
        toolName: message?.toolName ?? '',
        toolCallId: message?.toolCallId ?? '',
        text,
      }]
    }
    default:
      return []
  }
}

/** Project a session's message events into CoreMessage[] in log order. */
export function eventsToCoreMessages(events: readonly SessionEvent[]): CoreMessage[] {
  const out: CoreMessage[] = []
  for (const event of events) out.push(...projectEvent(event))
  return out
}

/** The surface-visible message events of a session, in model-visible order. */
export function surfaceEventsOf(session: import('@deepseek-ai/dsh-session').Session): SessionEvent[] {
  return session.surface.nodes
    .map((seq) => session.events[seq])
    .filter((event): event is SessionEvent => event !== undefined)
}

/** Extract the model-facing text of any surface message event. */
export function extractEventText(event: SessionEvent): string {
  switch (event.type) {
    case 'user/message':
      return extractText((event.data as { content?: unknown }).content)
    case 'assistant/message':
      return extractText((event.data as { message?: { content?: unknown } }).message?.content)
    case 'tool/result':
      return extractText((event.data as { message?: { content?: unknown } }).message?.content)
    default:
      return ''
  }
}
