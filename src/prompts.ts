/**
 * M4 — configurable prompt templates: the per-stage model-visible texts
 * (nudge frames, range table, system prompt, tool descriptions) rendered from
 * `config.prompts` templates with named placeholders.
 *
 * Design: docs/configurable-prompts-design.md (v4).
 * - placeholders are `{identifier}` only; literal braces like
 *   `compress({ content: [...] })` are left untouched (spaces/commas break the
 *   identifier rule);
 * - resolvePrompts merges user overrides over DEFAULT_PROMPTS per key
 *   (null/undefined → default, string → override; group-level null → whole
 *   group default for YAML hosts) and validates unknown placeholders at
 *   construction time (fail-fast, no silent typos);
 * - renderTemplate throws when a known placeholder has no value — callers
 *   must provide every value (e.g. tokens via a typeof fallback).
 * @module billion-context-dsh/prompts
 */

import { COMPRESS_PHILOSOPHY, HOW_TO_COMPRESS_RULES, TIER2_DISTILL_RULES, TIER3_CONDENSE_RULES } from 'acp-kernel'

/** 用户可写值:字符串模板,或 null(= 用默认,等价于不写)。YAML 宿主写 null 是合法输入。 */
export type PromptInput = string | null

/** 按组生成"每键可选、可 null"的覆盖类型。 */
export type PromptOverride<T> = { [K in keyof T]?: PromptInput }

export interface NudgePrompts {
  /** 普通档首句。占位符:{pct} {philosophy} */
  normal: string
  /** 紧急档首句。占位符:{pct} {philosophy} */
  emergency: string
  /** 指导行（HOW_TO_COMPRESS_RULES）。无占位符 */
  guidance: string
  /** tier 蒸馏行。占位符:{tier} {count} {prevTier} {tokens} {seqs} */
  tier: string
  /** 上下文分解。占位符:{system} {tool} {summaries} {code} {text} */
  breakdown: string
  /** 增长行。占位符:{growth} */
  growth: string
  /** 溢出提示。无占位符 */
  tip: string
}

export interface RangeTablePrompts {
  /** 表头。占位符:{surface} */
  header: string
  /** 标题。占位符:{count}(表格行数) */
  title: string
  /** 每行。占位符:{start} {end} {count} {tokens} */
  line: string
  /** 表尾调用语法。无占位符 */
  footer: string
}

export interface ToolPrompts {
  /** 工具描述(纯文本,无占位符) */
  compress: string
  decompress: string
  searchContext: string
  acpStatus: string
}

export interface AcpPrompts {
  readonly nudge?: PromptOverride<NudgePrompts>
  readonly rangeTable?: PromptOverride<RangeTablePrompts>
  readonly tools?: PromptOverride<ToolPrompts>
  /** 整段 system prompt 模板;`{philosophy}` 引用 kernel 的 COMPRESS_PHILOSOPHY */
  readonly systemPrompt?: PromptInput
}

/** 解析结果 —— 所有字段已填满(纯 string,无 null)、已校验。构造一次,全程复用。 */
export interface ResolvedPrompts {
  readonly nudge: NudgePrompts
  readonly rangeTable: RangeTablePrompts
  readonly tools: ToolPrompts
  /** 注意:这是【模板】(含 {philosophy}),不是渲染结果。渲染用 renderSystemPrompt。 */
  readonly systemPromptTemplate: string
}

/** 每槽允许的占位符名集合(构建期校验用)。 */
const NUDGE_ALLOWED: { [K in keyof NudgePrompts]: ReadonlySet<string> } = {
  normal: new Set(['pct', 'philosophy']),
  emergency: new Set(['pct', 'philosophy']),
  guidance: new Set(),
  tier: new Set(['tier', 'count', 'prevTier', 'tokens', 'seqs']),
  breakdown: new Set(['system', 'tool', 'summaries', 'code', 'text']),
  growth: new Set(['growth']),
  tip: new Set(),
}
const RANGE_TABLE_ALLOWED: { [K in keyof RangeTablePrompts]: ReadonlySet<string> } = {
  header: new Set(['surface']),
  title: new Set(['count']),
  line: new Set(['start', 'end', 'count', 'tokens']),
  footer: new Set(),
}
const TOOLS_ALLOWED: { [K in keyof ToolPrompts]: ReadonlySet<string> } = {
  compress: new Set(),
  decompress: new Set(),
  searchContext: new Set(),
  acpStatus: new Set(),
}
const SYSTEM_ALLOWED = new Set(['philosophy', 'howToCompressRules', 'tier2DistillRules', 'tier3CondenseRules'])

/** 校验单个模板:未知 `{ident}` → throw(带槽位路径)。默认模板开发期已核验,不重扫。 */
function validateTemplate(template: string, allowed: ReadonlySet<string>, path: string): string {
  const re = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g
  let match: RegExpExecArray | null
  while ((match = re.exec(template)) !== null) {
    const name = match[1]!
    if (!allowed.has(name)) {
      throw new Error(
        `${path} contains unknown placeholder {${name}} — allowed: ${[...allowed].join(', ') || '(none)'}`,
      )
    }
  }
  return template
}

/**
 * 纯替换。两个契约:
 * 1. 未知占位符不可能到达这里(构建期已校验);
 * 2. 已知占位符缺值 = 编程错误 → throw(绝不静默渲染空串)。
 */
export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const value = vars[name]
    if (value === undefined) {
      throw new Error(
        `renderTemplate: missing value for placeholder {${name}} in template "${template.slice(0, 60)}…"`,
      )
    }
    return String(value)
  })
}

/**
 * 逐键合并:null / undefined → 默认;字符串 → 覆盖默认(不用 spread,
 * 否则 null 会覆盖默认,与"null = 用默认"矛盾)。组级 null/undefined →
 * 整组用默认(YAML 宿主可能写 `{ nudge: null }`,W3)。
 */
function mergeGroup<T extends Record<keyof T, string>>(
  defaults: T,
  override: PromptOverride<T> | null | undefined,
  allowed: { [K in keyof T]: ReadonlySet<string> },
  path: string,
): T {
  if (override == null) return defaults
  const out = {} as { [K in keyof T]: string }
  for (const key of Object.keys(defaults) as Array<keyof T>) {
    const value = override[key]
    out[key] = value === null || value === undefined
      ? defaults[key]
      : validateTemplate(value, allowed[key], `${path}.${String(key)}`)
  }
  return out as T
}

/**
 * 深合并 + 校验;引擎构造期调用一次,出错即抛(fail-fast)。
 * 未传入时返回 DEFAULT_RESOLVED,零校验重跑。
 */
export function resolvePrompts(input?: AcpPrompts): ResolvedPrompts {
  if (input === undefined) return DEFAULT_RESOLVED
  return {
    nudge: mergeGroup(DEFAULT_PROMPTS.nudge, input.nudge, NUDGE_ALLOWED, 'prompts.nudge'),
    rangeTable: mergeGroup(DEFAULT_PROMPTS.rangeTable, input.rangeTable, RANGE_TABLE_ALLOWED, 'prompts.rangeTable'),
    tools: mergeGroup(DEFAULT_PROMPTS.tools, input.tools, TOOLS_ALLOWED, 'prompts.tools'),
    systemPromptTemplate:
      input.systemPrompt === null || input.systemPrompt === undefined
        ? DEFAULT_PROMPTS.systemPromptTemplate
        : validateTemplate(input.systemPrompt, SYSTEM_ALLOWED, 'prompts.systemPrompt'),
  }
}

/** 渲染 system prompt 模板(注入 kernel 压缩哲学、压缩规则、蒸馏规则)。 */
export function renderSystemPrompt(prompts: ResolvedPrompts): string {
  return renderTemplate(prompts.systemPromptTemplate, {
    philosophy: COMPRESS_PHILOSOPHY,
    howToCompressRules: HOW_TO_COMPRESS_RULES,
    tier2DistillRules: TIER2_DISTILL_RULES,
    tier3CondenseRules: TIER3_CONDENSE_RULES,
  })
}

/**
 * 默认模板 —— 与 v4 之前的硬编码文案逐字节一致
 * (回归锚点见 tests/prompts.test.ts 的硬编码字面量快照)。
 */
export const DEFAULT_PROMPTS: ResolvedPrompts = {
  nudge: {
    // 与 kernel nudge-text.ts EFFICIENCY_NOTE 逐字对齐——不含 "Context usage is at X%"
    // 陈述(usage 只通过 breakdown 传达);{pct} 仍可用作自定义占位符。
    normal: 'This is an efficiency nudge to compress early and keep context lean — not an overflow warning. A separate, stronger alert will appear if the context is actually full.\n\n{philosophy}',
    emergency: '⚠️ Context limit reached — compress now. Prioritize consumed tool outputs.\n\n{philosophy}',
    guidance: HOW_TO_COMPRESS_RULES,
    tier: 'Tier {tier}: {count} tier-{prevTier} block(s) distillable ({tokens} tokens) — compress their summary node(s) [seqs {seqs}] to reclaim the original messages.',
    breakdown: 'Context breakdown: {system}K system | {tool}K tool | {summaries}K summaries | {code}K code | {text}K text',
    growth: '+{growth}K since last nudge',
    tip: '💡 Compress all ranges in one call (pass multiple content entries: `content: [{...}, {...}]`).',
  },
  rangeTable: {
    header: 'Surface: {surface}',
    title: 'Compressible ranges (exact surface seqs — usable as-is in compress, no re-verification needed):',
    line: '  - seq {start}..{end} — {count} messages, ~{tokens} tokens',
    footer: 'Compress with: compress({ content: [{ startSeq, endSeq, summary }] }) — content is an array: batch multiple unrelated segments in one call, each entry its own block. Keep ranges disjoint.\n'
      + 'Snapshot taken at nudge time: the seqs go stale once the surface moves (a later compress shadows them), so re-run acp_status for fresh refs before compressing.',
  },
  tools: {
    compress: 'Replace older conversation ranges with dense summaries you write. Each message seq is a surface reference. Single range: compress({ content: [{ startSeq, endSeq, summary }] }). Batch multiple unrelated ranges in one call (each content entry becomes its own block); keep ranges disjoint. Never compress content the current step is actively using. Compress boundaries are SURFACE SEQS (acp_status Surface: row, latest nudge table) — NOT the block refs (bN, e.g. b1) that acp_status COMPRESSED BLOCKS shows, which are for decompress only. Drilldown mN refs (e.g. m00306) are ALSO accepted as startSeq/endSeq — they are auto-mapped to the live surface seq; an unknown mN (never assigned on the current surface) fails with guidance. Seq refs must come from the CURRENT surface (acp_status or the latest nudge): a span whose edges were shadowed by an earlier compress is auto-remapped to its still-live content, a fully compressed span is reported as already compressed, and invented/other-session seqs fail with guidance.',
    decompress: 'Recover the original content of a compressed block by its blockId — the kernel block ref `bN` shown by acp_status (e.g. b1), or a compaction id from search_context (read-only; does not unshadow the range).',
    searchContext: 'Search inside compressed blocks (summaries and original content) for information the model no longer sees in context.',
    acpStatus: 'Context status: overview of the current context — CONTEXT BREAKDOWN (tool/text/summaries token shares of the visible total), COMPRESSED BLOCKS ledger, and the nudge decision. No args = overview. Percentages are shares of the visible content, not the context window. Note: the block refs in COMPRESSED BLOCKS (bN, e.g. b1) are for decompress; compress uses the Surface: seq range, not bN. Drilldown: pass scope:"compressed" for a per-block list, or scope:"uncompressed" with view:"messages" (every visible message) / view:"ranges" (merged ranges); tool filters to one tool name, sort reorders (size/time/tool; age for compressed), limit caps rows (default 30). Drilldown row refs are kernel ids (mN) — feed them straight to compress as startSeq/endSeq (auto-mapped to the live surface seq); bN is for decompress, Surface: seqs also work in compress.',
  },
  systemPromptTemplate: `Active Context Pruning — model-driven context management

YOU decide whether and when to compress context. The nudge is an efficiency notification: when you see one, consider which ranges you have genuinely consumed and could summarise to keep working context lean.

{philosophy}

WHEN TO COMPRESS:
- A sub-agent or delegated task has returned a large result that you have already extracted the key facts from.
- Verbose command output (build/test logs, git diff, directory listings) where you have already used the information you need.
- Exploration that led nowhere.
- Repeated reads of the same file or repeated status checks once the decision is recorded.
- Resolved discussion threads where a decision has been captured in summary or in code.
- Intermediate steps of a completed multi-step task, once the final result is recorded.
- A task phase has ended — bug hunt complete, root cause found, exploration done, research sprint wrapped.

WHEN NOT TO COMPRESS:
- Content the current step is actively reading or reasoning about.
- Important user messages — preserve their exact intent, constraints, and acceptance criteria.
- Protected tool outputs — hard-excluded from compression ranges, survive intact in visible context.

{howToCompressRules}

Compression tools (refs are SURFACE SEQS, not ids):
- compress: replace one or more seq ranges, each with your own dense summary. Single range: compress({ content: [{ startSeq, endSeq, summary }] }). Batch multiple unrelated segments in one call (each entry becomes its own block): compress({ content: [{ startSeq: 1, endSeq: 5, summary: '...' }, { startSeq: 12, endSeq: 18, summary: '...' }] }). Keep ranges disjoint — overlapping entries in one batch are skipped. Edges are auto-balanced to tool-call/result boundaries; a trailing #callId fragment in a seq is ignored. Seq refs must be on the current surface: seqs from older nudges or earlier compresses go stale as the surface moves, so a stale span is auto-remapped to its still-live remainder (the result reports the adjusted span), a fully compressed span is reported as already compressed, and invented/other-session seqs fail with guidance. The block refs (bN, e.g. b1) in acp_status COMPRESSED BLOCKS are for decompress, NOT compress boundaries.
- decompress: recover a compressed block's original content, read-only. decompress({ blockId }) — accept the bN ref shown by acp_status (e.g. b1) or a compaction id.
- search_context: find information inside compressed blocks BEFORE decompressing. search_context({ query }).
- acp_status: current context usage and the live compressible-range list. Run it right before compressing — the only seqs that never go stale are the ones you just read. Drilldown (scope/view/tool/sort/limit) lists per-message or per-block sizes; drilldown rows are kernel ids (mN) — compress accepts them directly (auto-mapped to the live surface seq).

Tiered compression: each compressed block appears on the surface as one summary node. Compressing that node again DISTILLS the block (tier 2): the parent summary folds into your new summary and the original messages are freed. Distilling a tier-2 block yields tier 3. Distill when a summary itself is consumed — decompress on the tier-2 block recovers the full originals.

{tier2DistillRules}

{tier3CondenseRules}

When you write a summary, it becomes the ONLY record of that range: keep file paths, signatures, exact values, decisions, and error strings verbatim so a later reader (or you, after decompress) can continue without the original. Never reuse historical seqs — the surface moves as messages land and compress; verify with acp_status.`,
}

/** 模块级默认缓存:默认参/兜底直接引用,避免每次调用重跑校验。 */
export const DEFAULT_RESOLVED: ResolvedPrompts = DEFAULT_PROMPTS
