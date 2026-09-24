# Repository organization migration progress

**Status (2026-09-24):** B0, B1, and B2 are complete / exit accepted. **B3 has not started.** Seventeen tracked distribution/config/runtime assets and build helpers have settled at their target paths with locked npm ci installs at the new owner, the package gate passed, and the final full verification gate passed. Application source and test files remain at their original paths.

## Durable references

- [Migration plan](../REPOSITORY_ORGANIZATION_PLAN.md) — scope and batch exit criteria.
- [Manifest](repository-organization-migration-manifest.json) — original source identities, targets, current locations, immutable baseline test enumeration, and verification evidence.
- [B0 baseline verification](repository-organization-baseline-verification.md) — baseline commands, counts, reruns, and limitations.

## Inventory and identity

- The manifest retains its 1,785 original source records and baseline `trackedTestFilesByPackage` arrays (17 classifications, 696 paths). The 17 settled moves are recorded separately in `currentLocations`; source records and baseline test identities are unchanged. The new `scripts/test/build-typecheck.test.mjs` B2 regression is recorded (owner `scripts/build`, B8 target), and the current 2026-09-24 git status is recorded in the manifest inventory.
- Source/test relocation mappings previously assigned to B2 are rebatched to their owning B7/B8 work; source ownership for shared runtime/build identity is B7. No source or test was relocated as part of this checkpoint.
- The inventory validator uses extant tracked and relevant untracked working-tree paths, plus exact declared current paths for moved assets omitted by generic ignore rules. It maps only explicit current locations, still rejects missing current files and unrelated unmapped files, and preserves registry-routing, collision, retain, protected-tree, and baseline-test checks. The focused inventory suite passed 12/12; the scripts suite passed 268 with 3 existing skips.
- B1 remains accepted. Its final gate was model drift, all 17 typecheck projects, lint, `npm test` (7/7 groups; 7,436 passed / 35 skipped), and non-publishing build. The detailed B1 implementation evidence remains in the manifest.

## B2 complete — exit accepted

Implemented at the new owner, recorded in the manifest's `implemented` section: locked npm ci installs at `application/hosts/vscode/` (lock/pins unchanged; old protected dependency/output trees untouched); package gate passed — real VSIX produced, extracted entries inspected, and a packaged isolated backend check passed 2/2 after a minimal-settings fixture with no external packages; a low-risk SDK fresh-patch fix with lock/pins unchanged and 42 affected tests repeated; new-owner clean build through the generated overlay plus Preact identity and fast-runner fixes passed focused regressions. No source or test relocation (rebatched to B7/B8); host builds are staged and renderer assets published, with no loader activation or installed-host restart; user-owned `settings.json` edits are excluded from migration.

Final verification gate passed (2026-09-24): model drift, all 17 typecheck projects, lint, and the non-publishing build passed; the settled-tree full `npm run test:all` rerun exited 0 with 7/7 groups, 7,437 passed / 0 failed / 35 skipped. The markdown-rendering group initially failed and passed on a selective rerun, so the pass is not pristine. The required final `extension:build` passed with staged runtime generation `b076b8b9034b1a20d3cdbdf2f5fbc22ada3944083856ac5874c713055a544af2` and renderer build ID `751a37955834f94abd94`; the host runtime is staged for the next normal restart and renderer assets are published. Loaded behavior has not been verified; no installed-host restart was forced. The focused inventory suite passed 12/12 after the last `currentLocations` mapping resolved the earlier inventory race; the full suite is not failing.

B0 verification passed with reruns after transient parallel-wave failures. Opt-in browser/live/performance suites were not run. The recorded staged build is not live verification. Preserve the current user-owned `settings.json`; its B0 value is historical only. Milestone commits on master are user-approved; pushing is not authorized.
