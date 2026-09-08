import { runScenario } from './harness.mjs'
import { readFileSync } from 'node:fs'
const scenarioNames = ['basic-compress', 'nudge-rhythm', 'compress-then-decompress']
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
const checksBasic = (result) => {
  const list = []
  list.push(['compaction start/end paired', countsOf(result.events).starts >= 1 && countsOf(result.events).ends === countsOf(result.events).starts, `starts=${countsOf(result.events).starts} ends=${countsOf(result.events).ends}`])
  list.push(['summary shadows first user turn', shadowedSeqsOf(result.events, result.seqs.U1), `U1=${result.seqs.U1}`])
  list.push(['shadowedTokenCount non-negative', shadowedTokenCountOf(result.events) >= 0, `sum=${shadowedTokenCountOf(result.events)}`])
  list.push(['durable replace node landed', surfaceOpOf(result.events), ''])
  list.push(['strict tool pairing in final request', wirePairing(result.requests), ''])
  list.push(['nudge injected at least once', nudgeIndices(result.requests).length >= 1, `nudges on requests ${nudgeIndices(result.requests).join(',')}`])
  list.push(['conversation continued after end', continuationOf(result.events, lastEndSeq(result.events)), ''])
  return list
}
const checksRhythm = (result) => {
  const list = []
  list.push(['no nudge while history is small', nudgeIndices(result.requests).every((index) => index > 5), `nudges on requests ${nudgeIndices(result.requests).join(',') || 'none'}`])
  list.push(['nudge once history is large', nudgeIndices(result.requests).some((index) => index >= 6), `nudges on requests ${nudgeIndices(result.requests).join(',') || 'none'}`])
  list.push(['nudge not on every request', nudgeIndices(result.requests).length < result.requests.length, ''])
  return list
}
const checksDecompress = (result) => {
  const list = checksBasic(result).slice()
  list.push(['no new compaction events at decompress step', countsOf(result.events).starts === 1 && countsOf(result.events).ends === 1, `starts=${countsOf(result.events).starts}`])
  list.push(['decompress result carries original text', containsOf(result.events, 'Note 0: the pruning section'), ''])
  list.push(['compress result reports tier', containsOf(result.events, 'tier'), ''])
  return list
}
const checksOf = { 'basic-compress': checksBasic, 'nudge-rhythm': checksRhythm, 'compress-then-decompress': checksDecompress }
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
