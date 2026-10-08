import { runScenario } from './harness.mjs'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { Context } from '@deepseek-ai/cordis'
import { foldSurface } from '@deepseek-ai/dsh-session'
const scenarioNames = ['basic-compress', 'nudge-rhythm', 'compress-then-decompress', 'acp-status', 'overflow-recovery', 'jsonl-compress']
const countsOf = (events) => {
  const starts = events.filter((event) => event.type === 'compaction/start').length
  const ends = events.filter((event) => event.type === 'compaction/end').length
  return { starts, ends }
}
const nudgeIndices = (requests) => {
  const list = []
  requests.forEach((request, i) => {
  if (JSON.stringify(request.body).includes('efficiency nudge to compress early') || JSON.stringify(request.body).includes('Context limit reached')) list.push(i + 1)
  })
  return list
}
const wirePairing = (requests) => {
  const last = requests.filter((request) => request.kind === 'tool').slice(-1)[0]
  const roles = last.body.messages.map((message) => message.role)
  return roles.every((role, i) => role === 'tool' ? i > 0 && roles[i - 1] === 'assistant' : true)
}
const lastEndSeq = (events) => {
  const best = { seq: 0 }
  events.forEach((event) => {
  if (event.type === 'compaction/end' && event.seq > best.seq) best.seq = event.seq
})
return best.seq
}
const continuationOf = (events, endSeq) => {
  return events.some((event) => event.type === 'assistant/message' && event.seq > endSeq)
}
const shadowedSeqsOf = (events, seq) => {
  return events.some((event) => event.type === 'compaction/summary' && (event.data.shadowedSeqs ?? []).includes(seq))
}
const shadowedTokenCountOf = (events) => {
  const sum = events.filter((event) => event.type === 'compaction/summary').reduce((total, event) => total + (event.data.shadowedTokenCount ?? 0), 0)
  return sum
}
const surfaceOpOf = (events) => {
  return events.some((event) => event.type === 'user/message' && event.surfaceOp && event.surfaceOp.op === 'replace')
}
const containsOf = (events, name) => {
  return events.some((event) => event.type === 'tool/result' && JSON.stringify(event.data.message ?? {}).includes(name))
}
const deepText = (node) => {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(deepText).join('')
  if (node && typeof node === 'object') {
    if (typeof node.text === 'string') return node.text
    if (node.content) return deepText(node.content)
  }
  return ''
}
// The request immediately after the first tool call (the compress) is the first
// request built from the post-compression surface: the summary must be present
// and the shadowed original must be gone.
const projectionAfterFirstTool = (requests) => {
  const idx = requests.findIndex((request) => request.kind === 'tool')
  if (idx < 0 || idx + 1 >= requests.length) return ''
  return JSON.stringify(requests[idx + 1].body ?? {})
}
// Return the deep TEXT (real newlines), not the JSON string: the b1 block-row
// assertion is line-anchored, which only works against the rendered report.
const statusReportOf = (events) => {
  for (const event of events) {
    if (event.type === 'tool/result') {
      const text = deepText(event.data.message)
      if (text.includes('COMPRESSED BLOCKS')) return text
    }
  }
  return ''
}
const nudgeTableOf = (requests) => {
  for (const request of requests) {
    for (const message of (request.body.messages ?? [])) {
      const text = typeof message.content === 'string' ? message.content : deepText(message.content)
      if (text.includes('Compressible ranges')) return text
    }
  }
  return ''
}
const nudgeTableChecks = (result) => {
  const table = nudgeTableOf(result.requests)
  if (!table) return [['nudge range table present', false, 'no nudge with a range table found']]
  const rows = table.split('\n').filter((line) => /seq \d+\.\.\d+/.test(line) && /\[tool \d+% \| text \d+%\]/.test(line))
  const starts = rows.map((line) => {
    const match = line.match(/seq (\d+)\.\./)
    return match ? parseInt(match[1], 10) : -1
  })
  const ascending = starts.length >= 1 && starts.every((value, i) => i === 0 || value >= starts[i - 1])
  return [
    ['nudge range table header (oldest first)', table.includes('Compressible ranges') && table.includes('oldest first'), ''],
    ['nudge range rows carry [tool X% | text Y%] share', rows.length >= 1, `rows=${rows.length}`],
    ['nudge range rows oldest-first (ascending seq)', ascending, `starts=${starts.join(',')}`]
  ]
}
const checksBasic = (result) => {
  const list = []
  list.push(['compaction start/end paired', countsOf(result.events).starts >= 1 && countsOf(result.events).ends === countsOf(result.events).starts, `starts=${countsOf(result.events).starts} ends=${countsOf(result.events).ends}`])
  list.push(['summary shadows first user turn', shadowedSeqsOf(result.events, result.seqs.U1), `U1=${result.seqs.U1}`])
  list.push(['shadowedTokenCount non-negative', shadowedTokenCountOf(result.events) >= 0, `sum=${shadowedTokenCountOf(result.events)}`])
  list.push(['durable replace node landed', surfaceOpOf(result.events), ''])
  list.push(['strict tool pairing in final request', wirePairing(result.requests), ''])
  list.push(['nudge injected at least once', nudgeIndices(result.requests).length >= 1, `nudges on requests ${nudgeIndices(result.requests).join(',')}`])
  list.push(['conversation continued after end', continuationOf(result.events, lastEndSeq(result.events)), ''])
  const projection = projectionAfterFirstTool(result.requests)
  list.push(['projection: summary present after compress', projection.includes('Exchange 1: the user asked for a survey of the durable surface model'), ''])
  list.push(['projection: shadowed original gone after compress', projection.length > 0 && !projection.includes('Note 0: the pruning section documents behavior 0'), ''])
  list.push(...nudgeTableChecks(result))
  return list
}
const checksRhythm = (result) => {
  const list = []
  list.push(['no nudge while history is small', nudgeIndices(result.requests).every((index) => index > 5), `nudges on requests ${nudgeIndices(result.requests).join(',') || 'none'}`])
  list.push(['nudge once history is large', nudgeIndices(result.requests).some((index) => index >= 6), `nudges on requests ${nudgeIndices(result.requests).join(',') || 'none'}`])
  list.push(['nudge not on every request', nudgeIndices(result.requests).length < result.requests.length, ''])
  list.push(...nudgeTableChecks(result))
  return list
}
const checksDecompress = (result) => {
  const list = checksBasic(result).slice()
  list.push(['no new compaction events at decompress step', countsOf(result.events).starts === 1 && countsOf(result.events).ends === 1, `starts=${countsOf(result.events).starts}`])
  list.push(['decompress result carries original text', containsOf(result.events, 'Note 0: the pruning section'), ''])
  list.push(['compress result reports tier', containsOf(result.events, 'tier'), ''])
  return list
}
const checksStatus = (result) => {
  const list = []
  const report = statusReportOf(result.events)
  list.push(['acp_status report present', report.length > 0, `len=${report.length}`])
  list.push(['report has CONTEXT BREAKDOWN (kernel buildStatusReport)', report.includes('CONTEXT BREAKDOWN'), ''])
  list.push(['report has COMPRESSED BLOCKS section', report.includes('COMPRESSED BLOCKS'), ''])
  list.push(['report lists block b1', /^\s*b1\b/m.test(report), ''])
  list.push(['report has Checkpoint seqs row (distillation entry)', report.includes('Checkpoint seqs'), ''])
  list.push(['report has Surface: seq anchor', report.includes('Surface:'), ''])
  list.push(['report has Nudge decision row', report.includes('Nudge: '), ''])
  list.push(['report excludes window-semantics rows (human-side /acp-prune)', !report.includes('estimated context') && !report.includes('context window'), ''])
  return list
}
const overflowMarkersOf = (events) => {
  return events.filter((event) => event.type === 'compaction/summary').map((event) => deepText(event.data.summary ?? ''))
}
const overflowTopicsOf = (events) => {
  return events.filter((event) => event.type === 'compaction/summary').map((event) => deepText(event.data.rawOutput ?? ''))
}
const checksOverflow = (result) => {
  const list = []
  const counts = countsOf(result.events)
  const errorIdx = result.requests.findIndex((request) => request.kind === 'error')
  list.push(['scripted overflow reached the loop as a failed request', errorIdx >= 0, `errorIdx=${errorIdx}`])
  list.push(['loop retried and the retry request succeeded', errorIdx >= 0 && result.requests[errorIdx + 1]?.kind === 'text', `requests=${result.requests.length}`])
  list.push(['emergency compaction start/end paired', counts.starts >= 1 && counts.ends === counts.starts, `starts=${counts.starts} ends=${counts.ends}`])
  list.push(['emergency summary is the overflow recovery marker', overflowMarkersOf(result.events).some((text) => text.includes('context-overflow emergency compaction')), ''])
  list.push(['recovery block labeled context-overflow recovery', overflowTopicsOf(result.events).some((raw) => raw.includes('context-overflow recovery')), ''])
  list.push(['durable replace node landed', surfaceOpOf(result.events), ''])
  list.push(['conversation continued after recovery', continuationOf(result.events, lastEndSeq(result.events)), ''])
  return list
}
// Prompt-cache guard at the WIRE level. The request body is the only thing a provider
// can key a cache on, so pin the parts of it that must not move across a scenario's LLM
// calls. `raw` is the exact body string the fake LLM received (fake-llm.mjs keeps it);
// per-message comparisons re-serialize the parsed form, which preserves the wire key
// order (JSON.parse keeps insertion order) and normalizes only whitespace.
const outboundMessagesOf = (request) => {
  return Array.isArray(request.body?.messages) ? request.body.messages : []
}
const rawEnvelopeOf = (request) => {
  const at = request.raw ? request.raw.indexOf('"messages"') : -1
  return at < 0 ? request.raw ?? '' : request.raw.slice(0, at)
}
const cachePrefixChecks = (result) => {
  const list = []
  const requests = result.requests.filter((request) => outboundMessagesOf(request).length > 0)
  if (requests.length < 2) {
    return [['wire: at least two LLM request bodies captured', false, `requests=${requests.length}`]]
  }

  // Envelope: model / stream flags / key order / spacing, i.e. everything before the
  // messages array. Comparing the RAW string is what makes key order observable.
  const envelopes = new Set(requests.map(rawEnvelopeOf))
  list.push(['wire: raw request envelope byte-stable (key order + spacing)', envelopes.size === 1, `${envelopes.size} distinct`])

  const schemas = new Set(requests.map((request) => JSON.stringify(request.body.tools ?? null)))
  list.push(['wire: tools array byte-stable across requests', schemas.size === 1, `${schemas.size} distinct schema(s)`])

  // The leading message is the largest cacheable prefix. Compare from the second request
  // on: the engine injects its one-time ACP guidance section during the first turn's
  // pre-step, so request 1 may legitimately precede that injection. Byte-stability
  // only holds UNTIL the scenario's first durable surface rewrite — a landed compress
  // splices its summary node ahead of older nodes, and an overflow recovery hides
  // whole ranges — so compare only the requests sent before that rewrite (the rewrite
  // request itself is still pre-rewrite: it is built before the tool result lands).
  // On the Anthropic Messages wire the system prompt travels in a top-level field
  // (already pinned by the raw-envelope check above), so the leading message is the
  // first user message; the old OpenAI wire led the array with a stable system
  // message that survived compaction, which is why this used to scan every request.
  const rewriteIdx = Math.max(
    requests.findIndex((request) => request.kind === 'tool'),
    requests.findIndex((request) => request.kind === 'error'),
  )
  const leadWindow = requests.slice(1, rewriteIdx < 1 ? requests.length : rewriteIdx + 1)
  if (leadWindow.length >= 2) {
    const leading = leadWindow.map((request) => JSON.stringify(outboundMessagesOf(request)[0] ?? null))
    const leadingDistinct = new Set(leading).size
    list.push(['wire: leading message byte-stable until first surface rewrite', leadingDistinct === 1, `${leadingDistinct} distinct`])
  } else {
    list.push(['wire: leading message byte-stable until first surface rewrite', true, `no comparable requests before the rewrite (${leadWindow.length})`])
  }

  // A scenario with no compaction is append-only by construction, so the previous
  // request's message list must be a byte-identical prefix of the next one — any
  // in-place rewrite of an earlier message lands here. Compaction scenarios skip this:
  // the durable replace rewrites the surface by design.
  if (!result.events.some((event) => event.type === 'compaction/summary')) {
    let firstChange = ''
    for (let i = 1; i < requests.length && firstChange === ''; i += 1) {
      const before = outboundMessagesOf(requests[i - 1])
      const after = outboundMessagesOf(requests[i])
      for (let j = 0; j < before.length; j += 1) {
        if (JSON.stringify(after[j]) !== JSON.stringify(before[j])) {
          firstChange = `request #${i + 1} message ${j}`
          break
        }
      }
    }
    list.push(['wire: append-only turns keep every earlier message byte-identical', firstChange === '', firstChange])
  }
  return list
}
// --- JSONL persistence net (issue #183 part 2) ---------------------------------
// The harness mounts the REAL released JSONL backend for every scenario, so each
// row the engine writes passes through the writer's encode + admission path during
// the run. These checks decode what actually landed on disk and compare it against
// the live run — the admission-level blind spot (#163/#181 class) where a fully
// green in-memory suite still shipped sessions that wedged at write time.

const sessionFilesOf = (root) => {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd')) found.push(path)
    }
  }
  walk(root)
  return found
}
// A FRESH backend instance over the same root — as close to "restart and reload"
// as we can get without spinning up a second agent loop. open(id, 'read') takes no
// write claim, so it coexists with the harness's (now disposed) writer.
const storedEventsOf = async (result) => {
  const store = new JsonlSessionPersistence(new Context(), { root: result.persistRoot })
  const reader = await store.open(result.sessionId, 'read')
  try {
    return (await reader.read(0)).events
  } finally {
    await reader.close()
  }
}
// The retired V3 wrapper shape ({ kind: 'plugin', plugin: '<name>' }) is refused by
// the V4-line writer outright ("format v4 message requires a producer-owned source
// kind") — zero tolerance here is deliberate: any such row would brick the session.
// Source lives ON THE MESSAGE, not the event envelope: data.source on
// user/message rows, data.message.source on assistant/tool rows (rule 10's three
// durable locations). A string scan would false-positive on echoed argument text,
// so this checks the two structured positions only.
const retiredWrapperRows = (events) => {
  const rows = []
  for (const event of events) {
    const candidates = [event.data?.source, event.data?.message?.source].filter((s) => s && typeof s === 'object')
    if (candidates.some((s) => s.kind === 'plugin' && typeof s.plugin === 'string')) rows.push(`seq ${event.seq} (${event.type})`)
  }
  return rows
}
const firstRowMismatch = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (JSON.stringify(a[i] ?? null) !== JSON.stringify(b[i] ?? null)) {
      return `row ${i}: stored=${a[i]?.type ?? 'MISSING'}(seq ${a[i]?.seq ?? '?'}) vs live=${b[i]?.type ?? 'MISSING'}(seq ${b[i]?.seq ?? '?'})`
    }
  }
  return ''
}
// Shared by EVERY scenario: the file materialized, decodes fail-closed through the
// released codec, round-trips losslessly against the live log, re-folds to the same
// surface, and carries no retired wrapper shape.
const checksPersistence = (result, storedLoad) => {
  const list = []
  const files = sessionFilesOf(result.persistRoot)
  list.push(['persist: exactly one session log materialized on disk', files.length === 1, `files=${files.length}`])
  if (storedLoad.error) {
    list.push(['persist: stored log decodes through the released codec', false, storedLoad.error])
    return list
  }
  const stored = storedLoad.events
  list.push(['persist: stored log decodes through the released codec', true, `${stored.length} rows`])
  const mismatch = firstRowMismatch(stored, result.events)
  list.push(['persist: stored rows equal live events (lossless round-trip)', mismatch === '', mismatch])
  const replayed = foldSurface(stored).nodes.map((node) => [node.seq, node.type])
  const live = result.surfaceNodes.map((node) => [node.seq, node.type])
  list.push(['persist: replayed surface equals live surface (#181 restart signature)', JSON.stringify(replayed) === JSON.stringify(live), `replay=${replayed.length} live=${live.length}`])
  const wrappers = retiredWrapperRows(stored)
  list.push(['persist: no retired wrapper source shape in any stored row', wrappers.length === 0, wrappers.join('; ')])
  return list
}
// Scenario-specific: the FIRST-turn compress transaction must be complete IN THE
// FILE, not just in memory. The replace op must carry exactly three keys (the
// 0.1.5+ dialect — one extra key fails both validators); the checkpoint source must
// be producer-owned.
const checksJsonlCompress = (result, stored) => {
  const list = []
  const counts = countsOf(result.events)
  list.push(['compaction start/end paired', counts.starts >= 1 && counts.ends === counts.starts, `starts=${counts.starts} ends=${counts.ends}`])
  list.push(['summary shadows first user turn', shadowedSeqsOf(result.events, result.seqs.U1), `U1=${result.seqs.U1}`])
  list.push(['durable replace node landed', surfaceOpOf(result.events), ''])
  list.push(['strict tool pairing in final request', wirePairing(result.requests), ''])
  list.push(['conversation continued after end', continuationOf(result.events, lastEndSeq(result.events)), ''])
  const projection = projectionAfterFirstTool(result.requests)
  // The frame prefix rides ONLY on real summary nodes (SUMMARY_FRAME_PREFIX in
  // src/messages.ts, pinned by tests/injection-governance.test.ts). An echoed
  // compress argument or a failure note quoting the call never carries it, so
  // this cannot pass on a compress that did not land.
  list.push(['projection: framed summary node present after compress', projection.includes('[Model-written summary') && projection.includes('Exchange 1: the user asked for numbered pruning notes'), ''])
  list.push(['projection: shadowed original gone after compress', projection.length > 0 && !projection.includes('Note 0: the pruning section documents behavior 0'), ''])
  if (!stored) {
    list.push(['stored transaction checks skipped (decode failed)', false, ''])
    return list
  }
  const sCounts = countsOf(stored)
  const summaries = stored.filter((event) => event.type === 'compaction/summary')
  // data.source: user/message rows carry their source inside data (the message).
  const checkpoint = stored.find((event) => event.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint' && event.surfaceOp?.op === 'replace')
  list.push(['stored: compaction start/end paired', sCounts.starts >= 1 && sCounts.ends === sCounts.starts, `starts=${sCounts.starts} ends=${sCounts.ends}`])
  list.push(['stored: summary shadows U1..A1', summaries.some((event) => {
    const s = event.data.shadowedSeqs ?? []
    return s.includes(result.seqs.U1) && s.includes(result.seqs.A1)
  }), `U1=${result.seqs.U1} A1=${result.seqs.A1}`])
  list.push(['stored: summary carries rawOutput block-ledger marker', summaries.some((event) => JSON.stringify(event.data.rawOutput ?? '').includes('$dshAcpBlockLedger')), ''])
  list.push(['stored: checkpoint replace op has EXACTLY three keys (op/startSeq/endSeq)', !!checkpoint && Object.keys(checkpoint.surfaceOp).sort().join(',') === 'endSeq,op,startSeq' && checkpoint.surfaceOp.op === 'replace', checkpoint ? Object.keys(checkpoint.surfaceOp).sort().join(',') : 'no checkpoint row'])
  list.push(['stored: checkpoint source is producer-owned (compact-checkpoint + compactionId)', !!checkpoint && typeof checkpoint.data.source.compactionId === 'string', ''])
  const endSeq = lastEndSeq(stored)
  list.push(['stored: conversation continued after the transaction', stored.some((event) => event.type === 'assistant/message' && event.seq > endSeq), ''])
  return list
}
const checksOf = { 'basic-compress': checksBasic, 'nudge-rhythm': checksRhythm, 'compress-then-decompress': checksDecompress, 'acp-status': checksStatus, 'overflow-recovery': checksOverflow, 'jsonl-compress': checksJsonlCompress }
const loadScenario = async (name) => {
  return JSON.parse(readFileSync(new URL(`./scenarios/${name}.json`, import.meta.url), 'utf8'))
}
const main = async () => {
  const fails = []
  for (const name of scenarioNames) {
  const scenario = await loadScenario(name)
  let result
  try {
    result = await runScenario(scenario)
  } catch (err) {
    console.log(`--- ${name}`)
    console.log(`  ERROR ${err && err.message ? err.message : String(err)}`)
    fails.push(`${name}: scenario threw`)
    continue
  }
  console.log(`--- ${name}`)
  const kinds = result.requests.map((request) => request.kind ?? 'error').join(',')
  console.log(`requests: ${kinds}`)
  // Decode what actually landed on disk ONCE; every scenario's rows went through
  // the real writer, so every scenario gets the persistence net.
  let storedLoad
  try {
    storedLoad = { events: await storedEventsOf(result) }
  } catch (err) {
    storedLoad = { error: err && err.message ? err.message : String(err) }
  }
  const checks = [...checksOf[name](result, storedLoad.events ?? null), ...cachePrefixChecks(result), ...checksPersistence(result, storedLoad)]
  const before = fails.length
  checks.forEach((row) => {
  console.log(`  ${row[1] ? 'PASS' : 'FAIL'} ${row[0]}${row[2] ? ` — ${row[2]}` : ''}`)
  if (!row[1]) fails.push(`${name}: ${row[0]}`)
  })
  if (fails.length === before) {
    rmSync(result.persistRoot, { recursive: true, force: true })
  } else {
    console.log(`  (persisted log kept at ${result.persistRoot} for inspection)`)
  }
}
  if (fails.length) {
    console.log(`e2e FAIL (${fails.length}): ${fails.join('; ')}`)
    process.exit(1)
  }
  console.log('e2e PASS')
  process.exit(0)
}
await main()
