# 可配置提示词设计(Configurable Prompts Design)— v4

> **修订记录(v4,终审后精度修正;第三轮评审实测结论:通过,可进入实现):**
> - **W1**:§4 tier 行补"渲染非空"守卫,`tier: ''` = 删除该行,与 §4 值语义统一(默认模板恒渲染非空,对默认字节零影响);
> - **W2**:§3.3 校验范围明确为"用户覆盖的模板",与 §6 `DEFAULT_RESOLVED` 零校验重跑一致;
> - **W3**:§4 补组级 null 防御(YAML 宿主可写 `{ nudge: null }`,视为整组用默认);
> - **S1**:§5.1 `seqs` 空串声明为定义值(非缺值,不触发 §3.2);
> - **S2**:§9 补模板转义边界(字面 `{ident}` 无转义,可用空格隔开规避);
> - **S3**:§8 #11 注 `NudgeBreakdown.pendingT2/T3` 为必填 number,测试构造需类型断言;
> - **S4**:§4 字节表 `normal:''` 精确为"以 `\n\n` 开头";
> - **S5**:§6 补实例字段 `readonly prompts: ResolvedPrompts` 声明(赋值先于 env 构建)。
>
> **修订记录(v3,已吸收第二轮评审意见):**
> - **N1(阻断)**:§4 装配规则重写为**逐字节复现现状**的规则(parts = [frame] → guidance 带 `''` 分隔 → tier 紧跟单换行 → 范围表**无条件** push,零范围 `''` 也 push);修正 §4 默认公式与 §5.2 前导元素的矛盾(范围表不在 parts 层再加分隔);`guidance:''` 字节与 §8 #10 期望统一;
> - **N2**:§8 条数修正为"新增 13 条 + 现有 54 条回归"(v2 声称已修但实际编号 1-13 与"12"不符);
> - **N3**:§8 #2/#3 快照来源描述修正——注明零范围会话、**尾部 `\n` 是字节的一部分**、`assert.equal` 整串比较;
> - **N4**:§5.2 补范围表**行级**空串语义(行级不做省略,仅整块省略);`title` 的 `{count}` 由渲染器恒传。
>
> **修订记录(v2,已吸收子代理评审意见):**
> - **B1**:§6 补 `buildNudge` → `buildNudgeText` 的 `env.prompts` 转发行;§8 加接线集成测试;
> - **B2**:§5.1 `{tokens}` 映射补 `typeof pending === 'number' ? pending : 0` 兜底;§8 加 pending 缺失回归;
> - **B3**:null 语义与类型/合并统一——输入类型放宽为 `string | null`,`resolvePrompts` 把 null 归一化为 undefined(回默认)再逐键合并(不再用 spread);
> - **I1**:§5 补范围表零范围提前返回 `''`、装配顺序、tier 行条件渲染规则;
> - **I2**:§9 显式列入"工具错误/引导消息",理由与"数据格式"区分;
> - **I3**:§8 增加 nudge 全文本 / 范围表 / 四个工具描述的**硬编码字面量快照回归**(不只是 system prompt);
> - **I4**:§8 快照改为与**独立的硬编码字面量**比较,消除循环论证;
> - **I5**:§4 定义空串删除的精确装配语义(块级省略,含分隔);
> - **I6**:`renderTemplate` 对**已知占位符缺值**抛错(不再静默渲染空串),配合 B2 的调用方兜底契约;
> - **I7**:§6 修正测试文件引用(makeEnv 在 `tests/nudge.test.ts:33` 与 `tests/tools.test.ts:14`,非 helpers.ts);
> - 建议级:§2 行号修正(P1=`nudge.ts:123`,P2=`nudge.ts:122`)、P4 示例改数字直出、`DEFAULT_RESOLVED` 模块级缓存、systemPrompt 注册补冷启动重试、docs/README.md 已收录(§6 清单删除该行)、§8 条数修正、`systemPromptTemplate` 命名。

> 状态:设计评审稿 v4(**第三轮终审实测通过,可进入实现**)。实现时按 §6 接线改动逐文件落地,并以 §8 测试计划为验收。

## 1. 背景与目标

billion-context-dsh 目前所有"模型可见"的提示词文本都是硬编码在源码里的(普通/紧急 nudge、tier 蒸馏行、范围表、system prompt、四个工具描述)。宿主无法在不改代码的前提下定制文案(例如全文汉化、调整语气、适配特定模型的指令风格)。

目标:**通过宿主 composition 的 `config.prompts` 字段,按阶段覆盖这些提示词**,同时保证:

1. **默认输出逐字节不变**——现有测试断言了精确子串,默认渲染必须与当前完全一致;
2. **构造期 fail-fast**——配置拼写错误在引擎启动时抛错,而不是在会话中途悄悄漏进提示词;
3. **向后兼容**——`buildNudgeText` / `rangeTable` / `ACP_SYSTEM_PROMPT` 的现有导出签名继续可用;
4. **YAML 友好**——配置必须是 JSON/YAML 可序列化的纯字符串(null 允许,函数不支持)。

## 2. 可配置面盘点(分阶段提示词全清单)

| # | 阶段 | 当前位置 | 内容 | 可用占位符 |
|---|---|---|---|---|
| P1 | nudge 普通档首句 | `src/nudge.ts:123` | "Context usage is at X%. This is a suggestion, not a requirement…" | `{pct}` |
| P2 | nudge 紧急档首句 | `src/nudge.ts:122` | "⚠️ Context usage is at X% of the window — nearly full…" | `{pct}` |
| P3 | nudge 指导行 | `src/nudge.ts:124` | "Compress by need, not by percentage…" | 无 |
| P4 | nudge tier 蒸馏行 | `src/nudge.ts:126-136` | "Tier 2: 3 tier-1 block(s) distillable (4750 tokens)…"(数字直出,**无 K 格式化**) | `{tier} {count} {prevTier} {tokens} {seqs}` |
| P5 | nudge 范围表 | `src/nudge.ts:38-49` | 表头 "Surface: …" + 标题 + 每行 + 表尾调用语法 | 表头 `{surface}`;标题 `{count}`;行 `{start} {end} {count} {tokens}`;表尾无 |
| P6 | system prompt(一次性) | `src/system-prompt.ts:12` | 整段 ACP 指导(含 kernel 的 `COMPRESS_PHILOSOPHY`) | `{philosophy}` |
| P7 | 工具描述 | `src/tools.ts:355-395` | compress / decompress / search_context / acp_status 的 description | 无 |

## 3. 核心机制:模板 + 命名占位符

### 3.1 为什么不能做朴素 `{name}` 替换

现有提示词正文大量出现字面花括号:

```
compress({ content: [{ startSeq, endSeq, summary }] })
```

朴素正则替换会把这些字面花括号当成占位符吞掉。**解法:占位符语法收紧为"花括号 + 标识符"**:

- 占位符 token 匹配正则:`\{([A-Za-z_][A-Za-z0-9_]*)\}`;
- `{ startSeq, endSeq, summary }` 含空格/逗号,不是标识符 token → **原样保留**;
- 渲染时只替换该槽位**允许列表内**的名字,其余花括号一律字面输出。

**安全性已逐字核验**:`COMPRESS_PHILOSOPHY` 全文**零个花括号**;nudge 默认模板、范围表四段、系统提示模板、四个工具描述中的所有字面花括号均为"花括号后跟空格"(如 `compress({ content: …`)或"空格后跟花括号",均不匹配占位符正则。解法成立。

### 3.2 渲染函数

```ts
const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * 纯替换。两个契约:
 * 1. 未知占位符不可能到达这里(构建期已校验,见 §3.3);
 * 2. 已知占位符缺值 = 编程错误 → throw(绝不静默渲染空串)。
 *    (I6:与"绝不静默出错"一致;调用方必须保证 vars 覆盖模板全部占位符,
 *    例如 tokens 由 typeof 兜底恒为 number,见 §5.1)
 */
export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(PLACEHOLDER_RE, (_match, name: string) => {
    const value = vars[name]
    if (value === undefined) {
      throw new Error(`renderTemplate: missing value for placeholder {${name}} in template "${template.slice(0, 60)}…"`)
    }
    return String(value)
  })
}
```

> 用函数 replacer 而非字符串 replacer:`String.replace` 的函数 replacer 不解释 `$&`/`$1`,变量值含 `$` 也不会被吞。

### 3.3 构建期校验(核心安全网)

每个槽位声明自己的允许占位符集;`resolvePrompts()` 在**引擎构造期**扫描**用户覆盖的模板**(默认模板已在开发期核验、不重扫——与 §6 `DEFAULT_RESOLVED` 零校验重跑一致,W2):

- 遇到不在允许列表内的 `{ident}` → **throw**,错误信息带槽位路径,如:
  `prompts.nudge.normal contains unknown placeholder {pctt} — allowed: pct`;
- 这样拼写错误在启动时炸,而不是把 `{pct}` 字面漏进模型上下文(符合项目"绝不静默出错"的规矩)。

## 4. 类型设计(新文件 `src/prompts.ts`)

```ts
/** 用户可写值:字符串模板,或 null(= 用默认,等价于不写)。YAML 宿主写 null 是合法输入。 */
type PromptInput = string | null

/** 按组生成"每键可选、可 null"的覆盖类型,避免手工重复结构。 */
type PromptOverride<T> = { [K in keyof T]?: PromptInput }

export interface NudgePrompts {
  /** P1 普通档首句。占位符:{pct} */
  normal: string
  /** P2 紧急档首句。占位符:{pct} */
  emergency: string
  /** P3 指导行。无占位符 */
  guidance: string
  /** P4 tier 蒸馏行。占位符:{tier} {count} {prevTier} {tokens} {seqs} */
  tier: string
}
export interface RangeTablePrompts {
  /** P5 表头。占位符:{surface} */
  header: string
  /** P5 标题。占位符:{count}(表格行数) */
  title: string
  /** P5 每行。占位符:{start} {end} {count} {tokens} */
  line: string
  /** P5 表尾调用语法。无占位符 */
  footer: string
}
export interface ToolPrompts {
  /** P7 工具描述(均为纯文本,无占位符) */
  compress: string
  decompress: string
  searchContext: string
  acpStatus: string
}

export interface AcpPrompts {
  readonly nudge?: PromptOverride<NudgePrompts>
  readonly rangeTable?: PromptOverride<RangeTablePrompts>
  readonly tools?: PromptOverride<ToolPrompts>
  /** P6 整段 system prompt 模板;`{philosophy}` 引用 kernel 的 COMPRESS_PHILOSOPHY */
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

/** 现有文案原样搬入(§5),默认渲染与当前逐字节一致。 */
export const DEFAULT_PROMPTS: ResolvedPrompts = { … }

/** 模块级默认缓存:默认参/兜底直接引用,避免每次调用重跑校验。 */
export const DEFAULT_RESOLVED: ResolvedPrompts = DEFAULT_PROMPTS

/**
 * 深合并 + 校验;构造期调用,出错即抛。
 * 合并规则:逐键比较 —— null / undefined → 取默认;字符串 → 覆盖默认。
 * 不用 spread(否则 null 会覆盖默认,与"null = 用默认"矛盾)。
 */
export function resolvePrompts(input?: AcpPrompts): ResolvedPrompts { … }

/** 渲染 system prompt 模板(注入 {philosophy})。 */
export function renderSystemPrompt(prompts: ResolvedPrompts): string { … }
```

**值语义(B3 定案):**

- `null` / `undefined`(或省略该键)= 用默认;
- 空字符串 `''` = **故意渲染为空**(删除该行);
- **组级 null 防御(W3)**:YAML 宿主可能写 `prompts: { nudge: null }`(键级 null 在 TS 下合法,组级 null 过不了类型但 YAML 无类型检查);`resolvePrompts` 对组级 null 视为**整组用默认**——逐键比较前先做组级归一化;
- 类型层面 `PromptInput = string | null`,`ResolvedPrompts` 全是 `string`——null 只存在于输入侧,解析后被归一化,消费方永远看到 string。

**空串删除的精确装配语义(I5/N1 定案)——以 nudge 为例,规则逐字节复现现状输出:**

```
nudge 装配(精确复现现状 src/nudge.ts:125-138):
  parts = [frame]
  if (guidance 渲染非空)  push('', guidance)   // 分隔空行由这里提供
  if (tier 条件满足 && tier 行渲染非空)  push(tier 行)  // 紧跟 guidance,单换行分隔(现状 :133-135);tier 空串 = 删除该行(W1)
  push(rangeTable(session, prompts))            // 无条件 push:零范围返回 '' 也 push(保留现状尾部 '\n')
  return parts.join('\n')
```

字节对照表(实测现状输出,实现后必须逐字节一致):

| 情形 | 完整字节 |
|---|---|
| 默认有范围 | `frame` `\n\n` `guidance` `\n\n` `Surface: …`(guidance 与表头间 1 空行,该空行由范围表内部前导元素提供) |
| tier + 范围 | `frame` `\n\n` `guidance` `\n` `tierLine` `\n\n` `Surface: …`(tier 紧跟 guidance,单换行;表前空行由范围表前导元素提供) |
| 零范围 | `frame` `\n\n` `guidance` `\n`(**尾部 `\n` 是字节的一部分**——范围表返回 `''` 仍被 push) |
| `guidance: ''` | `frame` `\n\n` `Surface: …`(干净删除 guidance;表前空行仍由范围表前导元素提供,共 1 空行) |
| `normal: ''` | 输出以 `\n\n` 开头(实测,S4;允许,文档如此定义) |

**三个最容易写错的细节(N1/W1):**
1. 范围表**不在 parts 层再加 `''` 分隔**——表前空行完全由范围表内部前导元素提供(§5.2),再加就是双分隔;
2. tier 行**不加分隔**,紧跟 guidance 单换行——加了就与现状字节不符;
3. tier 行与 guidance 一样有"渲染非空"守卫——`tier: ''` = 删除该行,与 §4 值语义统一;默认模板恒渲染非空,对默认字节零影响。

## 5. 默认值(DEFAULT_PROMPTS)—— 从现有源码逐字搬迁

> 硬约束:以下默认模板渲染结果必须与当前源码输出**逐字节相同**;现有测试(`tests/nudge.test.ts` 断言 `/Tier 2: 1 tier-1 block\(s\) distillable \(4750 tokens\)/`、`/Surface: 12 nodes, seqs 1\.\.12/` 等)全部保持绿色。

### 5.1 nudge

```ts
nudge: {
  normal:    'Context usage is at {pct}%. This is a suggestion, not a requirement — you decide whether and when to compress.',
  emergency: '⚠️ Context usage is at {pct}% of the window — nearly full. Consider compressing consumed ranges soon so working context stays available; the choice and timing are yours.',
  guidance:  'Compress by need, not by percentage: replace only ranges you have genuinely consumed, with dense self-contained summaries.',
  tier:      'Tier {tier}: {count} tier-{prevTier} block(s) distillable ({tokens} tokens) — compress their summary node(s) [seqs {seqs}] to reclaim the original messages.',
}
```

渲染变量映射(调用方 buildNudgeText 负责补齐,配合 §3.2 缺值即抛契约):

- `pct` = `Math.round(Math.min(nudge.contextUsage, 1) * 100)`(封顶 100 的既有逻辑保留);
- `tier` = `nudge.tier`;`prevTier` = `nudge.tier - 1`;
- `count` = 目标块数(`nudge.tierTargetBlocks.length`);
- `tokens` = **`typeof pending === 'number' ? pending : 0`(B2:保留现有守卫,见 src/nudge.ts:131-132)**,其中 `pending = nudge.tier === 2 ? nudge.breakdown?.pendingT2 : nudge.breakdown?.pendingT3`——恒为 number,绝不让 `{tokens}` 渲染成空;
- `seqs` = `summarySeqs`(已过滤 null)逗号拼接;**全 null 时为空数组 → 渲染为 `''`(定义值,非缺值,不触发 §3.2;`[seqs ]` 与现状一致,S1)**。

**条件渲染规则(I1):** tier 行是**条件块**——仅当 `nudge.tier === 2 || nudge.tier === 3` 且 `tierTargetBlocks` 非空时才渲染(对应现状 src/nudge.ts:126);T1 普通 nudge 无 tier 行。

### 5.2 范围表

```ts
rangeTable: {
  header: 'Surface: {surface}',
  title:  'Compressible ranges (suggestions only — compress any consumed span; refs are surface seqs):',
  line:   '  - seq {start}..{end} — {count} messages, ~{tokens} tokens',
  footer: 'Compress with: compress({ content: [{ startSeq, endSeq, summary }] }) — content is an array: batch multiple unrelated segments in one call, each entry its own block. Keep ranges disjoint.',
}
```

渲染映射:`surface` = `surfaceSummary(session)`;行级 `start/end/count/tokens` 来自 `buildCompressibleSeqRanges(session).slice(0, 6)` 的每一项;`title` 的 `{count}` = 显示行数(截断后)。

**装配规则(I1,字节恒等的细节):**

- **零范围提前返回**:`buildCompressibleSeqRanges` 为空时整个函数返回 `''`(保留现状 src/nudge.ts:40 的提前返回,否则空表会渲染出 header/title/footer 骨架);
- 有范围时内部装配为 `['', header, title, ...lines, footer].join('\n')`(前导空串元素产生 nudge 中范围表前的**唯一**空行;§4 的 parts 层**不再**为范围表 push `''`,避免双分隔);
- **行级空串语义(N4)**:范围表**内部**各行渲染为空串时保留为空行(join 语义不变,不做行级省略);仅整块为空串(零范围)时整体省略。行级"删除"不支持——想删哪行就自行设计该模板内容;
- **`title` 的 `{count}` 由渲染器恒传 `lines.length`**:自定义 title 引用 `{count}` 不会缺值(否则只能在渲染期靠 I6 抛错,构造期校验覆盖不到);
- 范围表始终作为 nudge 的一个可选块保留(它是模型寻址的机制,不是散文;实测中即使 usage 只有 7%,范围表仍是 nudge 里最有价值的部分)。

### 5.3 system prompt

把现有 `ACP_SYSTEM_PROMPT` 中的 `${COMPRESS_PHILOSOPHY}` 原地换成占位符:

```ts
systemPromptTemplate:
  'Active Context Pruning — model-driven context management\n\n'
  + 'YOU decide whether and when to compress context. …(现有全文)…\n\n'
  + '{philosophy}\n\n'
  + 'Compression tools (refs are SURFACE SEQS, not ids):\n…(现有全文)…'
```

`renderSystemPrompt` 注入 `{philosophy: COMPRESS_PHILOSOPHY}`(kernel 导入保持不变)。

### 5.4 工具描述

```ts
tools: {
  compress:      'Replace older conversation ranges with dense summaries you write. Each message seq is a surface reference. Single range: compress({ content: [{ startSeq, endSeq, summary }] }). Batch multiple unrelated ranges in one call (each content entry becomes its own block); keep ranges disjoint. Never compress content the current step is actively using.',
  decompress:    'Recover the original content of a compressed block by its blockId (read-only; does not unshadow the range).',
  searchContext: 'Search inside compressed blocks (summaries and original content) for information the model no longer sees in context.',
  acpStatus:     'Report the ACP block ledger: compressed blocks, reclaimed tokens, and current context pressure.',
}
```

## 6. 接线改动(逐文件落点)

| 文件 | 改动 |
|---|---|
| `src/prompts.ts`(新) | 类型 + `DEFAULT_PROMPTS` + `DEFAULT_RESOLVED` + `resolvePrompts` + `renderTemplate` + `renderSystemPrompt` |
| `src/index.ts` | 新增实例字段 `readonly prompts: ResolvedPrompts`(赋值先于 env 构建,S5);`AcpConfig` 加 `readonly prompts?: AcpPrompts`;构造器 `this.prompts = resolvePrompts(config.prompts)`(**fail-fast**);env 带 `prompts: this.prompts`;system prompt section 用 `renderSystemPrompt(this.prompts)`;**顺带修复(I-建议4)**:systemPrompt.section 注册补 `internal/service` 冷启动重试(与同文件 tools/commands 的 registerTools 模式一致,现状 `ctx.get('systemPrompt')` 缺席时 ACP 段落会永久丢失) |
| `src/nudge.ts` | `NudgeEnvironment` 加 `readonly prompts?: ResolvedPrompts`;**B1 关键行**:`buildNudge` 内 `nudge.ts:100` 的调用改为 `buildNudgeText(nudge, emergency, session, env.prompts)`——这是配置进入 nudge 的**唯一转发点**,漏掉 = 配置被接受但静默失效;`buildNudgeText(nudge, emergency, session, prompts = DEFAULT_RESOLVED)`(可选末参);`rangeTable(session, prompts = DEFAULT_RESOLVED)`;拼装改用模板渲染(§4 装配规则) |
| `src/tools.ts` | `ToolEnvironment` 加 `readonly prompts?: ResolvedPrompts`;`makeTools` 里四个 description 从 `env.prompts.tools.*` 取,缺省 `DEFAULT_RESOLVED` |
| `src/system-prompt.ts` | `ACP_SYSTEM_PROMPT` 改为"默认模板渲染结果"导出(名称与语义不变);模板/渲染逻辑留在 `prompts.ts` |
| `AGENTS.md` | 模块图加 `prompts.ts`(M4) |
| `docs/README.md` | ~~加索引行~~ **已完成**(v1 已收录本设计文档条目) |

**可选性设计:** env 上的 `prompts?: ResolvedPrompts` 是可选的,消费方用 `env.prompts ?? DEFAULT_RESOLVED` 兜底——`DEFAULT_RESOLVED` 是模块级常量,**零开销、零校验重跑**,因此两个测试文件里的局部 `makeEnv`(`tests/nudge.test.ts:33`、`tests/tools.test.ts:14`;**不是** tests/helpers.ts——该文件只有 session 构建函数,I7 修正)都不需要改,现有 54 条测试原样通过。

## 7. 向后兼容清单

- `buildNudgeText(nudge, emergency, session)` 三参调用不变(第四参有默认值);
- `rangeTable(session)` 不变(第二参可选);
- `ACP_SYSTEM_PROMPT` / `ACP_SYSTEM_PROMPT_ORDER` 导出不变(`index.ts` 原样 re-export);
- `AcpConfig` 现有字段全部不动,只新增 `prompts`;
- 未配置 `prompts` 的部署:行为与现在完全相同(默认模板渲染 = 现文案)。

## 8. 测试计划(新增 13 条 + 现有 54 条回归)

> **快照原则(I3/I4):** 所有"逐字节回归"断言用**硬编码在测试里的字面量**(实现改造前抄下来的当前输出),与实现分离——测试与实现不同源,改造引入的字节差异(em-dash、⚠️、尾部空格、换行)都会被抓住。不依赖"改造后的 ACP_SYSTEM_PROMPT 导出"作比较(那是循环论证)。

1. **system prompt 快照回归**:`renderSystemPrompt(resolvePrompts())` === 硬编码的当前 `ACP_SYSTEM_PROMPT` 全文字面量;
2. **nudge 普通档全文本快照**:`buildNudgeText` 以 `pct=7` 渲染,**零范围会话**(范围表返回 `''`)→ 完整字节 === 硬编码字面量 `frame + '\n\n' + guidance + '\n'`(**尾部 `\n` 是字节的一部分,必须保留**;用 `assert.equal` 整串比较,N3);
3. **nudge 紧急档全文本快照**:`pct=96` 紧急档,零范围会话,完整字节 === 硬编码字面量(含 ⚠️ 与连字符、尾部 `\n`);
4. **范围表快照**:`rangeTable` 对固定 session 的完整输出 === 硬编码字面量(含前导空行);另加**零范围回归**:无可压缩范围时返回 `''`;
5. **工具描述快照**:四个 description === 硬编码字面量;
6. **深合并 + null 归一化**:只覆盖 `nudge.normal`,其余槽位仍是默认;`guidance: null` → 默认(B3);
7. **占位符替换**:`normal: '上下文 {pct}%'` 渲染出正确百分比;
8. **未知占位符抛错**:`normal: '…{pctt}…'` → throw,错误信息含槽位路径 `prompts.nudge.normal`;
9. **已知占位符缺值抛错(I6)**:`renderTemplate('{tokens}', {})` → throw;
10. **空串删除行(I5/N1)**:`guidance: ''` 的 nudge(有范围会话)完整字节 === `frame + '\n' + rangeTable`——不含 guidance 文本,表前恰 1 空行(由范围表前导元素提供);
11. **tokens 兜底回归(B2)**:pending 缺失(pendingT2/pendingT3 为 undefined)的 tier nudge 渲染出 `(0 tokens)` 而非 `( tokens)`;**注(S3)**:`NudgeBreakdown.pendingT2/pendingT3` 在 acp-kernel 类型里是**必填** number(types.d.ts:183-185),测试构造缺省时需类型断言(项目无 `as any`,用 `as never`/省略字段 cast,与现有 nudge.test.ts:117 同法);
12. **接线集成测试(B1)**:构造带 `prompts: resolvePrompts({ nudge: { normal: 'CUSTOM {pct}' } })` 的 env → `buildNudge` → 注入消息以 `CUSTOM` 开头(转发缺失时是默认文案,测试红);
13. **中文覆盖冒烟**:整套中文 nudge + 范围表 + system prompt 渲染,断言关键中文子串(i18n 场景可用);
14. **回归**:现有 54 条测试全部保持绿色(它们断言了默认文本子串,见 §5 硬约束)。

验收命令:`npm run typecheck && npm test && npm run build`。

## 9. v1 边界(明确不做)与理由

| 不做 | 理由 |
|---|---|
| 工具**结果**文本(compress 结果行、acp_status 格式) | 数据格式而非提示;配置会让模型看到的结构不稳定 |
| 工具**错误/引导消息**(I2,如 `compress failed: …`、`decompress: block "…" not found (see acp_status …)`、`search_context: no matches for …`、`seq N..M has no assigned ref — …(run acp_status …)`、`resolveSurfaceRange` 的校验文案) | 运行时**反馈**,模板化会掩盖修复路径(把错误文案写死成模板,用户改错会误导排查);且它们携带动态数据,属于工具输出范畴。v2 再评估 |
| 工具**参数级**描述(如 summary 字段描述) | 承载性指导,值得配,但会显著扩大 schema 面 → v2 |
| 函数式模板(`string \| (vars) => string`) | 宿主配置是 YAML,函数进不去;程序化使用者可自行预渲染成字符串 |
| 内置 `locale: 'zh-CN'` 预设 | 模板机制已能表达全部翻译;内置预设属于产品决策,留待需要时再加 |
| 模板**转义**语法(输出字面 `{ident}`)(S2) | 用户要字面输出 `{标识符}` 目前无转义,构建期校验会拒绝;需要时先用空格隔开规避(如 `{ {pct} }`),正式 {% raw %}`{{`{% endraw %} → `{` 转义留待 v2 按需引入 |

## 10. 备选方案与取舍记录(评审时可推翻)

1. **throw vs warn(未知占位符)**:选 throw。项目规矩是"绝不静默出错";配置错误应在启动时暴露。代价:构造器可能因配置崩启动——这正是 fail-fast 的意图。
2. **throw vs 空串(已知占位符缺值,I6)**:选 throw。缺值 = 调用方编程错误(不是用户配置错误),静默渲染空串会产出错文本;调用方以 §5.1 的 typeof 兜底保证恒有值。
3. **null 归一化 vs 拒绝 null(B3)**:选"输入接受 `string \| null`,解析时 null → 默认"。YAML 宿主写 `null` 是自然表达"恢复默认"的方式,拒绝它会让用户被迫删行;归一化后类型系统只见 string,无歧义。
4. **逐键合并 vs spread(B3)**:选逐键。spread 下 `null` 会覆盖默认值,与"null = 用默认"矛盾;逐键 `null/undefined → 默认,string → 覆盖` 语义唯一。
5. **整段替换 vs 分节拼接(system prompt)**:选整段模板 + `{philosophy}` 占位符。system prompt 是最不常改的,整段覆盖足够,`{philosophy}` 保留引用 kernel 哲学的能力;分节拼接留给 v2(如确需)。
6. **env 上可选 `prompts?` + `DEFAULT_RESOLVED` 兜底**:选前者,零测试churn(§6 可选性设计);校验成本集中在引擎构造器一次,兜底走模块级常量零开销。
7. **占位符集合每槽声明**:牺牲一点点灵活性(某槽位不能用另一个槽位的变量),换来构建期静态校验的可行性——这是本设计的关键取舍。
