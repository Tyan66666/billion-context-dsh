import { runScenario } from './harness.mjs'
import { readFileSync } from 'node:fs'
const scenarioNames = ['basic-compress', 'nudge-rhythm', 'compress-then-decompress', 'acp-status']
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
  list.push(['report excludes window-semantics rows (human-side /acp)', !report.includes('estimated context') && !report.includes('context window'), ''])
  return list
}
const checksOf = { 'basic-compress': checksBasic, 'nudge-rhythm': checksRhythm, 'compress-then-decompress': checksDecompress, 'acp-status': checksStatus }
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
  const checks = checksOf[name](result)
  checks.forEach((row) => {
  console.log(`  ${row[1] ? 'PASS' : 'FAIL'} ${row[0]}${row[2] ? ` — ${row[2]}` : ''}`)
  if (!row[1]) fails.push(`${name}: ${row[0]}`)
  })
}
  if (fails.length) {
    console.log(`e2e FAIL (${fails.length}): ${fails.join('; ')}`)
    process.exit(1)
  }
  console.log('e2e PASS')
  process.exit(0)
}
await main()
