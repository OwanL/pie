# Tests

Tests live beside their owning application, harness, analytics, or script package. The root `test/integration/` directory is reserved for cross-owner contracts and repository-level checks; `test/integration/perf/` holds performance tests where `*.perf.ts` files are opt-in and excluded from the registered fast suites, while the directory’s `*.test.ts` files are registered fast tests.

Use the package registry in `scripts/lib/test-packages.mjs` as the source of truth for test discovery, focused-file routing, and ownership. Add a new test root or explicit integration file there when introducing a new test location. Prefer the narrowest owner directory matching the behavior under test; shared fixtures belong in the nearest owner’s `test/` tree.

The root test runners and each owner’s TypeScript/lint configuration discover only their registered paths. Keep opt-in browser, performance, and end-to-end suites separately registered rather than silently adding them to the default fast test run.
