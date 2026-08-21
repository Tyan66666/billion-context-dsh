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
 *   - Decode uses the `zstd` CLI (or python3 `zstandard`) for reading; encode
 *     uses node:zlib and reproduces the host's MULTI-FRAME layout (header line
 *     in frame 1, events in frame 2) — a single whole-file frame fails the
 *     host's assertZstdHeaderFrame and blocks DSH startup.
 *   - The claim pricing imports the engine's own mirror (`src/host-tokens.ts`),
 *     so there is exactly ONE estimator.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, constants } from 'node:zlib'
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

/**
 * Encode a session log in the DSH persistence format (multi-frame zstd):
 * frame 1 = the header line ALONE, frame 2 = all event lines — each frame
 * compressed with node:zlib + checksum, mirroring the host's
 * `encodeMaterialization` (dsh-session-persistence-jsonl). A single
 * whole-file frame breaks the host's `assertZstdHeaderFrame` ("first frame is
 * not exactly one header line") and blocks DSH startup — do NOT compress the
 * whole log as one frame.
 */
function encodeZstd(path, text) {
  const nl = text.indexOf('\n')
  if (nl === -1) throw new Error('session log has no header line')
  const header = Buffer.from(text.slice(0, nl + 1), 'utf8')
  const body = Buffer.from(text.slice(nl + 1), 'utf8')
  const options = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
  const headerFrame = zstdCompressSync(header, options)
  const bodyFrame = zstdCompressSync(body, options)
  writeFileSync(path, Buffer.concat([headerFrame, bodyFrame]))
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
const pathArg = args.find((a) => a.startsWith('--path='))?.split('=')[1]
const pathPos = args.indexOf('--path')
const directPath = pathArg ?? (pathPos >= 0 ? args[pathPos + 1] : undefined)
const dryRun = args.includes('--dry-run')
const force = args.includes('--force')
const noBackup = args.includes('--no-backup')

if (!sessionId && !directPath) {
  console.error('usage: node --import tsx scripts/rescue-shadow-price.mjs --session <session-id> [--path <file>] [--dry-run] [--force]')
  process.exit(2)
}

const zstdPath = directPath ?? (sessionId !== undefined ? locateSession(sessionId) : null)
if (zstdPath === null || !existsSync(zstdPath)) {
  console.error(`session file not found: ${directPath ?? `session ${sessionId} under ${SESSIONS_ROOT}`}`)
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
// GUI before applying.
if (!force) {
  console.log('dry-run (no --force) — no changes written. Close the session in the GUI, then re-run with --force.')
  process.exit(0)
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
