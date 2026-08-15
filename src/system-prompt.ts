/**
 * M4 — the ACP system-prompt section (DSH counterpart of billion-context-pi's
 * ACP_SYSTEM_PROMPT): the load-bearing compression guidance lives here, ONCE,
 * instead of being re-sent with every nudge. The nudge itself stays a short,
 * advisory notice — ACP is model-driven, the model decides whether and when
 * to compress (never "compress now").
 *
 * The text is DEFAULT_PROMPTS.systemPromptTemplate rendered with the kernel's
 * COMPRESS_PHILOSOPHY; hosts can override the whole section via
 * `config.prompts.systemPrompt` (see docs/configurable-prompts-design.md).
 * @module billion-context-dsh/system-prompt
 */

import { DEFAULT_PROMPTS, renderSystemPrompt } from './prompts.ts'

export const ACP_SYSTEM_PROMPT = renderSystemPrompt(DEFAULT_PROMPTS)

/** System-prompt section order: tool guidance lives in 100–199. */
export const ACP_SYSTEM_PROMPT_ORDER = 150
