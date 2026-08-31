import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { Session } from '@deepseek-ai/dsh-session'
import AcpCompactionEngine from '../src/index.ts'

interface PackageManifest {
  readonly blue?: { readonly manifest?: string }
  readonly exports?: Record<string, unknown>
  readonly files?: readonly string[]
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
}

interface BlueManifest {
  readonly id?: string
  readonly entry?: string
  readonly api?: string
  readonly compatibility?: { readonly blue?: string; readonly harness?: string; readonly node?: string }
  readonly capabilities?: { readonly required?: readonly unknown[]; readonly optional?: readonly unknown[] }
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageManifest
const manifest = JSON.parse(readFileSync(new URL('../blue.plugin.json', import.meta.url), 'utf8')) as BlueManifest

test('Blue canonical identity targets only the verified alpha compatibility line', () => {
  assert.equal(manifest.id, 'billion-context-dsh')
  assert.equal(manifest.entry, './blue')
  assert.equal(manifest.api, '^1.0.0-beta.1')
  assert.deepEqual(manifest.compatibility, {
    blue: '>=0.1.2-alpha.1 <0.1.2',
    harness: '0.1.2-alpha.2',
    node: '^22.19.0 || >=24.0.0',
  })
})

test('Blue adapter reuses Harness /acp and requests no Blue-local capability', () => {
  assert.deepEqual(manifest.capabilities, { required: [], optional: [] })
})

test('Harness command registry exposes /acp for Blue current-session dispatch', async () => {
  const ctx = new Context()
  ctx.plugin(CommandRuntime)
  ctx.plugin(AcpCompactionEngine as never)
  await new Promise((resolve) => setTimeout(resolve, 20))

  const session = Session.create('blue-command-test')
  const agent = {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx,
  } as unknown as Agent

  assert.ok(ctx.commands.list(agent).some((command) => command.name === 'acp'))
  const execution = await ctx.commands.execute(agent, '/acp status', new AbortController().signal)
  assert.ok(execution !== undefined)
  assert.equal(execution.result.kind, 'success')
  assert.match(execution.result.text ?? '', /^ACP status — session blue-command-test/u)
  assert.deepEqual(session.events.map((event) => event.type), ['command/run', 'command/done'])
})

test('package discovery and packed files expose the dedicated Blue entry', () => {
  assert.equal(pkg.blue?.manifest, './blue.plugin.json')
  assert.ok(Object.hasOwn(pkg.exports ?? {}, './blue'))
  assert.ok(Object.hasOwn(pkg.exports ?? {}, './blue.plugin.json'))
  assert.ok(pkg.files?.includes('blue.plugin.json'))
  assert.equal(pkg.dependencies?.['@dsh-blue/blue-api'], '0.1.2-alpha.1')
  assert.equal(pkg.peerDependencies?.['@deepseek-ai/cordis'], '^4.0.2')
})
