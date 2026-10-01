import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import semver from 'semver'

// The peer contract spans FIVE seam packages the plugin VALUE-imports at
// runtime (not type-only, so they must resolve to the host's copy, not a
// stale nested copy): dsh-compaction, dsh-session, dsh-llm, dsh-tools and
// dsh-settings. All five publish the SAME version line (DSH releases them
// together), so they share one range.
//
// ISSUE #192 — the range now floors at the 0.2.0 line. The 0.2.0 seam changed
// two things this engine relies on: the tool-result model (a result payload is
// now a first-class ToolResultMessage with a message-level toolCallId; there is
// no nested tool-result content block anymore) and the settings service
// (`SettingsProvider.installSection` is gone — `SettingsForms` builds sections
// from each plugin's own `static Config` schema). This engine line is verified
// against 0.2.0-rc.2 (devDep baseline + typecheck + suite); earlier 0.2.0
// prereleases are unverified and stay below the floor. Hosts below 0.2.0 can
// no longer install this plugin line — users who stay on 0.1.x keep plugin
// ≤v0.2.26, which remains installed and functional there.
//
// The explicit `>=0.2.0-rc.2 <0.3.0-0` form pins EXACTLY the 0.2.0 line
// (every 0.2.0 prerelease from rc.2 up, plus every final 0.2.x release) and
// nothing beyond it: node-semver sorts `0.3.0-0` before any `0.3.0-x`
// prerelease (numeric ids precede alphanumeric ones), so the next line's
// alphas/rCs are rejected until someone verifies them deliberately. A caret
// (`^0.2.0-rc.2`) would silently admit 0.3.0+ — never allowed here (house
// rule: no unverified line).
//
// The same-tuple prerelease rule still applies underneath: a candidate WITH a
// prerelease tag satisfies only when some comparator shares its
// [major,minor,patch] tuple. The floor comparator `0.2.0-rc.2` therefore
// admits 0.2.0-x prereleases but NOT, say, 0.2.5-rc.1 (tuple 0.2.5) — while
// FINAL 0.2.x versions are admitted as ordinary versions. The asymmetry is
// intrinsic to semver's prerelease handling and held for the 0.1.5 range too.
//
// Versions below come from `npm view @deepseek-ai/dsh-session versions` — the
// published line matches dsh-compaction / dsh-llm / dsh-tools / dsh-settings
// exactly.

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
	peerDependencies: Record<string, string>
}

// The runtime VALUE-imported seam packages (matches what dist/index.js pulls
// in). cordis is also a peer but ships on a 4.x line and is NOT part of this
// seam version band, so it is excluded — these five move in lockstep with the
// DSH host.
// dsh-settings stays in the list although the engine no longer REGISTERS a
// settings section on this line (SettingsForms would need the engine's own
// `static Config` schema — tracked follow-up): src/commands.ts still
// VALUE-imports SettingsConflictError for the config-write failure mapping.
const seamPeers = [
	'@deepseek-ai/dsh-compaction',
	'@deepseek-ai/dsh-session',
	'@deepseek-ai/dsh-llm',
	'@deepseek-ai/dsh-tools',
	'@deepseek-ai/dsh-settings',
]

for (const peerName of seamPeers) {
	const peerRange = pkg.peerDependencies[peerName]
	assert.equal(typeof peerRange, 'string', `${peerName} must be declared as a peer (runtime VALUE-import)`)

	test(`${peerName}: peer range accepts the verified 0.2.0 seam line`, () => {
		// The verified baseline — including the live desktop build from issue
		// #192 (0.2.0-rc.2).
		assert.equal(
			semver.satisfies('0.2.0-rc.2', peerRange),
			true,
			`${peerRange} must accept the verified 0.2.0-rc.2 baseline`,
		)
		// Future same-tuple prereleases keep installing: publishing newer rCs on
		// the 0.2.0 line never breaks installs.
		for (const v of ['0.2.0-rc.9', '0.2.0-rc.99']) {
			assert.equal(semver.satisfies(v, peerRange), true, `${v} must satisfy ${peerRange} (same-line rc)`)
		}
		// A final 0.2.0 (no prerelease) is a normal version and stays in range.
		assert.equal(semver.satisfies('0.2.0', peerRange), true)
		// Later 0.2.x finals are the same line — admitted until 0.3.0 lands.
		for (const v of ['0.2.1', '0.2.9']) {
			assert.equal(semver.satisfies(v, peerRange), true, `${v} must satisfy ${peerRange} (same-line final)`)
		}
	})

	test(`${peerName}: peer range keeps rejecting older and next-line versions`, () => {
		// Below the floor: the UNVERIFIED 0.2.0-rc.1 and every pre-0.2.0 line,
		// including the former devDep baseline 0.1.5-rc.1 and the whole 0.1.6/
		// 0.1.7 stretch. Their tool-result and settings shapes predate what
		// this engine line verifies, so they are intentionally out of contract
		// (issue #192).
		for (const v of ['0.1.5-alpha.1', '0.1.5-rc.1', '0.1.6-alpha.1', '0.1.7-rc.2', '0.2.0-rc.1']) {
			assert.equal(semver.satisfies(v, peerRange), false, `${v} must NOT satisfy ${peerRange}`)
		}
		// Next lines: 0.3.0 (any prerelease or final) is a deliberate, later
		// decision — never silently allowed.
		for (const v of ['0.3.0-alpha.1', '0.3.0-rc.1', '0.3.0']) {
			assert.equal(semver.satisfies(v, peerRange), false, `${v} must NOT satisfy ${peerRange}`)
		}
		// Same-tuple rule: a 0.2.x PRERELEASE whose tuple is not 0.2.0 does not
		// satisfy the floor (while final 0.2.x versions above do) — pinning
		// semver's inherent asymmetry so nobody "fixes" it away.
		assert.equal(semver.satisfies('0.2.1-rc.1', peerRange), false, `0.2.1-rc.1 must NOT satisfy ${peerRange}`)
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
