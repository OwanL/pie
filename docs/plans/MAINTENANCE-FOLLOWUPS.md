# Maintenance follow-ups

Status from the October 2026 maintenance pass. Staging is not evidence of loaded behavior. The owning [state contract](../contracts/STATE_CONTRACT.md) and [analytics contract](../contracts/ANALYTICS_IMPLEMENTATION_CONTRACT.md) remain authoritative.

## Coordination findings

### Runtime lock takeover

**Implemented and staged (2026-10-17), not yet loaded.** The legacy directory-lock takeover race is replaced by [kernel-owned Windows named-pipe exclusion](../../application/hosts/vscode/runtime/windows-runtime-lock.cjs), with automatic release on process death. Supported storage is a stable-mounted, fixed local NTFS volume; unsupported platforms/storage fail explicitly. No native dependency or VS Code minimum-version increase was added.

The separate `pie-runtime-v2` store isolates older helpers. Every loader switch requires a verified selected v2 generation first. Legacy selections, leases, old bootstrap and running-generation sentinels were unchanged across staging. Development-workspace reader records are separate and must not be reclaimed as a workaround.

### Cross-process session-settings updates

[`session-settings-store.ts`](../../harness/session-storage/settings/session-settings-store.ts) now refuses destructive replacement after unreadable or malformed input, but its write queue remains process-local. Independent pre-cutoff writers can still overwrite each other's changes to the shared map.

Define one cross-process transaction owner and lock order for current and legacy sidecars. Review stale-lock takeover in candidate helpers rather than assuming atomic replacement also provides transaction isolation. Test competing processes updating different sessions. This finding does not establish storage-cutoff activation.

### Ambiguous session-open recovery

**Implemented and staged (2026-10-17), not yet loaded.** Coordinator outcomes are retained for the backend generation; heavy snapshots are byte-bounded without a lifetime open limit. Host recovery uses read-only `operation.status`, never another open. Acknowledgement without a snapshot remains recoverable. Retained inventory ownership, post-commit serialization failure, supersession, close fences and confirmed backend death have regression coverage. Unknown or evicted evidence never authorizes rollback or replay.

## Remaining cleanup limitation

The subagent resource loader exposes no reliable per-attempt handles for provider/pool signal listeners registered after cancelled reload or session creation. Delayed cleanup must not remove listeners belonging to another live attempt. The pass removed unsafe delayed global-snapshot reclamation; late closures can still accumulate. An SDK-owned disposal or registration handle is needed to close this gap. See [subagent lifecycle notes](../../harness/tools/subagent/README.md).

## Verification limitations

- The native test runner's SDK alias overlay can fail dynamic ESM imports in SDK-independent warm-bash and relocated-owner tests. Their SDK-free routes pass; this does not qualify SDK-overlay parity. Build/package-resolution fixtures also need SDK-free execution to avoid ambient compiler-selection interference.
- Ordinary project suites and all four typechecks passed across serial runs, with their existing skips. Follow-up fixture/routing corrections were verified. This does not establish that the default highly parallel route's Windows process census is reliable; uncertain teardown remains fail-closed. Failed packing now releases parent IPC/stderr handles while preserving uncertainty and diagnostic paths.
- Pi suites passed before the test-only Moon aggregator correction. Fresh Pi compilation remains blocked by three retained workspace reader registrations. Delivery explicitly reused the verified installed SDK: its source/lock/target inputs matched before that test-configuration-only change. No reader records were reclaimed.
- Full artifact, coverage, live-provider, visible-browser/Electron, and installed-host acceptance remain unqualified.

### Staging receipt

Runtime `1feff01a5781f87aca76868c32582cd93187a6ddb7d8db0d59cd7b8c75056f44`, host/renderer build `dedd15c096b58208fb99`, is verified and selected in `pie-runtime-v2`. The immutable three-file loader matches source. Renderer selection was published; no host restart or live adoption was observed. The user approved including the pre-existing working-tree changes, which remain uncommitted unless separately owned by this maintenance work.

Before/after checks and successful build log: `%TEMP%/pie-maintenance-stage-01a1490e-D3h8Lh/`. Other staged repairs include the Windows guardian environment limit, installed title-completion resolution, and replies to live sessions awaiting a title.

## Optional structural work

Canonical frontend activity projection was separated from token/cost accounting. Backend analytics remains a larger follow-up: separate canonical read-cache lifecycle from live capture orchestration, and recorder schema/migration/query responsibilities from mutations, only with transaction, snapshot, privacy, and single-authority regression coverage. File size alone is not a reason to split these modules.
