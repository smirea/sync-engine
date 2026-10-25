# protocol v2 (feat/protocol-v2 worktree at /Users/stefan/code/sync-engine-v2)

Feature playbook

- [x] 1. `how` over the affected subsystem. skip: read core, client, spec, docs directly; subsystem is 1k lines
- [x] 2. `architect` for parallel design exploration. skip: parent brief fixes the design (meta keys, request/response, laws)
- [x] 3. Throughput checkpoint
  - Blocking first steps: bench harness + baseline commit before any change
  - Independent workstreams: n/a, one coupled diff (model, core, client, docs)
  - Shared mutable state: one worktree, one owner
  - Smallest safe decomposition: single owner, the parent delegated to me
- [x] 4. Own the diff (I am the delegate)
- [x] 5. Verify on the matching surface: bun test, bun run spec, bench after
- [x] 6. Small ordered commits
- [x] 7. interrogate. skip: design fixed by the brief, Codex review was the independent read
- [x] 8. Opening a PR, then pr-ship.ts loop

Task

- [x] bench-pull.ts + baseline commit
- [x] core: horizon, compact, options, paged snapshot, protocol 2
- [x] core client: paged apply with _meta.after/_meta.snapshot_head resume
- [x] packages/client: protocol 2 loop, SyncStatus snapshot progress
- [x] http: accept 1 and 2, 426 otherwise
- [x] spec: model (horizon, compact, outbox collect, applyBatch, pullPage), laws, proofs
- [x] vectors + spec.test.ts
- [x] docs/protocol.md v2, docs/decisions/sync.md
- [x] tests listed in brief
- [x] PR + pr-ship
