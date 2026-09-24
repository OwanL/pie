# Repository organization B0 baseline verification

**Run date:** 2026-09-24  
**HEAD:** `6255f52b4387ee0fc8add6be649c2f5385e63849`  
**Scope:** verification only for `REPOSITORY_ORGANIZATION_PLAN.md`; no source edits or commit. The pre-existing `settings.json` working-tree change was preserved.

Commands were run sequentially from the repository root. Logs and per-command exit codes are outside the repository at `C:\Users\OWANLA~1\AppData\Local\Temp\pie-b0-baseline-ZYyp41\` (`<command>.log`, `<command>.exit`).

| Command | Exit | Result |
|---|---:|---|
| `npm run sync-models -- --check` | 0 | Derived files in sync. |
| `npm run typecheck` | 0 | All registered typecheck projects passed. |
| `npm run lint` | 0 | ESLint passed. |
| `npm run test:all` | 0 | 7/7 execution groups passed: 7,379 passed, 35 skipped. Two groups had transient failures in the parallel wave (four extension files, one Playwright file); all passed on the runner's rerun. Initial diagnostics included temp-directory `EPERM`, timeouts/assertion failure, and Windows Job-guardian `CLIXML`. Extension's summary retained 1 cancelled test. |
| `npm run extension:build:validate` | 0 | Non-publishing build validation passed; no package/publish step run. |

**Test enumeration / Windows limitation:** `test:all` executed rather than returning a cache-only result. All 17 registered package IDs were represented in the 7 summaries (one summary aggregates 11 root packages); no `ENAMETOOLONG` occurred. The runner output does not include a discovered test-file count, so package-level dispatch and reported test execution are evidenced, but a separate exhaustive file-by-file enumeration count is not available from this run. `test:all` is the fast suite; opt-in integration, browser/live, and performance gates were not run.
