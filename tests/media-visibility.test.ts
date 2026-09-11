/**
 * #117 — image/file blocks must be VISIBLE to the engine.
 *
 * An `image` block carries no characters, so every text-based estimator used to
 * price it at zero and `extractText` dropped it entirely. Four things broke at
 * once: the message had no kernel ref (so no compress boundary, and the range
 * solver shrank past it and swallowed neighbours), the kernel's recent/last-user
 * protection never saw it (an image-only last user turn could be compressed
 * away), the range table ranked picture-heavy spans at ~0 tokens, and search /
 * decompress lost the image context silently.
 *
 * The fix (src/messages.ts) renders a deterministic one-line placeholder from
 * durable attachment metadata — the same idea the host already applies to files
 * ("request assembly projects every occurrence to deterministic handle text",
 * dsh-llm/lib/types/types.d.ts). Placeholders restore the ref, the boundary and
 * the protection; the media PRICE (which no text estimator can compute) comes
 * from the host meter's routed structural surcharge, and the range row says how
 * many images/files the span carries.
 *
 * Fixtures use the real DSH shapes (rule 5): `{ type: 'image', attachment }`
 * inside `user/message` content, and a `{ type: 'tool-result', toolCallId,
 * content: [...] }` block nested inside `tool/result`'s message.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createCore, type CompressionCore } from 'acp-kernel'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { AcpStateStore } from '../src/state.ts'
import { makeTools, type ToolEnvironment } from '../src/tools.ts'
import {
  attachmentsOfEvent,
  extractEventText,
  extractText,
  projectEvent,
  surfaceEventsOf,
} from '../src/messages.ts'
import { buildCompressibleSeqRanges } from '../src/region.ts'
import { rangeTable } from '../src/nudge.ts'
import { mediaPriceViaMeter } from '../src/host-tokens.ts'
import { DEFAULT_RESOLVED } from '../src/prompts.ts'
import {
  appendAssistant,
  appendToolCall,
  appendTurn,
  appendUser,
  buildTextSession,
  longText,
  wholeSurfaceRangeView,
} from './helpers.ts'

const IMAGE_BLOCK = {
  type: 'image',
  attachment: {
    attachmentId: AttachmentId('att-image-1'),
    mediaType: 'image/png',
    bytes: 4321,
    width: 800,
    height: 600,
    name: 'shot.png',
  },
} as const

const FILE_BLOCK = {
  type: 'file',
  attachment: {
    attachmentId: AttachmentId('att-file-1'),
    name: 'notes.txt',
    bytes: 1024,
  },
} as const

/** A user message whose ONLY content is a screenshot — invisible before the fix. */
function appendImageUser(session: Session): void {
  session.append('user/message', createUserMessage({
    content: [IMAGE_BLOCK],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

/**
 * A 15-node session whose screenshot sits in the OLD half.
 *
 * The range table protects the last 5 surface nodes plus the last real user
 * turn, so a short fixture offers no compressible span at all (a 4-node version
 * of this test silently produced zero ranges). Everything here is text except
 * the tool-result pair at the middle, which carries one image.
 */
function buildMediaSession(id: string): Session {
  const session = Session.create(id)
  appendTurn(session, 1)
  for (let index = 0; index < 14; index += 1) {
    if (index === 4) {
      appendToolCall(session, longText('call', index), 'c1', 1, index)
      appendImageToolResult(session, 'c1')
      continue
    }
    if (index % 2 === 0) appendUser(session, longText('q', index))
    else appendAssistant(session, longText('a', index), 1, index)
  }
  return session
}

/** A tool result whose payload is a screenshot (nested `tool-result` block). */
function appendImageToolResult(session: Session, callId: string): void {
  session.append('tool/result', {
    turn: 1,
    step: 2,
    message: {
      id: `res-${callId}`,
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [IMAGE_BLOCK] }],
      source: { kind: 'tool', callId },
    },
  }, { surfaceOp: 'append' })
}

function makeEnv(limit = 128000): ToolEnvironment {
  return {
    kernel: createCore({}) as CompressionCore,
    store: new AcpStateStore(),
    modelContextLimit: limit,
    compressCallIdsToHide: new Set(),
  }
}

function fakeExec(session: Session): ToolRunContext {
  const agent = {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: new Context(),
  } as unknown as Agent
  return {
    callId: 'call-acp',
    name: 'acp_status',
    arguments: {},
    signal: new AbortController().signal,
    agent,
  } as unknown as ToolRunContext
}

async function statusText(env: ToolEnvironment, session: Session): Promise<string> {
  const tool = makeTools(env).find((definition) => definition.name === 'acp_status')
  assert.ok(tool, 'acp_status tool is registered')
  const result = await tool.execute({}, fakeExec(session))
  return (result as { text: string }).text
}

test('#117: extractText renders a placeholder for image/file blocks, at any nesting depth', () => {
  assert.equal(
    extractText([IMAGE_BLOCK]),
    '[image image/png shot.png 800x600 4.2KB]',
    'an image block contributes durable metadata, not nothing',
  )
  assert.equal(extractText([FILE_BLOCK]), '[file notes.txt 1.0KB]', 'file blocks are visible too')
  assert.equal(
    extractText([{ type: 'tool-result', toolCallId: 'c1', content: [IMAGE_BLOCK] }]),
    '[image image/png shot.png 800x600 4.2KB]',
    'a screenshot inside a tool result reaches the text walk',
  )
  assert.equal(
    extractText([{ type: 'text', text: 'before' }, IMAGE_BLOCK, { type: 'text', text: 'after' }]),
    'before\n[image image/png shot.png 800x600 4.2KB]\nafter',
    'placeholders keep their position relative to surrounding text',
  )
  // A malformed attachment must not invent a fake placeholder (and must not throw).
  assert.equal(extractText([{ type: 'image' }]), '', 'image block without attachment contributes nothing')
  assert.equal(extractText([{ type: 'file', attachment: null }]), '', 'null attachment contributes nothing')
})

test('#117: attachmentsOfEvent counts images/files where extractEventText looks', () => {
  const session = Session.create('media-count')
  appendTurn(session, 1)
  appendUser(session, longText('question', 1))
  appendImageUser(session)
  appendToolCall(session, longText('call', 2), 'c1', 1, 2)
  appendImageToolResult(session, 'c1')
  const events = surfaceEventsOf(session)
  const counts = events.map((event) => attachmentsOfEvent(event))
  assert.deepEqual(
    counts.map((entry) => entry.images),
    [0, 1, 0, 1],
    'the image-only user message and the screenshot tool result each report one image',
  )
  assert.equal(
    counts.every((entry) => entry.files === 0),
    true,
    'no files in this fixture',
  )
})

test('#117: an image-only user message now has a ref and a plain-ref boundary', () => {
  const session = Session.create('media-projection')
  appendTurn(session, 1)
  appendUser(session, longText('question', 1))
  appendImageUser(session)
  const imageEvent = surfaceEventsOf(session).at(-1)
  assert.ok(imageEvent, 'image message landed on the surface')

  const projected = projectEvent(imageEvent)
  assert.equal(projected.length, 1, 'the message projects to a CoreMessage (before: dropped, so no ref at all)')
  assert.equal(projected[0]?.id, String(imageEvent.seq), 'with its surface seq as the kernel ref')
  assert.match(String(projected[0]?.text), /^\[image /, 'carrying the placeholder as its text')

  // `hasPlainRef` (src/region.ts) requires non-empty event text for a
  // user/message — this is that precondition, and the range solver can now
  // treat the message as a boundary instead of shrinking past it.
  assert.ok(extractEventText(imageEvent).trim().length > 0, 'event text is non-empty → hasPlainRef true')
})

test('#117: the range table prices media spans and marks them; text-only sessions never measure', () => {
  const session = buildMediaSession('media-range')
  const mediaSeq = surfaceEventsOf(session).find((event) => attachmentsOfEvent(event).images > 0)?.seq
  assert.ok(mediaSeq !== undefined, 'fixture really carries the screenshot')

  const asked: number[] = []
  const view = wholeSurfaceRangeView(session)
  const ranges = buildCompressibleSeqRanges(session, view, {
    mediaPriceOf: (seq) => {
      asked.push(seq)
      return 1500
    },
  })
  assert.deepEqual(asked, [mediaSeq], 'only the media-bearing seq is priced — the meter is never measured per message')

  const mediaRow = ranges.find((range) => range.images > 0)
  assert.ok(mediaRow, 'the media span is offered to the model')
  assert.equal(mediaRow.images, 1, 'image count rides the row')
  assert.equal(mediaRow.files, 0, 'no files in this fixture')
  // The price must be ADDED, not merely present: the span is long text, so a
  // loose ">= 1500" would pass even if the surcharge were dropped (verified by
  // mutation). Compare the same span priced at 1500 vs 0 and require the exact
  // difference.
  const unpriced = buildCompressibleSeqRanges(session, view, { mediaPriceOf: () => 0 }).find((range) => range.images > 0)
  assert.ok(unpriced, 'the same span is offered without a media price')
  assert.equal(mediaRow.tokens - unpriced.tokens, 1500, 'the provider-anchored price is inside the token column')

  // The marker: without it a model reads the text-only token count as "nothing
  // to reclaim" on a picture-heavy span.
  const table = rangeTable(session, view, DEFAULT_RESOLVED, () => 1500)
  assert.match(table, /\[\+1 image\]/, 'the range row names the image it carries')

  // Lazy by construction: a media-free session asks for nothing.
  const plain = buildTextSession(10)
  let plainLookups = 0
  buildCompressibleSeqRanges(plain, wholeSurfaceRangeView(plain), {
    mediaPriceOf: () => {
      plainLookups += 1
      return 1500
    },
  })
  assert.equal(plainLookups, 0, 'no meter measurement for a session without media (issue #110: no new cost)')
})

test('#117: mediaPriceViaMeter reads the routed surcharge and degrades on every broken meter', () => {
  const session = Session.create('media-meter')
  appendTurn(session, 1)
  appendUser(session, longText('question', 1))
  const ctx = {
    get: (name: string) =>
      name === 'tokenMeter'
        ? {
            measure: () => ({
              nodes: [
                { seq: 1, tokens: 20, heuristicTokens: 18 },
                { seq: 2, tokens: 1520, heuristicTokens: 20, imageStructuralTokens: 1500, fileStructuralTokens: 120 },
              ],
            }),
          }
        : undefined,
  }
  const prices = mediaPriceViaMeter(session, ctx)
  assert.equal(prices.get(2), 1620, 'image + file structural surcharges add up to the provider-anchored price')
  assert.equal(prices.has(1), false, 'a text-only node carries no media price')

  assert.equal(mediaPriceViaMeter(session, { get: () => undefined }).size, 0, 'no meter service → no prices')
  assert.equal(mediaPriceViaMeter(session, undefined).size, 0, 'no ctx at all → no prices')
  assert.equal(
    mediaPriceViaMeter(session, {
      get: () => ({
        measure: () => {
          throw new Error('token meter measure requires a step-complete log')
        },
      }),
    }).size,
    0,
    'a throwing measurement (step-less log) degrades instead of failing the nudge',
  )
})

test('#117: acp_status explains the two calibers only when media is on the surface', async () => {
  const withMedia = Session.create('media-status')
  appendTurn(withMedia, 1)
  appendUser(withMedia, longText('look at this', 1))
  appendImageUser(withMedia)
  const mediaText = await statusText(makeEnv(), withMedia)
  assert.match(
    mediaText,
    /Note: the pressure line is provider-anchored \(images\/files priced by the live route\); the breakdown above is a text-only estimate\./,
    'the model is told why the pressure number and the breakdown can disagree',
  )

  const plainText = await statusText(makeEnv(), buildTextSession(6))
  assert.ok(
    !/provider-anchored/.test(plainText),
    'a text-only session keeps the kernel report untouched (no extra chatty row)',
  )
})
