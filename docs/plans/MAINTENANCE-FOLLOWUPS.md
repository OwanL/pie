# Maintenance follow-ups

Status from the October 2026 maintenance pass. Staging is not evidence of loaded behavior. The owning [state contract](../contracts/STATE_CONTRACT.md) and [analytics contract](../contracts/ANALYTICS_IMPLEMENTATION_CONTRACT.md) remain authoritative.

## Coordination findings

### Runtime lock takeover

**Implemented and staged (2026-10-17); present in the verified live runtime on 2026-10-18.** The legacy directory-lock takeover race is replaced by [kernel-owned Windows named-pipe exclusion](../../application/hosts/vscode/runtime/windows-runtime-lock.cjs), with automatic release on process death. Supported storage is a stable-mounted, fixed local NTFS volume; unsupported platforms/storage fail explicitly. No native dependency or VS Code minimum-version increase was added.

The separate `pie-runtime-v2` store isolates older helpers. Every loader switch requires a verified selected v2 generation first. Legacy selections, leases, old bootstrap and running-generation sentinels were unchanged across staging. Development-workspace reader records are separate and must not be reclaimed as a workaround.

### Cross-process session-settings updates

**Implemented and reviewed in source (2026-10-18); not staged or loaded.** [`session-settings-store.ts`](../../harness/session-storage/settings/session-settings-store.ts) now holds kernel-owned directory locks across the current/legacy read–modify–publish–scrub operation. Canonical directory identities are deduplicated and globally ordered; existing outer lifecycle barriers remain unchanged. Malformed or unreadable sidecars still prevent replacement.

The user approved Windows fixed-local-NTFS persistence with automatic kernel release on process death. Unsupported storage/platforms fail strict writes; live best-effort persistence retains its existing error boundary. The shared primitive lives in `lib/windows-runtime-lock`; published loader bytes and protocol identity remain unchanged. Focused Windows tests and independent review cover competing processes, shared legacy layouts and owner-death recovery.

Only cooperating updated writers are protected; older binaries do not acquire these locks. Two-file publication is not crash-atomic. This change does not activate storage cutoff.

### Ambiguous session-open recovery

**Implemented and staged (2026-10-17); present in the verified live runtime on 2026-10-18.** Coordinator outcomes are retained for the backend generation; heavy snapshots are byte-bounded without a lifetime open limit. Host recovery uses read-only `operation.status`, never another open. Acknowledgement without a snapshot remains recoverable. Retained inventory ownership, post-commit serialization failure, supersession, close fences and confirmed backend death have regression coverage. Unknown or evicted evidence never authorizes rollback or replay.

## Remaining cleanup limitation

The subagent resource loader exposes no reliable per-attempt handles for provider/pool signal listeners registered after cancelled reload or session creation. Delayed cleanup must not remove listeners belonging to another live attempt. The pass removed unsafe delayed global-snapshot reclamation; late closures can still accumulate. An SDK-owned disposal or registration handle is needed to close this gap. See [subagent lifecycle notes](../../harness/tools/subagent/README.md).

## Verification limitations

- The native test runner's SDK alias overlay can fail dynamic ESM imports in SDK-independent warm-bash and relocated-owner tests. Their SDK-free routes pass; this does not qualify SDK-overlay parity. Build/package-resolution fixtures also need SDK-free execution to avoid ambient compiler-selection interference.
- Ordinary project suites and all four typechecks passed across serial runs, with their existing skips. Follow-up fixture/routing corrections were verified. This does not establish that the default highly parallel route's Windows process census is reliable; uncertain teardown remains fail-closed. Failed packing now releases parent IPC/stderr handles while preserving uncertainty and diagnostic paths.
- Pi suites passed before the test-only Moon aggregator correction. Fresh Pi compilation remains blocked by three retained workspace reader registrations. Delivery explicitly reused the verified installed SDK: its source/lock/target inputs matched before that test-configuration-only change. No reader records were reclaimed.
- Full artifact, coverage, live-provider, visible-browser/Electron, and installed-host acceptance remain unqualified.

### Reload receipt (2026-10-18)

Verified reload used `pie-runtime-v2` generation `1feff01a5781f87aca76868c32582cd93187a6ddb7d8db0d59cd7b8c75056f44`; packaged host/renderer markers were `dedd15c096b58208fb99`. The live backend/worker run reached `backend.ready` successfully. A screenshot confirms the current conversation, tabs, and composer rendered in Pie, and there were no fresh startup errors. The old `--analyticsBuildId 84d09…` value identifies the canonical analytics descriptor, not a compiled host build.

This is evidence of the observed reload and rendering only. It does not attest the live renderer build or qualify all recovery scenarios or full installed acceptance.

## Optional structural work

Canonical frontend activity projection was separated from token/cost accounting. Backend analytics remains a larger follow-up: separate canonical read-cache lifecycle from live capture orchestration, and recorder schema/migration/query responsibilities from mutations, only with transaction, snapshot, privacy, and single-authority regression coverage. File size alone is not a reason to split these modules.
