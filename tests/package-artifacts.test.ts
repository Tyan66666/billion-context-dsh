import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'

// Git-source installs (`dsh plugin add github:Tyan66666/billion-context-dsh#<ref>`,
// the form the plugin store shows) ship the repo verbatim: pnpm ≥10/11 blocks
// dependency build scripts by default (`allowBuilds`), and for a git-hosted
// package the approval key must contain the exact resolved commit hash
// (pnpm#12367), so the install can only work if the package carries its build
// output and runs NO build scripts. That is why `dist/` is committed (issue
// #92) — this test pins the two halves of that contract so a future edit
// cannot silently re-break git installs.
//
// Freshness (the committed dist actually matching the current source) is
// enforced separately by the CI build step (`git status --porcelain -- dist`),
// which rebuilding cannot express inside a unit test.

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
	main: string
	types: string
	exports: Record<string, { types?: string; import?: string }>
	files: string[]
	dsh: { bundle: { patch: string } }
	scripts: Record<string, string>
}

test('the entry points and bundle patch resolve to committed files', () => {
	// The npm tarball ships exactly `files` (+ README/LICENSE/package.json);
	// committing the same paths makes a git clone install-equivalent to the
	// published package. If an entry point gains a path that is neither
	// committed nor built, one of these asserts names it.
	const targets = [pkg.main, pkg.types, pkg.exports['.']?.types, pkg.exports['.']?.import, pkg.dsh.bundle.patch].filter(
		(target): target is string => typeof target === 'string',
	)
	assert.ok(targets.length >= 4, 'package.json must declare main/types/exports and dsh.bundle.patch')
	for (const target of targets) {
		const path = new URL(`../${target}`, import.meta.url)
		assert.ok(existsSync(path), `committed artifact missing: ${target}`)
		assert.ok(statSync(path).size > 0, `committed artifact is empty: ${target}`)
	}
})

test('the committed bundle is the ACP engine (ESM, AcpCompactionEngine exported)', () => {
	const js = readFileSync(new URL(`../${pkg.main}`, import.meta.url), 'utf8')
	const dts = readFileSync(new URL(`../${pkg.types}`, import.meta.url), 'utf8')
	// A stale or wrong-file dist would still "exist"; pinning the exported
	// engine name catches a dist built from a different source tree.
	assert.match(dts, /AcpCompactionEngine/u, `dist types must export AcpCompactionEngine (${pkg.types})`)
	assert.match(js, /AcpCompactionEngine/u, `dist bundle must contain AcpCompactionEngine (${pkg.main})`)
})

test('the package defines zero build/lifecycle scripts', () => {
	// pnpm gates `prepare` on git-hosted packages and preinstall/install/
	// postinstall on ALL dependencies behind `allowBuilds`; adding any of
	// them turns every git-source (and potentially store) install into a
	// hard failure (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`) that users can
	// only escape with a commit-hash key (pnpm#12367, pnpm#12294). The
	// committed dist makes build steps unnecessary — keep it that way.
	const forbidden = ['prepare', 'preprepare', 'postprepare', 'preinstall', 'install', 'postinstall']
	const present = forbidden.filter((script) => script in pkg.scripts)
	assert.deepEqual(present, [], `no lifecycle build scripts allowed (pnpm 11 blocks them on installs); found: ${present.join(', ')}`)
})
