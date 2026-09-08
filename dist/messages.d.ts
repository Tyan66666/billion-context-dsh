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
import type { CoreMessage } from 'acp-kernel';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
/**
 * Extract plain text from a DSH content block array or string.
 *
 * Recursive: a real DSH `tool-result` block is `{ type: 'tool-result',
 * toolCallId, content: ContentBlock[] }` — the inner `content` array holds
 * the actual `text` blocks, so a top-level-only walk would drop every tool
 * result from the projection (and with it the seq's ref assignment, breaking
 * compress boundary resolution). Nested arrays are flattened depth-first.
 */
export declare function extractText(content: unknown): string;
/**
 * The tool-call id of one tool/result surface message, or null.
 *
 * Real DSH tool-result events carry NO `message.toolCallId` (hard-won rule
 * 10): the identity lives in the nested `{ type: 'tool-result', toolCallId }`
 * content block, falling back to `message.source.callId`. Shared with
 * `src/region.ts`'s call/result pairing — one implementation, never a copy.
 */
export declare function toolCallIdOfResultEvent(event: SessionEvent): string | null;
/**
 * Index of assistant tool-call `id` → tool `name`, used to attribute
 * tool/result messages to their tool. Real DSH tool-results carry no
 * `message.toolName` (rule 10), so the projection backfills it from the
 * matching assistant tool-call. Scans ALL events up front (order-independent:
 * a result may precede its call in the array) and covers shadowed calls too.
 */
export declare function buildToolCallIndex(events: readonly SessionEvent[]): ReadonlyMap<string, string>;
/**
 * Project one surface message event into CoreMessage(s).
 *  - user/message      → user text (verbatim content)
 *  - assistant/message → assistant text, or one CoreMessage per tool-call
 *  - tool/result       → tool result (role 'tool'); toolName/toolCallId are
 *                        backfilled from `toolNames` (assistant tool-call
 *                        index) — real DSH events do not carry them at the
 *                        message level. Without an index the result stays
 *                        untagged (`toolName: ''`), never "text".
 * Non-surface events project to nothing.
 */
/**
 * B1 摘要帧标源（2026-09-08 过度工程治理方案 §4 B1）。
 *
 * 压缩摘要是**模型自写**的，不是用户原话。旧实现把它以 user/message 注入（source=compact），
 * 与真人输入同等地位——于是摘要里的义务句被当成用户指令、模型自己的猜测被当成用户承诺。
 * 注入期加显式前缀；创建期（region.ts）与投影期（此处）两处同源，且幂等。
 */
export declare const SUMMARY_FRAME_PREFIX = "[\u6A21\u578B\u81EA\u5199\u6458\u8981 \u00B7 \u975E\u7528\u6237\u539F\u6587 \u00B7 \u5176\u4E2D\u4E49\u52A1\u53E5\u9700\u590D\u6838]";
export declare function withSummaryFramePrefix(text: string): string;
/** 是否为压缩检查点帧（compaction summary 注入的 user/message）。 */
export declare function isCompactionCheckpoint(event: SessionEvent): boolean;
export declare function projectEvent(event: SessionEvent, toolNames?: ReadonlyMap<string, string>): CoreMessage[];
/** Project a session's message events into CoreMessage[] in log order. */
export declare function eventsToCoreMessages(events: readonly SessionEvent[], toolNames?: ReadonlyMap<string, string>): CoreMessage[];
/** The surface-visible message events of a session, in model-visible order. */
export declare function surfaceEventsOf(session: Session): SessionEvent[];
/**
 * ALL message-type events in log order — the visible surface PLUS everything
 * shadowed by compression. The ACP kernel deactivates any block whose consumed
 * message ids are absent from the array it is given (syncBlocks), and refuses
 * to anchor a block boundary that cannot find its messages, so T2/T3
 * distillation requires the full log, not just the visible surface.
 */
export declare function allLogMessages(session: import('@deepseek-ai/dsh-session').Session): CoreMessage[];
/** Extract the model-facing text of any surface message event. */
export declare function extractEventText(event: SessionEvent): string;
