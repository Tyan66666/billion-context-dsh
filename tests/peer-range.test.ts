import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import semver from 'semver'

// The peer contract spans FOUR seam packages the plugin VALUE-imports at
// runtime (not type-only, so they must resolve to the host's copy, not a
// stale nested copy): dsh-compaction, dsh-session, dsh-llm, dsh-tools. All
// four publish the SAME version line (in lockstep because DSH releases them
// together), so one shared range guards them all.
//
// ISSUE #136 — the range now floors at the 0.1.5 line. The replace surfaceOp
// protocol is DRAFTED per session version by a strict validator that accepts
// EXACTLY three keys: `dsh-session <= 0.1.3-alpha.2` wants `{ op, start, end }`,
// `>= 0.1.5-alpha.1` wants `{ op, startSeq, endSeq }`. The engine emits one
// dialect only (the current one), so hosts on older lines reject every
// compress at runtime — admitting them in the peer range would be a lie. The
// 0.1.5 line also changed the assistant settlement shape (required `stream`)
// and forbids `sourceEventSeqs` on assistant replaces; both are pinned by the
// typecheck against the 0.1.5-rc.1 devDeps.
//
// The explicit `>=0.1.5-alpha.1 <0.1.6-0` form pins EXACTLY the 0.1.5 line
// (every 0.1.5 prerelease plus the final 0.1.5) and nothing beyond it: node-semver
// sorts `0.1.6-0` before any `0.1.6-x` prerelease (numeric ids precede
// alphanumeric ones), so the next line's alphas/rCs are rejected until someone
// verifies them deliberately. A caret (`^0.1.5-alpha.1`) would silently admit
// 0.1.6+ — never allowed here (house rule: no unverified line).
//
// The same-tuple prerelease rule still applies underneath: a candidate with a
// prerelease tag only satisfies a range when some comparator shares its
// [major, minor, patch] tuple — `0.1.5-alpha.1`/`rc.x` all share tuple 0.1.5,
// which is why one clause covers the whole line.
//
// Versions below come from `npm view @deepseek-ai/dsh-session versions` — the
// published line matches dsh-compaction / dsh-llm / dsh-tools exactly.

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
	peerDependencies: Record<string, string>
}

// The runtime VALUE-imported seam packages (matches what dist/index.js pulls
// in). cordis is also a peer but ships on a 4.x line and is NOT part of this
// seam version band, so it is excluded — these four move in lockstep with the
// DSH host.
const seamPeers = ['@deepseek-ai/dsh-compaction', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools']

for (const peerName of seamPeers) {
	const peerRange = pkg.peerDependencies[peerName]
	assert.equal(typeof peerRange, 'string', `${peerName} must be declared as a peer (runtime VALUE-import)`)

	test(`${peerName}: peer range accepts the whole 0.1.5 seam line`, () => {
		// Every published 0.1.5 version installs — including the live desktop
		// build from issue #136 (0.1.5-alpha.2).
		for (const v of ['0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1']) {
			assert.equal(
				semver.satisfies(v, peerRange),
				true,
				`${v} must satisfy ${peerRange} (same replace-op dialect as 0.1.5-alpha.1)`,
			)
		}
		// Future same-tuple prereleases keep installing: publishing newer rCs on
		// the 0.1.5 line never breaks installs.
		for (const v of ['0.1.5-rc.9', '0.1.5-rc.99']) {
			assert.equal(semver.satisfies(v, peerRange), true, `${v} must satisfy ${peerRange} (same-line rc)`)
		}
		// A final 0.1.5 (no prerelease) is a normal version and stays in range.
		assert.equal(semver.satisfies('0.1.5', peerRange), true)
	})

	test(`${peerName}: peer range keeps rejecting older and next-line versions`, () => {
		// Below the floor: every pre-0.1.5 line, including the former devDep
		// baseline 0.1.0-rc.6 and the 0.1.2/0.1.3 seams. Their session validators
		// reject the startSeq/endSeq dialect at runtime (issue #136), so they are
		// intentionally out of contract.
		for (const v of ['0.1.0-rc.6', '0.1.1-rc.2', '0.1.2-alpha.4', '0.1.2-rc.1', '0.1.3-alpha.2']) {
			assert.equal(semver.satisfies(v, peerRange), false, `${v} must NOT satisfy ${peerRange}`)
		}
		// Next lines: 0.1.6 (any prerelease or final) and 0.2.x are deliberate,
		// later decisions — never silently allowed.
		for (const v of ['0.1.6-alpha.1', '0.1.6-rc.1', '0.1.6', '0.2.0-rc.1', '0.2.0']) {
			assert.equal(semver.satisfies(v, peerRange), false, `${v} must NOT satisfy ${peerRange}`)
		}
	})
}

test('every runtime VALUE-imported seam package is declared as a peer', () => {
	// dist/index.js must never carry a VALUE import of a @deepseek-ai seam
	// package that is NOT a peer — in a non-hoisted / stale-nested install that
	// resolves to a copy inconsistent with the host (the "reading 7" class of
	// crash). seamPeers above are the complete runtime set.
	for (const name of seamPeers) {
		assert.equal(typeof pkg.peerDependencies[name], 'string', `${name} must be a peer (runtime VALUE-import)`)
	}
})
