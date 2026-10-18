# Tests

Tests live beside their owning application, harness, analytics, script, or shared-library code. The root `test/integration/` directory is reserved for cross-owner contracts and repository-level checks. Prefer the narrowest owner directory matching the behavior under test; shared fixtures belong in the nearest owner’s `test/` tree.

Ordinary test selection is owned by each project’s `moon.yml` test task and Moon’s affected-input graph, not the package registry. Add new ordinary test locations to the owning Moon selectors and inputs. Artifact-only `*.artifact.test.*` suites remain excluded from ordinary tasks; browser, performance (`*.perf.ts`), and end-to-end suites remain opt-in.

`scripts/lib/test-packages.mjs` owns focused-file routing and the retained legacy package/coverage inventory. Register new test roots or explicit integration files there as well; registry membership alone does not add a test to ordinary Moon selection. TypeScript and lint configurations have their own scopes. See the root [test guidance](../README.md#test-and-validate) for commands and coverage limits.
