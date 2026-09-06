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

## Writing for readers

Assume the reader sees your PR title, description, and commit message for the first time — no internal jargon, no abbreviations. PR title = one sentence on what changed and what problem it fixes; PR description = problem → cause → fix → verification. Plain, however, never means lossy: keep the precise anchors (function names, parameter names, file paths, line numbers) verbatim — they are the grep-able evidence. See AGENTS.md §4 (Plain-language writing).

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

## `dist/` build artifacts (you never touch them)

`dist/` is committed so git-source installs work with zero build steps (AGENTS.md §5, issue #92) — but it is invisible to your workflow:

- PR branches never carry `dist/` and you never rebuild or commit it. Push freely — the CI dist check does not gate PRs.
- After every merge that can change the build output (`src/**`, `package.json`, `package-lock.json`, `tsup.config.ts`), `.github/workflows/dist-bot.yml` rebuilds and pushes one fresh-`dist/` commit directly to main as `github-actions[bot]` (main's branch protection has `enforce_admins` disabled and the bot pushes with the maintainer's `DIST_BOT_TOKEN` PAT; humans still land everything via PRs). Your branch is never touched — no bot commits to pull, no dist conflicts.
- Local `npm run build` is optional (typecheck and tests run off `src/`). Its output may show as a tracked modification of the `dist/` you inherited from main — just don't commit it (`git checkout -- dist` restores).
- Releases: after merging the release PR, the dist-bot refreshes main's dist if the build output changed; if so, wait for that commit before `gh release create` so the `#<tag>` install carries the final artifacts.

## Branch protection on main (enabled)

`main` is branch-protected:

- PRs must pass the `ci` and `pr-title` status checks;
- Force pushes and branch deletion are disabled;
- `enforce_admins` is **disabled** — the maintainer's admin credential may push directly, which is what lets the dist-bot's `DIST_BOT_TOKEN` PAT land its `dist/` commit on main (`.github/workflows/dist-bot.yml`);
- By convention ALL human changes land via PRs; no reviewer approval required (solo maintainer can't approve their own PR).

## Releasing

See AGENTS.md §5: `npm version` bump → sync version refs in docs → `npm publish` → `release vX.Y.Z` commit → `gh release create` → Pages rebuilds automatically.

## Issue triage automation (labels → Roadmap project)

`.github/workflows/issue-triage.yml` keeps the GitHub Project「billion-context-dsh Roadmap」in sync with issue labels:

- **sync job** — when an issue is opened, labeled, or unlabeled, it is added to project #1 (idempotently), and the label currently applied maps to project fields: `priority: P0/P1/P2/backlog` → the Priority single-select field; `upstream-pending` → a pointer in the Upstream text field (see `docs/upstream-tracker.md`). Only the label from the triggering event is synced — other labels are left untouched.
- **watch-upstream job** — a daily cron compares the upstream PRs referenced in `docs/upstream-tracker.md` and in issue bodies (links of the form `acp-kernel/pull/<n>`); when an upstream PR is merged, the issue gets the `upstream-merged` label and an SOP comment. Requires `docs/upstream-tracker.md` to exist (skipped otherwise).

Both jobs write to the project via a repository secret **GH_PROJECT_TOKEN** — a fine-grained PAT with the user-level **Projects → Read and write** permission (Project V2 GraphQL mutations need more than the default `GITHUB_TOKEN`). To activate the automation, add the secret under Settings → Secrets and variables → Actions. Without it, the workflow prints a notice and exits 0 (CI stays green; project fields are simply not updated).
