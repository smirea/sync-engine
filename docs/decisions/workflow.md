# Workflow

- **One PR per thread, never stacked.** Fold small same-area follow-ups into an open PR instead of starting a new thread.
- **Rebase only on a real conflict.** PR CI already tests the merge with `master`.
- **PRs wait on one script.** `bun scripts/pr-ship.ts [--merge]` waits for CI, lists failing checks and unresolved review threads, reports a conflict with the base branch, and merges when green. It exits before the 600-second tool limit with a code that names the next step, printed as its last line, so an agent reruns it instead of writing `sleep` loops.
- **Hooks install with `bun install`.** Bun skips dependency lifecycle scripts, so lefthook's own installer never runs; the root `postinstall` runs `lefthook install`.
- **Hooks run only what the change touches.** Pre-commit runs oxlint and oxfmt one after the other on staged files, since in parallel one overwrote the other's fix. The typecheck runs only when a script or JSON file is staged. Pre-commit and pre-push run `scripts/test-changed.ts`, which picks every test whose imports reach a changed file. It runs with `--no-env-file`, so it sees the same environment as CI.
- **Tests run in a pinned zone and never against a remote database.** `bunfig.toml` preloads `scripts/test-timezone.ts` and `scripts/test-guard.ts`.
- **Git hooks are never skipped.** A Claude Code hook in `.claude/settings.json` blocks `--no-verify` and lefthook overrides. A failing hook gets its cause fixed; a flaky test is a bad test.
- **Run only the relevant tests locally.** CI runs the full suite.
- **The protocol proofs run under the Lean kernel.** `bun run spec` runs `bend spec/PROOF.bend --verdict` with the Bend release and Lean toolchain pinned in `spec/toolchain.json`; `--install` fetches both into `~/.bend` and `~/.elan` without touching a shell profile. Pre-commit runs it when a `spec/` file is staged, and the CI `proofs` job runs it with `--install` when `spec/` or `scripts/spec.ts` changed, caching the two toolchains by the pin file's hash. A failing proof is fixed by re-aligning `PROOF.bend`, never by weakening `LAWS.bend`.
