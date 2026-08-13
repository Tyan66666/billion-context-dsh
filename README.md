# billion-context-dsh

**One billion, not one million.** [Active Context Pruning (ACP)](https://github.com/ranxianglei/acp-kernel) for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — model-driven context management as a `CompactionEngine` backend.

The model decides *when* and *what* to compress — not a hard limit. Long conversations stay lean while critical details (paths, decisions, errors) survive in high-fidelity summaries you can search and decompress.

This is the DSH port of [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) (the Pi coding-agent adapter). The compression kernel (`acp-kernel`) is reused verbatim; the adapter layer was rewritten against DSH's durable-surface model — see [docs/dsh-porting-verification.md](docs/dsh-porting-verification.md) for the verified mapping.

## How it works

DSH derives every model request from its append-only session log (the *surface*). ACP semantics map onto that model directly:

| ACP concept | DSH implementation |
|---|---|
| `compress` tool shadows a range | durable `surfaceOp: { op: 'replace' }` — the model-written summary becomes a checkpoint node; the originals stay in the log |
| refs (`m00001` tags) | surface seqs, carried by the nudge's compressible-range table |
| nudge ("you should compress") | injected at `agent/pre-step` by the kernel's pressure decision |
| `decompress` | read-only recovery of shadowed originals from the log |
| `search_context` | scores block summaries + originals rebuilt from the log |
| `acp_status` | block ledger + context pressure |
| block state | in-memory kernel state + **log-rebuilt ledger** (no sidecar files) |

There is deliberately **no automatic summarization**: automatic policy only nudges the model (`compactIfNeeded` returns null). That is the ACP cost win — the model writes one dense summary instead of paying for a second LLM summarization call.

## Install / mount

The package is a drop-in compaction backend. Add one row to the host composition (or an agent preset's compaction realm):

```yaml
# host composition (e.g. profile cordis.patch.yml)
- insert:
    - id: compaction-billion-context
      name: 'billion-context-dsh'
      config:
        modelContextLimit: 128000   # default; the pressure window
```

To replace `dsh-compaction-basic` for one agent, mount it inside the preset's `compaction` isolate realm instead:

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
  config:
    - id: compaction-acp
      name: 'billion-context-dsh'
      config:
        modelContextLimit: 128000
```

When the hosting context provides `ctx.tools` / `ctx.commands`, the engine also registers:

- `compress` — replace ranges with dense summaries you write
- `decompress` — recover a block's original content (read-only)
- `search_context` — find information inside compressed blocks
- `acp_status` — block ledger and pressure
- `/acp` — status / compress / decompress from the command bar

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `modelContextLimit` | `128000` | Context window used for the kernel's pressure decisions |
| `nudgeMinContextLimitPct` | kernel default `0.45` | Nudge window lower bound (usage fraction) — same default as billion-context-pi |
| `nudgeMaxContextLimitPct` | kernel default `0.75` | Over-limit line: above this the nudge fires regardless of growth |
| `nudgeEmergencyThresholdPct` | kernel default `0.95` | Emergency nudge (bypasses the per-turn dedup) |
| `coreOverrides` | — | Any other acp-kernel `Config` override (billion-context-pi's `coreOverrides` escape hatch) |
| `autoTools` | `true` | Register the four model tools on `ctx.tools` |
| `autoCommand` | `true` | Register the `/acp` command on `ctx.commands` |
| `autoNudge` | `true` | Inject the nudge into `agent/pre-step` |

## Development

```bash
npm install
npm run typecheck   # strict TS
npm test            # node --import tsx --test tests/*.test.ts
npm run build       # tsup bundle (inlines acp-kernel) + .d.ts
```

`dist/index.js` is self-contained except for the `@deepseek-ai/*` seam packages, which the hosting deployment provides.

## Architecture

```
src/
├── index.ts      # AcpCompactionEngine (CompactionEngine backend) + wiring
├── messages.ts   # M1: session events ↔ acp-kernel CoreMessage projection
├── state.ts      # M2: per-session kernel state
├── region.ts     # M5: durable region transaction + log-rebuilt block ledger
├── tools.ts      # M3: compress / decompress / search_context / acp_status
├── nudge.ts      # M4: kernel pressure decision → injected nudge message
└── commands.ts   # M4: /acp slash command
```

## License

MIT
