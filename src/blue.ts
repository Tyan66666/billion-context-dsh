/**
 * Minimal Blue frontend identity for marketplace discovery and compatibility
 * admission. ACP keeps its existing Harness command and model tools; this
 * entry deliberately contributes no Blue-specific UI or session access.
 * @module billion-context-dsh/blue
 */

import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { BluePluginHost } from '@dsh-blue/blue-api'
import { validateBluePluginManifestV1 } from '@dsh-blue/blue-api/protocol/v1'

type BlueContext = Context & { readonly bluePluginHost: BluePluginHost }

export const name = 'billion-context-dsh-blue'
export const inject = ['bluePluginHost']

function loadManifest() {
  const source: unknown = JSON.parse(readFileSync(new URL('../blue.plugin.json', import.meta.url), 'utf8'))
  const parsed = validateBluePluginManifestV1(source)
  if (!parsed.ok) {
    throw new TypeError(`invalid blue.plugin.json: ${parsed.issues[0]?.message ?? 'unknown issue'}`)
  }
  return parsed.value
}

export function apply(ctx: BlueContext): void {
  const opened = ctx.bluePluginHost.open(ctx, loadManifest())
  if (!opened.ok) ctx.logger.warn(`billion-context-dsh: Blue frontend admission failed: ${opened.message}`)
}
