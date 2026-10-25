# follow-ups todo (figure-it-out)

- [x] read poteto-mode Principles (model-the-domain, sequence-verifiable-units, prove-it-works, separate-before-serializing-shared-state)
- [x] Phase A: Frame (predicate, scope, rigor)
- [x] Phase B: Design the workflow (units, harness, fan-out)
- [x] Phase C: Run the loop
  - [x] U1 protocol v2 core: PR 15 merged
  - [x] U1b Swift port: PR 16 merged
  - [x] U2 web client: PR 14 merged 4307474
  - [x] U3 observability: a-better-me PR 36 merged
  - [x] U4 a-better-me adoption: PR 37 merged, deployed, production verified; reader outage gap filed as issue 17
- [ ] Phase D: audit trail (.audit/followups.tsv, committed at the end)
- [ ] Phase E: verify whole against predicate, cross-model trail review, hand back
- skip: architect/arena for the protocol shapes, reason: the shapes are forced by the existing protocol (one cursor, one head, tombstone table); the one open fork, paging semantics under a moving head, is settled by a proof, not by a bakeoff
