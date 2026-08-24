import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The bundle patch (`cordis.patch.yml`, declared as `dsh.bundle.patch` in
// package.json) is the zero-config install contract (AGENTS.md design
// decision 8): the plugin store / `dsh plugin add` auto-layers it into a
// profile's composition, so it alone must make the engine GLOBAL for that
// profile with nothing else to write. This test pins that contract so a
// future edit of the patch cannot silently ship a broken install.
//
// Parsing is deliberately line-based (like dshmarket's own patch checker):
// no YAML dependency, and the file is a small hand-maintained entry list.

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const lines = patch.split(/\r?\n/u)

/** Column-0 rows of the patch (the entry list items). */
const topLevelRows = lines
	.map((line, index) => ({ line, index }))
	.filter(({ line }) => /^-\s/u.test(line) && !/^\s/u.test(line))

test('bundle patch ships the root-realm collision guard', () => {
	// The host's own `compaction-basic` would register `ctx.compaction` at the
	// root realm too; only one provider per realm may own that service name.
	const row = topLevelRows.find(({ line }) => line === '- id: compaction-basic')
	assert.ok(row, 'patch must contain a top-level `- id: compaction-basic` row')
	// `disabled: true` must sit in the same block, a few lines below the id.
	const block = lines.slice(row.index + 1, row.index + 4).map((line) => line.trimStart())
	assert.ok(block.some((line) => line === 'disabled: true'), 'the compaction-basic row must be disabled: true')
})

test('bundle patch mounts the engine globally with zero config', () => {
	const insert = topLevelRows.find(({ line }) => line === '- insert:')
	assert.ok(insert, 'patch must contain a top-level `- insert:` list')

	// Collect the indented rows that belong to the insert list.
	const block: string[] = []
	for (let i = insert.index + 1; i < lines.length; i++) {
		const line = lines[i]
		if (!line || !line.startsWith('    ')) break
		block.push(line.trimStart())
	}

	assert.ok(block.includes('- id: compaction-acp'), 'the insert list must mount the engine row `compaction-acp`')
	assert.equal(
		block.filter((line) => line.includes("name: 'billion-context-dsh'")).length,
		1,
		'the engine row must reference `billion-context-dsh` exactly once',
	)
	// Zero-config default: no `config:` on the bundle row — the context window
	// is auto-detected (fallback 128000) and the built-in prompt copy is used.
	assert.ok(
		!block.some((line) => line.startsWith('config:')),
		'the bundle row must carry NO config (users override with a same-id row)',
	)
})