# Contributing — billion-context-dsh

> The full development specification lives in [AGENTS.md](AGENTS.md) (highest priority). This file covers the collaboration workflow only.

## Getting started

```bash
npm install
npm run typecheck   # strict TypeScript check
npm test            # unit tests (node --import tsx --test)
npm run build       # tsup bundle
```

- No `as any`, no `@ts-ignore`; tests use ESM static imports.
- Every bug fix ships with a regression test (AGENTS.md §4).
- `acp-kernel` upgrades follow the manual SOP in AGENTS.md §4b — don't bump the version yourself.

## Commit convention

`main` only accepts **squash merges**: the commit landed on main IS the **PR title**, which must match one of the formats below. **Commits inside a PR are intentionally unconstrained** — the squash subject is what matters.

| Kind | Format | Use |
|---|---|---|
| Feature | `(feat) <summary>` | new functionality (e.g. `(feat) tier-2/3 block distillation — …`) |
| Fix | `(fix) <summary>` | bug fixes |
| Refactor | `(refactor) <summary>` | internal restructuring, no behavior change |
| Test | `(test) <summary>` | tests only |
| Chore | `(chore) <summary>` | tooling / process (CI, deps, scripts) |
| Docs | `docs: <summary>` | docs only (README / docs/ / AGENTS.md) |
| Release | `release vX.Y.Z` | the release commit (strictly per AGENTS.md §5) |

`<summary>` is a single informative sentence without a trailing period.

PR titles are enforced by CI (`.github/workflows/pr-lint.yml`, rule in `scripts/check-pr-title.mjs`); a PR whose title doesn't match cannot be merged.

## Opening a PR

1. Branch off `main` (`git switch -c <your-branch> main`).
2. Commit freely inside the branch.
3. Open the PR with a **title** following the convention above — it becomes the main-branch commit message.
4. CI must be green: `ci` (typecheck + test + build) and `pr-title` (title check) are required to merge.
5. Merging is **human-only**. Per AGENTS.md §5, an Agent must never merge any PR.

## Branch protection on main (enabled)

`main` is branch-protected:

- Direct pushes are blocked; all changes land via PRs;
- PRs must pass the `ci` and `pr-title` status checks;
- Force pushes and branch deletion are disabled;
- No reviewer approval required (solo maintainer can't approve their own PR).

## Releasing

See AGENTS.md §5: `npm version` bump → sync version refs in docs → `npm publish` → `release vX.Y.Z` commit → `gh release create` → Pages rebuilds automatically.
