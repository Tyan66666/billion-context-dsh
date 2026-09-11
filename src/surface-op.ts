/**
 * Version-aware `surfaceOp` replacement shape.
 *
 * DSH renamed the positional replacement contract in 0.1.5-alpha.1 (host
 * commit 657e68186a). Before that a replace carried `{ op:'replace', start,
 * end }`; from 0.1.5-alpha.1 the fields are `{ op:'replace', startSeq,
 * endSeq }` and the host's `isReplaceOp` guard (`surface.ts`) now also REJECTS
 * any object that is not exactly `op` + `startSeq` + `endSeq`. The old shape
 * makes every host of that line throw
 *   `session event "<type>" carries an invalid replace surfaceOp`
 * at append AND at history replay, so a single production build must emit the
 * field set the INSTALLED host expects.
 *
 * Both lines are distinguished by the literally installed
 * `@deepseek-ai/dsh-session` version (the host's copy is the contract owner —
 * the surface fold lives in the `dsh-session` package, not the DSH web
 * bundle). We probe it at runtime via `createRequire` — the same resolution
 * the Host implicitly trusts when it lazily loads `@deepseek-ai/*` — and cache
 * the answer for the process lifetime (a process runs against one installed
 * seam; it cannot change mid-flight).
 *
 * The threshold follows the host's own tag history (checked against the
 * DeepSeek Harness monorepo):
 *   - `dsh-v0.1.3-alpha.2` and earlier: `{ op:'replace', start, end }`
 *   - `dsh-v0.1.5-alpha.1` and later: `{ op:'replace', startSeq, endSeq }`
 * 0.1.4 was never published, so the newest-legacy `0.1.3-alpha.2` and the
 * oldest-new `0.1.5-alpha.1` bound a clean gap.
 *
 * `semver` is a devDependency only (never bundled into dist), so the compare
 * is a self-contained pre-release-aware helper scoped to the two published
 * lines — no extra runtime dependency.
 * @module billion-context-dsh/surface-op
 */

import { createRequire } from 'node:module'
import type { SurfaceOp } from '@deepseek-ai/dsh-session'

/** The replacement range an event lands, in the shape the host expects. */
export type SurfaceReplaceOp =
  | { op: 'replace'; start: number; end: number }
  | { op: 'replace'; startSeq: number; endSeq: number }

/**
 * The replacement-range member of the INSTALLED dsh-session's `SurfaceOp` —
 * the static type axiom this module is compiled against. The 0.1.0-rc.6 seam
 * (the devDep/test baseline) spells it `{op:'replace',start,end}`; the version
 * probe below decides at RUNTIME which of the two published field sets to
 * write. The return type is pinned to the installed shape so `region.ts` can
 * hand the result straight to `session.append`, whose `surfaceOp` parameter is
 * typed with the installed `SurfaceOp`. When the runtime probe chooses the
 * RENAMED shape, we deliberately step past this type: a probe that reads the
 * installed version will never produce `{start,end}` on an 0.1.5+ host, and
 * vice-versa, so assigning a `SurfaceReplaceOp` to the installed `SurfaceOp`
 * at the call site is safe (the union admits the only two runtimes a host can
 * be). The cast lives in one place below, not scattered over region.ts.
 */
export type InstalledReplaceSurfaceOp = Extract<SurfaceOp, { op: 'replace' }>

/** Pre-release-aware numeric-ish sort of two UTF-8 version identifiers. */
function compareIdentifiers(a: string, b: string): number {
  const aNum = /^\d+$/.test(a)
  const bNum = /^\d+$/.test(b)
  if (aNum && bNum) return Number(a) - Number(b)
  if (aNum) return -1 // numeric identifiers sort below alphanumeric
  if (bNum) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Compare two semver strings. Returns <0 when `a` sorts before `b`, 0 on
 * equality, >0 after. Handles the `major.minor.patch[-pre]` form used by the
 * dsh-session lines (a full build metadata `+` suffix is ignored, which never
 * occurs on these line tags). Scope is intentionally the two published
 * version families; the generic core is still RFC-2119 semver.
 */
export function compareSurfaceOpVersions(a: string, b: string): number {
  const parse = (v: string): { parts: number[]; pre: string[] } => {
    const split = v.split('-')
    const core = split[0] ?? '0'
    const prePart = split[1]
    const parts = core.split('.').map((n) => Number.parseInt(n, 10))
    const pre = (prePart ?? '').split('.').filter((s) => s.length > 0)
    return { parts, pre }
  }
  const A = parse(a)
  const B = parse(b)
  const max = Math.max(A.parts.length, B.parts.length)
  for (let i = 0; i < max; i++) {
    const pA = A.parts[i] ?? 0
    const pB = B.parts[i] ?? 0
    if (pA !== pB) return pA - pB
  }
  // No pre-release identifiers on either: equal core == equal version.
  if (A.pre.length === 0 && B.pre.length === 0) return 0
  // A release (no pre) sorts after any pre-release of the same core.
  if (A.pre.length === 0) return 1
  if (B.pre.length === 0) return -1
  const len = Math.min(A.pre.length, B.pre.length)
  for (let i = 0; i < len; i++) {
    const cmp = compareIdentifiers(A.pre[i]!, B.pre[i]!)
    if (cmp !== 0) return cmp
  }
  return A.pre.length - B.pre.length
}

/** The first dsh-session version that renamed the surfaceOp replace fields. */
export const SURFACE_OP_RENAME_VERSION = '0.1.5-alpha.1'

/** Whether an installed dsh-session speaks the NEW `startSeq/endSeq` shape. */
export function usesNewSurfaceOpShape(version: string): boolean {
  return compareSurfaceOpVersions(version, SURFACE_OP_RENAME_VERSION) >= 0
}

/** Build a surfaceOp replacement in the shape the given host line expects. */
export function replaceSurfaceOp(start: number, end: number, version: string): SurfaceReplaceOp {
  if (usesNewSurfaceOpShape(version)) {
    return { op: 'replace', startSeq: start, endSeq: end }
  }
  return { op: 'replace', start, end }
}

let cachedUsesNewShape: boolean | undefined

/**
 * Probe the installed `@deepseek-ai/dsh-session` version once and remember
 * which surfaceOp shape it speaks. Cached for the process lifetime — a
 * process runs against one installed seam, so the answer cannot flip.
 * Falls back to the LEGACY shape when the version cannot be resolved (e.g. a
 * test harness that never installed the seam past the rc.6 baseline) — older
 * line semantics are the conservative default that matches the peers listed
 * before this rename landed.
 */
export function installedUsesNewSurfaceOpShape(): boolean {
  if (cachedUsesNewShape !== undefined) return cachedUsesNewShape
  let version: string | undefined
  try {
    const require = createRequire(import.meta.url)
    version = require('@deepseek-ai/dsh-session/package.json').version as string
  } catch {
    version = undefined
  }
  cachedUsesNewShape = usesNewSurfaceOpShape(version ?? '0.1.0-rc.6')
  return cachedUsesNewShape
}

/** Build the replacement op in the installed host's expected shape. */
export function installedSurfaceReplaceOp(start: number, end: number): InstalledReplaceSurfaceOp {
  return replaceSurfaceOp(start, end, installedUsesNewSurfaceOpShape() ? SURFACE_OP_RENAME_VERSION : '0.1.0-rc.6') as InstalledReplaceSurfaceOp
}

/** Reset the module-level version cache (test only). */
export function resetSurfaceOpDetection(): void {
  cachedUsesNewShape = undefined
}