// E2E 场景与断言的单一事实源（docs/e2e-testing-design.md「场景定义与断言读点」）。
//
// 每个场景一个对象，由容器内执行器 container-main.mjs 消费：
//   id / title / issues   —— 场景标识与关联的 issue（bug 回归场景用 S<issue> 编号）
//   patch                 —— 可选的 launcher --patch 覆盖（YAML 字符串；典型用途：压小窗口）
//   fixtures(dir)         —— 在场景 cwd 物化测试文件（确定性生成，可复现）；返回值存入 this.fixturesOf
//   task                  —— 任务文本（字符串，或用 this.fixturesOf 的函数）；模型是被脚本化的
//                            驱动器：任务文本明确指示调用哪个工具、传什么参数形态
//   assert(ctx)           —— 断言函数；返回 [{name, pass, detail, soft}]
//
// 硬/软断言分界（设计文档决策）：引擎契约 = 硬；模型自由意志 = 软；
// "模型被明确指示后是否照做" = 硬（考验的是我们的工具调用链路：schema 校验、
// 信封拆解、引用解析），不是模型意愿。
//
// 所有字段名与锚点字符串均从真实会话日志与 src/ 核实过：
//   tool/call: data{callId, name, arguments}；tool/result: data.message.content[] 内
//   {type:'tool-result', toolCallId, content:[{type:'text',text}], isError}
//   turn/end: data.reason = {kind:'completed'|...}（对象，不是字符串）
//   compaction/summary: data.shadowedTokenCount / kernelBlockId / tier ...
//   compaction/prune: data.shadowedTokenCount ...
//   acp_status 渲染自 kernel buildStatusReport（"CONTEXT BREAKDOWN" / "COMPRESSED BLOCKS"）
//   加引擎附加行：`Nudge: ACTIVE|idle — ...`（src/tools.ts:751）、
//   `Checkpoint seqs (active blocks — ...)`（src/tools.ts:764）、`Surface: ...`（:767）

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ── 会话日志解析助手 ──────────────────────────────────────────────

/** 解包后的日志文本 → 事件数组（跳过截断的坏行，不因单行损坏丢掉整个场景）。 */
export function parseSessionLog(text) {
  const events = []
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { events.push(JSON.parse(t)) } catch { /* 截断行：跳过 */ }
  }
  return events
}

/** callId → {name, arguments, resultText, isError, seq}。call 与 result 靠同一 callId 配对。 */
export function indexToolCalls(events) {
  const byCallId = new Map()
  const ensure = (id) => {
    if (!byCallId.has(id)) byCallId.set(id, { callId: id, name: '', arguments: '', resultText: '', isError: false, seq: -1 })
    return byCallId.get(id)
  }
  for (const e of events) {
    if (e.type === 'tool/call') {
      const t = ensure(e.data?.callId)
      t.name = e.data?.name ?? ''
      t.arguments = typeof e.data?.arguments === 'string' ? e.data.arguments : JSON.stringify(e.data?.arguments ?? {})
      t.seq = e.seq ?? -1
    } else if (e.type === 'tool/result') {
      const blocks = e.data?.message?.content ?? []
      for (const b of blocks) {
        if (b?.type !== 'tool-result') continue
        const t = ensure(b.toolCallId ?? e.data?.message?.source?.callId ?? '')
        t.resultText = (b.content ?? []).map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n')
        t.isError = Boolean(b.isError)
      }
    }
  }
  return byCallId
}

export function allToolCalls(index, name) {
  return [...index.values()].filter((t) => t.name === name)
}

export function compactionEvents(events) {
  const starts = [], summaries = [], prunes = [], ends = []
  for (const e of events) {
    if (e.type === 'compaction/start') starts.push(e)
    else if (e.type === 'compaction/summary') summaries.push(e)
    else if (e.type === 'compaction/prune') prunes.push(e)
    else if (e.type === 'compaction/end') ends.push(e)
  }
  return { starts, summaries, prunes, ends }
}

export function finalTurnReason(events) {
  let kind = null
  for (const e of events) if (e.type === 'turn/end') kind = e.data?.reason?.kind ?? null
  return kind
}

// ── 断言结果助手 ──────────────────────────────────────────────

const ok = (name, pass, detail = '') => ({ name, pass, detail, soft: false })
const soft = (name, pass, detail = '') => ({ name, pass, detail, soft: true })

/**
 * 通用完整性检查（每个场景都跑）：
 *  - exit 0 + stdout 非空 + turn completed
 *  - compaction start/end 严格配对 —— 悬挂 start 是"悬挂 compaction start 恢复"
 *    那类修复的回归哨兵。
 */
function integrityResults(ctx) {
  const { exitCode, stdout, events, comp } = ctx
  const results = [
    ok('进程退出码 0', exitCode === 0, `exit=${exitCode}`),
    ok('stdout 有非空最终回答', String(stdout ?? '').trim().length > 0),
    ok('最终 turn 理由 completed', finalTurnReason(events) === 'completed', `kind=${finalTurnReason(events)}`),
    ok(
      'compaction start/end 配对（无悬挂 start）',
      comp.starts.length === comp.ends.length,
      `start=${comp.starts.length} end=${comp.ends.length}`,
    ),
  ]
  return results
}

/**
 * 影子价与投影完整性（issue #54 的回归哨兵，凡有 compaction 事件的场景都跑）：
 *  - 所有 shadowedTokenCount ≥ 0
 *  - 日志/输出任何位置不出现投影 zod 拒绝串（出现 = 会话已砖化）
 */
function shadowPriceResults(ctx) {
  const { comp, rawLogText, stdout, stderr } = ctx
  const all = [...comp.summaries, ...comp.prunes]
  if (all.length === 0) return []
  const bad = all.filter((e) => typeof e.data?.shadowedTokenCount !== 'number' || !(e.data.shadowedTokenCount >= 0))
  const brickMark = 'Too small: expected number to be >=0'
  const bricked = [rawLogText, stdout, stderr].some((s) => String(s ?? '').includes(brickMark))
  return [
    ok(
      `所有 shadowedTokenCount ≥ 0（${all.length} 个事件）`,
      bad.length === 0,
      bad.length ? `异常值: ${bad.map((e) => JSON.stringify(e.data?.shadowedTokenCount)).join(', ')}` : '全部非负',
    ),
    ok('无投影 zod 拒绝（未砖化）', !bricked, brickMark),
  ]
}

/** 最近一次名为 name 的工具调用返回给模型的原文；没调用过返回 ''。 */
function lastResultText(ctx, name) {
  const calls = allToolCalls(ctx.tools, name)
  return calls.length ? calls[calls.length - 1].resultText : ''
}

/**
 * acp_status 报告是"调用时刻"的快照：与事件对比必须做时间对齐（只统计调用
 * 之前落盘的 summary），并扣除已被 tier-2/3 蒸馏吸收的父块（parentBlockIds
 * 是 compactionId，要经此前事件的 compactionId→kernelBlockId 映射回 bN）。
 * 首次全量实测的教训：拿最终事件状态对比中途快照，会误判 #47 回归（实测
 * 模型压了 10 块并自发蒸馏出 tier-2 b6，报告"3 active"是正确答案）。
 */
function activeBlocksAtCall(ctx) {
  const calls = allToolCalls(ctx.tools, 'acp_status')
  const last = calls[calls.length - 1]
  if (!last || last.seq < 0) return null
  const compIdToBlock = new Map()
  const absorbedParents = new Set()
  const active = []
  for (const e of ctx.events) {
    if (e.seq >= last.seq) break
    if (e.type !== 'compaction/summary') continue
    compIdToBlock.set(e.data?.compactionId, e.data?.kernelBlockId)
    active.push(e.data?.kernelBlockId)
    if ((e.data?.tier ?? 1) > 1) for (const p of e.data?.parentBlockIds ?? []) absorbedParents.add(p)
  }
  const absorbedBlocks = new Set([...absorbedParents].map((id) => compIdToBlock.get(id) ?? id))
  return { active: active.filter((id) => id && !absorbedBlocks.has(id)) }
}

// ── fixture 生成（确定性：固定种子，两次运行内容一致、可 diff）──────────

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CJK_SENTENCES = [
  '上下文窗口是模型一次能读取的全部内容的上限，超过之后最早的内容就会被挤出。',
  '主动上下文压缩的理念是由模型自己决定什么时候压缩、压缩哪些内容。',
  '自动策略从不代替模型做总结，它只负责在合适的时机提醒模型注意上下文压力。',
  '会话日志是一条只增不改的流水，压缩只是把一段原始内容替换成摘要节点。',
  '被压缩的原始内容并没有消失，解压缩和全文检索都能从日志里把它们找回来。',
  '每一条影子价记录都必须使用宿主侧的计价口径，否则计数会被悄悄透支。',
  '压缩范围的两端如果已经被更早的压缩覆盖，引擎会把引用重映射到仍然存活的内容上。',
  '工具调用的配对完整性比任何优化都重要，一条孤儿结果就能让下一次请求直接报错。',
  '状态报告的价值在于让模型看见自己的上下文构成，从而做出更好的压缩决策。',
  '检索命中会同时覆盖摘要与被遮蔽的原文，摘要里没有的细节依然可以按分数召回。',
  '长会话里最贵的错误是压掉了后面还要逐字引用的内容，宁可晚压也不要误压。',
  '每次压缩落盘的事件序列必须严格配对，悬挂的开启标记会让后续事务无法开启。',
]

/** 生成一个约 targetChars 字符的中文 fixture（≈ targetChars 个 token，CJK 1 字/token）。 */
export function makeCjkFixture(seed, targetChars, token = null) {
  const rng = mulberry32(seed)
  const lines = []
  let chars = 0
  let i = 0
  while (chars < targetChars) {
    const s = CJK_SENTENCES[Math.floor(rng() * CJK_SENTENCES.length)]
    lines.push(`${String(++i).padStart(3, '0')} ${s}`)
    chars += s.length + 4
  }
  if (token) lines.push(`本文件暗号：${token}`)
  return lines.join('\n') + '\n'
}

// ── 场景共用小工具 ──────────────────────────────────────────────

const WINDOW = 16000 // 显式压小窗口（显式值优先于自动探测）；45% nudge 线 = 7200 token
const FILE_CHARS = 4000 // 每个文件 ≈ 4000 token：读两三个文件就过 nudge 线

const windowPatch = [
  '- id: compaction-acp',
  '  config:',
  `    modelContextLimit: ${WINDOW}`,
].join('\n')

function materializeFixtures(dir, count, seedBase, { token = false } = {}) {
  const sub = join(dir, 'fixture')
  mkdirSync(sub, { recursive: true })
  const paths = []
  const tokens = []
  for (let i = 1; i <= count; i++) {
    const tok = token ? `ACPE2E-${seedBase}-${String(i).padStart(2, '0')}` : null
    writeFileSync(join(sub, `a${i}.txt`), makeCjkFixture(seedBase * 100 + i, FILE_CHARS, tok))
    paths.push(`fixture/a${i}.txt`)
    if (tok) tokens.push(tok)
  }
  return { paths, tokens }
}

const readAll = (paths) =>
  `请用 read 工具依次完整读取以下 ${paths.length} 个文件（严格按顺序，每个都要读）：${paths.join('、')}。`

// ── 场景定义 ──────────────────────────────────────────────

export const SCENARIOS = [
  {
    id: 'S4-baseline',
    set: 'smoke', weight: 5,
    title: '空会话基线：极短任务不被 ACP 干扰',
    issues: [],
    patch: null,
    fixtures: null,
    task: '只回复两个字：正常',
    assert(ctx) {
      const results = integrityResults(ctx)
      const n = ctx.comp.starts.length + ctx.comp.summaries.length + ctx.comp.prunes.length + ctx.comp.ends.length
      results.push(ok('无任何 compaction 事件（低压会话不写压缩协议）', n === 0, `compaction 事件数=${n}`))
      return results
    },
  },

  {
    id: 'S1-pressure',
    set: 'full', weight: 30,
    title: '自然压力路径：大工具输出过线后出现压缩事件',
    issues: [],
    patch: windowPatch,
    fixtures(dir) { return materializeFixtures(dir, 6, 101) },
    task() {
      return `${readAll(this.fixturesOf.paths)}全部读完后，简要汇报每个文件的行数。`
    },
    assert(ctx) {
      const results = [...integrityResults(ctx), ...shadowPriceResults(ctx)]
      // 注：request/context 事件披露的是 provider 路由的窗口（如 1000000），
      // 不是 modelContextLimit 配置值——配置杠杆只作用于引擎侧压力计算，
      // 在层 A 日志里没有直接观测点（归层 B 看请求体）。首测教训：这里
      // 曾错误断言 contextWindow===16000。
      // 任务文本不提 compress：是否压缩是模型对自然 nudge 的自发响应 → 软。
      results.push(
        soft('出现 compaction/summary（模型对自然 nudge 的自发响应）', ctx.comp.summaries.length >= 1, `summary=${ctx.comp.summaries.length}`),
      )
      return results
    },
  },

  {
    id: 'S2-search-after-compress',
    set: 'full', weight: 45,
    title: '压缩后检索：search_context 命中被遮蔽原文里的暗号',
    issues: [],
    patch: windowPatch,
    fixtures(dir) { return materializeFixtures(dir, 6, 202, { token: true }) },
    task() {
      return [
        readAll(this.fixturesOf.paths),
        '读完后，用 compress 工具压缩前面已读完的文件内容（至少压缩一次）。',
        `然后用 search_context 工具搜索暗号 ${this.fixturesOf.tokens[0]}，把搜索到的暗号原文告诉我。`,
      ].join('\n')
    },
    assert(ctx) {
      const results = [...integrityResults(ctx), ...shadowPriceResults(ctx)]
      results.push(ok('出现 compaction/summary（任务明确指示压缩）', ctx.comp.summaries.length >= 1, `summary=${ctx.comp.summaries.length}`))
      const searches = allToolCalls(ctx.tools, 'search_context')
      results.push(ok('发生了 search_context 调用（任务明确指示检索）', searches.length >= 1, `search 调用=${searches.length}`))
      const last = searches.length ? searches[searches.length - 1].resultText : ''
      const token = this.fixturesOf.tokens[0]
      // 结果文本带 160 字符 preview（src/tools.ts handleSearch）——暗号出现说明
      // 被遮蔽的原文进了检索文档集且排到了前面：这是 kernel+引擎的契约，硬断言。
      results.push(ok('检索命中暗号（被遮蔽原文仍可召回）', last.includes(token), last ? '结果含暗号' : '结果不含暗号'))
      return results
    },
  },

  {
    id: 'S3-batch-compress',
    set: 'full', weight: 224,
    title: '连续多次压缩：多笔事务全部合法',
    issues: [],
    patch: windowPatch,
    fixtures(dir) { return materializeFixtures(dir, 4, 303) },
    task() {
      return [
        readAll(this.fixturesOf.paths),
        '每读完一个文件，就立即用 compress 工具把刚读完的内容压缩掉（要求至少完成 3 次 compress 调用，逐个进行）。',
        '全部完成后，汇报每个文件的行数。',
      ].join('\n')
    },
    assert(ctx) {
      const results = [...integrityResults(ctx), ...shadowPriceResults(ctx)]
      results.push(ok('至少 2 次 compaction/summary（连续多笔事务）', ctx.comp.summaries.length >= 2, `summary=${ctx.comp.summaries.length}`))
      const compressCalls = allToolCalls(ctx.tools, 'compress')
      results.push(soft('compress 调用 ≥ 3 次（指示值；少压只说明模型保守）', compressCalls.length >= 3, `compress=${compressCalls.length}`))
      return results
    },
  },

  {
    id: 'S54-shadow-price',
    set: 'smoke', weight: 32,
    title: 'issue #54 回归：CJK 会话影子价不透支、投影不砖化',
    issues: [54],
    patch: windowPatch,
    fixtures(dir) { return materializeFixtures(dir, 6, 404) },
    task() {
      return [
        readAll(this.fixturesOf.paths),
        '读完后用 compress 工具把已读完的文件内容压缩掉（至少一次）。',
        '最后回复：done',
      ].join('\n')
    },
    assert(ctx) {
      // S54 的核心就是 shadowPriceResults：CJK 重负载下影子价必须始终非负、
      // 投影绝不出现 "Too small" zod 拒绝（那意味着会话已砖化、后续 turn 全挂）。
      const results = [...integrityResults(ctx), ...shadowPriceResults(ctx)]
      results.push(ok('出现 compaction/summary（CJK 重负载触发压缩）', ctx.comp.summaries.length >= 1, `summary=${ctx.comp.summaries.length}`))
      return results
    },
  },

  {
    id: 'S47-status-all-blocks',
    set: 'full', weight: 267,
    title: 'issue #47/#48 回归：acp_status 列出全部块，而非只有最老 10 个',
    issues: [47, 48],
    patch: windowPatch,
    fixtures(dir) { return materializeFixtures(dir, 4, 505) },
    task() {
      return [
        readAll(this.fixturesOf.paths),
        '每读完一个文件就立即用 compress 压缩它（4 个文件共 4 次）。',
        '全部读完后，调用 acp_status 工具查看上下文构成，然后回复：ok',
      ].join('\n')
    },
    assert(ctx) {
      const results = [...integrityResults(ctx), ...shadowPriceResults(ctx)]
      results.push(ok('至少 2 次 compaction/summary', ctx.comp.summaries.length >= 2, `summary=${ctx.comp.summaries.length}`))
      const report = lastResultText(ctx, 'acp_status')
      results.push(ok('acp_status 返回 CONTEXT BREAKDOWN 报告', report.includes('CONTEXT BREAKDOWN'), report ? '有报告' : '未调用 acp_status'))
      // 时间对齐对照（activeBlocksAtCall）：调用时刻的活跃块（扣除蒸馏吸收的
      // 父块）必须逐块出现在报告里——这正是 #47/#48（slice(0,10) 截断）的
      // 回归哨兵。首次实测即验证了该断言设计的必要性：模型压了 10 块并自发
      // 蒸馏出 tier-2 b6，报告"3 active"是正确答案而非回归。
      const at = activeBlocksAtCall(ctx)
      if (!at) {
        results.push(soft('调用了 acp_status（任务明确指示）', false, '未调用 acp_status'))
      } else {
        const header = report.match(/COMPRESSED BLOCKS — (\d+) active/)
        const shown = new Set([...report.matchAll(/\bb\d+\b/g)].map((m) => m[0]))
        const missing = at.active.filter((id) => !shown.has(id))
        results.push(
          ok(`调用时刻的活跃块全部显示（${at.active.length} 个，已扣除蒸馏吸收）`,
            Boolean(header) && Number(header?.[1]) === at.active.length && missing.length === 0,
            `header=${header?.[1] ?? '无'} 活跃=${at.active.join(',') || '无'} 缺失=${missing.join(',') || '无'}`),
        )
      }
      results.push(
        soft('模型自发做过 tier-2/3 蒸馏（超出指示的加分信号）', ctx.comp.summaries.some((e) => (e.data?.tier ?? 1) > 1),
          `tier 分布=${ctx.comp.summaries.map((e) => e.data?.tier ?? 1).join(',')}`),
      )
      results.push(soft('压缩数达到指示的 4 次', ctx.comp.summaries.length >= 4, `summary=${ctx.comp.summaries.length}`))
      return results
    },
  },

  {
    id: 'S60-checkpoint-seqs',
    set: 'smoke', weight: 27,
    title: 'issue #60 回归：ACTIVE 块带 Checkpoint seqs 行（T2/T3 蒸馏入口）',
    issues: [60],
    patch: windowPatch,
    fixtures(dir) { return materializeFixtures(dir, 2, 606) },
    task() {
      return [
        readAll(this.fixturesOf.paths),
        '读完后用 compress 工具压缩已读完的内容（至少一次），然后调用 acp_status 工具，最后回复：ok',
      ].join('\n')
    },
    assert(ctx) {
      const results = [...integrityResults(ctx), ...shadowPriceResults(ctx)]
      results.push(ok('出现 compaction/summary', ctx.comp.summaries.length >= 1, `summary=${ctx.comp.summaries.length}`))
      const report = lastResultText(ctx, 'acp_status')
      results.push(ok('报告含 CONTEXT BREAKDOWN', report.includes('CONTEXT BREAKDOWN'), report ? '有报告' : '未调用 acp_status'))
      results.push(
        ok('ACTIVE 块带 Checkpoint seqs 行（蒸馏入口可见）',
          report.includes('Checkpoint seqs (active blocks'),
          report.includes('Checkpoint seqs') ? '有行' : '缺失（#60 P2 回归）'),
      )
      return results
    },
  },

  {
    id: 'S9-envelope-drilldown',
    set: 'full', weight: 50,
    title: 'rule 9 回归：wrapped {arguments} 信封不被静默吞参（drilldown 生效）',
    issues: [9],
    patch: windowPatch,
    fixtures(dir) { return materializeFixtures(dir, 2, 707) },
    task() {
      return [
        readAll(this.fixturesOf.paths),
        '读完后用 compress 压缩已读完的内容（至少一次）。',
        '然后调用 acp_status 工具，参数必须写成这样的包裹形态（顶层只有一个 arguments 键）：',
        '{"arguments": {"scope": "compressed"}}',
        '调用后回复：ok',
      ].join('\n')
    },
    assert(ctx) {
      const results = [...integrityResults(ctx), ...shadowPriceResults(ctx)]
      results.push(ok('出现 compaction/summary', ctx.comp.summaries.length >= 1, `summary=${ctx.comp.summaries.length}`))
      // 首测教训：即使任务给了逐字参数形态，模型也不保证照做——"模型是否发出
      // wrapped 形态"是模型意愿，降级为软断言；信封链路的确定性回归归层 B
      // （mock 直接控制调用形态，字节级断言 unwrapEnvelope 的行为）。
      const wrapped = allToolCalls(ctx.tools, 'acp_status').filter((t) => {
        try { return t.arguments && 'arguments' in JSON.parse(t.arguments) } catch { return false }
      })
      results.push(
        soft('模型按指示发出 wrapped {arguments} 形态的调用',
          wrapped.length >= 1, wrapped.length ? '有包裹调用' : '模型未按包裹形态调用（层 A 软断言）'),
      )
      // 若模型确实发出了包裹调用，则拆解行为是引擎契约，硬断言：
      const report = wrapped.length ? wrapped[wrapped.length - 1].resultText : ''
      results.push(
        ok('wrapped 调用被拆解并生效：drilldown 报告（含块段、无 Nudge 决策行）',
          wrapped.length === 0 || (report.includes('COMPRESSED BLOCKS') && !/Nudge: (ACTIVE|idle) — /.test(report)),
          wrapped.length ? `含块段=${report.includes('COMPRESSED BLOCKS')} 含Nudge行=${/Nudge: (ACTIVE|idle) — /.test(report)}` : '模型未发出包裹调用（软断言已记录）'),
      )
      return results
    },
  },

  {
    id: 'S35-mn-ref',
    set: 'full', weight: 120,
    title: 'issue #35 回归：drilldown 的 mN 引用可以直接作为 compress 边界',
    issues: [35],
    patch: windowPatch,
    fixtures(dir) { return materializeFixtures(dir, 3, 808) },
    task() {
      return [
        readAll(this.fixturesOf.paths),
        '第一步：用 compress 压缩 a1 相关的内容（至少一次）。',
        '第二步：调用 acp_status 工具，参数为 {"scope": "compressed"}，在 drilldown 报告里找到仍存活消息行的 mN 编号。',
        '第三步：再次调用 compress，content 里那一项的 startSeq 和 endSeq 就填那些 mN 编号（把 a2 相关的消息压掉）。',
        '完成后回复：ok',
      ].join('\n')
    },
    assert(ctx) {
      const results = [...integrityResults(ctx), ...shadowPriceResults(ctx)]
      // mN 引用若解析失败，handleCompress 会拒绝且不会落盘第二笔事务——
      // 所以"第二笔 summary 存在"就是 mN 链路修好的 observable 证明。
      results.push(ok('至少 2 次 compaction/summary（第二次经 mN 引用落盘）', ctx.comp.summaries.length >= 2, `summary=${ctx.comp.summaries.length}`))
      const mnCalls = allToolCalls(ctx.tools, 'compress').filter((t) => /"m\d+/.test(t.arguments) || /\bm\d+\b/.test(t.arguments))
      results.push(
        soft('第二次 compress 的参数里出现 mN 引用', mnCalls.length >= 1, mnCalls.length ? '有 mN 参数' : '模型用了其他引用形态'),
      )
      return results
    },
  },
]

/** 按 id 挑选场景：ACP_E2E_SCENARIOS=S4-baseline,S54-shadow-price。 */
export function selectScenarios(filter) {
  if (!filter) return SCENARIOS
  const wanted = new Set(String(filter).split(',').map((s) => s.trim()).filter(Boolean))
  return SCENARIOS.filter((s) => wanted.has(s.id))
}

/** 按集合挑选：'smoke'（默认，日常跑）| 'full'/'all'（全量）。 */
export function scenariosForSet(set) {
  if (set === 'full' || set === 'all') return SCENARIOS
  return SCENARIOS.filter((s) => s.set === 'smoke')
}
