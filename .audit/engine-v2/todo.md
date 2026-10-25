# engine-v2: move a-better-me to sync-engine 7e25a98 (protocol 2)

Feature playbook

- [x] 1. `how` over the affected subsystem. (done inline: read engine docs, option plumbing, a-better-me server/iOS sync code; the brief fixed the design)
- [ ] 2. `architect` for parallel design exploration. skip: the brief prescribes every shape (pin, three dev-only env knobs through parseConfig, one progress row); nothing is open to explore
- [ ] 3. Throughput checkpoint
  - Blocking first steps: pin + bun install + Package.resolved before any build; dev server with page size 3 before simulators
  - Independent workstreams: code delegate (server config, iOS row, pin) vs. me (measure script, simulators, audit dir)
  - Shared mutable state: delegate owns /Users/stefan/code/a-better-me-v2 exclusively until it reports; I write only under sync-engine/.audit/engine-v2
  - Smallest safe decomposition: one delegate, the diff is ~40 lines across coupled files (config -> index/worker -> env schema)
- [x] 4. Delegate code-writing (opus, poteto-agent)
- [x] 5. Verify on the matching surface: two simulators + local Bun server, measurements per brief
- [ ] 6. Rebase into small ordered commits
- [ ] 7. interrogate if contested. skip unless the delegate's diff raises a real fork
- [ ] 8. Opening a PR, then pr-ship.ts (no --merge)

Task

- [ ] pin package.json + Package.resolved to 7e25a98, bun run generate, SyncSchema test green
- [ ] SYNC_PAGE_SIZE / SYNC_RETENTION_MS / SYNC_COMPACT_EVERY_MS dev-only, refused in production
- [ ] MoreTab "Downloading… N rows" while snapshotRows != nil (brief named SyncSettingsView, which does not exist)
- [ ] iOS build + 210 tests
- [x] measurements: paging 211 pages, A->B 122 ms, outage 915 ms and 9.9 s (<= 15 s), compaction verified, C converged and showed the row
- [ ] production rerun instructions
