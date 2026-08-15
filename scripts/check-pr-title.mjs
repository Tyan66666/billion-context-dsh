// Validates a PR title against the repo commit convention.
//
// The PR title becomes the squash-merge commit subject on main, so it must
// follow the convention documented in CONTRIBUTING.md / AGENTS.md §4.
// Commits inside a PR are intentionally NOT constrained.
//
// Usage: node scripts/check-pr-title.mjs "<PR title>"

const title = (process.argv[2] ?? '').trim();

const re =
  /^(\((feat|fix|refactor|test|chore)\) .+|docs: .+|release v\d+\.\d+\.\d+)$/;

if (!re.test(title)) {
  console.error('[pr-lint] PR title does not match the commit convention:');
  console.error(`  got:      ${title}`);
  console.error('  expected: (feat|fix|refactor|test|chore) <summary>');
  console.error('            docs: <summary>');
  console.error('            release vX.Y.Z');
  process.exit(1);
}

console.log(`[pr-lint] OK: ${title}`);
