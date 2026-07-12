# Handoff: session hangs before the 2026-07-12 restart

## Scope

Investigated without subagents, using persisted session JSONL, VS Code `pie.log` / `pie (backend).log`, run analytics, the VS Code global-state database, process inspection, and current source.

No verification/build has been run yet. The working tree already contained extensive concurrent changes before this investigation.

## Executive finding

The last parent sessions were not independently stuck in the main model. They all ended up waiting inside `subagent` tool calls. Those children were routed predominantly to the same Umans medium-model pool while runtime settings allowed far more local concurrency than the provider could reliably handle.

The failure chain was:

1. Several parent sessions reached final reviewer/worker subagent calls at roughly the same time.
2. Runtime preferences allowed `subagentMaxInflight=16` and per-call concurrency `8`; medium children used `umans-glm-5.2` / `umans-kimi-k2.7`.
3. Umans was configured at four concurrent provider requests by a user override (the catalog base is two).
4. Logs show Umans connect timeout, stream stall, overload 502, aborts, and an `ECONNRESET` during this period.
5. The outer subagent settlement net was a fixed 30-minute deadline. This is long enough to look like a permanent hang and also kills productive children at 30 minutes regardless of progress.
6. The committed runner released its process-wide semaphore immediately after `createSession()`, rather than holding the permit for the child lifetime. Therefore the intended local in-flight cap did not actually bound active child runs. The current dirty `runner.ts` already contains a change to register the permit with `ChildLifecycle` and release it on terminal settlement, but it is unverified.
7. Restarting the extension host terminated the in-memory children and made all parent sessions appear idle again.

External providers can always fail; the achievable guarantee is that parent tool calls always settle within a bounded *inactive* period and never retain permits/children after abort.

## Session evidence

The affected open sessions were:

| Session | Last persisted action |
|---|---|
| `2026-07-11T21-16-46-601Z_019f530a-...` | reviewer subagent started at `00:41:14Z`, no result before restart |
| `2026-07-11T21-30-24-862Z_019f5316-...` | reviewer subagent started at `00:29:54Z`, no result before restart |
| `2026-07-11T21-47-42-663Z_019f5326-...` | worker subagent started at `00:47:18Z`, no result before restart |
| `2026-07-11T23-36-05-799Z_019f5389-...` | reviewer subagent started at `00:42:24Z`, no result before restart |
| `2026-07-11T23-40-56-841Z_019f538e-...` | completed normally at `00:00:03Z`; it was not part of the final unresolved set |

Earlier calls demonstrate the fixed 30-minute net exactly:

- `12:01:52` local: child force-settled after `1800s`.
- `12:26:49` local: child force-settled after `1800s`.
- `12:39:25` local: child force-settled after `1800s`; `session.abort()` then failed to settle within five seconds and was registered as dangling cleanup.
- `12:47:11` local: another child force-settled after `1800s`.

Relevant backend failures:

- `11:34:10`: Umans connect timeout.
- `11:56:41`: `upstream stream stalled: no chunk for 120s (provider=umans)`.
- `11:56:55`: Umans returned HTTP 502 `overloaded_error`.
- `12:41:06`: ChatGPT/Codex request failed with `ECONNRESET`.
- Multiple child abort logs report `session.abort() did not settle within 5s`.

The parent run snapshots showed very long single busy periods and all were forcibly finalized as `closed_unscored` at restart (`00:57:43.859Z`).

## Risky runtime configuration found

Read from `state.vscdb`, key `pie.pie.chatPrefs`:

```text
subagentMaxInflight:      16
subagentMaxConcurrency:   8
subagentMaxParallelTasks: 16
small bucket:             [umans-flash]
medium bucket:            [umans-glm-5.2, umans-kimi-k2.7]
frontier bucket:          [gpt-5.6-sol]
Umans provider override:  maxConcurrentRequests=4, afterburnSeconds=5
```

Optional overload-mitigation values (not a correctness fix):

```text
subagentMaxInflight:      2
subagentMaxConcurrency:   2
subagentMaxParallelTasks: 4
Umans maxConcurrentRequests: 2
```

These may reduce provider overload while diagnosing capacity, but bounded settlement must not depend on them. If changed, use the pie settings UI rather than editing `state.vscdb` directly.

## Separate resource leak found and handled

Sixteen stale Node test processes were still alive from July 9–10. Four orphaned test trees were stuck in `app-smoke.test.ts` / `provider-gate.test.ts`, with their original parent processes gone, using roughly 800 MB total.

The user approved terminating them. All 16 stale processes were force-terminated; the current pie backend (`node ... out/backend.js`, PID 35696 at inspection time) was left running.

Current source should still be reviewed to ensure every test-runner timeout/abort kills the full Windows process tree. The stale processes predated some newer warm-bash tree-kill work, so this may already be fixed but is not proven.

## Run-analytics EPERM observed during this investigation

At `2026-07-12T01:02:47.980Z`, analytics checkpoint persistence failed with:

```text
EPERM: operation not permitted, rename
.open-runs.gen.<pid>-<timestamp>-<random>.tmp -> open-runs.gen
```

The same temp rename failed repeatedly for about four seconds. Persistence later recovered automatically; by `13:03:50` local `open-runs.gen`, slot files, and export files were updating and no temp file remained. This is consistent with a transient Windows sharing violation (antivirus/indexer/file watcher), not directory corruption.

### Changes made for analytics resilience (not yet verified)

Added:

- `extension/src/host/shared/atomic-write.ts`
- `extension/test/atomic-write.test.ts`

Updated atomic writes in:

- `extension/src/host/stats-service/persistence.ts`
- `extension/src/host/run-analytics/query.ts`
- `extension/src/host/stats-service/storage.ts`

Behavior: retry `EPERM`, `EACCES`, and `EBUSY` rename failures with bounded delays of 10/25/50/100/250 ms before surfacing an error. Permanent errors still fail immediately; temp cleanup remains intact.

## Current subagent source state

Important uncommitted work already present before/during this investigation includes:

- phase-specific renewable liveness budgets in `extensions/subagent/src/lifecycle.ts`;
- prompt/abort races in `extensions/subagent/runner.ts`;
- a fixed 30-minute outer settlement net in `extensions/subagent/src/execute.ts`;
- current dirty `runner.ts` changes that hold the process-wide semaphore permit for the full child lifetime and clean up late-created sessions;
- current dirty `execute.ts` changes from another session (automatic agent discovery/error signaling). These are **not** changes made by this investigation and overlap must be preserved.

The most important remaining design correction is to make the outer settlement net a **renewable inactivity deadline**, not a fixed total-runtime deadline:

- re-arm it whenever the child publishes credible progress;
- use a bounded idle period (suggest 10–12 minutes, longer than normal provider/tool phase budgets);
- retain the short post-abort grace and synthesized terminal result;
- optionally keep a separately configurable absolute containment ceiling, disabled by default.

That avoids both failure modes: a silent child cannot hang forever, while a productive 30+ minute worker is not killed solely because total wall time elapsed.

## Recommended next steps

1. Finish/review the existing dirty subagent hardening rather than relying on lower concurrency.
2. Optionally tune the four runtime concurrency values above to reduce provider overload; treat this only as capacity management.
3. Convert the outer settlement timer to renewable inactivity semantics and add tests proving:
   - a never-updating dispatch force-settles;
   - periodic progress renews the deadline;
   - parent abort settles even when child `abort()` never resolves;
   - permits are released exactly once on success, failure, timeout, and late-session cleanup;
   - provider fallback does not start after parent abort.
4. Add/verify a bounded test-runner watchdog that kills the complete Windows process tree.
5. Verify the analytics retry changes.
6. Rebuild after all `extension/src` changes so output syncs to the installed extension.

Suggested focused commands:

```bash
cd pie
node scripts/run-test-files.mjs extension/test/atomic-write.test.ts extension/test/analytics-persist-error.test.ts extension/test/run-analytics-query.test.ts
node scripts/run-test-files.mjs extensions/subagent/test/lifecycle.test.ts extensions/subagent/test/settlement.test.ts extensions/subagent/test/interrupt-hardening.test.ts extensions/subagent/test/concurrency-limit.test.ts
cd extension
npm run typecheck
npm run build
```

Do not start with the full test suite until the test-process watchdog is verified; stale full-suite runners were part of the machine-pressure problem.

## Log locations used

- Host: `C:\Users\OwanLazic\AppData\Roaming\Code\logs\20260711T125328\window1\exthost\pie.pie\pie.log`
- Backend: same directory, `pie (backend).log`
- Sessions: `C:\Users\OwanLazic\Documents\GitHub\pie\sessions\--c--Users-OwanLazic-Documents-GitHub--\*.jsonl`
- Analytics: `pie\data\outcomes\d0586130398071a9\`
- VS Code state: `C:\Users\OwanLazic\AppData\Roaming\Code\User\globalStorage\state.vscdb`

## Continuation status (completed later on 2026-07-12)

Implemented and verified without changing VS Code's `state.vscdb`:

- Converted the outer settlement net in `extensions/subagent/src/execute.ts` from a fixed 30-minute wall-clock deadline to a renewable 12-minute inactivity deadline. Credible mode/runner progress re-arms it; silent dispatches still force-settle after the abort grace.
- Kept the full-lifetime semaphore ownership and late-created-session cleanup in `runner.ts`, and fixed a synchronous prompt/abort race that could leave a rejected prompt promise unobserved.
- Added coverage for silent force-settlement, periodic deadline renewal, hung child `abort()`, exactly-once permit release, full child-lifetime capacity, late-session cleanup, and no fallback after parent abort.
- Added a default 20-minute test/typecheck child-process watchdog (`PIE_TEST_PROCESS_TIMEOUT_MS`, `0` disables) with recursive Windows `taskkill /T /F` and Unix process-group kill. Root, focused, changed-test, and typecheck runners use it; direct `extension` and `analysis` test scripts now route through the guarded root runner.
- Added a real Windows integration test proving a watchdog timeout kills a spawned grandchild, not only the direct Node process.
- Verified the analytics atomic-rename retry changes and rebuilt/synced the VS Code extension.

Verification completed:

```text
scripts/test/*.test.mjs: 54 passed
focused subagent hardening: 98 passed
focused analytics persistence/query: 10 passed
shared + extension typecheck runner: passed
analysis npm test (guarded runner): 295 passed
extension build + installed-extension sync: passed
```

The guarded full extension test completed (so the prior orphan risk is covered) with 2360 passed, 1 skipped, and one unrelated failure: the concurrently modified root `settings.json` lacked its expected trailing newline. That file was not changed here because its content belongs to other in-progress work.

Concurrency reduction is **not required for correctness** and is not the hang fix. The structural guarantees above must settle parents even at the maximum supported local concurrency; coverage now exercises silent parallel children with `maxInflight=16` and proves bounded settlement. Lower values such as 2/2/4 and Umans concurrency 2 remain optional capacity/overload tuning only: they can reduce upstream 502s and queue pressure, but the system must remain bounded if the persisted overrides stay at 16/8/16 and provider concurrency 4.
