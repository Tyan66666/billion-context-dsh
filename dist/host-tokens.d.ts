/**
 * Host-vocabulary token pricing for the durable shadow-price protocol.
 *
 * The host token-meter prices every appended message with a fixed flat-4
 * heuristic (`estimateContent` / `estimateMessage` in `dsh-token-meter`) and
 * the producer contract requires every `compaction/summary`/`compaction/prune`
 * `shadowedTokenCount` claim to be derived from the SAME estimator. Writing
 * claims with the engine's CJK-aware `defaultCountTokens` overdraws the meter
 * on CJK-heavy sessions and permanently bricks them (live session
 * `session-3aa366c3`, issue #54; AGENTS.md rule 12 — `defaultCountTokens` is
 * display currency, NEVER event currency).
 *
 * This module prices claims in the host's vocabulary: it prefers the live
 * meter's own per-node prices (`ctx.tokenMeter.measure(session).nodes` —
 * exact by construction, follows host estimator changes automatically, the
 * same path the host's own `compaction-basic` uses) and falls back to an
 * exact mirror of the host's estimator when the meter is unreachable.
 */
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
/** The host's model-visible content block union (structural, mirror-side only). */
export type HostBlock = {
    type: 'text';
    text: string;
} | {
    type: 'reasoning';
    text: string;
} | {
    type: 'tool-call';
    name: string;
    arguments: string;
} | {
    type: 'tool-result';
    toolCallId: string;
    content: HostContent;
} | ({
    type?: string;
} & Record<string, unknown>);
/** A content block list, or a bare string (`tool-result` content may be either). */
export type HostContent = readonly HostBlock[] | string;
/**
 * Exact mirror of the host's `estimateContent`
 * (`@deepseek-ai/dsh-token-meter/lib/types/estimate.js`): text/reasoning
 * `ceil(len/4)+4`, tool-call `ceil(name/4)+ceil(arguments/4)+4`, tool-result
 * recursive over its content, unknown blocks `4+ceil(JSON.stringify/4)` over
 * the ORIGINAL block object. A string content is iterated as an iterable, so
 * every CHARACTER falls to the default branch (`4+ceil(JSON.stringify(char)/4)`
 * — 5 tokens for any single unescaped character).
 */
export declare function estimateHostContent(blocks: HostContent): number;
/** Exact mirror of the host's `estimateMessage` (content + role framing). */
export declare function estimateHostMessage(message: {
    content: HostContent;
}): number;
/**
 * Host price of ONE session event under the mirror: project it through the
 * host's `deriveEventMessage` (null for non-surface events and empty-content
 * assistant messages) and price the derived message; null derives to 0.
 */
export declare function hostPriceEvent(event: SessionEvent): number;
/** Mirror price of a set of surface seqs (the fallback claim computation). */
export declare function shadowedHostTokens(session: Session, seqs: readonly number[]): number;
/**
 * Claim price for `seqs` in the host's vocabulary. Prefers the live meter's
 * own per-node prices when `ctx.tokenMeter` is reachable and covers every
 * shadowed seq (exact by construction, follows host estimator changes); ANY
 * failure — meter absent, `measure` throwing (e.g. a step-less log), or a seq
 * missing from the measurement — falls back to the exact mirror. Never returns
 * a `defaultCountTokens` price (rule 12).
 */
export declare function shadowedTokensViaMeter(session: Session, seqs: readonly number[], ctx?: {
    get?(name: string): unknown;
} | null): number;
