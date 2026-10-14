# Maintenance follow-ups

Open findings from the October 2026 maintenance pass. These are not completed fixes or evidence of installed-host behavior. The owning [state contract](../contracts/STATE_CONTRACT.md) and [analytics contract](../contracts/ANALYTICS_IMPLEMENTATION_CONTRACT.md) remain authoritative.

## Coordination changes requiring design

### Runtime lock takeover

[`withRuntimeLock`](../../application/hosts/vscode/runtime/runtime-generations.cjs) can have two contenders observe the same abandoned lock. One can remove the other's newly acquired lock because inspection and removal are not an atomic ownership check. Re-reading metadata or renaming the canonical pathname does not close that race.

A non-reclaimed transition guard could serialize creation, reclamation, and release, but introduces manual crash recovery and does not protect against older participants that ignore the guard. Decide the recovery policy and mixed-version upgrade boundary before implementation. Do not reclaim development-workspace gate records as a workaround.

### Cross-process session-settings updates

[`session-settings-store.ts`](../../harness/session-storage/settings/session-settings-store.ts) now refuses destructive replacement after unreadable or malformed input, but its write queue remains process-local. Independent pre-cutoff writers can still overwrite each other's changes to the shared map.

Define one cross-process transaction owner and lock order for current and legacy sidecars. Review stale-lock takeover in candidate helpers rather than assuming atomic replacement also provides transaction isolation. Test competing processes updating different sessions. This finding does not establish storage-cutoff activation.

### Ambiguous session-open recovery

Transport failures now retain uncertainty rather than rolling back selection. However, [`misc-handlers.ts`](../../application/backend/conversation-state/reducers/misc-handlers.ts) still reconciles ambiguous opens by issuing another `OpenSession`. The contract calls for read-only reconciliation; the coordinator's current `operation.status` ledger does not cover cold opens.

Design retained, generation-addressed open outcomes across the coordinator and host before replacing the retry. Test acknowledgement loss with exactly one state-changing open, late success, supersession, and backend death.

## Remaining cleanup limitation

The subagent resource loader exposes no reliable per-attempt handles for provider/pool signal listeners registered after cancelled reload or session creation. Delayed cleanup must not remove listeners belonging to another live attempt. The pass removed unsafe delayed global-snapshot reclamation; late closures can still accumulate. An SDK-owned disposal or registration handle is needed to close this gap. See [subagent lifecycle notes](../../harness/tools/subagent/README.md).

## Verification limitations

- The native test runner's SDK alias overlay can fail dynamic ESM imports in SDK-independent warm-bash and relocated-owner tests. Their SDK-free routes pass; this does not qualify SDK-overlay parity. Build/package-resolution fixtures also need SDK-free execution to avoid ambient compiler-selection interference.
- On Windows, `run-test-files-sdk-path.test.mjs` intermittently reports unconfirmed child-tree teardown after its inner test succeeds. It reproduced in broad and focused runs, followed by successful isolated runs. Logs did not distinguish a surviving child from an inconclusive process census. Preserve fail-closed runtime retention; collect ownership diagnostics before changing watchdog behavior.
- Full artifact, coverage, live-provider, visible-browser/Electron, and installed-host acceptance were not run. Ordinary typechecks reused a verified existing runtime rather than rebuilding the workspace with an active reader.

## Optional structural work

Canonical frontend activity projection was separated from token/cost accounting. Backend analytics remains a larger follow-up: separate canonical read-cache lifecycle from live capture orchestration, and recorder schema/migration/query responsibilities from mutations, only with transaction, snapshot, privacy, and single-authority regression coverage. File size alone is not a reason to split these modules.
