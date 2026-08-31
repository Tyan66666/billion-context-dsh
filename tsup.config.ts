import { defineConfig } from 'tsup'

// Bundle the adapter into one self-contained dist/index.js. acp-kernel is
// deliberately INLINED (not external), matching billion-context-pi: zero
// runtime deps. tsup externalizes `dependencies` BY DEFAULT, so the inline
// requires an explicit noExternal — without it dist/index.js ships
// `import ... from "acp-kernel"` and the published package silently gains a
// runtime dep (this exact drift shipped through v0.2.4). The @deepseek-ai/*
// seam packages stay external — the hosting DSH deployment provides them.
//
// Blue's validator requires the public entry to retain a literal `const name`.
// Bundling turns that declaration into `var`, so the small Blue entry is only
// transpiled; its JSON import resolves to the manifest beside dist/ at runtime.
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node20',
    dts: false,
    sourcemap: true,
    clean: true,
    external: [/^@deepseek-ai\//],
    noExternal: ['acp-kernel'],
  },
  {
    entry: ['src/blue.ts'],
    format: ['esm'],
    target: 'node20',
    dts: false,
    sourcemap: true,
    clean: false,
    bundle: false,
    esbuildOptions(options) {
      // The Blue manifest already requires Node 22.19+; keep the runtime JSON
      // attribute even though the ACP entry still targets the Node 20 baseline.
      options.supported = { 'import-attributes': true }
    },
  },
])
