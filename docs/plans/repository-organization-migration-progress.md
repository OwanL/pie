# Repository organization migration progress

**Status:** B0 (baseline, inventory and migration manifest) is complete after the
review correction below; the manifest is exhaustive, validated, and collision-
resolved. No source implementation or B1+ migration batch has started. The
approved planning checkpoint is already committed; no push is authorized.

Owned artifacts: `repository-organization-migration-manifest.json` (B0
deliverable), `repository-organization-baseline-verification.md`, and this file.
All three have explicit `retain` records in the manifest.

## Baseline (evidence)

- Original/source inspected baseline: `78e5c0d7c446bb3c42dff6ac4751a89fdebec69d`.
- Approved planning checkpoint and verification baseline:
  `6255f52b4387ee0fc8add6be649c2f5385e63849`. The primary checkout is at this
  checkpoint; it is the commit for which B0 verification was recorded.
- Baseline verification passed at the checkpoint (`sync-models --check`,
  `typecheck`, `lint`, `test:all`, `extension:build:validate` all exit 0).
  **Truthful caveat:** the baseline passed with reruns, not a pristine first
  pass — two groups had transient parallel-wave failures (four extension files,
  one Playwright file) that passed on the runner's rerun; details in
  [repository-organization-baseline-verification.md](repository-organization-baseline-verification.md).
- Opt-in browser/live/performance gates were not run; recorded as not exercised,
  not as passing.
- Dirty working tree: `settings.json` `defaultThinkingLevel: "high" -> "medium"`
  is a pre-existing user change — preserved, must not be committed or reverted
  by migration batches. Disposition is recorded in the manifest baseline block.

## Manifest

- 1771 records = 1768 tracked-file records at the verification baseline + 3
  explicit `retain` records for the new `docs/plans/` artifacts. Original B0
  generation ran from OS temp (`%TEMP%\pie-b0-manifest-gen\`). The review
  correction updated the existing manifest in place and revalidated it against
  the Git tree and test registry; no generator/checker scripts or logs are in
  the repo.
- Coverage validation: exact bijection between `git ls-tree` at the verification
  baseline and record sources (0 missing, 0 extra tracked sources), plus the 3
  declared new docs.
- Actions: 1639 move, 50 split, 11 consolidate, 71 retain. Every record has an
  owner, batch (B0–B8), verification, and reason.
- Test inventory: all 17 registry package classifications have explicit
  `trackedTestFilesByPackage` path arrays (696 files total), not just counts.
  The extension array is 538 files, including all 8 `.perf.ts` suites and the
  `.e2e.ts` suite previously omitted; `computer-use` is corrected to 11.
  Registry globs and opt-in suite paths are kept distinct, with overlap noted.
- Collisions: 10 multi-source target paths are explained by 13 resolution
  records; no unintended or unexplained target collisions remain. The false
  application transcript-window merge is removed, and the logger's core and
  VS Code adapter targets are explicitly resolved.
- No generated, dependency, runtime-data, or packaged-artifact path is a record
  source or target (path checks; sources are tracked files plus the three owned
  B0 documents).

## B0 review correction (2026-09-24)

Review found and corrected four manifest/progress inaccuracies before B0
artifact sign-off:

- **Transcript budget ownership:** inspection found
  `TRANSCRIPT_WINDOW_BUDGETS` in `extension/src/shared/transcript-window.ts` is
  imported by backend transcript slicing, host paging and culling, and the
  frontend top/bottom gap rows. The constants are not part of the application
  paging implementation. The manifest now assigns one inert,
  browser-safe contract (`harness/session-storage/transcripts/transcript-window-contract.ts`)
  and an `application/lib/protocol/transcript-window.ts` re-export of that same
  binding for the frontend. Snapshot fitting remains harness-owned; paging
  remains application-owned. There is no copied constant or dependency-rule
  exception, and the former application transcript-window collision was false.
- **Logger boundary:** the inspected logger uses Node filesystem/OS APIs and
  concretely couples to VS Code types plus lazy `require('vscode')` for native
  OutputChannels and `showPieLogs`. The manifest now splits the one
  host-neutral logger core (`lib/structured-logging/pie-logger.ts`) from an
  injected concrete VS Code adapter
  (`application/hosts/vscode/logging/pie-logger-adapter.ts`); VS Code host
  composition wires the adapter and backend show-log requests use a host port.
  The root logger has no permanent VS Code exception and logger state/sinks are
  not duplicated.
- **Test coverage inventory:** registry-based path enumeration corrected the
  extension count from 529 to 538 and `computer-use` from 12 to 11. Explicit
  per-package path arrays now let B1 compare routes by file, not just counts.
- **Commit terminology:** the source-inspection baseline is 78e5c0d; the
  approved planning checkpoint and B0 verification baseline are both
  6255f52b4387ee0fc8add6be649c2f5385e63849. The approved checkpoint exists;
  progress therefore does not claim there have been no commits overall.

## Resolutions made by source inspection (not renaming)

- **error-message / sensitive-redaction helpers:** `shared/error-message.ts`
  and `shared/sensitive-redaction.ts` are canonical implementations; the
  `extension/src/shared/*` and `extension/src/host/util/error-message.ts` files
  are 3–4 line re-export shims. Single survivors:
  `lib/structured-logging/error-message.ts` (host shard's separate
  `lib/error-message.ts` leaf retargeted away) and
  `lib/sensitive-data/sensitive-redaction.ts`.
- **live-pipeline trace helpers:** canonical schema + Node store are imported by
  both harness backend and application host runtime, so
  `application/backend/agent-connection/` (extension-other shard's choice)
  would force a forbidden harness→application import. Survivors:
  `lib/structured-logging/live-pipeline-trace.ts` and
  `.../live-pipeline-trace-store.ts`; host-process runtime singleton retargeted
  to `application/backend/agent-connection/live-pipeline-trace-runtime.ts`
  (host-only importers); backend runtime unchanged in
  `harness/agent-processes/coordinator/`.
- **backend session-lifecycle-store:** the shared-store seam is explicit: one
  SQLite database, one schema version, one coordinator writer-admission
  authority. `harness/session-storage/lifecycle/` owns database identity/schema
  and session-lifecycle APIs; `analytics/authority/` owns the host-registry +
  writer-fence/lease/admission API surface as a narrow adapter over the same
  store. No second store, schema, or authority change.
- **host private-session-cleanup (medium confidence):** all deletion/privacy
  effects are injected ports and the only importer is
  `session-service/service.ts` → retargeted to
  `application/backend/session-actions/private-session-cleanup.ts` as the
  application-side orchestrator over the harness lifecycle cleanup port.
- **stats-service run-state-manager (medium confidence):** mutates
  `SessionRunState` via `getArchState`/`dispatchArchEvent`; consumers read state.
  Confirmed `application/backend/conversation-state/`.
- **aggregate-pricing-cache:** loads `loadModelPricing` from backend/pricing
  plus pricing-history into a stat-signature catalog; confirmed
  `harness/model-providers/pricing/` per plan §3.2.
- **shared/tsconfig vs tools/tsconfig:** `shared/tsconfig.json` dissolves (its
  sources disperse to owners; no third tsconfig). Survivors:
  `application/hosts/vscode/tsconfig.json` (moved extension package tsconfig)
  and `harness/tools/tsconfig.json` (moved `tools/tsconfig.json`, the surviving
  base).
- **transcript-window split:** lossless snapshot bounds remain in
  `harness/session-storage/transcripts/snapshot-boundary.ts`; one inert
  `TRANSCRIPT_WINDOW_BUDGETS` contract is harness-owned and re-exported through
  application protocol for browser use. The application windowing algorithm
  does not absorb the constants.
- **pie logger split:** host-neutral Node logging implementation remains in
  `lib/structured-logging/`; VS Code OutputChannel creation and `showPieLogs`
  behavior belong to the injected VS Code host adapter. No `vscode` import or
  require is permitted in the root logger.

## Enumeration sources (all from the actual checkpoint tree)

- Test enumeration imported the real `scripts/lib/test-packages.mjs`
  `PACKAGE_REGISTRY` and `scripts/run-tests.mjs` package test globs, then
  matched them against tracked paths at the planning checkpoint. The exact
  per-package arrays are preserved in the manifest. Extension opt-in browser
  (`.pw.ts`), performance (`.perf.ts`) and large-detail e2e (`.e2e.ts`) suite
  paths remain explicitly enumerated; overlapping default `.test.ts` suites
  and the `backend-probe.ts` helper are not double-counted as additional tests.
  Baseline `test:all` output reports test-case outcomes but no discovered file
  count (Windows limitation in the baseline doc), so this is static tracked-file
  evidence, not a run-derived count.
- Package/lock owners, host bundle entries (extension, standalone, backend,
  worker-entry, analytics-recorder-worker, analytics-query-worker,
  cold-browse-helper-entry, initial-context-estimate-worker,
  phase4-worker-command-extension), renderer manifest contract, VS Code
  identities (`pie.sessionsView`, publisher/name/main `./runtime/bootstrap.cjs`),
  the stable nine-tool catalog names/registrations, extension IDs, nine Pie
  skill bundles, and agent definitions were extracted from the actual
  `package.json`/`vite.config.ts`/`build.mjs`/`tools/index.ts`/tree state.

## Open items (non-blocking for B0 exit)

1. The session-lifecycle-store seam is a documented disposition; adapter
   extraction is B5/B6 implementation work with its own verification.
2. B1 should make run-level test enumeration compare the explicit path arrays
   with actual multi-root dispatch and prove every enumerated file runs exactly
   once. The arrays strengthen the baseline inventory but are not execution
   evidence.

## Git workflow (user-approved constraints)

- Milestone commits are approved; push is not authorized.
- The `settings.json` user change stays out of migration commits.
