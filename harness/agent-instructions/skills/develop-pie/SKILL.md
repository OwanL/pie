---
name: develop-pie
description: "Use when implementing, debugging, reviewing, or documenting pie itself or its Pi-based configuration; do not load for unrelated repositories merely because pie is the active agent harness."
---

# Develop pie

Use this skill only for work on the `pie` repository. **pie** is the VS Code sidebar and personal configuration stack built around the **Pi** coding-agent runtime; keep those names distinct.

Route to a specialized skill when the request matches one; this skill remains the general workflow reference:

- **`add-provider`** — adding or updating providers/models in the centralized catalog
- **`diagnose`** — hard, unclear, intermittent, or performance bugs
- **`grill-with-docs`** — challenging a plan against the repo's language and documented decisions

## Repository map

For the repository overview, see the [README](../../../../README.md#whats-in-this-repo); architectural ownership and dependency boundaries are described in [Architecture](../../../../docs/architecture/ARCHITECTURE.md#ownership-and-dependencies). Computer-use and Playwright dependencies remain owned by `extensions/` (see the [computer-use](../../../../docs/operations/COMPUTER-USE.md) and [Playwright](../../../../docs/operations/PLAYWRIGHT.md) guides).

For setup, storage, and repository-wide workflows, see [`README.md`](../../../../README.md). Use scoped search for task-relevant documents. For documentation changes, follow the [documentation policy](../../../../docs/DOCUMENTATION-POLICY.md).

## Common practices

- Use the repository-root Proto/pnpm scripts. The primary `test` route is Moon's affected task graph (`:test --affected --include-relations`), not a static-import/file-URL test-file selector. Explicit task inputs cover consumer sources; project dependencies alone do not propagate consumer selection in Moon 2.4.2. Do not add deep task traversal to ordinary checks: it can include artifact tasks. Use the uncached `proto run moon -- run root:graphTest` for NOOP affected-selection qualification in temporary Git fixtures. Ordinary Moon test tasks exclude files matching `*.artifact.test.*` (currently 30 fixtures: 26 TypeScript and four `.mjs`, including development refresh), which are retained for the separate `test:artifact` route. SDK-backed package-resolution, unbundled-module and CLI cases run in artifact companions; their SDK-free cases remain in ordinary tests. Generic native test selection supports repeatable `--include` and `--exclude <repo-relative glob>` file globs. Use `test:file` for focused native `node:test` work, and do not invoke `npx tsx` directly. TypeScript entries use private CommonJS wrappers with the local `tsx` loader; JavaScript and `.mjs` entries use Node's standard loading. This focused compatibility route does not qualify full native parity; see the root [README test guidance](../../../../README.md#test-and-validate) for coverage limits and retained legacy routes. Its optional `--sdk-path` supplies aliases from an already compiled SDK package but does not verify/acquire an artifact; SDK-backed source fixtures must point at the coding-agent package inside an independently verified `pi-runtime`, not `harness/pi/packages/coding-agent`.
- Ordinary build/watch are local development only: `proto run pnpm -- run build` and `proto run pnpm -- run watch` write to `application/hosts/vscode/out-dev` and never publish. Use `proto run pnpm -- run dev` or `proto run pnpm -- run dev:vscode` for the isolated development host. Backend/Pi refresh requires stop → build → relaunch; shared renderer rebuilds reload the development host and are not HMR. See the root [README lifecycle](../../../../README.md#build-and-run-pie-from-source) for the profile, reader gate, and explicit delivery route.
- Artifact delivery is separate: `proto run pnpm -- run delivery:build` builds only, while `proto run pnpm -- run extension:publish` explicitly publishes. Loader setup/upgrade additionally requires the explicit `--delivery --activate` route. Build/publication success does not establish installation, loading, or behavior verification; keep those states distinct. See the root [README lifecycle](../../../../README.md#build-and-run-pie-from-source) for workflow details.
- For a user-reported bug, distinguish built, staged, loaded, and behavior verified. Check the staged generation and running build evidence, not just build success. A staged delivery is not a live fix; only report it as loaded after checking the active host and matching delivery setup. Do not mistake reopening the sidebar for restarting the extension host.
- Treat [`docs/contracts/STATE_CONTRACT.md`](../../../../docs/contracts/STATE_CONTRACT.md) as authoritative for host↔webview synchronization. Contract changes require matching tests under the owning test roots, including `test/integration/sync-contract.test.ts`.
- Analytics have one active authority at a time, selected by the activation manifest: legacy (run analytics + billable ledger, the default) or canonical (the SQLite store under the resolved data root). Capture is never a dual-write between them. See [`docs/contracts/ANALYTICS_IMPLEMENTATION_CONTRACT.md`](../../../../docs/contracts/ANALYTICS_IMPLEMENTATION_CONTRACT.md) before changing capture, privacy, or storage paths; the `PIE_STORAGE_CUTOFF_AUTHORIZATION` cutoff and any activation must not be described as active without evidence.
- Keep the host architecture CQRS/Elm-style MVI: pure reducer, one effect runner, passive webview, explicit session addressing, and `Record<string, T>` host collections rather than `Map`/`Set`.
- Preserve unrelated working-tree changes. Generated or user-owned files may already be modified; inspect status and focused diffs before finishing.

### Model configuration

Edit `models.yaml`, then run `npm run sync-models`. This regenerates `models.json`, `model-profiles.yaml`, and model-owned fields in `settings.json`. Do not directly edit generated model files; `scripts/model-config/test/model-config-sync.test.ts` guards against drift. `settings.json` is tracked and committed: synchronization rewrites only its model-owned fields, while existing chat and pruning model selections are user-owned and preserved. Use `npm run settings:init` to seed it from `settings.defaults.json` if it is ever missing. For provider work, also load the `add-provider` skill.

### Context-lean terminology

Do not conflate these mechanisms:

- **History compaction**: Pi summarizes older conversation history across turns (`/compact`; `compaction{enabled,reserveTokens,keepRecentTokens}`). Avoid unqualified “compaction” or “summarization.”
- **Skill pruning**: the `skill-pruner` extension's prepass removes tools or skills from the catalog for a turn (`pruning-result`; `disablePruning`). Avoid unqualified “pruning.”
- **Tool-result pruning**: deterministic middleware rewrites one tool result before it enters context (for example ANSI stripping or JSON minification). Avoid “output compaction” and “result compaction.” See [`docs/contracts/TOOL-RESULT-PRUNING.md`](../../../../docs/contracts/TOOL-RESULT-PRUNING.md).

## Commands

Run from the repository root unless noted:

```bash
proto run pnpm -- run setup                 # gated frozen-lockfile dependency setup
proto run pnpm -- run install:dependencies  # alias for setup
proto run pnpm -- run test                  # primary affected Moon project tasks
proto run pnpm -- run test:file path/to/owner/test.ts
proto run pnpm -- run test:artifact         # artifact fixtures; prepares one private SDK artifact
proto run pnpm -- run test:artifact -- --pi-runtime "<absolute verified runtime root>" # reuse artifact
proto run pnpm -- run test:all              # all configured Moon :test project tasks
proto run pnpm -- run test:integration      # retained opt-in integration route
proto run pnpm -- run test:fast              # compatibility alias for affected Moon tasks
proto run pnpm -- run test:coverage          # retained legacy coverage gate
proto run pnpm -- run typecheck
proto run pnpm -- run lint                  # extension-owned lint command
proto run pnpm -- run check                 # model drift + typecheck + affected Moon tests
proto run pnpm -- run verify                # model drift + typecheck + Moon tests + VS Code build
proto run pnpm -- run verify:release        # coverage-gated legacy release route
proto run pnpm -- run sync-models           # regenerate centralized model configuration
proto run pnpm -- run sync-models -- --check
proto run pnpm -- run build                 # local development output only: application/hosts/vscode/out-dev
proto run pnpm -- run watch                 # local development build/watch; no publication
proto run pnpm -- run dev                   # isolated standalone development host
proto run pnpm -- run dev:vscode            # isolated VS Code development host
proto run pnpm -- run delivery:build        # explicit artifact build only: application/hosts/vscode/out
proto run pnpm -- run delivery:qualify      # uncached private delivery + relocated headless hosts/browser; no publication
proto run pnpm -- run extension:package     # package a VSIX; does not install or publish
proto run pnpm -- run extension:publish     # explicit --delivery --publish publication
proto run pnpm -- run extension:test:browser
proto run pnpm -- run analytics:query -- --name core_runs
proto run pnpm -- run doctor                # non-destructive installation/config check
```

For a focused SDK-backed fixture, pass `--sdk-path` before the selector and use the coding-agent package from a separately verified artifact (not the native Pi workspace). For example, `completion-entry.artifact.test.ts` can be selected with `test:file`:

```bash
proto run pnpm -- run test:file --sdk-path "<absolute verified runtime root>/node_modules/@earendil-works/pi-coding-agent" harness/tool-and-skill-selection/prepass/test/completion-entry.artifact.test.ts
```

The `test:file` runner checks that the selected SDK package graph is compiled/coherent; it does not itself verify the artifact manifest or acquire a runtime. The dedicated `test:artifact` command delegates to Moon `root:artifactTest`, whose `pi:build` dependency compiles the workspace, then prepares one private SDK artifact (or reuses the explicit verified runtime) and invokes the native runner once for the artifact fixtures. This task boundary is not a lightweight-artifact or speed claim. These are production-style SDK bytes, not an application release build, publication or installation; no SDK cache is added. An explicit `-- --pi-runtime <absolute runtime root>` reuses a verified artifact and skips private artifact preparation, but not the Pi workspace build prerequisite. Some provider/integration cases remain opt-in or skip without credentials; do not report the task as running or qualifying all fixtures or integration smoke tests. Native TypeScript totals and the evaluated c8/Monocart candidates remain unqualified. Use the retained `test:coverage` / `verify:release` lane: Node/tsx test APIs are unchanged, with four rolling owner jobs, exact invocation-private V8/generated-script/source-map capture, and AST-aware Istanbul conversion from the pinned agent framework's existing coverage dependencies. Missing or conflicting source provenance fails the gate; accounting failures and uncertain child lifetime retain raw evidence and alias overlays. Keep thresholds, deadlines and provider skip flags. `test:fast` aliases affected Moon tasks; legacy package `--fast` invokes native dispatch, not the removed batching/impact/custom result-cache/cost tooling. No full live/browser/provider qualification or equivalence to native TypeScript totals is claimed.

`delivery:qualify` composes the existing gated Pi compiler, external-output delivery build and relocated-host/browser fixtures in an invocation-owned OS-temp package. Explicit `-- --pi-runtime <absolute runtime root>` verifies/reuses caller bytes and skips Pi compilation. It does not publish/install, launch visible Electron, download browsers or send prompts. Failure/cancellation/uncertain nested teardown retains the package; success removes it after confirmed completion. It is a smoke route, not coverage, all-browser, installed-host or real-Electron qualification.

Root setup uses the shared frozen pnpm installer behind the [development-workspace gate](../../../../lib/development-runtime/lifetime.mjs). Setup/rebuild is allowed only without active workspace readers; preserve the installed host. Registrations fail closed and are not reclaimed by PID or age: do not kill installed Pie or delete gate state. Bootstrap's default compiles Pi and prepares a private shared-lock artifact; explicit `--pi-runtime` verifies/reuses one and skips compilation. Neither route publishes. The [runtime guide](../../../../harness/pi-runtime/README.md) owns construction details; there is one shared lock and no npm bridge refresh route.

For real development Pi/backend refresh, stop the isolated host → `build` → relaunch; renderer watch only rebuilds/reloads renderer output. The printed development profile owns private settings/auth/session-settings and does not copy installed state; ambient provider variables may still be inherited, so this is not a credential sandbox. Development standalone/headless adapter and refresh checks require `PIE_RUN_DEVELOPMENT_HOST_TESTS=1`. Visible real-Electron acceptance requires explicit user consent and `PIE_RUN_ELECTRON_ACCEPTANCE=1`; never launch it as an ordinary check. See the root [README](../../../../README.md#build-and-run-pie-from-source) for practical commands and distinctions; the [migration plan](../../../../docs/plans/PIE-PRODUCTIZATION.md) owns acceptance/status.

Choose focused tests while iterating, then run checks proportionate to the changed behavior.

## Read more by task

### pie architecture and UI

- [`docs/architecture/ARCHITECTURE.md`](../../../../docs/architecture/ARCHITECTURE.md) — primary system architecture, data flow, extension points, and invariants
- [`docs/contracts/STATE_CONTRACT.md`](../../../../docs/contracts/STATE_CONTRACT.md) — authoritative host↔webview state contract
- [`docs/contracts/ANALYTICS_IMPLEMENTATION_CONTRACT.md`](../../../../docs/contracts/ANALYTICS_IMPLEMENTATION_CONTRACT.md) — analytics authority, data root, privacy, and the gated storage cutoff
- [UI design philosophy](../../../../docs/architecture/UI-DESIGN-PHILOSOPHY.md) and [GUI development](../../../../docs/operations/GUI-DEVELOPMENT.md)

### Pi runtime documentation (in-tree source)

For Pi API work, use the topic that owns the API being changed. The in-tree coding-agent source is based on upstream Pi 0.80.6 plus Pie's local semantic changes; use its [README](../../../../harness/pi/packages/coding-agent/README.md), docs, and examples as the API references. The [Pie productization plan](../../../../docs/plans/PIE-PRODUCTIZATION.md) owns source provenance and the local-change boundary.

- [extensions](../../../../harness/pi/packages/coding-agent/docs/extensions.md) and [extension examples](../../../../harness/pi/packages/coding-agent/examples/extensions/)
- [skills](../../../../harness/pi/packages/coding-agent/docs/skills.md)
- [SDK](../../../../harness/pi/packages/coding-agent/docs/sdk.md) and [SDK examples](../../../../harness/pi/packages/coding-agent/examples/sdk/)
- [RPC protocol](../../../../harness/pi/packages/coding-agent/docs/rpc.md)
- [custom providers](../../../../harness/pi/packages/coding-agent/docs/custom-provider.md) and [models](../../../../harness/pi/packages/coding-agent/docs/models.md)
- [settings](../../../../harness/pi/packages/coding-agent/docs/settings.md), [packages](../../../../harness/pi/packages/coding-agent/docs/packages.md), and [prompt templates](../../../../harness/pi/packages/coding-agent/docs/prompt-templates.md)
- [TUI](../../../../harness/pi/packages/coding-agent/docs/tui.md) and [keybindings](../../../../harness/pi/packages/coding-agent/docs/keybindings.md)

A Pi package version alone does not identify a built runtime: use the verified artifact's `pi-runtime/manifest.json` identity, which includes source and lock fingerprints, target, package trees, and payload hash. See the [runtime artifact guide](../../../../harness/pi-runtime/README.md). The upstream landing page is [pi.dev](https://pi.dev/).
