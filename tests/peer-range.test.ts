import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import semver from 'semver'

// Issue #68: the peer range must cover BOTH `0.1.0-rc.x` and `0.1.1-rc.x` of
// `@deepseek-ai/dsh-compaction`. node-semver (what npm uses for peer
// resolution) only lets a prerelease version satisfy a range when the range
// has a comparator on the SAME [major, minor, patch] tuple — a lone
// `^0.1.0-rc.6` (tuple 0.1.0) can never match `0.1.1-rc.2` (tuple 0.1.1), so
// the plugin failed to install on DSH releases that bumped the seam to
// 0.1.1-rc.x even though the public API did not change. The fix is the
// explicit multi-clause range below; this test pins the real npm behavior so a
// future tightening of the range turns red here.
//
// DSH 0.1.2-alpha removed the public `Session.events` getter (replaced by
// `snapshotEvents()` / `eventAt()`); the engine now feature-detects both
// shapes, and the `^0.1.2-alpha.4` clause admits the whole 0.1.2 alpha seam.
//
// The versions below come from `npm view @deepseek-ai/dsh-compaction
// versions` (the full published list, plus 0.1.1 and 0.2.x as the
// not-yet-published neighbors the range must anticipate or reject).

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
	peerDependencies: { '@deepseek-ai/dsh-compaction': string }
}

const peerRange = pkg.peerDependencies['@deepseek-ai/dsh-compaction']

test('peer range accepts every published dsh-compaction rc line the seam shares', () => {
	// Every version ever published on the 0.1.0 → 0.1.1 seam line must install.
	// (The DSH release diffs for rc.7 → rc.8 → 0.1.1-rc.1 → 0.1.1-rc.2 touch
	// only package.json + README — src/ is unchanged.)
	for (const v of ['0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8', '0.1.1-rc.1', '0.1.1-rc.2']) {
		assert.equal(
			semver.satisfies(v, peerRange),
			true,
			`${v} must satisfy ${peerRange} (same seam API as 0.1.0-rc.6)`,
		)
	}
	// A future final 0.1.1 (no prerelease) is a normal version and stays in range.
	assert.equal(semver.satisfies('0.1.1', peerRange), true)
	// The `^0.1.1-rc.1` clause covers the WHOLE 0.1.1 line: its `>=0.1.1-rc.1`
	// comparator carries tuple 0.1.1, matching the tuple of every future
	// 0.1.1-rc.x — publishing newer rcs on the same line never breaks installs.
	for (const v of ['0.1.1-rc.3', '0.1.1-rc.9', '0.1.1-rc.99']) {
		assert.equal(semver.satisfies(v, peerRange), true, `${v} must satisfy ${peerRange} (same-line rc)`)
	}
	// The 0.1.2 alpha seam (current DSH runtime, `Session.events` removed): the
	// published 0.1.2-alpha.4 and any same-tuple-prerelease successor install.
	for (const v of ['0.1.2-alpha.4', '0.1.2-alpha.5', '0.1.2-rc.1']) {
		assert.equal(semver.satisfies(v, peerRange), true, `${v} must satisfy ${peerRange} (0.1.2 seam)`)
	}
})

test('peer range keeps rejecting older and next-minor versions', () => {
	// Below the floor: nothing before 0.1.0-rc.6 (the old workaround era).
	for (const v of ['0.0.1-rc.5', '0.1.0-rc.2', '0.1.0-rc.5']) {
		assert.equal(semver.satisfies(v, peerRange), false, `${v} must NOT satisfy ${peerRange}`)
	}
	// Next lines: a jump to 0.1.3, and 0.2.x are all deliberate, later
	// decisions — never silently allowed. (0.1.2-rc.x is allowed above: it is
	// the same tuple as the admitted 0.1.2-alpha seam.)
	for (const v of ['0.1.3-rc.1', '0.2.0-rc.1', '0.2.0', '0.2.1']) {
		assert.equal(semver.satisfies(v, peerRange), false, `${v} must NOT satisfy ${peerRange}`)
	}
})