# Product goals

- **A sync engine for our own offline-first apps.** It replaces PowerSync in procrastimate and a-better-me: each client keeps a full SQLite copy, works fully offline, and syncs when it has connectivity. We build it for ourselves, so it is opinionated and skips anything our apps do not need.
- **The server is not a server.** The endpoint runs on short-lived compute, fits the free tier of its host at our usage, and needs no container, no always-on VM and no managed database service. A new environment is one deploy with nothing to provision. Local runs start in about a second with no cloud account.
- **Optimized for one or a few users and low throughput.** Human-speed writes, a few thousand rows per space. Nothing is tuned for scale at the cost of simplicity.
- **One schema, every runtime.** A TypeScript schema file produces the SQLite DDL for client and server, the validators, and the Swift types, so an agent changes one file and a failing check names any stale output. No backwards compatibility: clients re-pull when the schema changes shape.
- **Few dependencies.** The engine core is plain TypeScript over a small SQL driver interface. Clients use the platform's SQLite (sqlite-wasm on the web, GRDB on Apple platforms).
- The investigation that produced these goals is in [`docs/investigation/README.md`](../investigation/README.md).
