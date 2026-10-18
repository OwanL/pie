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

The subagent resource loader exposes no reliable per-attempt handles for provider/pool signal listeners registered after cancelled reload or session creation. Delayed cleanup must not remove listeners belonging to another live attempt. The pass removed unsafe delayed global-snapshot reclamation. Mock-based regressions demonstrate the ownership gap; a current real-SDK reproduction of the listener leak remains unverified. Existing loader, provider-registration and session-disposal APIs do not supply the missing ownership handle. Establish that reproduction before designing SDK-owned disposal or registration handles. See [subagent lifecycle notes](../../harness/tools/subagent/README.md).

An offline control against verified installed SDK `94c1af…` found no signal-listener growth across 20 resource reloads and 20 session-creation caller-abort races. Every late result was awaited; owned sessions were disposed. Import itself added one listener each for SIGINT, SIGTERM and SIGHUP; their identities then remained stable, including late checks through one second. Empty resources, in-memory session/auth/settings stores and network/subprocess tripwires isolated the control; no prompts or provider calls occurred. These are caller-wait races, not SDK cancellation. They do not cover third-party extensions, provider streaming, other emitter subscriptions, or freshly compiled SDK source. The ownership gap remains a limitation, not a reproduced current-SDK leak; no speculative listener redesign is justified by this control.

### Native SDK-reader containment (2026-10-18)

**Implemented; 113 focused checks passed on Windows (zero skips)**, including synthetic-workspace native tests, typecheck and explicit offline Pi Vitest. A dedicated keeper and atomic Job containment require open-handle/zero-active proof for release after child admission. Native test startup requires explicit authorization (EOF cannot authorize it); launcher loss takes normal cleanup, without WMI authority for owned routes. Regression coverage also checks delayed output drainage, case-insensitive Windows environments and reserved exit-code preservation. Guardian/keeper/enclosing-Job failure retains unknown state; no universal crash recovery is claimed. CLI, non-Windows and materialized-SDK paths are unchanged. Three legacy reader records remain untouched; no installed state changed. Fresh SDK compilation is still blocked. The original isolated validation receipt below covers only `f4c08144`; the later packaging qualification is recorded separately. Full SDK-backed parity remains unverified.

## Verification limitations

- The native test runner's SDK alias overlay can fail dynamic ESM imports in SDK-independent warm-bash and relocated-owner tests. Their SDK-free routes pass; this does not qualify SDK-overlay parity. Build/package-resolution fixtures also need SDK-free execution to avoid ambient compiler-selection interference.
- Ordinary project suites and all four typechecks passed across serial runs, with their existing skips. Follow-up fixture/routing corrections were verified. This does not establish that the default highly parallel route's Windows process census is reliable; uncertain teardown remains fail-closed. Failed packing now releases parent IPC/stderr handles while preserving uncertainty and diagnostic paths.
- Pi suites passed before the test-only Moon aggregator correction. Fresh Pi compilation remains blocked by three retained workspace reader registrations. Delivery explicitly reused the verified installed SDK: its source/lock/target inputs matched before that test-configuration-only change. No reader records were reclaimed.
- Full artifact, coverage, live-provider, visible-browser/Electron, and installed-host acceptance remain unqualified.

### Reload receipt (2026-10-18)

Verified reload used `pie-runtime-v2` generation `1feff01a5781f87aca76868c32582cd93187a6ddb7d8db0d59cd7b8c75056f44`; packaged host/renderer markers were `dedd15c096b58208fb99`. The live backend/worker run reached `backend.ready` successfully. A screenshot confirms the current conversation, tabs, and composer rendered in Pie, and there were no fresh startup errors. The old `--analyticsBuildId 84d09…` value identifies the canonical analytics descriptor, not a compiled host build.

This is evidence of the observed reload and rendering only. It does not attest the live renderer build or qualify all recovery scenarios or full installed acceptance.

### Isolated source validation (2026-10-18)

The subsequent session-control/title, settings-lock, Playwright cleanup and test-fixture maintenance is committed, but not installed or loaded. Nine affected typecheck owners passed using explicitly verified installed runtime/tooling artifacts; the three owners affected by later metadata/change-reporting fixes passed again. The refreshed host/renderer validation build, covering source through `f4c08144`, completed with identity `30fc388bc842701eb7f7` in `%TEMP%/pie-maintenance-validation-20261018-01a1490e-refresh`; no loader selection, installation or running host was changed. It supersedes the earlier `f83703e98bc270fa1937` temporary bundle. Later source commits are not implicitly qualified by this build receipt.

This build reused Pi runtime identity `94c1af2347bfa7f2cc7d5cd2d63d7fedcfc0213f4e25b5b3e817074bbd982047`. It does **not** compile or include the subsequent Pi-source Windows background-console fixes. Those changes have focused source tests but still require a fresh qualified SDK build. Retained workspace reader registrations were not reclaimed. Full artifact and installed acceptance remain unqualified; successful targeted SDK-resolution and session-control artifact fixtures do not establish the full matrix.

### Packaging qualification refresh (2026-10-18)

Source through `62d31f80` passed fresh private delivery qualification using the verified existing SDK identity `94c1af2347bfa7f2cc7d5cd2d63d7fedcfc0213f4e25b5b3e817074bbd982047`. Host/renderer identity was `688ffe434261d4f7df87`; both headless adapters and browser first paint passed, with confirmed teardown. The successful temporary package was removed by its owning runner. Earlier failed qualification evidence remains retained.

The VSIX now includes the standalone Windows lock module in build output, while preserving the original packaging CLI and versioning behavior. The explicit built-package fixture also passed startup, backend/session operations, and relocated loader checks. Qualification packaging and deactivation-reporting regressions were fixed in `f0282be0` and `218dbcb1`; Windows short/long path spellings are compared by physical path in the packaged fixture. This is not fresh Pi compilation, real Electron acceptance, publication, installation, or loaded-fix evidence. The three historical workspace readers remain untouched.

### Expanded existing-SDK validation (2026-10-18)

Using verified SDK `94c1af…` explicitly, five serial artifact runs passed 321 checks across agent/session lifecycle, provider and tool registration, integration boundaries, CLI and package resolution. Two initially gated provider-runtime cases were rerun with their artifact prerequisite and passed; the installed-prior-reader case remained unrun. Local mock-provider integration was enabled; no external provider acceptance is claimed. A CJS fixture incorrectly loading import-only SDK exports was corrected in `896a1050`, then the full 62-check provider/tool group passed with zero skips. All 32 registered typecheck projects also passed with the explicit runtime/tooling artifacts.

The development refresh artifact suite was deliberately excluded: its fixture acquires a reader on the canonical native workspace and copies compiled workspace bytes rather than using the selected artifact. This is not full default artifact-lane qualification, fresh SDK compilation, coverage acceptance, or installed-host verification. No historical reader was reclaimed and no runtime was published or installed.

## Optional structural work

Canonical frontend activity projection was separated from token/cost accounting. Backend analytics remains a larger follow-up: separate canonical read-cache lifecycle from live capture orchestration, and recorder schema/migration/query responsibilities from mutations, only with transaction, snapshot, privacy, and single-authority regression coverage. File size alone is not a reason to split these modules.
