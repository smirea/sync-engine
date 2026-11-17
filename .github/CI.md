# Continuous integration

`workflows/ci.yml` runs on pull requests, `master` pushes and manual dispatches. A newer push cancels the run in progress. Every check is its own job, and all of them run in parallel.

- **Bun** (`lint:ci`, `typecheck`, `test`, `build`): one job per root package script, the same scripts the pre-commit hook calls. They run on every change and time out at 5 minutes. CI caches package downloads, then installs with `--frozen-lockfile`. `.bun-version` and `packageManager` pin Bun; update them together.
- **`web`**: the Playwright browser suite, `bun run test:web`.
- **`proofs`**: the Bend proofs under the Lean kernel, `bun scripts/spec.ts --install`.
- **`swift`**: `swift test` on a macOS runner.

The last three sit behind `scripts/changes.ts`, which decides from the diff whether each one's inputs changed. When they did not, the job reports success without running, and `swift` does so from a Linux runner, so a change that touches no Swift never waits for a macOS machine. Manual dispatches, initial pushes and changes under `.github/` run every job. Documentation changes are ignored. A failure in change detection fails those jobs too. Edit `scripts/changes.ts` when a job gains or loses an input.

Actions are pinned to commit SHAs. Dependabot checks for action updates weekly. Keep CI checks read-only.
