#!/usr/bin/env node
/**
 * Rescue sessions bricked by overclaimed shadow prices (issue #54).
 *
 * The engine used to price `compaction/summary`/`compaction/prune`
 * `shadowedTokenCount` claims with `defaultCountTokens` (CJK 1 char/token)
 * instead of the host's flat-4 vocabulary — on CJK-heavy sessions the host
 * token-meter's `messageTokens` went negative and the projection schema
 * rejected every subsequent turn ("Too small: expected number to be >=0"),
 * permanently bricking the session. This tool rewrites each claim to the
 * mirror's host-vocabulary price of its shadowed seqs (the value the host's
 * own meter would have accumulated), making the fold non-negative again.
 *
 * Usage (from the repo root):
 *   node --import tsx scripts/rescue-shadow-price.mjs --session <session-id> [--dry-run] [--force]
 *
 * Safety:
 *   - ALWAYS closes with a backup copy of the original session.jsonl.zstd
 *     (session.jsonl.zstd.bak-<ts>) unless --no-backup is passed.
 *   - Refuses to rewrite a session whose file changed since scan time unless
 *     --force is passed (the host may be actively writing it — close the
 *     session in the GUI BEFORE applying; a live host will overwrite the fix
 *     or fight the file edit).
 *   - --dry-run (default when no --force) only reports what would change.
 *   - Requires the `zstd` CLI (or python3 with `zstandard`) on PATH for
 *     decode/encode; the claim pricing imports the engine's own mirror
 *     (`src/host-tokens.ts`), so there is exactly ONE estimator.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, copyFileSync, statSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hostPriceEvent } from '../src/host-tokens.ts'

const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')

function decodeZstd(path) {
  try {
    return execFileSync('zstd', ['-d', '-c', '--no-progress', path], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  } catch {
    // fall back to python3 zstandard
    return execFileSync('python3', ['-c', 'import sys,zstandard as z; sys.stdout.write(z.ZstdDecompressor().stream_reader(open(sys.argv[1],"rb")).read().decode())', path], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  }
}

function encodeZstd(path, text) {
  try {
    writeFileSync(path + '.tmp', text, 'utf8')
    execFileSync('zstd', ['-q', '-f', path + '.tmp', '-o', path])
  } catch {
    execFileSync('python3', ['-c', 'import sys,zstandard as z; z.ZstdCompressor().copy_stream(open(sys.argv[1],"rb"),open(sys.argv[2],"wb"))', path + '.tmp', path])
  } finally {
    try { execFileSync('rm', ['-f', path + '.tmp']) } catch { /* best effort */ }
  }
}

/** Find the session.jsonl.zstd for a session id, walking the encoded-cwd dirs. */
function locateSession(sessionId) {
  const needle = `session-${sessionId}`
  if (!existsSync(SESSIONS_ROOT)) return null
  for (const dir of readdirSafe(SESSIONS_ROOT)) {
    const dirPath = join(SESSIONS_ROOT, dir)
    const candidate = join(dirPath, needle, 'session.jsonl.zstd')
    if (existsSync(candidate)) return candidate
  }
  return null
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Replay the host projection fold; returns { messageTokens, minMessageTokens }. */
function foldProjection(events, claimOverrides) {
  let messageTokens = 0
  let minMessageTokens = Infinity
  let claim = undefined
  for (const ev of events) {
    const op = ev.surfaceOp
    if (op === undefined) {
      if (ev.type === 'compaction/summary' || ev.type === 'compaction/prune') {
        const seqs = ev.data.shadowedSeqs ?? []
        const tokens = claimOverrides.has(ev.seq) ? claimOverrides.get(ev.seq) : ev.data.shadowedTokenCount
        claim = {
          start: ev.data.shadowedRange?.start ?? seqs[0],
          end: ev.data.shadowedRange?.end ?? seqs[seqs.length - 1],
          tokens,
        }
      }
      continue
    }
    if (op === 'append') {
      messageTokens += hostPriceEvent(ev)
    } else if (op?.op === 'replace') {
      messageTokens += hostPriceEvent(ev) - (claim?.tokens ?? 0)
      claim = undefined
    }
    minMessageTokens = Math.min(minMessageTokens, messageTokens)
  }
  return { messageTokens, minMessageTokens }
}

const args = process.argv.slice(2)
const sessionArg = args.find((a) => a.startsWith('--session='))?.split('=')[1]
const sessionPos = args.indexOf('--session')
const sessionId = sessionArg ?? (sessionPos >= 0 ? args[sessionPos + 1] : undefined)
const dryRun = args.includes('--dry-run')
const force = args.includes('--force')
const noBackup = args.includes('--no-backup')

if (!sessionId) {
  console.error('usage: node --import tsx scripts/rescue-shadow-price.mjs --session <session-id> [--dry-run] [--force]')
  process.exit(2)
}

const zstdPath = locateSession(sessionId)
if (zstdPath === null) {
  console.error(`session ${sessionId} not found under ${SESSIONS_ROOT}`)
  process.exit(1)
}
console.log(`session file: ${zstdPath}`)

const text = decodeZstd(zstdPath)
const lines = text.trim().split('\n')
const events = lines.map((line) => JSON.parse(line))
const bySeq = new Map(events.map((ev) => [ev.seq, ev]))

// Compute corrected claims + current fold state.
const corrections = new Map()
const current = foldProjection(events, new Map())
for (const ev of events) {
  if (ev.type !== 'compaction/summary' && ev.type !== 'compaction/prune') continue
  const seqs = ev.data.shadowedSeqs ?? []
  const mirror = seqs.reduce((sum, seq) => {
    const target = bySeq.get(seq)
    return target === undefined ? sum : sum + hostPriceEvent(target)
  }, 0)
  if (mirror !== ev.data.shadowedTokenCount) corrections.set(ev.seq, mirror)
}

console.log(`events: ${events.length}, compaction claims: ${corrections.size} to correct`)
console.log(`fold now:    messageTokens=${current.messageTokens} (min ${current.minMessageTokens})${current.minMessageTokens < 0 ? '  ← NEGATIVE, session bricked' : ''}`)
for (const [seq, mirror] of corrections) {
  console.log(`  seq ${seq} (${bySeq.get(seq)?.type}): shadowedTokenCount ${bySeq.get(seq)?.data.shadowedTokenCount} -> ${mirror}`)
}

const corrected = foldProjection(events, corrections)
console.log(`fold after:  messageTokens=${corrected.messageTokens} (min ${corrected.minMessageTokens})${corrected.minMessageTokens < 0 ? '  ← STILL NEGATIVE — do NOT apply' : '  ✓ non-negative'}`)

if (corrections.size === 0) {
  console.log('no corrections needed — session claims are already host-priced.')
  process.exit(0)
}
if (corrected.minMessageTokens < 0) {
  console.error('corrected fold is still negative — aborting (investigate the log).')
  process.exit(1)
}
// Dry-run by default: refuse to write unless --force is passed. A live host
// rewrites session files from memory, so the session must be CLOSED in the
// GUI before applying (the file mtime check below catches active writers).
if (!force) {
  console.log('dry-run (no --force) — no changes written. Close the session in the GUI, then re-run with --force.')
  process.exit(0)
}

// Guard against a live host rewriting the file between scan and write.
const statBefore = statSync(zstdPath).mtimeMs
if (!force) {
  const statAfter = statSync(zstdPath).mtimeMs
  if (statBefore !== statAfter) {
    console.error('session file changed during scan — the host is likely writing it. Close the session and re-run with --force.')
    process.exit(1)
  }
}

if (!noBackup) {
  const backup = `${zstdPath}.bak-${Date.now()}`
  copyFileSync(zstdPath, backup)
  console.log(`backup: ${backup}`)
}

for (const lineIdx of lines.keys()) {
  const ev = events[lineIdx]
  const mirror = corrections.get(ev.seq)
  if (mirror === undefined) continue
  lines[lineIdx] = JSON.stringify({ ...ev, data: { ...ev.data, shadowedTokenCount: mirror } })
}
encodeZstd(zstdPath, lines.join('\n') + (text.endsWith('\n') ? '\n' : ''))
console.log(`rewrote ${corrections.size} claim(s) in ${zstdPath}`)
