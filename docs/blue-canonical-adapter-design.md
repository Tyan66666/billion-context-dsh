# Blue canonical adapter design

## Problem

`billion-context-dsh` already provides its complete user workflow through the Harness `/acp` command and the `compress`, `decompress`, `search_context`, and `acp_status` model tools. Blue still needs a canonical package identity to discover the installed plugin and check whether its frontend entry is compatible.

Rebuilding the ACP block ledger in a Blue projection would create a second implementation of `src/region.ts` and make the renderer responsible for domain rules it does not own. A Blue-only status panel would also duplicate the kernel-owned report already exposed by `/acp` and `acp_status`.

## Decision

The package keeps `src/index.ts` as the existing Harness domain entry and adds `src/blue.ts` as a separate public entry. The Blue entry:

- parses the packaged `blue.plugin.json` with `@dsh-blue/blue-api/protocol/v1`;
- opens that same manifest through `bluePluginHost`;
- declares no required or optional capability;
- contributes no command, status node, pane, overlay, notification, or custom UI;
- reads no session identity or projection data.

The existing Harness `/acp` command and four model tools remain the only user-facing ACP surfaces. Domain state continues to come only from the ACP engine and its durable Harness session log.

The host entry already registers `/acp` in the Harness command registry. Blue projects that registry for the current Agent and dispatches a submitted slash command through the Harness command lifecycle, so `/acp status` works directly in Blue without a canonical command contribution. Blue's `commands` capability is for Blue-local commands whose callback returns a `BlueResult` or consumes a Blue user gesture; registering another `acp` contribution would duplicate the existing Harness command instead of adapting it. The empty capability list is therefore the minimal correct declaration, not a loss of command functionality.

## Package and composition

`package.json.blue.manifest` points to `./blue.plugin.json`. The manifest selects the public `./blue` export, and both files are included in the packed package. `@dsh-blue/blue-api` is an exact runtime dependency; host-owned `@deepseek-ai/cordis@^4.0.2` remains a peer so the package cannot introduce a second Cordis service instance.

The bundle row is installed in Blue and non-Blue profiles alike. The module must therefore parse on the package's Node 20 baseline before Cordis can wait for `bluePluginHost`. It reads and validates `blue.plugin.json` with `node:fs` inside `apply`, after the injected service is available; a module-scope JSON import attribute would fail during parsing on older Node 20 releases.

The bundle patch mounts two independent entries:

```yaml
- insert:
    - id: compaction-acp
      name: 'billion-context-dsh'
    - id: billion-context-dsh-blue
      name: 'billion-context-dsh/blue'
```

The Blue entry injects `bluePluginHost`. In an ordinary DSH profile it waits for that service while the independent `compaction-acp` entry continues to run. A plain `npm install` user adds the second row only when the target profile is Blue.

The identifiers belong to separate host and distribution namespaces:

| Namespace | Value |
| --- | --- |
| npm package and canonical manifest id | `billion-context-dsh` |
| public package export | `billion-context-dsh/blue` |
| Cordis plugin name and bundle row id | `billion-context-dsh-blue` |
| Website Marketplace slug | `billion-context` |

## Compatibility boundary

The canonical manifest targets API `^1.0.0-beta.1`, Blue `>=0.1.2-alpha.1 <0.1.2`, and exactly Harness `0.1.2-alpha.2`. The API caret is a protocol compatibility promise: compatible v1 API additions remain admissible. The product ranges record actual integration evidence, so Harness stays exact and Blue is capped before `0.1.2`. Acceptance must use Blue's packed validator and conformance runner against that exact Harness line.

The Blue API requires `@deepseek-ai/cordis@^4.0.2`. A fresh install of an older Harness line can resolve its `^4.0.1` declaration to 4.0.2, but a profile whose manifest pins the exact `4.0.1` version must upgrade Cordis or the host and refresh its lockfile before installing this adapter.

This result does not cover Blue `0.1.1-rc.3` with Harness `0.1.1-rc.2`, even though that older pair appeared in the original issue discussion. The ACP engine's peer range may retain separately verified RC seams; that broader install range is not a Blue conformance claim.

## Marketplace boundary

A valid canonical manifest proves package discovery shape and enables host admission. It does not prove Website Marketplace verification by itself. Billion Context is already listed as Adapting at `https://dsh-blue.dev/marketplace/billion-context/`. After this adapter is merged and released, the author must open a separate PR against `dsh-blue/marketplace` to update the plugin's `registry.json` entry and bilingual `content/billion-context/{zh,en}.md` description. A Blue maintainer changes the entry to `verified` only after reviewing the conformance and real-profile evidence.

## Verification

Repository tests guard the manifest identity, empty capability lists, package discovery pointer, public export, packed file list, exact Blue API dependency, Harness peer tuple, and additive bundle row. The release gate additionally requires:

1. project typecheck, tests, and build;
2. Node 20 import of the built Blue entry in a non-Blue environment;
3. Blue validator success against the packed package;
4. packed conformance on Harness `0.1.2-alpha.2` with `declared == executed`, no skipped scenarios or failures, and cleanup success;
5. installation into a dedicated non-production Blue profile, followed by direct `/acp status`, `acp_status` model-tool, and clean-exit smoke checks; the adapter must not duplicate the Harness command as a Blue-local contribution.
