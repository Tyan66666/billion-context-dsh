import { defineConfig } from 'tsup'

// Bundle the adapter into one self-contained dist/index.js. acp-kernel is
// deliberately INLINED (not external), matching billion-context-pi: zero
// runtime deps. tsup externalizes `dependencies` BY DEFAULT, so the inline
// requires an explicit noExternal — without it dist/index.js ships
// `import ... from "acp-kernel"` and the published package silently gains a
// runtime dep (this exact drift shipped through v0.2.4). The @deepseek-ai/*
// seam packages stay external — the hosting DSH deployment provides them.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  dts: false,
  sourcemap: true,
  clean: true,
  external: [/^@deepseek-ai\//],
  noExternal: ['acp-kernel'],
})
