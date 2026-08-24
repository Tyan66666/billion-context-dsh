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
// explicit two-clause range below; this test pins the real npm behavior so a
// future tightening of the range turns red here.
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
})

test('peer range keeps rejecting older and next-minor versions', () => {
	// Below the floor: nothing before 0.1.0-rc.6 (the old workaround era).
	for (const v of ['0.0.1-rc.5', '0.1.0-rc.2', '0.1.0-rc.5']) {
		assert.equal(semver.satisfies(v, peerRange), false, `${v} must NOT satisfy ${peerRange}`)
	}
	// Next minor: 0.2.x is a deliberate, later decision — never silently allowed.
	for (const v of ['0.2.0-rc.1', '0.2.0', '0.2.1']) {
		assert.equal(semver.satisfies(v, peerRange), false, `${v} must NOT satisfy ${peerRange}`)
	}
})