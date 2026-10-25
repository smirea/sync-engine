# client-web todo (Feature playbook)

- [x] 1. `how` over the affected subsystem. skip as a skill run: read core types, client loop, client test, bun-server, bun-sqlite, procrastimate's PowerSync use directly (single-owner feature, files named in the brief)
- [x] 2. `architect` for parallel design exploration. skip: the architecture was decided by two browser spikes (Prototype playbook), not by a bakeoff; Chromium forbids both OPFS in a SharedWorker and nested workers from one
- [x] 3. Throughput checkpoint
  - Blocking first steps: spikes (done), design brief
  - Independent workstreams: n/a, one code-coupled feature; the fork owns the worktree
  - Shared mutable state: the worktree /Users/stefan/code/sync-engine-web belongs to the fork until it returns
  - Smallest safe decomposition: one fork, since every file depends on the one RPC shape
- [x] 4. Delegate code-writing (fork, own worktree)
- [x] 5. Verify on the matching surface (chromium + webkit, real Playwright run, read the measured latency)
- [x] 6. Rebase into small ordered commits
- [x] 7. interrogate if contested. skip: the architecture was forced by browser capabilities measured in the spikes, not a contested choice
- [x] 8. Opening a PR: deslop, no-comments, technical-writing, gh pr create, pr-ship until green
