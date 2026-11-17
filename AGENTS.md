# Decisions

- Read [`docs/decisions/README.md`](docs/decisions/README.md) and the area files your work touches before starting.
- Whenever a new concept, goal, paradigm, or high-level system decision comes up, record it in the matching area file under `docs/decisions/` in the same PR as the work. Add a new file and list it in the index when no area fits.

# Workflow

Full rules in [`docs/decisions/workflow.md`](docs/decisions/workflow.md).

- One PR per thread, never stacked. Rebase only when GitHub reports a real conflict.
- After opening a PR, run `pr-ship [--merge]` (shared, from `~/code/scripts`) in the foreground until it exits 0. Its exit code names the next step.
- Never skip git hooks. Fix the failure instead.
- Run only the relevant tests locally; CI runs the full suite.
- `packages/client-web/web.test.ts` is the browser-runtime exception the `tests` skill allows: sync logic that runs only in a page, a worker and OPFS. It never drives UI, never runs in a hook, and runs as its own CI job (`bun run test:web`).
- After a PR merges, bump the sync-engine pin in every repo that depends on it (today `a-better-me`: `bun.lock` and `Package.resolved`). Commit the bump straight to that repo's `master`; open a PR there only when the merge broke the protocol, an API or a schema consumers use.

# Stack

- Runtime: Bun
- Language: TypeScript
- Linting: Oxlint
- Git Hooks: Lefthook
