# Decisions

- Read [`docs/decisions/README.md`](docs/decisions/README.md) and the area files your work touches before starting.
- Whenever a new concept, goal, paradigm, or high-level system decision comes up, record it in the matching area file under `docs/decisions/` in the same PR as the work. Add a new file and list it in the index when no area fits.

# Workflow

Full rules in [`docs/decisions/workflow.md`](docs/decisions/workflow.md).

- One PR per thread, never stacked. Rebase only when GitHub reports a real conflict.
- After opening a PR, run `bun scripts/pr-ship.ts [--merge]` in the foreground until it exits 0. Its exit code names the next step.
- Never skip git hooks. Fix the failure instead.
- Run only the relevant tests locally; CI runs the full suite.
- After a PR merges, bump the sync-engine pin in every repo that depends on it (today `a-better-me`: `package.json` and `Package.resolved`), one PR per repo.

# Stack

- Runtime: Bun
- Language: TypeScript
- Linting: Oxlint
- Git Hooks: Lefthook
