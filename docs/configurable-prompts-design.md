# 可配置提示词设计(Configurable Prompts Design)— v7

> **修订记录(v7,防过度压缩文案提升为默认,issue #55):**
> - **R6**:默认模板追加三条防过度压缩引导(见 issue #55:审阅/核对型任务中模型"读完文件→立刻 compress→又 decompress→再压缩"循环):① `WHEN NOT TO COMPRESS` 新增「Content you will still need to cite verbatim — in review/audit/verification tasks, keep source reads un-compressed until the final report is written. If you compressed it and now need the exact detail, decompress costs a full round-trip; prefer delaying the compress.」;② compress 工具描述的 subtask completion 触发词加限定「whose details you have fully consumed and will not re-check」;③ compress 工具描述末尾加自问兜底「Before compressing, ask: will I need to re-verify any detail from this range in this task? If yes, keep it live.」。三条文案先经本地 `cordis.patch.yml` 覆盖(`prompts.tools.compress` + `prompts.systemPrompt`)长时间实测有效,再提升为默认模板——与 R5(#43)同一提升路径。回归:prompts 测试 #5d 钉住三条语义载体,测试 #5 字节快照与 #1 的 WHEN NOT 断言同步更新。改宿主默认模板,不 bump kernel。提升后,本地 `cordis.patch.yml` 中的同名覆盖成为冗余(内容一致),可自行移除。
> - **R5**:默认 compress 工具描述追加语义压缩时机 + 可行动摘要两句(见 issue #43,AgentFold/CAT 论文启发):「Good compression moments: stage or subtask completion, strategy switches, intermediate milestones, and wrapping up failed exploration — when the details are consumed and no longer critical for the task ahead.」+「When you write a summary, turn dead-end exploration into a conclusion (what was tried, why it failed, the next step) — not a blow-by-blow; and keep the summary the ONLY record.」——纯文案增强,改宿主默认模板,不 bump kernel。
> - **R1**:默认(无 `prompts.nudge` 覆盖)`buildNudgeText` 直接调用 kernel `renderNudgeText(nudge)`——EFFICIENCY_NOTE/EMERGENCY_HEADER、breakdown、HOW_TO_COMPRESS_RULES、TIER2/3 规则、`💡` tip **全部来自 acp-kernel 原文**,不再手抄模板。仅把 ref-ID 导向的段替换为 surface-seq 版本:`rangesStr`(mNNNNN)→ 我们的范围表;紧急档 JSON example(startId/endId)→ seq 示例;tier 触发块(bN block ids)→ 我们的 tier 行。零范围时保留 kernel 的 "[No specific ranges detected]" 提示。
> - **R2**:**双路径分派**——`prompts.nudge !== DEFAULT_RESOLVED.nudge`(宿主覆盖了任何 nudge 槽位)→ 走模板渲染路径(`renderNudgeFromTemplates`,v5 装配原样保留,config.prompts 定制优先);否则走 kernel 路径。默认引用(未覆盖)与模板路径按引用相等判断。
> - **R3**:kernel 路径下紧急档**无 `💡 tip`**(kernel 紧急分支没有批量提示行)——这是与 kernel 对齐的行为变化,测试 #3 断言同步更新。
> - **R4**:**compress 工具参数包裹容错**——部分模型把参数写成 `{ "arguments": "{\"content\": [...]}" }`(双重嵌套)或 `{ "arguments": { "content": [...] } }`;旧 DSH 校验器报 `invalid arguments: "arguments" must be an object` 导致模型无限重试。修复:schema 增加可选 `arguments`(type: `json`)节点 + `content` 去掉 `required: true`(required 会在解包前拒绝包裹形态),`handleCompress` 用 `unwrapCompressArgs` 解包;两种形态都不带 content 时报清晰错误。
>
> **修订记录(v5,对齐 kernel/billion-context-pi 的 nudge 文案与装配):**
> - **K1**:默认 nudge 文案对齐 kernel——普通档首句从"suggestion, not a requirement"改为"efficiency nudge to compress early and keep context lean";紧急档从"Consider…the choice is yours"改为"⚠️ Context limit reached — compress now";两档均在模板中嵌入 `{philosophy}`(kernel `COMPRESS_PHILOSOPHY`)。
> - **K2**:`NudgePrompts` 新增 3 个槽位——`breakdown`(上下文分解,占位符 `{system} {tool} {summaries} {code} {text}`)、`growth`(增长行,`{growth}`)、`tip`(批量压缩提示,无占位符);默认值逐字对齐 kernel `nudge-text.ts` 的 `formatBreakdown` / `formatRanges` 尾部 `💡` 行。
> - **K3**:nudge 装配顺序对齐 kernel `renderNudgeText`——`frame(内嵌 philosophy)` → `breakdown` → `growth` → `guidance`(默认 = kernel `HOW_TO_COMPRESS_RULES`) → `tier` 行(+ kernel `TIER2_DISTILL_RULES`/`TIER3_CONDENSE_RULES`) → 范围表(仅非 tier nudge) → `tip`。**tier nudge 不再渲染范围表**(tier 目标块由 tier 行 + 蒸馏规则承载,与 kernel 一致)。
> - **K4**:system prompt 模板新增占位符 `{howToCompressRules}` / `{tier2DistillRules}` / `{tier3CondenseRules}`(分别注入 kernel `HOW_TO_COMPRESS_RULES` / `TIER2_DISTILL_RULES` / `TIER3_CONDENSE_RULES`),并新增 `WHEN TO COMPRESS` / `WHEN NOT TO COMPRESS` 场景清单(对齐 pi 的 `ACP_SYSTEM_PROMPT`);首段去掉 "Nothing forces you" 语气,改为效率通知框架。
> - **K5**:`renderSystemPrompt` 的注入变量从 `{philosophy}` 单占位符扩展为 4 个;`buildNudgeText` 的 `{philosophy}` 由调用方渲染(normal/emergency 模板内嵌)。
>
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

1. **默认输出逐字节不变**——v4 的模板化迁移不改文案(现有测试断言了精确子串,默认渲染必须与迁移前完全一致);**v5 例外**:在模板化之上**故意**把默认 nudge 文案与 system prompt 对齐 kernel/billion-context-pi(K1–K4),该轮默认文案的字节以本 PR 的新快照为准;
2. **构造期 fail-fast**——配置拼写错误在引擎启动时抛错,而不是在会话中途悄悄漏进提示词;
3. **向后兼容**——`buildNudgeText` / `rangeTable` / `ACP_SYSTEM_PROMPT` 的现有导出签名继续可用;
4. **YAML 友好**——配置必须是 JSON/YAML 可序列化的纯字符串(null 允许,函数不支持)。

## 2. 可配置面盘点(分阶段提示词全清单)

| # | 阶段 | 当前位置 | 内容 | 可用占位符 |
|---|---|---|---|---|
| P1 | nudge 普通档首句 | `src/prompts.ts`(DEFAULT_PROMPTS.nudge.normal) | kernel `EFFICIENCY_NOTE` 逐字——"This is an efficiency nudge to compress early and keep context lean — not an overflow warning. …"(内嵌 philosophy;**不含 "Context usage is at X%" 陈述**,usage 只通过 breakdown 传达) | `{pct}` `{philosophy}` |
| P2 | nudge 紧急档首句 | `src/prompts.ts`(DEFAULT_PROMPTS.nudge.emergency) | "⚠️ Context limit reached — compress now. Prioritize consumed tool outputs."(内嵌 philosophy) | `{pct}` `{philosophy}` |
| P3 | nudge 指导行 | `src/prompts.ts`(DEFAULT_PROMPTS.nudge.guidance) | kernel `HOW_TO_COMPRESS_RULES` 全文(KEEP/DROP/PRIORITY/格式) | 无 |
| P4 | nudge tier 蒸馏行 | `src/nudge.ts`(buildNudgeText) | "Tier 2: 1 tier-1 block(s) distillable (4750 tokens) — compress their summary node(s) [seqs …]…" | `{tier} {count} {prevTier} {tokens} {seqs}` |
| P8 | nudge 上下文分解 | `src/prompts.ts`(DEFAULT_PROMPTS.nudge.breakdown) | "Context breakdown: 0K system \| 134K tool \| 0K summaries \| 10K code \| 7K text"(对齐 kernel `formatBreakdown`) | `{system} {tool} {summaries} {code} {text}` |
| P9 | nudge 增长行 | `src/prompts.ts`(DEFAULT_PROMPTS.nudge.growth) | "+26K since last nudge" | `{growth}` |
| P10 | nudge 批量提示 | `src/prompts.ts`(DEFAULT_PROMPTS.nudge.tip) | "💡 Compress all ranges in one call (pass multiple content entries: `content: [{...}, {...}]`)." | 无 |
| P5 | nudge 范围表 | `src/nudge.ts`(rangeTable) | 表头 "Surface: …" + 标题 + 每行 + 表尾调用语法 | 表头 `{surface}`;标题 `{count}`;行 `{start} {end} {count} {tokens}`;表尾无 |
| P6 | system prompt(一次性) | `src/system-prompt.ts` | 整段 ACP 指导:效率通知框架 + philosophy + WHEN TO/WHEN NOT + HOW_TO_COMPRESS_RULES + 工具描述 + tier 蒸馏/浓缩规则 | `{philosophy}` `{howToCompressRules}` `{tier2DistillRules}` `{tier3CondenseRules}` |
| P7 | 工具描述 | `src/tools.ts:500-535` | compress / decompress / search_context / acp_status 的 description | 无 |

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
  /** P1 普通档首句。占位符:{pct} {philosophy} */
  normal: string
  /** P2 紧急档首句。占位符:{pct} {philosophy} */
  emergency: string
  /** P3 指导行(默认 = kernel HOW_TO_COMPRESS_RULES)。无占位符 */
  guidance: string
  /** P4 tier 蒸馏行。占位符:{tier} {count} {prevTier} {tokens} {seqs} */
  tier: string
  /** P8 上下文分解。占位符:{system} {tool} {summaries} {code} {text} */
  breakdown: string
  /** P9 增长行。占位符:{growth} */
  growth: string
  /** P10 批量压缩提示。无占位符 */
  tip: string
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

**双路径装配(R1/R2 定案,v6)——默认走 kernel 渲染,覆盖走模板:**

```
buildNudgeText(nudge, emergency, session, prompts):
  if (prompts.nudge !== DEFAULT_RESOLVED.nudge):        // R2:宿主覆盖了 nudge 槽位
    return renderNudgeFromTemplates(...)                 // 模板路径(v5 装配,见下)
  // 默认:kernel renderNudgeText + seq 段适配(R1)
  rendered = renderNudgeText(nudge)                      // EFFICIENCY_NOTE/EMERGENCY_HEADER、
                                                         // breakdown、HOW_TO_COMPRESS_RULES、
                                                         // TIER2/3 规则、💡 tip 全部来自 kernel 原文
  return adaptKernelNudgeToSeq(rendered.text, ...):
    if (tier 2/3 && tierTargetBlocks 非空)  replaceTierTrigger(...)   // bN 块 id 段 → 我们的 tier 行(seqs)
    else if (text 含 '"startId"')           replaceEmergencyExample(...) // startId/endId 示例 → seq 示例
    if (rangeTable(session, prompts) !== '') replaceRangesStr(...)      // mNNNNN 范围表 → surface-seq 表
    // 零范围:保留 kernel 的 "[No specific ranges detected]" 提示(比空表好)
```

模板路径(仅覆盖时)装配顺序(v5 原样,config.prompts 定制优先):

```
  parts = [frame]                       // frame = normal/emergency 模板渲染({pct} + {philosophy} 内嵌)
  if (breakdown 渲染非空)  push('', breakdown)   // P8,来自 nudge.contextBreakdown
  if (growth 渲染非空)     push(growth)          // P9,仅 contextBreakdown.growth > 0 时渲染
  if (guidance 渲染非空)  push('', guidance)     // P3 默认 = HOW_TO_COMPRESS_RULES;分隔空行由这里提供
  if (tier 条件满足 && tier 行渲染非空) {
    push(tier 行)                              // P4,紧跟 guidance,单换行分隔
    push('', tierRules)                        // K3:tier nudge 附加 TIER2_DISTILL_RULES / TIER3_CONDENSE_RULES
  } else {
    push(rangeTable(session, prompts))          // K3:仅非 tier nudge 渲染范围表;零范围返回 '' 也 push
  }
  if (tip 渲染非空)  push('', tip)              // P10 💡 批量提示,对齐 kernel 尾部行
  return parts.join('\n')
```

字节对照表(v6;R3 后默认紧急档**无 `💡 tip`**——kernel 紧急分支本来就没有批量提示行):

| 情形 | 完整字节 |
|---|---|
| 默认有范围(非 tier) | kernel 渲染,`rangesStr` 段替换为 `\n` + 我们的范围表;尾部 `💡 tip` 保留 |
| 默认紧急档 | kernel 渲染,JSON example 段替换为 seq 示例 + `rangesStr` 段替换为范围表;**无 tip**(R3,kernel 对齐) |
| 默认 tier | kernel 渲染,`[TIER n TRIGGER]` 段替换为我们的 tier 行;TIER2/3 规则保留 |
| 默认零范围 | kernel 渲染,保留 "[No specific ranges detected]" 提示(R1,不替换为空) |
| 覆盖路径 | 模板装配(v5 字节表原样) |

**三个最容易写错的细节(N1/W1):**
1. 范围表**不在 parts 层再加 `''` 分隔**——表前空行完全由范围表内部前导元素提供(§5.2),再加就是双分隔;
2. tier 行**不加分隔**,紧跟 guidance 单换行——加了就与现状字节不符;
3. tier 行与 guidance 一样有"渲染非空"守卫——`tier: ''` = 删除该行,与 §4 值语义统一;默认模板恒渲染非空,对默认字节零影响。

## 5. 默认值(DEFAULT_PROMPTS)—— 从现有源码逐字搬迁

> 硬约束:以下默认模板渲染结果必须与 v5 源码输出**逐字节相同**(K1–K4 是本 PR 的默认文案基线——normal/emergency/guidance/system prompt 已按 kernel/pi 对齐,下方 §5.1/§5.3 即新基线的逐字内容);现有测试(`tests/nudge.test.ts` 断言 `/Tier 2: 1 tier-1 block\(s\) distillable \(4750 tokens\)/`、`/Surface: 12 nodes, seqs 1\.\.12/` 等)全部保持绿色。
>
> **实现时与 main v0.1.8 对齐**:本设计定稿于 main v0.1.7 时代,实现 rebase 到 v0.1.8 后,默认文案已同步 main 的新增内容——范围表 footer 追加 stale-seq 提示行(提交 `ea1de6a`)、compress 工具描述追加 stale-remap 句(同提交)、system prompt 的 compress/acp_status 描述行更新(同提交)。下方示例即实现 `DEFAULT_PROMPTS` 的逐字内容。

### 5.1 nudge

> **R1 注**:默认(无覆盖)渲染**不经过这些模板**——`buildNudgeText` 直接调用 kernel `renderNudgeText`,帧/breakdown/规则/tip 全部来自 kernel 原文。下方 DEFAULT_PROMPTS.nudge 的模板值仅用于**宿主覆盖时**的模板路径(`renderNudgeFromTemplates`),作为"未覆盖槽位"的基线;它们的文本与 kernel 逐字对齐,保证覆盖路径与 kernel 路径输出一致。

```ts
nudge: {
  normal:    'This is an efficiency nudge to compress early and keep context lean — not an overflow warning. A separate, stronger alert will appear if the context is actually full.\n\n{philosophy}',
  emergency: '⚠️ Context limit reached — compress now. Prioritize consumed tool outputs.\n\n{philosophy}',
  guidance:  HOW_TO_COMPRESS_RULES,   // kernel 导入,见 acp-kernel/src/compression-rules.ts
  tier:      'Tier {tier}: {count} tier-{prevTier} block(s) distillable ({tokens} tokens) — compress their summary node(s) [seqs {seqs}] to reclaim the original messages.',
  breakdown: 'Context breakdown: {system}K system | {tool}K tool | {summaries}K summaries | {code}K code | {text}K text',
  growth:    '+{growth}K since last nudge',
  tip:       '💡 Compress all ranges in one call (pass multiple content entries: `content: [{...}, {...}]`).',
}
```

渲染变量映射(调用方 buildNudgeText 负责补齐,配合 §3.2 缺值即抛契约):

- `pct` = `Math.round(Math.min(nudge.contextUsage, 1) * 100)`(封顶 100 的既有逻辑保留);
- `philosophy` = kernel `COMPRESS_PHILOSOPHY`(K1:普通/紧急档模板内嵌,对齐 kernel `EFFICIENCY_NOTE` / `EMERGENCY_HEADER`);
- `tier` = `nudge.tier`;`prevTier` = `nudge.tier - 1`;
- `count` = 目标块数(`nudge.tierTargetBlocks.length`);
- `tokens` = **`typeof pending === 'number' ? pending : 0`(B2:保留现有守卫,见 src/nudge.ts)**,其中 `pending = nudge.tier === 2 ? nudge.breakdown?.pendingT2 : nudge.breakdown?.pendingT3`——恒为 number,绝不让 `{tokens}` 渲染成空;
- `seqs` = `summarySeqs`(已过滤 null)逗号拼接;**全 null 时为空数组 → 渲染为 `''`(定义值,非缺值,不触发 §3.2;`[seqs ]` 与现状一致,S1)**;
- `system/tool/summaries/code/text` = `nudge.contextBreakdown` 对应字段除以 1000 取整(K2,对齐 kernel `formatBreakdown` 的 K 格式化);`growth` = `contextBreakdown.growth / 1000` 取整,仅在 `growth > 0` 时渲染。

**条件渲染规则(I1 保留 + K3 新增):**
- tier 行是**条件块**——仅当 `nudge.tier === 2 || nudge.tier === 3` 且 `tierTargetBlocks` 非空时才渲染(对应 src/nudge.ts);T1 普通 nudge 无 tier 行;
- **K3**:tier nudge 在 tier 行后附加 kernel `TIER2_DISTILL_RULES`(tier=2)或 `TIER3_CONDENSE_RULES`(tier=3),且**跳过范围表**——tier 目标块由 tier 行 + 蒸馏规则承载,与 kernel `renderNudgeText` 一致;
- **breakdown 条件**:仅 `nudge.contextBreakdown` 存在时渲染(K2 新增,普通 nudge 有 breakdown、纯 tier 决策也可能有);`breakdown` 模板渲染为空串则整块省略。

### 5.2 范围表

```ts
rangeTable: {
  header: 'Surface: {surface}',
  title:  'Compressible ranges (suggestions only — compress any consumed span; refs are surface seqs):',
  line:   '  - seq {start}..{end} — {count} messages, ~{tokens} tokens',
  footer: 'Compress with: compress({ content: [{ startSeq, endSeq, summary }] }) — content is an array: batch multiple unrelated segments in one call, each entry its own block. Keep ranges disjoint.\n'
    + 'Snapshot taken at nudge time: the seqs go stale once the surface moves (a later compress shadows them), so re-run acp_status for fresh refs before compressing.',
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

把现有 `ACP_SYSTEM_PROMPT` 的可变段换成占位符(K4):

```ts
systemPromptTemplate:
  'Active Context Pruning — model-driven context management\n\n'
  + 'YOU decide whether and when to compress context. The nudge is an efficiency notification: …(v5 效率通知框架,去掉了 "Nothing forces you")…\n\n'
  + '{philosophy}\n\n'
  + 'WHEN TO COMPRESS:\n- …(7 条场景清单,对齐 pi ACP_SYSTEM_PROMPT)…\n\n'
  + 'WHEN NOT TO COMPRESS:\n- …(3 条,对齐 pi)…\n\n'
  + '{howToCompressRules}\n\n'
  + 'Compression tools (refs are SURFACE SEQS, not ids):\n…(现有全文)…\n\n'
  + 'Tiered compression: …\n\n{tier2DistillRules}\n\n{tier3CondenseRules}\n\n'
  + 'When you write a summary, …(现有结尾)…'
```

`renderSystemPrompt` 注入 4 个变量(K5):`{philosophy: COMPRESS_PHILOSOPHY}`、`{howToCompressRules: HOW_TO_COMPRESS_RULES}`、`{tier2DistillRules: TIER2_DISTILL_RULES}`、`{tier3CondenseRules: TIER3_CONDENSE_RULES}`(全部来自 kernel 导入)。

### 5.4 工具描述

```ts
tools: {
  compress:      'Replace older conversation ranges with dense summaries you write. Each message seq is a surface reference. Single range: compress({ content: [{ startSeq, endSeq, summary }] }). Batch multiple unrelated ranges in one call (each content entry becomes its own block); keep ranges disjoint. Never compress content the current step is actively using. Compress boundaries are SURFACE SEQS (acp_status Surface: row, latest nudge table) — NOT the block refs (bN, e.g. b1) that acp_status COMPRESSED BLOCKS shows, which are for decompress only. Drilldown mN refs (e.g. m00306) are ALSO accepted as startSeq/endSeq — they are auto-mapped to the live surface seq; an unknown mN (never assigned on the current surface) fails with guidance. Seq refs must come from the CURRENT surface (acp_status or the latest nudge): a span whose edges were shadowed by an earlier compress is auto-remapped to its still-live content, a fully compressed span is reported as already compressed, and invented/other-session seqs fail with guidance. Good compression moments: stage or subtask completion, strategy switches, intermediate milestones, and wrapping up failed exploration — when the details are consumed and no longer critical for the task ahead. When you write a summary, turn dead-end exploration into a conclusion (what was tried, why it failed, the next step) — not a blow-by-blow; and keep the summary the ONLY record: self-contained, so a later reader (or you, after decompress) can continue without the original.',
  decompress:    'Recover the original content of a compressed block by its blockId — the kernel block ref `bN` shown by acp_status (e.g. b1), or a compaction id from search_context (read-only; does not unshadow the range).',
  searchContext: 'Search inside compressed blocks (summaries and original content) for information the model no longer sees in context. When a summary lacks a detail you need (exact values, error strings, decisions, verbatim code), SEARCH the compressed blocks FIRST — never guess or reconstruct from memory: search_context(query) locates the right block, then decompress only that block to recover the original.',
  acpStatus:     'Context status: overview of the current context — CONTEXT BREAKDOWN (tool/text/summaries token shares of the visible total), COMPRESSED BLOCKS ledger, and the nudge decision. No args = overview. Percentages are shares of the visible content, not the context window. Note: the block refs in COMPRESSED BLOCKS (bN, e.g. b1) are for decompress; compress uses the Surface: seq range, not bN. Drilldown: pass scope:"compressed" for a per-block list, or scope:"uncompressed" with view:"messages" (every visible message) / view:"ranges" (merged ranges); tool filters to one tool name, sort reorders (size/time/tool; age for compressed), limit caps rows (default 30). Drilldown row refs are kernel ids (mN) — feed them straight to compress as startSeq/endSeq (auto-mapped to the live surface seq); bN is for decompress, Surface: seqs also work in compress.',
}
```
> 注:示例保持与 `src/prompts.ts` `DEFAULT_PROMPTS.tools.*` 逐字同步(本 PR 同步了 searchContext 强化版并顺带对齐了 decompress/acpStatus 两个此前过期的示例行)。

## 6. 接线改动(逐文件落点)

| 文件 | 改动 |
|---|---|
| `src/prompts.ts`(新) | 类型 + `DEFAULT_PROMPTS` + `DEFAULT_RESOLVED` + `resolvePrompts` + `renderTemplate` + `renderSystemPrompt` |
| `src/index.ts` | 新增实例字段 `readonly prompts: ResolvedPrompts`(赋值先于 env 构建,S5);`AcpConfig` 加 `readonly prompts?: AcpPrompts`;构造器 `this.prompts = resolvePrompts(config.prompts)`(**fail-fast**);env 带 `prompts: this.prompts`;system prompt section 用 `renderSystemPrompt(this.prompts)`;**顺带修复(I-建议4)**:systemPrompt.section 注册补 `internal/service` 冷启动重试(与同文件 tools/commands 的 registerTools 模式一致,现状 `ctx.get('systemPrompt')` 缺席时 ACP 段落会永久丢失) |
| `src/nudge.ts` | `NudgeEnvironment` 加 `readonly prompts?: ResolvedPrompts`;**B1 关键行**:`buildNudge` 内 `nudge.ts:100` 的调用改为 `buildNudgeText(nudge, emergency, session, env.prompts)`——这是配置进入 nudge 的**唯一转发点**,漏掉 = 配置被接受但静默失效;`buildNudgeText(nudge, emergency, session, prompts = DEFAULT_RESOLVED)`(可选末参);`rangeTable(session, prompts = DEFAULT_RESOLVED)`;**R1/R2 双路径**:默认引用 → kernel `renderNudgeText` + `adaptKernelNudgeToSeq`(replaceRangesStr / replaceTierTrigger / replaceEmergencyExample);覆盖 → `renderNudgeFromTemplates`(模板装配) |
| `src/tools.ts` | `ToolEnvironment` 加 `readonly prompts?: ResolvedPrompts`;`makeTools` 里四个 description 从 `env.prompts.tools.*` 取,缺省 `DEFAULT_RESOLVED`;**R4 容错**:compress schema 增加可选 `arguments`(type: `json`)节点、`content` 去掉 `required: true`;`handleCompress` 开头用 `unwrapCompressArgs` 解包 `{ arguments: "..." }` / `{ arguments: {...} }` 两种包裹形态,两种形态都不带 content 时报清晰错误 |
| `src/system-prompt.ts` | `ACP_SYSTEM_PROMPT` 改为"默认模板渲染结果"导出(名称与语义不变);模板/渲染逻辑留在 `prompts.ts` |
| `src/prompts.ts` | **K2**:`NudgePrompts` 新增 `breakdown` / `growth` / `tip` 槽位与默认模板;**K1**:normal/emergency 默认模板对齐 kernel(内嵌 `{philosophy}`);`guidance` 默认 = `HOW_TO_COMPRESS_RULES`;**K4**:systemPromptTemplate 新增 `{howToCompressRules}` / `{tier2DistillRules}` / `{tier3CondenseRules}` 占位符 + WHEN TO/WHEN NOT 段落;**K5**:`renderSystemPrompt` 注入 4 个 kernel 变量 |
| `AGENTS.md` | 模块图加 `prompts.ts`(M4) |
| `docs/README.md` | ~~加索引行~~ **已完成**(v1 已收录本设计文档条目) |

**可选性设计:** env 上的 `prompts?: ResolvedPrompts` 是可选的,消费方用 `env.prompts ?? DEFAULT_RESOLVED` 兜底——`DEFAULT_RESOLVED` 是模块级常量,**零开销、零校验重跑**,因此两个测试文件里的局部 `makeEnv`(`tests/nudge.test.ts:33`、`tests/tools.test.ts:14`;**不是** tests/helpers.ts——该文件只有 session 构建函数,I7 修正)都不需要改,现有 54 条测试原样通过。

## 7. 向后兼容清单

- `buildNudgeText(nudge, emergency, session)` 三参调用不变(第四参有默认值);
- `rangeTable(session)` 不变(第二参可选);
- `ACP_SYSTEM_PROMPT` / `ACP_SYSTEM_PROMPT_ORDER` 导出不变(`index.ts` 原样 re-export);
- `AcpConfig` 现有字段全部不动,只新增 `prompts`;
- 未配置 `prompts` 的部署:行为与 v5 的默认模板渲染一致(默认文案已对齐 kernel,见 K1–K4;这是**有意的**默认文案变更,不是兼容性破坏——`prompts` 槽位结构向后兼容,v4 部署写的 `nudge.normal` 覆盖仍然有效);
- **R1/R2**:默认渲染从"模板装配"改为"kernel `renderNudgeText` + seq 段适配"——输出内容与 v5 默认模板渲染等价(EFFICIENCY_NOTE/breakdown/规则/tip 同源),但来源变为 kernel 原文;宿主覆盖任何 nudge 槽位时自动回退模板路径,覆盖语义不变;
- **R3**:默认紧急档不再有 `💡 tip`(kernel 紧急分支没有批量提示行)——与 kernel 对齐的预期变化;
- **R4**:compress 参数 schema 增加可选 `arguments`、`content` 不再 required——`{ content: [...] }` 与 `{ arguments: "..." }` 均接受,后者由 handleCompress 解包;旧的"包裹形态被拒"行为移除。

## 8. 测试计划(v6:80 条回归全绿;新增 kernel 路径 + 容错回归)

> **v6 实现落地**:`tests/prompts.test.ts` #2 之后新增 #2b(kernel 路径验证——默认 nudge 含 EFFICIENCY_NOTE 帧、kernel HOW_TO_COMPRESS_RULES、💡 tip,ref 范围表被 surface-seq 表替换、无 "oldest first"、无 "Context usage is at");#3 紧急档断言改为"seq 示例替换 startId + 无 💡 tip(R3)";#11 tier fixture 补齐 kernel 需要的 block 字段(`effectiveMessageIds` 等);`tests/tools.test.ts` 新增 2 条容错回归(包裹字符串形态解包压缩成功、无 content 报清晰错误)。

> **v5 实现落地**:`tests/prompts.test.ts` 的 #1/#2/#3/#10/#13 快照按新默认文案重写——#1 由整串字节对比改为"关键段落存在 + 旧语气缺席"(system prompt 变长且含 kernel 规则,整串快照维护成本高);#2/#3 改为断言 efficiency-note 首句、philosophy 内嵌、HOW_TO_COMPRESS_RULES 存在、💡 tip 结尾、旧文案缺席;#10 空串删除用例同时置空 breakdown/growth/tip 以验证干净装配;新增 breakdown/growth 槽位渲染断言(中文覆盖冒烟 #13 同步扩展)。

> **快照原则(I3/I4):** 所有"逐字节回归"断言用**硬编码在测试里的字面量**(实现改造前抄下来的当前输出),与实现分离——测试与实现不同源,改造引入的字节差异(em-dash、⚠️、尾部空格、换行)都会被抓住。不依赖"改造后的 ACP_SYSTEM_PROMPT 导出"作比较(那是循环论证)。

1. **system prompt 快照回归**:`renderSystemPrompt(resolvePrompts())` === 硬编码的当前 `ACP_SYSTEM_PROMPT` 全文字面量(v5 改为**关键段落断言**:首段效率通知框架、philosophy、WHEN TO/WHEN NOT、HOW TO COMPRESS、四工具描述、tier 规则、结尾规则——避免整串快照随 kernel 规则文本漂移);
2. **nudge 普通档全文本快照**:`buildNudgeText` 以 `pct=7` 渲染,**零范围会话** → 断言 efficiency-note 首句 + philosophy 内嵌 + HOW_TO_COMPRESS_RULES + 💡 tip 结尾 + 无 "suggestion, not a requirement";
3. **nudge 紧急档全文本快照**:`pct=96` 紧急档 → 断言 "⚠️ Context limit reached — compress now" 首句 + philosophy 内嵌 + HOW_TO_COMPRESS_RULES + 💡 tip 结尾 + 无 "choice and timing are yours";
4. **范围表快照**:`rangeTable` 对固定 session 的完整输出 === 硬编码字面量(含前导空行);另加**零范围回归**:无可压缩范围时返回 `''`;
5. **工具描述快照**:四个 description === 硬编码字面量;
6. **深合并 + null 归一化**:只覆盖 `nudge.normal`,其余槽位仍是默认;`guidance: null` → 默认(B3);
7. **占位符替换**:`normal: '上下文 {pct}%'` 渲染出正确百分比;
8. **未知占位符抛错**:`normal: '…{pctt}…'` → throw,错误信息含槽位路径 `prompts.nudge.normal`;
9. **已知占位符缺值抛错(I6)**:`renderTemplate('{tokens}', {})` → throw;
10. **空串删除行(I5/N1)**:`guidance: ''` + `breakdown: ''` + `growth: ''` + `tip: ''` 的 nudge(有范围会话)完整字节 === `frame + '\n' + rangeTable`——不含 guidance/breakdown/tip 文本,表前恰 1 空行(由范围表前导元素提供);
11. **tokens 兜底回归(B2)**:pending 缺失(pendingT2/pendingT3 为 undefined)的 tier nudge 渲染出 `(0 tokens)` 而非 `( tokens)`;**注(S3)**:`NudgeBreakdown.pendingT2/pendingT3` 在 acp-kernel 类型里是**必填** number(types.d.ts:183-185),测试构造缺省时需类型断言(项目无 `as any`,用 `as never`/省略字段 cast,与现有 nudge.test.ts:117 同法);
12. **接线集成测试(B1)**:构造带 `prompts: resolvePrompts({ nudge: { normal: 'CUSTOM {pct}' } })` 的 env → `buildNudge` → 注入消息以 `CUSTOM` 开头(转发缺失时是默认文案,测试红);
13. **中文覆盖冒烟**:整套中文 nudge + 范围表 + system prompt 渲染,断言关键中文子串(i18n 场景可用;**v5 扩展**:中文覆盖新增 breakdown/growth/tip 槽位 + `{howToCompressRules}` 占位符);
14. **回归**:现有 77 条测试全部保持绿色(它们断言了默认文本子串,见 §5 硬约束)。

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
