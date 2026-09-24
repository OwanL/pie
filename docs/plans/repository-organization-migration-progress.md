# Repository organization migration progress

**Status:** B0 is complete and B1 is **complete / exit accepted** (2026-09-24). B2 is **not started**; no relocation is authorized or recorded. This checkpoint is documentation-only and leaves existing source, settings, and Git state untouched (no commit, push, stash, or reset).

## Durable references

- [Migration plan](../REPOSITORY_ORGANIZATION_PLAN.md) — scope, boundaries, and batch exit criteria.
- [Manifest](repository-organization-migration-manifest.json) — full source/target inventory, ownership decisions, exact baseline test-path arrays, collision resolutions, and detailed B1 implementation evidence.
- [B0 baseline verification](repository-organization-baseline-verification.md) — exact commands, counts, rerun details, and limitations.

## Current inventory and decision

- The manifest maps 1,778 current tracked paths and six relevant untracked additions (1,784 source records total). Its baseline `trackedTestFilesByPackage` arrays remain unchanged: 17 package classifications, 696 paths (including the opt-in extension paths as documented there). These static arrays are inventory, not run-derived exact-once evidence.
- `extension/test/build-identity.test.ts` maps to `scripts/build/test/build-identity.test.ts` under the build tooling owner.
- `scripts/test/run-tests.test.mjs` was inspected and is an existing tracked file: it is in the baseline `scripts` array and carries an explicit manifest record (`scripts/verification/test/run-tests.test.mjs`). All six new working-tree files already have explicit manifest records, so no manifest coverage additions were needed.
- Root and extension fast-runner per-file accounting is **accepted**: after a tiny accounting guard fix, the focused regressions (19 tests), the scripts suite (264 passed / 3 skipped), the real reporter direct-file regression, and the file-accounting exact-once checks (root 79, subagent 46, extension 498 files) all passed.
- B1 requirements are fulfilled per the gap audit: representative compiler/Vite/tsx/Node/real-SDK resolution, native owners, test enumeration enforcement, the neutral browser port plus inert capability contract, selector discovered identity, and the inventory itself. B1 is marked complete; no B2 relocation has occurred.

## Final verification gate

- Final broad gate at the current integration, run before the tiny accounting guard fix: model drift, typecheck (all 17 projects), lint, npm test 7/7 groups 7436 passed / 35 skipped with no failures, cancels, or reruns, and the non-publishing build passed. After the guard fix, only the focused/scripts re-verification listed above was rerun.

## Deferred tests — no permanent exceptions

- Deep logger, analytics, and resource-move verification tests are deferred to their owning later batches and remain recorded in the manifest; no permanent skips or exemptions were added, and none may be.

## Evidence and limitations

- B0 verification passed at `6255f52b4387ee0fc8add6be649c2f5385e63849`; the detailed record is linked above. It passed with reruns after transient parallel-wave failures, and the extension summary retained one cancelled test. Opt-in browser/live/performance suites were not run. The baseline run did not expose an exhaustive file-dispatch count.
- Existing focused B1 evidence and its caveats are in the manifest. A staged extension build is **not loaded/live**, no restart was performed, and its exact staged generation identity was not checked. Do not treat build success as live behavior verification.
- The B0 `settings.json` high-to-medium entry is historical only. Exclude `settings.json` and ongoing user settings changes from migration; preserve current user state.
- One low-risk projection correction was user-authorized: backend-supplied `primaryOperation` is suppressed at projection while wire validation and reducer storage remain unchanged; only a live reducer-owned operation is surfaced. Focused tests, typecheck, and build passed for that correction; the final broad gate above was subsequently run at the integrated state.

**Next:** B2 may only begin as a separately authorized slice with its own checkpoint and gate; no commit, push, or B2 relocation is part of this checkpoint.
