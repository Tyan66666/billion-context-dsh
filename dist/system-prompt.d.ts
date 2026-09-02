/**
 * M4 — the ACP system-prompt section (DSH counterpart of billion-context-pi's
 * ACP_SYSTEM_PROMPT): the load-bearing compression guidance lives here, ONCE,
 * instead of being re-sent with every nudge. The nudge itself stays a short,
 * advisory notice — ACP is model-driven, the model decides whether and when
 * to compress.
 *
 * The text is DEFAULT_PROMPTS.systemPromptTemplate rendered with the kernel's
 * COMPRESS_PHILOSOPHY and HOW_TO_COMPRESS_RULES; hosts can override the whole
 * section via `config.prompts.systemPrompt` (see docs/configurable-prompts-design.md).
 * @module billion-context-dsh/system-prompt
 */
export declare const ACP_SYSTEM_PROMPT: string;
/** System-prompt section order: tool guidance lives in 100–199. */
export declare const ACP_SYSTEM_PROMPT_ORDER = 150;
