# engine-v2 device verification

Artifacts of the a-better-me move to sync-engine 7e25a98 (protocol 2). Everything here is outside the app worktree.

- `trail.tsv` decision trail, `todo.md` playbook checklist.
- `measure.ts` the measuring script, `serve.sh` the worktree dev server with the three dev-only knobs.
- `adA`, `adB`, `adC` agent-device wrappers bound to the simulators `abm-sync-a` (FC3EE5FB), `abm-sync-b` (25E51086) and `iPhone 18 Pro Max` (27DE4391). The `--session` flags inside them belong to one T3 thread; a new thread gets new ones from `device_open`.
- `*.log` the raw output of each measured scenario, `shots/` screenshots.

## Rerun against production

The script only reads the app's SQLite files and, for the server-side checks, the local server file. Against production the server-side lines are unavailable (the Durable Object's SQLite is not on this Mac), so use `latency`, `outage` and `deletion` and skip `compare` and `state`'s server line.

1. Build a Release-pointed Debug build: `cd /Users/stefan/code/a-better-me-v2 && bun run env:ios` writes the production URL and owner token into the native config (needs AWS). Then `cd app-ios && ./scripts/run -t FC3EE5FB-540D-4A39-B482-669270A16111 --no-watch --headless` and the same for 25E51086-1AFC-40EE-907B-ECAA3693CB18. Uninstall first (`xcrun simctl uninstall <udid> com.stefan.a-better-me`) for a fresh-install test.
2. Write on one simulator through the UI, the way this run did: More tab, Weight Unit picker (`settings` table), or More, API Tokens, New Token and swipe-left Revoke (`api_tokens` table).
3. In this directory, before the tap: `bun measure.ts latency <writer> <reader> settings`, or `bun measure.ts deletion <writer> <reader> api_tokens`. The number printed is from the writer's database changing to the reader's matching it, polled every 10 ms.
4. For the outage case there is no server to stop; turn the writer's network off instead (`xcrun simctl status_bar` cannot cut traffic, so use the Mac's network or a `pfctl` rule for a-better-me.stf.lol), make the write, then `bun measure.ts outage` will wait for `https://a-better-me.stf.lol/status` only if `SERVER_URL` in the script is changed to it; edit the constant for that run.
5. Paging on production needs the default page size (1000), so the first download of a fresh client pages only once the space holds more than 1000 rows. `bun measure.ts snapshot <udid>` still reports convergence and how many `_meta.after` values it saw.

## Production rerun, as done on 2026-10-25

Step 1 above is wrong about the build: `./scripts/run` always builds Debug, and Debug keeps LocalSecrets' local
`API_URL` and the dev token, so it never reaches production. Build Release instead, after `bun run env:ios`:

    cd /Users/stefan/code/a-better-me-v2/app-ios
    xcodebuild -quiet -project App.xcodeproj -scheme App -configuration Release \
      -destination 'platform=iOS Simulator,id=<udid>' -derivedDataPath DerivedData/simulator CODE_SIGN_IDENTITY=- build
    xcrun simctl uninstall <udid> com.stefan.a-better-me
    xcrun simctl install <udid> DerivedData/simulator/Build/Products/Release-iphonesimulator/App.app
    SERVER_URL=https://a-better-me.stf.lol bun measure.ts snapshot <udid>...   # before simctl launch, after install
    xcrun simctl launch <udid> com.stefan.a-better-me

`measure.ts` reads `SERVER_URL` from the environment and skips the local server file when it is set. `outage.sh`
cuts the Mac's Wi-Fi (no sudo here, so no pfctl), taps the picker option on the writer through `pA`/`pB`, waits, and
turns Wi-Fi back on under a trap; run it with `nohup` so the agent's own lost connection cannot leave it half done.
Results and methods: `production.tsv`, raw output in `production-*.log`, client-side timelines in
`production-syslog-*.log` from `xcrun simctl spawn <udid> log show --predicate 'process == "App"'`.
