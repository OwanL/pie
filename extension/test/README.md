# Extension tests

Tests are grouped by the primary source area or behavior they exercise:

- `backend/` — backend models, runtime, sessions, and transcript handling
- `host/` — host services and the core state/effect architecture
- `shared/` — protocols, tool-call analysis, and shared utilities
- `webview/` — components, composer, context window, file changes, tabs, and transcript UI
- `integration/` — repository-level and generated-config contracts
- `_helpers/`, `helpers/`, and `fixtures/` — shared test support
- `perf/` — performance tests and harnesses

Place a test in the narrowest folder matching its primary subject. Prefer extending an existing folder over adding a new one for a single test; split a folder when it becomes difficult to scan (roughly 25–30 files).

The test runner, TypeScript, and ESLint configurations all discover tests recursively under `test/`.
