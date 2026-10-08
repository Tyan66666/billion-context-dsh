import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import semver from 'semver'

// The peer contract spans FIVE seam packages the plugin VALUE-imports at
// runtime (not type-only, so they must resolve to the host's copy, not a
// stale nested copy): dsh-compaction, dsh-session, dsh-llm, dsh-tools and
// dsh-settings. All five publish the SAME version line (DSH releases them
// together) and share one range. dsh-settings historically moved on its own
// cadence; since issue #190 the band admits lines where the settings service
// no longer offers `installSection` (≥0.1.7 renamed it SettingsForms) because
// the engine probes for the method at startup and degrades cleanly there
// (issue #173 path: the six knobs keep their composition values, /acp-prune
// config reports unavailable) instead of crashing.
//
// ISSUE #136 — the range floors at the 0.1.5 line. The replace surfaceOp
// protocol is DRAFTED per session version by a strict validator that accepts
// EXACTLY three keys: `dsh-session <= 0.1.3-alpha.2` wants `{ op, start, end }`,
// `>= 0.1.5-alpha.1` wants `{ op, startSeq, endSeq }`. The engine emits one
// dialect only (the current one), so hosts on older lines reject every
// compress at runtime — admitting them in the peer range would be a lie. The
// 0.1.5 line also changed the assistant settlement shape (required `stream`)
// and forbids `sourceEventSeqs` on assistant replaces; both are pinned by the
// typecheck against the devDeps baseline.
//
// ISSUE #190 — the ceiling moved from `<0.1.6-0` to `<0.2.1-0`. DSH ≥0.1.6
// ships a pre-install peer gate (`dsh plugin add` runs `pnpm view` on the
// spec and semver-checks every `@deepseek-ai/dsh*` peer against the RUNNING
// host version before installing anything), so the old ceiling made every
// host from 0.1.6 onward reject the plugin outright — nothing was installed,
// and the failure surfaced as a generic "plugin command failed". The
// 0.2.0-rc.2 seam line is verified end-to-end here (typecheck + full suite +
// e2e harness run against the 0.2.0-rc.2 devDeps baseline); the intermediate
// 0.1.6/0.1.7 lines are admitted by bracket verification plus their documented
// live audits of read-side shapes (V4 source kinds #163/#169,
// compact-checkpoint #168, SettingsForms probe #173). The replace-op dialect
// is unchanged across the whole band (pinned by tests/surfaceop-dialect.test.ts
// against real sessions of whichever line is installed). `0.2.1-0` still sorts
// ahead of any `0.2.1-x` prerelease (numeric ids precede alphanumeric ones),
// so the NEXT line stays rejected until it is verified deliberately — the
// house rule (no unverified line) is unchanged, only the verified set grew.
//
// The assertions below call semver.satisfies with `{ includePrerelease: true }`
// — the EXACT option the host's pre-install gate uses (packages/boot/app-boot
// plugin-compatibility.ts). Under plain satisfies() a mid-band prerelease such
// as 0.2.0-rc.2 would be rejected (no comparator shares its [major,minor,patch]
// tuple), which would make this file lie about what actually installs; matching
// the host's evaluation is the point of the pin.
//
// Versions below come from `npm view @deepseek-ai/dsh-session versions` — the
// published line matches dsh-compaction / dsh-llm / dsh-tools exactly.

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
	peerDependencies: Record<string, string>
}

// The runtime VALUE-imported seam packages (matches what dist/index.js pulls
// in). cordis is also a peer but ships on a 4.x line and is NOT part of this
// seam version band, so it is excluded — these five move in lockstep with the
// DSH host.
// dsh-settings joined this list with the 0.1.5 seam: the plugin calls
// `settingsProvider.installSection(...)`, which the older standalone
// `installSettingsSection(ctx, ns, schema, entry, hooks)` helper does not
// provide, so a host below the floor cannot work. On lines ≥0.1.7 the method
// is gone entirely (service renamed SettingsForms) — the engine probes for it
// and degrades cleanly there instead (issue #173 path, see header above).
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

	test(`${peerName}: peer range accepts the whole verified seam band (0.1.5 → 0.2.0)`, () => {
		// Every published version from the 0.1.5 floor through the 0.2.0
		// ceiling installs — including the live desktop builds from issue #136
		// (0.1.5-alpha.2) and the issue #190 reporter's host (0.2.0-rc.2).
		// Future same-line rCs stay in range, so new releases on an admitted
		// line never break installs.
		for (const v of [
			'0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.9', '0.1.5-rc.99', '0.1.5',
			'0.1.6-alpha.1', '0.1.6-alpha.2', '0.1.6-rc.1', '0.1.6',
			'0.1.7-alpha.1', '0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2', '0.1.7',
			'0.2.0-rc.1', '0.2.0-rc.2', '0.2.0-rc.99', '0.2.0',
		]) {
			assert.equal(
				semver.satisfies(v, peerRange, { includePrerelease: true }),
				true,
				`${v} must satisfy ${peerRange}`,
			)
		}
	})

	test(`${peerName}: peer range keeps rejecting older and next-line versions`, () => {
		// Below the floor: every pre-0.1.5 line, including the former devDep
		// baseline 0.1.0-rc.6 and the 0.1.2/0.1.3 seams. Their session validators
		// reject the startSeq/endSeq dialect at runtime (issue #136), so they are
		// intentionally out of contract.
		for (const v of ['0.1.0-rc.6', '0.1.1-rc.2', '0.1.2-alpha.4', '0.1.2-rc.1', '0.1.3-alpha.2']) {
			assert.equal(
				semver.satisfies(v, peerRange, { includePrerelease: true }),
				false,
				`${v} must NOT satisfy ${peerRange}`,
			)
		}
		// Next line and beyond: 0.2.1+ (any prerelease or final) and 0.3.x are
		// deliberate, later decisions — never silently allowed (house rule).
		for (const v of ['0.2.1-0', '0.2.1-rc.1', '0.2.1', '0.2.2', '0.3.0-rc.1', '0.3.0']) {
			assert.equal(
				semver.satisfies(v, peerRange, { includePrerelease: true }),
				false,
				`${v} must NOT satisfy ${peerRange}`,
			)
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
