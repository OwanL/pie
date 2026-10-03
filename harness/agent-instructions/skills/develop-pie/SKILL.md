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

- Use the repository-root test wrappers: `test:file` for focused checks while iterating and `npm test` as the default final development test. `npm test` resolves working-tree changes to affected tests, runs package groups concurrently, and conservatively broadens when dependency evidence is incomplete. Do not invoke `npx tsx` directly. Use `test:coverage` only for an explicit release coverage gate.
- After any runtime-source edit under `application/`, `analytics/`, `harness/`, or `lib/`, run `npm run extension:build`. It validates and stages a complete immutable runtime in a matching installed extension, and publishes live renderer assets. The startup loader automatically selects the newest verified runtime on the next normal VS Code restart; loaded windows retain their leased host/backend files. Never force a restart or interrupt active work merely to deploy a fix.
- Older installations need `npm run extension:activate` once to install the startup loader. This command stages immutable loader files and updates the entrypoint for the next restart without replacing locked running bundles. Routine changes need only a successful build and a normal restart, not another installation command. SDK/dependency or extension manifest upgrades remain explicit package/install work.
- For a user-reported bug, distinguish built, staged, loaded, and behavior verified. Check the staged generation and running build evidence, not just build success. A pending host update is not a live fix; tell the user it will load on their next normal restart. Do not mistake reopening the sidebar for restarting the extension host.
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
npm ci                                      # install all locked dependency trees
npm run test                                # changed-file affected development testing
npm run test:file -- path/to/owner/test.ts
npm run test:all                             # full fast suite
npm run test:all -- --package extension --test-name-pattern="pattern"
npm run test:changed                        # fast suites affected by working-tree changes
npm run typecheck                           # all TypeScript projects
npm run lint                                # all configured lint checks (currently the extension)
npm run check                               # model drift + typecheck + lint + changed tests
npm run verify                              # full verification: drift + typecheck + lint + all fast suites + build
npm run verify:release                      # release gate: replaces the fast suites with coverage-gated runs
npm run sync-models                         # regenerate centralized model configuration
npm run sync-models -- --check              # fail on generated-config drift
npm run extension:build                     # validate + stage runtime + live renderer publish
npm run extension:build:validate            # compile/validate without publishing
npm run extension:activate                  # one-time startup loader setup or explicit upgrade
npm run extension:package                   # build a .vsix from the root
npm run extension:test:browser              # extension Playwright browser suite
npm run analytics:query -- --name core_runs # query the retained DuckDB workspace (legacy run-analytics sources)
npm run doctor                              # non-destructive installation/config check
```

Extension-only loop:

```bash
cd application/hosts/vscode
npm run build            # validate + stage runtime + renderer publish
npm run build:validate   # compile/validate only
npm run publish:renderer # publish existing renderer output
npm run activate         # startup loader setup/upgrade; loads on next restart
npm run watch            # incremental validation + runtime/renderer publication
npm run test             # extension tests
npm run typecheck        # extension typecheck
npm run lint             # extension ESLint
npm run package          # build a .vsix
```

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
