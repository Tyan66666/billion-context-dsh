/**
 * M4 — the ACP system-prompt section (DSH counterpart of billion-context-pi's
 * ACP_SYSTEM_PROMPT): the load-bearing compression guidance lives here, ONCE,
 * instead of being re-sent with every nudge. The nudge itself stays a short,
 * advisory notice — ACP is model-driven, the model decides whether and when
 * to compress (never "compress now").
 * @module billion-context-dsh/system-prompt
 */

import { COMPRESS_PHILOSOPHY } from 'acp-kernel'

export const ACP_SYSTEM_PROMPT = `Active Context Pruning — model-driven context management

YOU decide whether and when to compress context. Nothing forces you: the injected "nudge" is a suggestion, not an order, and you may ignore it when compression would not help. Compress only ranges you have genuinely consumed (read tool outputs, finished explorations, superseded steps) that the current work no longer needs verbatim.

${COMPRESS_PHILOSOPHY}

Compression tools (refs are SURFACE SEQS, not ids):
- compress: replace one or more seq ranges, each with your own dense summary. Single range: compress({ content: [{ startSeq, endSeq, summary }] }). Batch multiple unrelated segments in one call (each entry becomes its own block): compress({ content: [{ startSeq: 1, endSeq: 5, summary: '...' }, { startSeq: 12, endSeq: 18, summary: '...' }] }). Keep ranges disjoint — overlapping entries in one batch are skipped. Edges are auto-balanced to tool-call/result boundaries; a trailing #callId fragment in a seq is ignored. Ranges must be on the current surface — stale seqs fail with guidance.
- decompress: recover a compressed block's original content, read-only. decompress({ blockId }).
- search_context: find information inside compressed blocks BEFORE decompressing. search_context({ query }).
- acp_status: current context usage and the live compressible-range list. Run it before compressing when in doubt.

Tiered compression: each compressed block appears on the surface as one summary node. Compressing that node again DISTILLS the block (tier 2): the parent summary folds into your new summary and the original messages are freed. Distilling a tier-2 block yields tier 3. Distill when a summary itself is consumed — decompress on the tier-2 block recovers the full originals.

When you write a summary, it becomes the ONLY record of that range: keep file paths, signatures, exact values, decisions, and error strings verbatim so a later reader (or you, after decompress) can continue without the original. Never reuse historical seqs — the surface moves as messages land and compress; verify with acp_status.`

/** System-prompt section order: tool guidance lives in 100–199. */
export const ACP_SYSTEM_PROMPT_ORDER = 150
