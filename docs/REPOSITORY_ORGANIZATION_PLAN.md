# Repository Organization Plan

**Status:** design plan only — no source moves executed. Iterated design: review findings are incorporated into the decisions recorded here (§2); the design is reviewed, not yet user-approved for execution. Approved direction: plan first, moves after pending work lands. Renaming/restructuring decisions may still be revised before execution. **Scope-out: behavioral change.** Every batch below is a pure move/rename plus the import/config updates it forces.

Ownership of execution: this document is the plan of record. Other agents are expected to review and iterate it; do not start batch B0 (§12) until the dirty-work gate (§9) passes.

---

## 1. Purpose and problem statement

The repository works, but its layout has drifted from its ownership model:

- `extension/` (the complete VS Code product: extension host, embedded Pi backend, Preact webview, browser server, analytics) sits next to `extensions/` (the Pi conventional resource-discovery root for reusable pi plugins). The names differ by one character and mean unrelated things.
- `extension/src/backend/` is a flat directory of **89 TypeScript files** spanning at least nine distinct ownership domains (coordinator server surface, worker plane, durable session store, cold-browse subsystem, SDK patch barrier, provider admission, prompts, MCP, context, transcript/live pipeline). The folder gives no ownership signal; the only subfolder today is `transcript/`.
- `extension/src/host/` root carries two coherent clusters (analytics authority control plane: 7 files; aggregate strip: 5 files) mixed among files owned by other host clusters.
- Organization knowledge lives in docs and reviewers' heads. Two concrete drift examples already exist: `extension/eslint.config.mjs` pins a non-existent `src/host/store/` tree, and `backend/system-prompt-toggle-store.ts` is a deprecated re-export shim with zero remaining importers (its test already imports `session-settings-store` directly).

Goal: an ownership-based target layout that makes the VS Code product, the shared kernel, and the Pi extension ecosystem unmistakable, with a complete, verified current→target mapping and a batch plan that never leaves the tree uncompiling or unreviewable.

Non-goals (explicit scope-outs):

- No behavioral change. No protocol, lifecycle, analytics-authority, or SDK-patch changes. Moves update import specifiers and path-referencing configs/docs only.
- No speculative `apps/` hierarchy, no npm package splitting, no new `services/`/`utils/`/`common/` catch-alls, no barrel files, no shared-kernel `runtime-io/`-style grab bag.
- No new lint infrastructure and no new structural drift tests. Organization rules (§7) are review-enforced; existing drift tests remain the mechanical guard. The pre-existing stale `src/host/store/` eslint glob is pre-existing cleanup, deliberately outside execution scope (not needed for moves; fix separately if desired).
- No test-group reshuffles beyond what a move forces (backend tests are already grouped; §7 fixes the rule).
- No deletion cleanups folded into move batches. The deprecated shim's deletion (§2.1 R4) is separate, unrelated cleanup with its own review.

---

## 2. Decision summary (round 2)

| # | Decision |
|---|----------|
| D1 | Rename top-level `extension/` → **`vscode-extension/`** — the complete VS Code product (host, backend, webview, browser server, analytics, workers, tests). Installed identity, artifact layout, logical test package id, and `extension:*` script names stay stable. |
| D2 | Keep **`extensions/`** unchanged as the Pi conventional resource-discovery root (`PI_CODING_AGENT_DIR` is the repo root; pi auto-discovers `<agentDir>/extensions/`). |
| D3 | Keep **`shared/`** at the repo root as the cross-package kernel — consumed by the extension, **seven** `extensions/*` packages (ask-user, deferred-triggers, skill-pruner, subagent, tool-result-pruner, warm-bash, web-access-guard), `analysis/`, and `scripts/` — and group it into cohesive cross-package **families**: `providers/`, `data-root/`, `managed-packages/`, `subagents/`, `run-analytics/`, alongside the existing `analytics/`; independent leaves stay at the shared root (§6.1). No package split of the kernel now. |
| D4 | Reorganize `vscode-extension/src/backend/` into ownership folders — entries + shared request-dispatch spine at the backend root, then `coordinator/` (named for the process role, distinct from the shared RPC dispatch), `worker/`, `sessions/` (+ `sessions/cold/`), `sdk/`, `providers/`, `mcp/`, `context/`, `models/`, `transcript/` (absorbing `history-compaction`), `live-pipeline/`. No `prompts/` folder: `system-prompts.ts` joins `worker/`, the settings shim joins `sessions/`. Vite entry points stay at the backend root. |
| D5 | Group the two verified host clusters into `host/analytics-control/` (7 files) and `host/aggregate-stats/` (5 files); the rest of `host/` is out of scope and stays put. |
| D6 | Exactly two deliberate leaf renames, both in the transcript family: `transcript.ts` → `transcript/model.ts` (avoids file/directory ambiguity beside the `transcript/` folder — deliberate, not technically forced) and `transcript-window.ts` → `transcript/window.ts` (folder-relative clarity). No other leaf renames; keeping a leaf name is churn-minimization, never a doc-compatibility mechanism (docs follow moves in-batch, §7 rule 9). |

Everything else (`analysis/`, `agents/`, `skills/`, `docs/`, `scripts/`, `models.yaml`, root config) stays where it is.

### 2.1 Resolved round-2 decisions (formerly open questions)

All twelve questions from design round 1 are resolved; none remains open for a later round.

| # | Question (round 1) | Resolved decision |
|---|--------------------|-------------------|
| R1 | `server/` membership of `coordinator-operations.ts` | Stays in the coordinator folder (now named `coordinator/`), with the coordinator-owned ledgers and auth storage. |
| R2 | `models/` folder value | Keep `models/` with `pricing.ts` + `subagent-profiles.ts`: both are model-catalog adapters. `pricing.ts` is the package-local pricing loader re-exporting the shared core, not a disposable wrapper. |
| R3 | `session-event-*` placement | `worker/`, as chosen (workers own live event translation — verified sole importer chain). No pre-planned split; if the folder ever exceeds the ~25–30-file rule of thumb, split only along a verified sub-domain (e.g. protocol side), never by size alone. |
| R4 | Retire `system-prompt-toggle-store.ts` shim | **Keep it.** The shim moves into `sessions/` alongside its target `session-settings-store` (B2.3); existing tests retain their locations and update imports; deletion is deferred as unrelated cleanup — a separate explicit decision outside the move batches. |
| R5 | `rpc.ts` leaf rename to `startup-args.ts` | **Keep `rpc.ts`** (explicit decision). Its content — arg parsing *plus* model/runtime-prefs validation consumed by the shared dispatch in both processes — does not fit `startup-args` as a whole; a rename would misstate half the responsibility. |
| R6 | Root `shared/` naming (`kernel/`?) | Keep `shared/`. Renaming is ~60 specifiers of churn across four package families for naming clarity only. |
| R7 | Extension-only kernel members | Superseded by the family grouping (§6.1): `wake-conditions.ts` is in fact cross-package (consumed by `extensions/deferred-triggers`), and `analytics/host-status-messages.ts` stays as a family-local helper of the analytics family. No member moves into the extension. |
| R8 | `process-tree.ts` placement | `worker/` (both importers spawn/terminate children). |
| R9 | New structural allowlist drift test + stale eslint glob cleanup | **Dropped from execution scope.** No new structural test; the stale `src/host/store/` eslint glob is pre-existing cleanup, unrelated to moves and not needed for them. Existing drift tests remain the mechanical guard. |
| R10 | `analytics-control` test placement | No test moves. The flat `test/host/analytics-*.test.ts` files keep their group; only their specifiers update (B3). |
| R11 | `working-time-service.ts` in the aggregate cluster | Stays at host root — verified consumed by `stats-service/` (legacy authority), not the aggregate cluster. |
| R12 | `initial-context-estimate-worker.ts` placement | Stays at the backend root (entry rule, §7 rule 3); its client lives in `context/`. Moving the entry into `context/` would be an artifact-layout decision and is not taken. |

Round-2 review also resolved (beyond the round-1 list): root `shared/` is grouped into families rather than left flat (D3, §6.1); the coordinator folder is named `coordinator/`, not `server/` (D4); the request-dispatch spine stays at the backend root with `rpc.ts` unchanged (D4, R5); `history-compaction.ts` co-locates under `transcript/` (§6.2); batch validation is focused per batch with full verification at B1 and the final batch (§11); B1 additionally updates `scripts/sync-models.mjs` (§8.2).

---

## 3. Verified current-state evidence

Facts below were verified in the checkout (2026-09-21, commit `04cbdb69` + pending tree), not inferred from filenames. The backend import graph and the root-`shared/` consumer lists were resolved programmatically.

**Snapshot caveat.** Every count and consumer list in this section is a snapshot of that checkout *including pending work*; pending work can still add, rename, or remove files. Batch B0 re-runs the programmatic inventory (backend import graph, `shared/` consumer map, host→backend surface) and re-verifies every mapping row in §6 against the actual tree before any move starts. Nothing in §6 is a guarantee about the tree at execution time beyond what B0 re-confirms.

### 3.1 Process roles (from `docs/ARCHITECTURE.md`, confirmed in code)

- **PI coordinator** (`backend/index.ts` → `server.ts`): JSON-RPC stdio server; owns cold durable browsing, settings/catalog authority, worker routing/supervision, global provider-network admission, session lifecycle receipts. Never creates an `AgentSession`.
- **Cold browse helper** (`cold-browse-helper-entry.ts`): persistent read-only child; owns exact-v3 manager-free projection misses + weighted LRU.
- **Root workers** (`worker-entry.ts`): one process per hot root; owns the SDK runtime/session context, extensions/tools discovery, live event translation, extension-UI bridge, and the root's sole write lease. **Verified:** the worker executes the same `handleBackendRequest` dispatch the coordinator uses (`worker-runtime-host.ts` imports and calls it), so the request-dispatch layer is shared, not coordinator-only.
- **One-shot inventory child** (`initial-context-estimate-worker.ts`): temporary worker for cold empty-session catalog estimates.
- **Extension host + webview + browser server**: outside `backend/`; unchanged by this plan except the two host clusters in §6.3.

### 3.2 Backend ownership clusters (verified by imports, not filenames)

- `request-handler.ts` + `request-handler-message/session/shared.ts` are consumed by **both** `server.ts` (coordinator) and `worker-runtime-host.ts` (worker) — a shared dispatch layer. This is why the spine stays at the backend root and the coordinator-specific authorities get their own `coordinator/` folder (D4).
- `worker-protocol.ts` is the private coordinator↔worker contract; its importers span both process sides (server, supervisor, router, coordinator lease on one side; host, server, frame-io, stores on the other).
- `sdk.ts` is the backend-wide SDK adapter (importers in every cluster; snapshot: 37 of the 87 backend-root files); `sdk-patch-barrier.ts` + the two patch modules are the fail-closed transform machinery; `session-manager-fence.ts` is the fenced `MutableSdkSessionManager` used by durable-store code on both sides.
- `cold-session-store.ts ↔ session-ownership-authority.ts` form a pre-existing cycle with one runtime edge (`session-ownership-authority` → `cold-session-store`) and one type-only back-edge (`cold-session-store` → `session-ownership-authority`, `import type`). After the move it crosses the `sessions/cold/` subfolder boundary but stays inside the `sessions/` ownership subtree (§7 rule 6).
- `transcript.ts ↔ history-compaction.ts` form a runtime+type cycle: `transcript.ts` runtime-imports `history-compaction` (overflow-message helpers); `history-compaction.ts` type-imports `transcript.ts` (`SessionEntryLike`) and `transcript/types` (`MessageLike`). The type-only back-edge is erased at compile time; the runtime edge is one-directional. Round 2 co-locates `history-compaction` under `transcript/` so the whole cycle sits in one ownership folder (§6.2).
- `backend/pricing.ts` is the package-local pricing loader (`loadModelPricing` over `models.json` + the generated historical catalog) that re-exports the shared core parser/types from root `shared/pricing-core.ts`; its only backend-internal consumer is `subagent-profiles.ts`, and three host files consume it (§3.2 host→backend).
- **Host→backend imports (complete, snapshot: 10 refs in 8 host files, three modules).** `backend/session-lifecycle-store.js` — 6 refs in 4 files (`analytics-all-host-handoff.ts` ×3 including two re-exports, `analytics-handoff-control.ts`, `analytics-handoff-discovery.ts`, `extension-host.ts`); `backend/session-manager-fence.js` — 1 type-only ref (`analytics-all-host-handoff.ts`); `backend/pricing` — 3 refs in 3 files (`aggregate-pricing-cache.ts`, `billable-accounting/service.ts`, `stats-service/aggregate-stats.ts`). There is **no** host import of a `backend/client` module: `host/backend/client.ts` is the host's own `BackendClient` wrapper, host-internal and unaffected by backend reorganization. Moving everything else inside `backend/` does not touch host code.
- Host `analytics-*.ts` cluster (7 files) is consumed only by `extension-host.ts` and within the cluster. Host aggregate-strip cluster (5 files) is consumed by `extension-host.ts` and within the cluster. `working-time-service.ts` is consumed by `stats-service/` (legacy authority) — **not** part of the aggregate cluster.
- `backend/system-prompt-toggle-store.ts` is a deprecated re-export of `session-settings-store.ts` with zero importers anywhere — including its own test, which already imports `session-settings-store` directly (round-1 evidence stale; corrected here).
- Build identity: Vite emits fixed entry names (`extension.js`, `backend.js`, `worker-entry.js`, `analytics-recorder-worker.js`, `analytics-query-worker.js`, `cold-browse-helper-entry.js`, `initial-context-estimate-worker.js`, `phase4-worker-command-extension.js`); `backend/index.ts` hands child entry paths to the server via `__dirname`; `host/session-service/startup.ts` spawns `backend.js` from `runtimeOutputDirectory`; `extension/scripts/build.mjs` verifies `requiredBuildFiles`. These names are the installed artifact contract.

### 3.3 Cross-package import surface (enumerated)

Root `shared/` consumers per module were resolved exactly (§6.1). Imports **into** `extension/src/…` from other packages — the rename-affected import-specifier set for D1 as resolved in this snapshot. This table is not a completeness claim for path-like references (dynamic joins, `extension/package.json` / `extension/package-lock.json` resolution, backslash spellings): those are owned by §8's mandatory per-batch discovery (round-3 examples: `extensions/subagent/src/bucket-config.ts` resolves `extension/package.json` via `createRequire(new URL(...))`; the §8.4 dynamic SDK-path joins). (Note the two different `shared` scopes: rows below marked `extension/src/shared` are the extension-internal protocol layer, *not* root `shared/`):

| Importer | Imports from extension |
|---|---|
| `extensions/ask-user/src/types.ts` | `extension/src/shared/ask-user-sentinel.js` |
| `extensions/ask-user/index.ts` | root `shared/autonomous-mode.js` (unchanged by D1; counted in §6.1) |
| `extensions/session-changes/index.ts`, `src/diff.ts`, `src/session-jsonl.ts` | `extension/src/shared/file-path.js`, `git-baseline.js`, `file-change-derivation.js` |
| `extensions/subagent/src/result-compaction.ts` | `extension/src/shared/file-change-derivation.js` |
| `extensions/subagent/test/*.ts` (p4 analytics suite) | `backend/analytics-worker-transport.js`, `analytics/{recorder-supervisor,sqlite-recorder,canonical-capture}.js`, `host/analytics-transport.js`, `host/billable-accounting/service.js`, `extension/src/shared/subagent-result.js`, `host/core/arch-state.ts` |
| `extensions/subagent/test/execution-paths.test.ts` | `backend/session-event-content-tool.js` |
| `extensions/copilot-model-discovery/{src,test}` | `extension/node_modules/yaml` |
| `extensions/playwright/test/schema.test.ts` | `extension/node_modules/.../typebox` |
| `analysis/scripts/source.ts` | dynamic `pathToFileURL` import of `extension/src/host/run-analytics/{query,types}.ts` |
| `extensions/deferred-triggers/{index,src/store,src/types}.ts` | root `shared/wake-conditions.js` (unchanged by D1; counted in §6.1) |

Plus doc-comment references and cosmetic string fixtures (e.g. `extensions/tool-result-pruner` test sample strings) that are not gating. Specifiers pointing into backend folders update in the corresponding backend move batch; the `extension/`-spelled prefix updates in B1.

### 3.4 Test and registry layout

- `extension/test/` groups: `backend/{models,runtime,sessions,transcript,worker}`, `host/*`, `webview/*`, `shared/*`, `analytics/*`, `integration/*`, `browser/*`, `perf/*`, `fixtures/`, `helpers/`. Backend tests are already grouped; no test moves are planned.
- `scripts/lib/test-packages.mjs` is the authoritative registry: `id: 'extension'`, `dir: 'extension'`, `testCwd: 'extension'`, typecheck config/compiler under `extension/`; `SHARED_TYPECHECK_PROJECT` compiles root `shared/` with `extension/node_modules/typescript`. `shared/` and `scripts/lib/` are global-infra prefixes (a change selects all packages).
- `scripts/lib/test-impact.mjs` resolves affected tests from a reverse graph of **relative imports**, so folder moves only require updating the specifiers themselves; two hardcoded `extension/test/integration/model-*.test.ts` entries exist in `MODEL_CONFIG_TESTS`.
- `scripts/lib/package-registry-drift.test.mjs` fails when runners or root scripts diverge from the registry — the existing drift-guard pattern §7 reuses.

---

## 4. Target repository layout

```
pie/  (repo root; unchanged paths unless listed)
├── vscode-extension/            ← renamed from extension/ (the complete VS Code product)
│   ├── package.json             (identity unchanged: publisher/name "pie", version, main ./runtime/bootstrap.cjs)
│   ├── package-lock.json        (moved; content unchanged)
│   ├── runtime/                 (startup loader — unchanged)
│   ├── scripts/                 (build/publication — unchanged)
│   ├── media/, .vscodeignore/, playwright.config.ts, eslint.config.mjs, tsconfig.json, vite.config.ts
│   ├── src/
│   │   ├── extension.ts         (host entry — unchanged)
│   │   ├── host/                (unchanged except §6.3 clusters)
│   │   │   ├── analytics-control/   ← new (7 files)
│   │   │   ├── aggregate-stats/     ← new (5 files)
│   │   │   └── …                    (core, session-service, sidebar, browser-server, run-analytics, stats-service, billable-*, activity-timeline, deferred-triggers, backend/, analytics-runtime wiring, util, webview — unchanged)
│   │   ├── analytics/           (canonical store: recorder/query/activation — unchanged)
│   │   ├── shared/              (host↔webview protocol + cross-layer helpers — unchanged)
│   │   ├── webview/             (unchanged)
│   │   └── backend/             ← reorganized per §6.2 (entries + dispatch spine + 11 ownership folders)
│   ├── test/                    (unchanged layout; import specifiers updated by the batches)
│   └── out/, node_modules/, test-results/, pie-*.vsix   (generated — see §10)
├── shared/                      ← kernel stays; regrouped into families per §6.1
│   ├── analytics/               (existing family — unchanged)
│   ├── providers/, data-root/, managed-packages/, subagents/, run-analytics/   ← new families
│   └── <independent leaves>     (autonomous-mode, error-message, jsonl-writer, pie-harness-prompt, sensitive-redaction, temp-file-reaper, tokenize, traversal-policy, wake-conditions — unchanged)
├── extensions/                  ← unchanged: Pi conventional resource-discovery root
├── analysis/                    (unchanged)
├── agents/, skills/, docs/, scripts/   (unchanged locations; path references updated by batches)
├── models.yaml, models.json, model-profiles.yaml, settings.json, settings.defaults.json, APPEND_SYSTEM.md, README.md, AGENTS.md, install.bat
├── data/, npm/, bin/, git/, node_modules/  (local runtime data / pi-managed trees — never source-moved)
└── docs/REPOSITORY_ORGANIZATION_PLAN.md  (this plan; removed when work completes)
```

Naming note: `vscode-extension` (singular, hyphenated) describes exactly what the package is and cannot be confused with `extensions/`. Prefix classification stays collision-free: `vscode-extension/` does not start with `extensions/`.

---

## 5. Stability guarantees

The following must not change in any batch. They are the installed product's identity and the reason moves are safe:

1. **Installed identity.** `package.json` content: `publisher: "pie"`, `name: "pie"` (id `pie.pie`), displayName/description, `version`, `main: "./runtime/bootstrap.cjs"`, `pieRuntimeBootstrap: 1`, `activationEvents`, all `pie.*` contributed commands, views, and view container ids.
2. **Installed artifact layout.** The installed extension directory keeps `runtime/bootstrap.cjs`, `runtime/runtime-generations.cjs`, `pie-bootstrap/<gen>/bootstrap.cjs`, content-addressed `out/` runtime generations with the fixed bundle names (`extension.js`, `backend.js`, `worker-entry.js`, `analytics-recorder-worker.js`, `analytics-query-worker.js`, `cold-browse-helper-entry.js`, `initial-context-estimate-worker.js`, `phase4-worker-command-extension.js`), `webview/panel` renderer generations, and `sdk-local-path.json`. Vite rollup entry ids and `vscode-extension/scripts/build.mjs#requiredBuildFiles` are unchanged; the source entries they point at stay at `backend/` root.
3. **Logical test package id.** `scripts/lib/test-packages.mjs` keeps `id: 'extension'` (so `--package extension` and every runner message keep working) while `dir`/`testCwd`/typecheck paths become `vscode-extension/…`. `PACKAGE_GROUPS.extensions` continues to mean the pi plugins under `extensions/`.
4. **Root npm script names.** All `extension:*` script names stay (`extension:build`, `extension:activate`, `extension:package`, `extension:typecheck`, …); only their `--prefix` targets change to `vscode-extension`.
5. **Runtime contracts.** `PIE_*`/`PI_*` environment names, the resolved data root and `<data-root>` subtree layout, `WEBVIEW_PROTOCOL_VERSION`, live-pipeline protocol version, `PIE_BUILD_ID` mechanism, `COLD_SESSION_STORE_PLACEMENT`, and the analytics authority switch are untouched.
6. **Generated model configuration.** `models.json`, `model-profiles.yaml`, and the model-owned fields of `settings.json` are regenerated by `npm run sync-models` and never hand-edited; `sync-models --check` is an explicit gate (§11).
7. **Behavioral invariants.** Reducer purity, effect-runner ownership, operation conservation, accounting conservation, fail-closed SDK patch barrier semantics — unchanged. No reducer/effect code is edited in any batch.

---

## 6. Complete current→target mapping

Convention: every immediate source file under root `shared/` and `vscode-extension/src/backend/` appears below. Rows may be grouped when membership is explicit and verified; per-file rows carry a one-line ownership rationale. "Unchanged" = same path after the top-level rename (D1 applies to everything under the renamed package). B0 re-inventory re-checks completeness (§3 snapshot caveat).

### 6.1 Root `shared/` — complete mapping (kernel stays, grouped into families)

The kernel stays at the repo root because seven pi extensions resolve it by relative path from `extensions/<id>/`, `analysis/scripts` imports it, `scripts/doctor.mjs` imports `pie-data-root-core.mjs` (plain .mjs, no TypeScript), and pi extension runtime loading requires an ancestor-reachable directory. Moving it into `vscode-extension/` would break those consumers for zero ownership gain. Round 2 supersedes the draft's flat-kernel presentation: files are grouped into cohesive cross-package families; independent leaves stay at the shared root.

Target families: **`shared/providers/`** (provider/pricing contracts), **`shared/data-root/`** (data-root contract: JS core + typed wrapper), **`shared/managed-packages/`** (managed-package contract), **`shared/subagents/`** (subagent contracts), **`shared/run-analytics/`** (legacy analytics contracts). The existing `shared/analytics/` family stays as is.

| Current (shared/) | Target | Verified consumers (extension = vscode-extension/src, ext-* = extensions/*) |
|---|---|---|
| **`analytics/` family — stays (existing folder)** | | |
| `analytics/activation.ts` | unchanged | extension (backend/server+rpc, host analytics-runtime/backend-client/session-service, analytics/activation-store, shared/protocol/sessions) |
| `analytics/contracts.ts` | unchanged | extension (backend×5, host×2, analytics×8) + ext-subagent (runtime + tests) |
| `analytics/host-status-messages.ts` | unchanged (new, pending) | extension only (host handoff/restart/census, backend/session-lifecycle-store) — family-local helper of the analytics family (§7 rule 5) |
| `analytics/metrics.ts` | unchanged | extension only (analytics read model, host aggregate/stats) — family-local helper |
| `analytics/transport.ts` | unchanged | extension (analytics, backend worker/transport, host transport/event-dispatch) + ext-subagent |
| **`providers/` family** | | |
| `pricing-core.ts` | `providers/pricing-core.ts` | extension (backend/pricing loader re-exports it; host aggregate-stats-service, aggregate-pricing-cache, billable-accounting/service, stats-service/aggregate-stats) + analysis/scripts/pricing + scripts/test fixture |
| `provider-capacity-bridge.ts` | `providers/provider-capacity-bridge.ts` | extension backend/provider-gate (+ its test) + ext-subagent (model-resolution, runner, src/provider-capacity, test) |
| `provider-gate-request-class.ts` | `providers/provider-gate-request-class.ts` | extension backend (provider-gate, session-title-generator) + ext-skill-pruner prepass |
| **`data-root/` family** | | |
| `pie-data-root-core.mjs` | `data-root/pie-data-root-core.mjs` | JS implementation: scripts/doctor.mjs, ext-web-access-guard, scripts/test |
| `pie-data-root-core.d.mts` | `data-root/pie-data-root-core.d.mts` | types for the .mjs core |
| `pie-data-root.ts` | `data-root/pie-data-root.ts` | typed wrapper — extension only (backend/server+worker-runtime-host, host/backend-client, host/extension-host + tests); kept beside the JS core for family cohesion (§7 rule 5) |
| **`managed-packages/` family** | | |
| `managed-package-contract.mjs` | `managed-packages/managed-package-contract.mjs` | ext-web-access-guard + scripts/install/lib/managed-packages + scripts/test |
| `managed-package-contract.d.mts` | `managed-packages/managed-package-contract.d.mts` | types for the .mjs contract |
| **`subagents/` family** | | |
| `subagent-context.ts` | `subagents/subagent-context.ts` | ext-skill-pruner + ext-subagent (+ scripts/test fixture) |
| `pruned-skills.ts` | `subagents/pruned-skills.ts` | ext-skill-pruner + ext-subagent |
| `subagent-provider-policy.ts` | `subagents/subagent-provider-policy.ts` (new, pending; was missing from round 1) | extension backend (worker-runtime-host, system-prompts) + ext-subagent (provider-toggles) + extension test/shared test |
| **`run-analytics/` family** | | |
| `run-analytics-contracts.ts` | `run-analytics/run-analytics-contracts.ts` | legacy contracts — extension (host run-analytics, shared protocol models/sessions, shared/subagent-result) + analysis/scripts/contracts |
| `tool-analysis-kinds.ts` | `run-analytics/tool-analysis-kinds.ts` | extension shared/tool-call-analysis + analysis/scripts/contracts |
| **Independent leaves — unchanged at shared root** | | |
| `autonomous-mode.ts` | unchanged | extension backend (3) + ext-ask-user + ext-skill-pruner |
| `error-message.ts` | unchanged | extension re-export shims (shared/, host/util) + analysis CLI + ext-skill-pruner/subagent/tool-result-pruner |
| `jsonl-writer.ts` | unchanged | ext-skill-pruner, ext-tool-result-pruner, ext-warm-bash (loggers) — no extension import |
| `pie-harness-prompt.ts` | unchanged | extension backend (worker-runtime-host, initial-context-estimate-worker) + ext-skill-pruner + ext-subagent |
| `sensitive-redaction.ts` | unchanged | extension re-export (shared/) + analytics/sqlite-recorder + ext-subagent analytics capture |
| `temp-file-reaper.ts` | unchanged | extension host/util/temp-log-reaper + ext-tool-result-pruner reaper |
| `tokenize.ts` | unchanged | ext-skill-pruner + ext-tool-result-pruner (repo-root `gpt-tokenizer` devDependency; not imported by the extension) |
| `traversal-policy.ts` | unchanged | ext-subagent user-context + ext-warm-bash + drift-checked block in repo `AGENTS.md` (scripts/lib carries its own .mjs copy) |
| `wake-conditions.ts` | unchanged (new, pending) | cross-package: extension (host/deferred-triggers/* ×4, shared/protocol/deferred-triggers) **and** ext-deferred-triggers (index, src/store, src/types) — not extension-only (round-1 claim corrected); independent leaf, not a family |
| `package.json`, `tsconfig.json` | unchanged | typecheck project `shared` (first in `TYPECHECK_PROJECTS`); tsconfig includes `./**/*.ts`, so family subfolders need no config change |

Count: 27 source files (13 move into families, 5 stay in `analytics/`, 9 leaves stay at root) + 2 config. Family admission and the no-grab-bag rule are §7 rule 5; the batch is B2.0 (§12).

### 6.2 `vscode-extension/src/backend/` — complete mapping (89 files)

Target shape (folder → ownership):

- **backend root** — process entries + the shared request-dispatch spine + cross-cluster contracts. Root files are the coordinator entry/composition, the dispatch layer shared by coordinator and workers (verified §3.1), and the two backend-wide contract modules (`server-types.ts`, `log.ts`).
- **`coordinator/`** — coordinator-owned execution authorities around the request spine (role-named; the shared RPC dispatch it uses stays at the root).
- **`worker/`** — the worker domain: the private protocol contract, coordinator-side routing/supervision, the in-worker runtime, and the worker-side system-prompt assembly.
- **`sessions/`** — durable session store, ownership, lifecycle, payloads, settings shim; **`sessions/cold/`** — the cold-browse subsystem.
- **`sdk/`, `providers/`, `mcp/`, `context/`, `models/`** — single-domain integration clusters.
- **`transcript/`** (model + windowing + detail paging + history-compaction), **`live-pipeline/`** (live-turn accumulation + trace).

#### backend root — 13 files (all unchanged paths)

| Current → Target | Rationale |
|---|---|
| `index.ts` → `index.ts` | Coordinator process entry (vite entry `backend`). Owns process lifecycle trace records. |
| `worker-entry.ts` → `worker-entry.ts` | Worker process entry (vite entry `worker-entry.js`; spawned via `__dirname` path). |
| `cold-browse-helper-entry.ts` → `cold-browse-helper-entry.ts` | Helper process entry (vite entry). |
| `initial-context-estimate-worker.ts` → `initial-context-estimate-worker.ts` | Inventory-child entry (vite entry; one-shot child). |
| `server.ts` → `server.ts` | Coordinator composition root (`BackendServer`); imports every folder — this is why it stays at the root. |
| `server-io.ts` → `server-io.ts` | Shared JSONL response/event lanes + `BackendError`; used by coordinator and workers. |
| `server-types.ts` → `server-types.ts` | Backend-wide `SessionContext`/`ActiveRequest` contracts, used across server/worker/sessions. |
| `rpc.ts` → `rpc.ts` | Shared `parseArgs` + model/runtime-prefs validation consumed by dispatch in both processes. Keeping the name is the explicit round-2 decision (§2.1 R5). |
| `request-handler.ts` → `request-handler.ts` | Shared `handleBackendRequest` dispatch (coordinator + worker); stays at root because it is not coordinator-only. Pinned by `backend-request-handler-boundaries.test.ts` source reads. |
| `request-handler-message.ts` → `request-handler-message.ts` | Message/live-pipeline request handlers (shared dispatch family). |
| `request-handler-session.ts` → `request-handler-session.ts` | Session-lifecycle request handlers (shared dispatch family). |
| `request-handler-shared.ts` → `request-handler-shared.ts` | Shared request helpers (shared dispatch family). |
| `log.ts` → `log.ts` | Structured backend stderr logger; imported from every cluster. |

#### `coordinator/` — 6 files (new folder; named for the process role, not for the shared dispatch)

| Current → Target | Rationale |
|---|---|
| `coordinator-operations.ts` → `coordinator/coordinator-operations.ts` | Coordinator method catalog (which RPCs stay runtime-free vs route to workers). |
| `create-operation-ledger.ts` → `coordinator/create-operation-ledger.ts` | Coordinator create/duplicate/truncate ledger (server-IO bound). |
| `interrupt-operation-ledger.ts` → `coordinator/interrupt-operation-ledger.ts` | Interrupt ledger (server-IO bound). |
| `send-operation-ledger.ts` → `coordinator/send-operation-ledger.ts` | Send/continue ledger (server-IO bound). |
| `auth.ts` → `coordinator/auth.ts` | Coordinator auth-file migration entry (re-export; sole consumer `server.ts`). |
| `auth-storage.ts` → `coordinator/auth-storage.ts` | Auth storage/DI (git-worktree detection, migrateAuthFile). |

#### `worker/` — 22 files (new folder)

One folder for the worker domain; the private protocol is the shared anchor, coordinator-side management and worker-side runtime live on either side of it (mirrors `test/backend/worker/`, which already covers both sides). `system-prompts.ts` joins here (round 2): its sole runtime consumer is the worker composition root, and a two-file `prompts/` folder was rejected (§2.1, §13).

| Current → Target | Rationale |
|---|---|
| `worker-protocol.ts` → `worker/worker-protocol.ts` | Private coordinator↔worker protocol v2 (shared contract of the folder). |
| `worker-frame-io.ts` → `worker/worker-frame-io.ts` | Directional FD frame IO (both sides). |
| `worker-client.ts` → `worker/worker-client.ts` | Coordinator spawn/compat client. |
| `worker-supervisor.ts` → `worker/worker-supervisor.ts` | Coordinator supervisor (spawn params incl. MCP override). |
| `worker-runtime-router.ts` → `worker/worker-runtime-router.ts` | Coordinator cold→promoting→hot→retiring router. |
| `coordinator-provider-network-lease.ts` → `worker/coordinator-provider-network-lease.ts` | Coordinator side of the provider lease authority (sole importer: router). |
| `worker-runtime-host.ts` → `worker/worker-runtime-host.ts` | In-worker composition root (vite bundle only via entry). |
| `worker-server.ts` → `worker/worker-server.ts` | Worker transport server. |
| `worker-live-detail-store.ts` → `worker/worker-live-detail-store.ts` | Worker demand-driven canonical detail store. |
| `worker-provider-network-lease.ts` → `worker/worker-provider-network-lease.ts` | Worker fetch-boundary provider fence. |
| `runtime-factory.ts` → `worker/runtime-factory.ts` | Agent-session runtime factory (worker side). |
| `session-event-handler.ts` → `worker/session-event-handler.ts` | SDK event wiring (workers own live event translation — ARCHITECTURE). |
| `session-event-content-tool.ts` → `worker/session-event-content-tool.ts` | Tool-event content sizing/normalization. |
| `session-event-lifecycle.ts` → `worker/session-event-lifecycle.ts` | Lifecycle events + compaction sidecar. |
| `session-event-shared.ts` → `worker/session-event-shared.ts` | Shared event helpers/diagnostics. |
| `session-control-tool.ts` → `worker/session-control-tool.ts` | Agent session-control tool (new, pending). |
| `system-prompts.ts` → `worker/system-prompts.ts` | Pie system-prompt assembly (harness/skills/tools/context-file/append entries, MCP tool guard, pie-harness integration). Sole runtime consumer: `worker-runtime-host.ts`; the inventory-child entry imports it too. Worker-side prompt integration — replaces the rejected single-file `prompts/` folder. |
| `analytics-worker-transport.ts` → `worker/analytics-worker-transport.ts` | Worker-side analytics capture transport. |
| `auxiliary-llm-meter.ts` → `worker/auxiliary-llm-meter.ts` | Auxiliary (compaction/tree) LLM metering (sole importer: worker-runtime-host). |
| `extension-ui-bridge.ts` → `worker/extension-ui-bridge.ts` | SDK ExtensionUIContext implementation (worker side). |
| `extension-ui-owner-registry.ts` → `worker/extension-ui-owner-registry.ts` | Coordinator pending ExtensionUI owner registry (sole importer: router). |
| `process-tree.ts` → `worker/process-tree.ts` | Windows job-object child termination (worker spawn + inventory child). |

#### `sessions/` — 15 files (new folder)

| Current → Target | Rationale |
|---|---|
| `session-catalog.ts` → `sessions/session-catalog.ts` | Canonical inventory projection (coordinator). |
| `session-directory.ts` → `sessions/session-directory.ts` | Canonical session storage-path resolution. |
| `session-index-store.ts` → `sessions/session-index-store.ts` | SQLite metadata sidecar store. |
| `session-metadata.ts` → `sessions/session-metadata.ts` | Sidecar projections + append checkpoints. |
| `session-lifecycle-store.ts` → `sessions/session-lifecycle-store.ts` | Lifecycle receipts/census/cutoff authority (6 host refs in 4 files — §3.2). |
| `session-filesystem-lifecycle.ts` → `sessions/session-filesystem-lifecycle.ts` | Cross-process transcript-mutation lock. |
| `session-ownership-authority.ts` → `sessions/session-ownership-authority.ts` | Coordinator ownership authority (one runtime edge of the verified pre-existing cycle with cold-session-store). |
| `session-settings-store.ts` → `sessions/session-settings-store.ts` | Neutral runtime-data owner for session-scoped settings. |
| `system-prompt-toggle-store.ts` → `sessions/system-prompt-toggle-store.ts` | Deprecated re-export shim; zero importers (§3.2). Moved beside its target `session-settings-store`; deletion deferred as unrelated cleanup (§2.1 R4). |
| `session-opened.ts` → `sessions/session-opened.ts` | `session.opened` payload builder (shared coordinator/worker/cold). |
| `session-activity.ts` → `sessions/session-activity.ts` | Session-attributed billable-activity authority (shared across processes). |
| `session-analytics.ts` → `sessions/session-analytics.ts` | Session usage factors for payloads. |
| `session-title-generator.ts` → `sessions/session-title-generator.ts` | Async LLM session titles (coordinator request path; session-domain owner). |
| `private-session-artifacts.ts` → `sessions/private-session-artifacts.ts` | Private-session artifact cleanup. |
| `legacy-review-artifact-cleanup.ts` → `sessions/legacy-review-artifact-cleanup.ts` | Retired-review artifact cleanup. |

#### `sessions/cold/` — 7 files (new folder; the cold-browse subsystem)

| Current → Target | Rationale |
|---|---|
| `cold-session-store.ts` → `sessions/cold/cold-session-store.ts` | `ColdSessionStore` — the documented `COLD_SESSION_STORE_PLACEMENT` constant lives here. Type-only back-edge of the pre-existing cycle (§3.2). |
| `cold-browse-helper-client.ts` → `sessions/cold/cold-browse-helper-client.ts` | Coordinator client for the read-only helper. |
| `cold-browse-helper-protocol.ts` → `sessions/cold/cold-browse-helper-protocol.ts` | Helper JSONL protocol. |
| `cold-browse-helper-runtime.ts` → `sessions/cold/cold-browse-helper-runtime.ts` | Helper-side manager-free projection authority. |
| `cold-browse-projection-cache.ts` → `sessions/cold/cold-browse-projection-cache.ts` | Weighted LRU (helper production, coordinator fallback). |
| `session-browser.ts` → `sessions/cold/session-browser.ts` | Durable browse-snapshot builder (sole consumers are the cold cluster). |
| `write-ownership-trace.ts` → `sessions/cold/write-ownership-trace.ts` | Cold write-ownership diagnostics (sole importer: cold-session-store). |

#### `sdk/` — 5 files (new folder)

| Current → Target | Rationale |
|---|---|
| `sdk.ts` → `sdk/sdk.ts` | Supported Pie SDK adapter (the backend↔SDK surface). |
| `sdk-patch-barrier.ts` → `sdk/sdk-patch-barrier.ts` | Fail-closed patch planning/validation. |
| `sdk-session-open-patch.ts` → `sdk/sdk-session-open-patch.ts` | Single-read transform reversal. |
| `sdk-session-ownership-patch.ts` → `sdk/sdk-session-ownership-patch.ts` | Ownership transform (+v1→v2 upgrade candidate). |
| `session-manager-fence.ts` → `sdk/session-manager-fence.ts` | Fenced `MutableSdkSessionManager` (SDK adaptation; 1 type-only host ref). |

#### `providers/` — 4 files (new folder; distinct from MCP/context by design)

| Current → Target | Rationale |
|---|---|
| `provider-gate.ts` → `providers/provider-gate.ts` | Per-provider concurrency/circuit/metrics gate (both processes). |
| `provider-incident.ts` → `providers/provider-incident.ts` | Provider incident types. |
| `provider-progress-bus.ts` → `providers/provider-progress-bus.ts` | Transport-observation bus. |
| `provider-traffic-observer.ts` → `providers/provider-traffic-observer.ts` | Undici/fetch traffic observer (installed by both entries). |

#### `mcp/` — 2 files (new folder)

| Current → Target | Rationale |
|---|---|
| `mcp-config.ts` → `mcp/mcp-config.ts` | MCP discovery/toggles via pinned `pi-mcp-adapter`. |
| `mcp-session-config.ts` → `mcp/mcp-session-config.ts` | Session-scoped MCP override artifact (`<sessionPath>.mcp-overrides.json`). |

#### `context/` — 4 files (new folder; what may enter the model context)

| Current → Target | Rationale |
|---|---|
| `context-files.ts` → `context/context-files.ts` | Prepared context files/resources discovery. |
| `context-usage.ts` → `context/context-usage.ts` | Context-window usage projection. |
| `message-inputs.ts` → `context/message-inputs.ts` | Composer input normalization/input-kind resolution. |
| `initial-context-estimate-client.ts` → `context/initial-context-estimate-client.ts` | Coordinator client for the one-shot inventory child. |

(`history-compaction.ts` leaves this folder for `transcript/` — §6.2 transcript family.)

#### `models/` — 2 files (new folder; model-catalog adapters)

| Current → Target | Rationale |
|---|---|
| `pricing.ts` → `models/pricing.ts` | Package-local pricing loader (`loadModelPricing`) re-exporting the shared core (`shared/providers/pricing-core` post-B2.0); consumed by `subagent-profiles.ts` and 3 host files. |
| `subagent-profiles.ts` → `models/subagent-profiles.ts` | `model-profiles.yaml` reader feeding picker ordering via session metadata. |

#### `transcript/` — 6 files (extends the existing subfolder)

| Current → Target | Rationale |
|---|---|
| `transcript.ts` → `transcript/model.ts` | **Deliberate rename** to avoid file/directory ambiguity: a root-level `transcript.ts` beside a `transcript/` folder would compile but leave `./transcript` ambiguous between the module and the folder. Not technically forced — chosen (D6). ChatMessage/session-name/tool-result-format helpers. |
| `transcript/content.ts` → `transcript/content.ts` | Unchanged. |
| `transcript/types.ts` → `transcript/types.ts` | Unchanged. |
| `transcript-window.ts` → `transcript/window.ts` | **Deliberate rename** for folder-relative clarity and to distinguish from the host↔webview `extension/src/shared/transcript-window.ts` contract. Also not technically required (D6). |
| `durable-detail-store.ts` → `transcript/durable-detail-store.ts` | Durable terminal-detail resolution/paging (cold + coordinator consumers). |
| `history-compaction.ts` → `transcript/history-compaction.ts` | Co-located with its runtime anchor (§3.2 cycle): the transcript model runtime-imports its overflow helpers; it type-imports the model back. Keeps the type-only back-edge inside one ownership folder. |

#### `live-pipeline/` — 3 files (new folder; mirrors `host/core/live-pipeline/`)

| Current → Target | Rationale |
|---|---|
| `live-turn-accumulator.ts` → `live-pipeline/live-turn-accumulator.ts` | Canonical in-memory turn accumulator (v7 semantics). |
| `tool-progress-normalizer.ts` → `live-pipeline/tool-progress-normalizer.ts` | Bounded progress/tool normalization. |
| `live-pipeline-trace-runtime.ts` → `live-pipeline/live-pipeline-trace-runtime.ts` | Backend trace runtime (all clusters import it; folder documents the domain). |

Count check: 13 + 6 + 22 + 15 + 7 + 5 + 4 + 2 + 4 + 2 + 6 + 3 = **89** — nothing is deleted in any batch (the shim is kept, §2.1 R4). B0 re-verifies the count against the tree. ✔

### 6.3 Host clusters (selective — the only `host/` changes)

**`host/analytics-control/` (new; 7 files).** Ownership: the analytics authority control plane — canonical-runtime supervision, capture transport, cross-host handoff, controlled quiet restart, process census. Verified: consumed only by `extension-host.ts` and within the cluster. Distinct from `src/analytics/` (the canonical store implementation: recorder/query/activation) — different authority layer, different folder.

| Current → Target |
|---|
| `host/analytics-runtime.ts` → `host/analytics-control/analytics-runtime.ts` |
| `host/analytics-transport.ts` → `host/analytics-control/analytics-transport.ts` |
| `host/analytics-all-host-handoff.ts` → `host/analytics-control/analytics-all-host-handoff.ts` |
| `host/analytics-controlled-restart.ts` → `host/analytics-control/analytics-controlled-restart.ts` |
| `host/analytics-handoff-control.ts` → `host/analytics-control/analytics-handoff-control.ts` |
| `host/analytics-handoff-discovery.ts` → `host/analytics-control/analytics-handoff-discovery.ts` |
| `host/analytics-process-census.ts` → `host/analytics-control/analytics-process-census.ts` |

**`host/aggregate-stats/` (new; 5 files).** Ownership: the aggregate-strip service and its direct collaborators (live token rate, rolling rate, pricing cache, completed-history cache). `working-time-service.ts` stays at host root — verified to be consumed by `stats-service/` (legacy authority), not this cluster (§2.1 R11).

| Current → Target |
|---|
| `host/aggregate-stats-service.ts` → `host/aggregate-stats/aggregate-stats-service.ts` |
| `host/token-rate-service.ts` → `host/aggregate-stats/token-rate-service.ts` |
| `host/rolling-aggregate-rate.ts` → `host/aggregate-stats/rolling-aggregate-rate.ts` |
| `host/aggregate-pricing-cache.ts` → `host/aggregate-stats/aggregate-pricing-cache.ts` |
| `host/completed-history-cache.ts` → `host/aggregate-stats/completed-history-cache.ts` |

Leaf names are kept (no renames); folder names carry the grouping. Doc references are updated in-batch regardless (§7 rule 9), so no doc path depends on a leaf name.

### 6.4 Explicitly out of scope (verified, not omitted by accident)

- `vscode-extension/src/host/` other than §6.3 (core/, session-service/, sidebar/, browser-server/, run-analytics/, stats-service/, billable-*, activity-timeline/, deferred-triggers/, webview/, util/, working-time-service.ts) — unchanged.
- `vscode-extension/src/analytics/`, `src/shared/`, `src/webview/`, `src/extension.ts` — unchanged.
- `extensions/*`, `analysis/`, `agents/`, `skills/`, `scripts/` directory trees — unchanged locations (script/docs content updates are in §8).
- Root `shared/` — regrouped per §6.1 only; no file leaves the kernel.
- `docs/` locations — unchanged (path-reference content updates only).

---

## 7. Organization rules (decay prevention)

These rules are the contract this plan leaves behind. They are review-enforced; no new lint infrastructure and no new structural drift tests are required. Where a mechanical guard already exists (package-registry drift test), it stays the enforcement pattern.

1. **Ownership first.** A file's home is the folder whose ownership domain its primary behavior belongs to. When adding a backend file, name the owner; if none fits, the file stays at the backend root with the reason recorded. Never create `misc/`, `utils/`, `common/`, `services/`, or `helpers/` folders. Folders are admitted only for a domain from the process-role architecture (§3.1) or an integration cluster verified by imports — not for size alone.
2. **Backend root is load-bearing.** Only (a) the four process entries, (b) the shared request-dispatch spine (`server.ts`, `server-io.ts`, `server-types.ts`, `rpc.ts`, `request-handler*.ts`), and (c) the shared logger may live at backend root. Anything else needs a folder or a written exception in this plan.
3. **Entries stay at the backend root.** Vite rollup entry ids and the spawned script names they produce (`worker-entry.js`, `cold-browse-helper-entry.js`, `initial-context-estimate-worker.js`) are installed-artifact contract (§5). Moving an entry or renaming an emitted bundle is an explicit artifact-layout decision, never a routine move.
4. **No barrels.** `backend/index.ts` is the coordinator entry, not a re-export hub. Folders do not get `index.ts` re-export files; importers import the owning module directly. (Corollary: deprecated re-export shims are deleted once their importers reach zero — but always as separate cleanup, never inside a move batch; see the `system-prompt-toggle-store.ts` handling, §2.1 R4.)
5. **Root `shared/` admission and families.** A module enters root `shared/` only when a second package family consumes it (extension + extensions/*, analysis, scripts) or it is a cross-package contract family (analytics authority, prompt harness). Cohesive cross-package families live in a family folder (`providers/`, `data-root/`, `managed-packages/`, `subagents/`, `run-analytics/`, `analytics/`), and **family-local helpers stay with their family** even when they lack a second consumer of their own (e.g. `analytics/metrics`, `analytics/host-status-messages`, the typed `data-root/pie-data-root.ts` wrapper beside the .mjs core). Independent single-purpose leaves stay at the shared root; do not create a `runtime-io/`-style grab bag for them (redaction, reaper, writer, tokenizer are separate concerns, not a family). Single-extension-consumer helpers that are not part of a family belong in `vscode-extension/src/shared/`.
6. **Cycles: type-only vs runtime, judged per ownership subtree.** An ownership subtree is a folder and its subfolders (`sessions/` includes `sessions/cold/`). Type-only back-edges (`import type`) are erased at compile time and are acceptable when they encode a genuine two-way contract, provided they stay inside one ownership subtree. Runtime cycles must likewise stay inside one ownership subtree; a new cross-subtree runtime cycle is an ownership bug — resolve by moving or splitting, never by re-export indirection. The two pre-existing verified cycles are examples, not precedents to copy: `sessions/cold/` ↔ `sessions/` (one runtime edge, one type-only back-edge) and `transcript/` internal (runtime forward, type-only back). Neither crosses an ownership subtree.
7. **Leaf naming.** Files are named for their primary export, kebab-case. Rename a leaf only as a deliberate, reasoned choice — folder-collision ambiguity (`transcript/model.ts`) or folder-relative clarity (`transcript/window.ts`) — and record the rationale in this plan. Never rename wholesale, and never treat a kept leaf name as a doc-compatibility mechanism (rule 9).
8. **Tests stay grouped.** Backend tests remain in `test/backend/{models,runtime,sessions,transcript,worker}`; a new source folder never forces a test-folder move. Place new tests in the narrowest existing group; split a group only at ~25–30 files (existing `test/README.md` rule). Source-reading tests (e.g. `backend-request-handler-boundaries.test.ts`) update their read paths in the same batch as the files they read.
9. **Docs follow moves in the same batch.** Any batch that moves a file updates `docs/` and `skills/` references to it in the same commit, so documentation never points at a path that no longer exists. `docs/INDEX.md` gains no entry for pure moves.
10. **Generated trees are never source-moved.** `out/`, `node_modules/`, `test-results/`, `.cache/`, `pie-runtime/`, `pie-bootstrap/`, `data/`, `npm/`, `bin/`, `git/` are regenerated/reinstalled, not tracked moves (§10).

---

## 8. Migration surfaces (categories + mandatory per-batch discovery)

The subsections below are verified categories and examples from the §3 snapshot. They are **not a complete enumeration**, and no batch may treat them as one: a path can be spelled in forms no list fully captures. Every batch that owns a move therefore runs, **as part of that batch**, a repository-wide Git-aware reference discovery over the tracked tree (`rg` / `git grep -nE`, generated/ignored trees excluded) for every old path it introduces, and updates everything it finds. The discovery must cover at least these old-path forms:

- **Literal old source-root paths** — `extension/…`, including `extension/package.json`, `extension/package-lock.json`, and `extension/node_modules/…` references.
- **Backslash Windows spellings** — `extension\src\…` forms inside strings, regexes, and fixtures (verified examples: `extensions/tool-result-pruner/test/lossy-rules.test.ts` sample-output strings; `scripts/update-extension-test-costs.mjs` path-normalization regex).
- **Split path segments** — `extension` as a standalone segment assembled at runtime or in regexes (`path.join` / `path.resolve` / `new URL(...)` / `createRequire(...)` / `pathToFileURL(...)`), invisible to any literal `extension/` grep (verified examples in §8.4).
- **Prose references** — comments, usage/help strings, docs, skills, and agent files.

Each batch records the discovery patterns it ran and every hit it deliberately left (with the reason) in its commit; a deliberate leave is acceptable only on the intentional allowlist (historical docs, this plan while it exists). B4's final audit (§14) re-runs the inspection as a cross-check — it is never the mechanism that finds a batch's references, and no reference work is deferred to it.

### 8.1 Build

- `vscode-extension/vite.config.ts` — rollup inputs point at `src/backend/index.ts`, `worker-entry.ts`, `cold-browse-helper-entry.ts`, `initial-context-estimate-worker.ts` (+ analytics entries + test fixture). Unchanged by all batches because entries stay at backend root; entry **ids** (= emitted file names) are the artifact contract (§5).
- `vscode-extension/tsconfig.json` — include `src/**/*` — unchanged (folder moves are inside it). `shared/tsconfig.json` includes `./**/*.ts` — family subfolders need no config change.
- `vscode-extension/eslint.config.mjs` — package-relative globs — unchanged by backend moves; the stale `src/host/store/` glob is pre-existing cleanup, out of execution scope (§1).
- `vscode-extension/scripts/{build,publication,runtime-publication,publish-renderer}.mjs` — operate on `out/` + installed dir by manifest identity — unchanged.
- `buildIdentityInputs()` hashes package-relative source paths — a folder rename inside `src/` changes the hash (new build id, new staged generation) without changing emitted names. Expected and harmless; any batch editing `src/` runs `extension:build` (§11).

### 8.2 Install / bootstrap / doctor / model sync

- `install.bat` — `EXTENSION_DIR=%REPO_ROOT%\extension` → `vscode-extension`; message strings mention `extension/`.
- `scripts/install-dependencies.mjs` — directory list `["extension", "analysis", "extensions/computer-use", "extensions/playwright"]`.
- `scripts/bootstrap.mjs` — `npm run build` cwd `${repoRoot}/extension`.
- `scripts/doctor.mjs` — `extension/package-lock.json` presence check, `npm ls` in `extension`, plus `shared/pie-data-root-core.mjs` import (path gains the `data-root/` family segment in B2.0).
- `scripts/sync-models.mjs` — lazy-resolves `yaml` + `ajv` via `createRequire(new URL('../extension/package.json', import.meta.url))` and `extension/node_modules`; B1 updates the path and B1 validation runs `npm run sync-models -- --check` explicitly.
- `scripts/toolchain.mjs`, `scripts/install/lib/toolchain.mjs` — extension lockfile path for the pi version pin.
- `scripts/install/lib/vscode-settings.mjs`, `settings-repair.mjs` — no source-dir references beyond settings paths (verified); unaffected.
- `extension/package-lock.json` — moves with the folder; content unchanged (lockfiles do not encode the directory path). `scripts/lib/sdk-version.mjs` and doctor read it at the new path.

### 8.3 Test registry and affected-file resolver

- `scripts/lib/test-packages.mjs` — registry `dir`, `testCwd`, `typecheck.config`, `typecheck.compiler` for id `extension`; `SHARED_TYPECHECK_PROJECT` compiler path; registry header comment ("directory layout is the identity anchor") updated to the dir/id split. Package id and group ids unchanged.
- `scripts/lib/test-impact.mjs` — `MODEL_CONFIG_TESTS` two hardcoded `extension/test/integration/model-*.test.ts` paths. The reverse-dependency resolver itself follows relative imports, so moved sources are tracked automatically once specifiers are updated.
- `scripts/run-fast-extension-tests.mjs` — `extensionRoot` join + `test/backend/...` UNSAFE/SAFE entry sets (test-cwd-relative; unaffected by backend folder moves, updated for the rename).
- `scripts/run-test-files.mjs`, `scripts/run-tests.mjs` — comments/usage strings and classification messages naming `extension/`.
- `scripts/run-typechecks.mjs`, `scripts/run-package-group.mjs`, `scripts/run-affected-tests.mjs` — consume the registry; no literal paths (verified).
- `scripts/update-extension-test-costs.mjs` + `scripts/extension-test-costs.json` — extension root path.
- `scripts/test/*.mjs` root-relative tests — `fast-extension-runner.test.mjs`, `run-test-files.test.mjs`, `test-packages.test.mjs`, `test-impact.test.mjs`, `install-batch.test.mjs` (creates a temp `extension/` tree), `sdk-version.test.mjs`, `skills-loader.test.mjs` — string/path updates.
- Root `.gitignore` — `/extension/out/`, `/extension/pie-runtime/`, `/extension/pie-bootstrap/`, `/extension/qualitas-report.json`, `/extension/.qualitas.config.js`, `/extension/src/-`.

### 8.4 Dynamic paths (verified inventory)

- `backend/index.ts` `__dirname` → `worker-entry.js` / `cold-browse-helper-entry.js` / `initial-context-estimate-worker.js` — bundle-relative; stable because entry names are stable.
- `host/session-service/startup.ts` — `runtimeOutputDirectory(context)` + `backend.js`; `extension-host.ts` — `analytics-{recorder,query}-worker.js` — artifact names, stable.
- `host/runtime-location.ts` — `extensionPath`-relative fallback — provided by VS Code at runtime; unaffected by source rename.
- `analysis/scripts/source.ts` — `pathToFileURL` dynamic imports into `extension/src/host/run-analytics/` — updated in the rename batch.
- `extensions/copilot-model-discovery`, `extensions/playwright(test)`, and `extensions/skill-pruner/test/integration.test.ts` (~line 1039) — `extension/node_modules/...` dependency-tree references — updated in the rename batch. skill-pruner assembles a dynamic SDK runner path at runtime: `path.join(process.cwd(), "extension", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "extensions", "runner.js")` fed to `pathToFileURL(...)` — a split-segment old path no literal `extension/` grep finds. The same split-segment shape is verified in `extensions/subagent/test/execution-paths.test.ts` (SDK `system-prompt.js` join), `extensions/playwright/test/fixtures/host-runtime-loader.ts` (SDK `loader.js` join), and — at runtime, not in a test — `extensions/subagent/src/bucket-config.ts` (`createRequire(new URL("../../../extension/package.json", import.meta.url))` pinned-SDK resolution).
- Runtime-data roots (`data/outcomes/sessions`, `<data-root>/*`, `PI_CODING_AGENT_*`) — runtime data, never moved by this plan.

### 8.5 Docs, skills, and harness paths

- `docs/ARCHITECTURE.md` (35 path refs), `docs/internal/ARCH-OVERVIEW.md` (spine map), `docs/BROWSER_SERVER_PLAN.md`, `docs/DEFERRED-TRIGGERS.md`, `docs/SUBAGENT_PROVIDER_RESILIENCE.md`, `docs/MCP.md`, `docs/AGENT-WORKFLOWS.md`, `docs/internal/centralized-model-config.md` — bulk `extension/…` → `vscode-extension/…` path updates; backend cluster moves additionally update per-file references in the same batch.
- `docs/INDEX.md` — B1 docs surface: currently references `extension/test/` (STATE_CONTRACT entry) and `extension/src/host/deferred-triggers/` (DEFERRED-TRIGGERS entry). `docs/STATE_CONTRACT.md` — B1 docs surface: currently references `extension/test/` (sync-contract tests). `docs/SESSION-TITLES.md` — round-3 example of a backend-feature doc carrying no literal path references; it is still covered by the owning batch's discovery sweep (§8), which is exactly why that sweep must be repository-wide instead of list-driven.
- `skills/develop-pie/SKILL.md` (repository map + commands + Pi-doc links under `extension/node_modules/...`), `skills/diagnose/SKILL.md`, `skills/pie-logs/SKILL.md`, `skills/query-analytics/SKILL.md`, `skills/add-provider/SKILL.md`, `skills/check-ui/` (new) — path updates in the rename batch.
- Repo `README.md` — update source-package, lockfile, and SDK-documentation paths in B1, including `extension/package-lock.json` and `extension/node_modules/...`. Validate it with the same stale-path check as scripts and skills.
- `agents/{reviewer,scout,worker}.md` — update any source-path references in B1. Root `AGENTS.md` currently has no `extension/` source paths; preserve its drift-checked traversal block.
- `.vscode/settings.json` comment referencing `extension/package-lock.json` and `extension/src/shared/runtime-resolution.ts`.
- **External injected harness SDK paths.** References to `extension/node_modules/@earendil-works/pi-coding-agent/**` (pinned-SDK doc paths) also appear in text injected into agent sessions by the outside harness/config, not only in tracked files. Repo-side skill/doc updates fix tracked files only and cannot fix those injected references. For each stale externally injected path: first find a tracked source (skill/config file in the repo) and update it in-batch; if none exists, record it as a migration prerequisite — coordinate the external config update and a session restart so new sessions resolve the renamed paths. **B0 validates this prerequisite before B1 starts** (§12): every externally injected path source is classified as repo-tracked (updated in-batch) or external-only (external config update + session restart coordinated). No machine-wide edits, no rewrites outside the repo.

### 8.6 Cross-package imports (from §3.3)

- Runtime: `extensions/ask-user`, `extensions/session-changes` (3 modules), `extensions/subagent` (`file-change-derivation`; also `src/bucket-config.ts` resolving `extension/package.json` — §8.4), `analysis/scripts/source.ts` (dynamic URL imports).
- Tests: `extensions/subagent/test/*` (analytics bridge suite + `session-event-content-tool`), the dynamic SDK-path tests of §8.4 (skill-pruner integration, subagent execution-paths, playwright host-runtime-loader fixture), plus cosmetic string fixtures (non-gating).
- `extension/`-spelled specifiers update in B1; specifiers pointing into moved backend folders (e.g. ext-subagent's `analytics-worker-transport`, `session-event-content-tool` imports) update in the corresponding move batch. After B1 the §14 stale-path detector must return only intentional references; it is a final cross-check, never the completeness mechanism — §8's per-batch discovery is.

---

## 9. Dirty-work gate (execution prerequisites)

1. All current pending working-tree edits (tracked modifications + untracked files, including `session-control-tool.ts`, `wake-conditions.ts`, `shared/analytics/host-status-messages.ts`, `shared/subagent-provider-policy.ts`) land and are verified (`npm run verify`). This plan's documents (`docs/REPOSITORY_ORGANIZATION_PLAN.md`, `docs/INDEX.md` entry) land first and independently.
2. No move batch starts with unrelated dirty files. Each batch is exactly: the move + its import/config updates + its doc updates — one commit, nothing else.
3. During any move batch, `git status` must show only the batch's own files. A dirty-tree failure aborts the batch before commit (moves are staged, never half-committed).
4. Batches are sequential; no parallel reorganization branches (Git worktrees are not used in this repo).

---

## 10. What does not move (generated artifacts, dependencies, runtime data)

No batch automatically deletes, relocates, or rewrites any generated, dependency, or runtime-data tree — not even in B1. Tracked sources move; physical trees stay where they are until someone with ownership of that tree decides otherwise.

- **Generated/build outputs** — `out/`, `pie-runtime/`, `pie-bootstrap/`, `test-results/`, `pie-*.vsix`, `qualitas-report.json`, tsbuildinfo caches: never `git mv`-ed and never blanket-deleted by a batch. After B1 the renamed package reproduces them fresh under `vscode-extension/` via `npm run install:dependencies` + `npm run extension:build`; the pre-existing `extension/...` trees are left in place and are cleaned up later as a separate, explicit ownership decision (not a blanket deletion inside any batch).
- **Dependency trees** — `node_modules/` (root, `vscode-extension/`, `analysis/`, `extensions/computer-use`, `extensions/playwright`), the pi-managed agent-dir trees `npm/`, `bin/`, `git/`: never auto-relocated. Dependencies are installed fresh under the new path; lockfiles move as tracked files, contents unchanged.
- **Runtime data** — `data/`, `auth.json` (relocated by the installer at its own runtime, not by this plan), session stores, analytics stores, caches (`PIE_CACHE_DIR` targets): untouched; `npm run doctor` verifies store/managed-package integrity after batches.
- **The installed extension** — `~/.vscode/extensions/pie.pie-<version>/` with its staged runtime generations and leases is untouched by source moves; publication matches by manifest identity (unchanged), so the next build stages normally on top of the existing generations.

---

## 11. Validation, staged vs loaded runtime, and rollback boundaries

**Per-batch validation is focused, not uniformly full.** Every batch runs `npm run typecheck` (catches every missed import specifier), `npm run lint`, and the batch's affected tests (registry-driven: `npm run test:changed` / `test:fast`, or `test:file` for the touched specifiers). That focused gate is sufficient for the small move batches B2.0–B3.

**Full verification** — `npm run verify` (which includes `sync-models --check`, typecheck, lint, `test:all`, `extension:build`) plus `npm run doctor` — runs at **B1** (the rename, which touches registry/toolchain surfaces and reinstalls dependencies) and at the **final batch**. `npm run sync-models -- --check` is called out explicitly in B1 because B1 edits `sync-models.mjs` itself. `npm run extension:build` is required in any batch that edits files under `src/` (it validates and stages a complete immutable runtime generation and publishes renderer generations); build identity will change (source layout input), emitted bundle names will not.

**B1 fresh-dependency snapshot validation (proving nothing resolves the old tree).** Because B1 leaves the legacy ignored trees in place (§10), the main checkout still contains `extension/node_modules` and `extension/out` — its own full verification cannot distinguish a genuinely updated reference from one still silently resolving the old dependency tree. B1 therefore adds one gate: after the batch's tracked changes are prepared and before the commit is finalized, copy every Git-tracked file at its post-batch working-tree path (Git manifest, e.g. `git ls-files`; a plain file copy — **not** a Git worktree, which this repo does not use (§9.4); no generated trees copied — no `out/`, `node_modules/`, `test-results/`, `pie-runtime/`, `pie-bootstrap/`, `data/`, VSIX artifacts) into a disposable directory under the OS temp dir, run root `npm ci --include=dev` there to install root dependencies (including `tsx`) and, through the root `postinstall` hook, the nested dependency trees under the renamed paths. `install:dependencies` alone is insufficient because it does not install root dependencies; then run in the snapshot: `npm run sync-models -- --check`, `npm run typecheck`, `npm run lint`, `npm run test:all`, `npm run extension:build:validate`. With no `extension/` tree present, any remaining old-path dependency resolution — a dynamic join, a `createRequire`, a fixture path — fails visibly. **No publication ever runs from the temporary checkout** (`extension:activate`, `extension:package`, `extension:publish:renderer`, `install.bat`, `verify:release` are forbidden there; `extension:build:validate` builds and validates `out/` without publishing). The task deletes only its own snapshot directory afterwards. The main checkout's legacy ignored trees are not modified, moved, or deleted by this validation (§10); `npm run doctor` keeps running in the main checkout only.

**Staged vs loaded runtime.** Every build stages a new immutable generation; the startup loader selects the newest verified runtime on the next normal VS Code restart. Already-loaded windows keep their leased host/backend/worker bundles: an existing loaded backend is safe across batches, and validation never forces a restart — build + tests + doctor is the gate for pure moves. One honest caveat: renderer generations are published live, so `extension:build` may update renderer assets that an already-open webview picks up; no batch can guarantee that an entire loaded UI remains byte-identical — only the host/backend/worker process bundles are lease-protected. A batch is "behavior verified" only after its staged generation loads in a normal restart and a session runs; for pure moves the behavioral surface is the unchanged bundle contract, so test/build/doctor evidence is the gate.

**Rollback boundaries:**

- Every batch is exactly one commit. `git revert` restores that commit's **tracked** content; it does **not** restore physical trees (`out/`, `node_modules/`, staged runtime generations) byte-for-byte. After reverting, rebuild and/or reinstall as appropriate (for B1-shaped batches: reinstall dependencies, then build; for source-move batches: rebuild), and only ever on a clean tree — a revert must never overwrite pending changes (the §9 gate governs batch starts and cleanups).
- The runtime is the deeper rollback layer: if a batch stages a broken generation, loaded windows keep the previous leased generation until shutdown; `git revert` + one build re-stages the previous content. No manual runtime cleanup is required because publication never replaces loaded bundles.
- B1 has one extra rollback surface: dependencies under the new path. Reverting B1 requires re-running `npm run install:dependencies` and `npm run extension:build`; nothing else is persistent.
- `npm run sync-models -- --check` after any revert involving model-config surfaces proves generated-config integrity (`models.json`, `model-profiles.yaml`, `settings.json` model fields are never hand-edited in any batch).

---

## 12. Batch plan (sequenced)

Batches are ordered so that no commit introduces stale active source-path references, and the widest reference fan-out lands before any backend moves. Every batch includes all affected documentation, skill, and comment paths even when its table row names only code consumers; it ends with §11 validation and is individually revertible subject to later dependent batches. Those references are found by the per-batch repository-wide discovery mandated in §8 — the §8 lists are categories and examples, not the completeness mechanism, and no reference work is deferred to B4.

**B0 — gate.** Pending work lands; `npm run verify` green; tree clean. Then **re-inventory**: re-run the programmatic backend import graph, the root-`shared/` consumer list, and the host→backend surface, and re-verify every §6 mapping row (including the 89-file count) against the actual tree. The §3 snapshot is planning evidence, not an execution guarantee; B0 is where it is re-confirmed. Any drift updates §6 before B1 starts. B0 also validates the harness path-authority migration prerequisite (§8.5, external injected SDK paths): it enumerates the surfaces that inject `extension/node_modules/...` SDK doc paths into agent sessions from outside the repo, classifies each as repo-tracked (updated in-batch) or external-only (external config update + session restart coordinated), and confirms that coordination is agreed before B1 starts.

| Batch | Content | Primary reference updates | Rollback |
|---|---|---|---|
| **B1 — top-level rename** | Move only Git-tracked files from `extension/` into `vscode-extension/`, preserving relative paths. Use a Git-derived file manifest and per-file moves, not directory-level `git mv` (which would also move ignored dependencies and outputs). Leave untracked/ignored trees in place (§10); retain ignore coverage for old generated paths while they remain. Install dependencies under the new path. | Root `package.json` prefixes (names unchanged), test registry (`test-packages`, `test-impact`, `sdk-version`), all `scripts/run-*.mjs`, `install-dependencies`, `bootstrap`, `doctor`, `toolchain`, `update-extension-test-costs`, **`sync-models.mjs` dependency resolution**, `install.bat`, `.gitignore`, `.vscode/settings.json`, cross-package imports (§8.6), all docs/skills/agents path refs (§8.5, including `docs/INDEX.md` and `docs/STATE_CONTRACT.md`). Validation: full `npm run verify` (explicit `sync-models --check`) + `npm run doctor` + the §11 fresh-dependency snapshot validation. | Revert commit + reinstall deps + rebuild. |
| **B2.0 — `shared/` families** | Move 13 root-`shared/` files into `providers/` (3), `data-root/` (3), `managed-packages/` (2), `subagents/` (3), `run-analytics/` (2). | Specifiers in extension, seven `extensions/*` packages, `analysis/scripts`, `scripts/doctor.mjs`, `scripts/install/lib/managed-packages.mjs`, scripts/test fixtures; documentation and skill references, including `docs/internal/ARCH-OVERVIEW.md`'s data-root path. | Revert. |
| **B2.1 — `sdk/`** | 5 files (highest fan-out first, to prove the move mechanics). | ~40 backend import specifiers + `test/backend/runtime/sdk-*` + 1 host `session-manager-fence` ref. | Revert. |
| **B2.2 — `providers/`** | 4 files. | backend + test/backend/models/provider-* + worker/server specifiers. | Revert. |
| **B2.3 — `sessions/` + `sessions/cold/`** | 22 files, including the `system-prompt-toggle-store` shim beside `session-settings-store` (kept, not deleted — §2.1 R4). Test locations stay unchanged. | backend, test/backend/sessions/*, host `session-lifecycle-store` (6 refs / 4 files). | Revert. |
| **B2.4 — `worker/`** | 22 files, including `system-prompts.ts` (no `prompts/` folder). | backend + test/backend/worker/* + `backend/models/backend-system-prompts.test.ts` + `test/integration/pie-harness-prompt.test.ts` specifiers. | Revert. |
| **B2.5 — `coordinator/`** | 6 files (coordinator-operations, 3 ledgers, auth, auth-storage). | `server.ts`/request-handler specifiers + tests. | Revert. |
| **B2.6 — `mcp/`, `context/`, `models/`** | 8 files (2 + 4 + 2; small sibling folders, identical mechanical shape). | backend + host `pricing` (3 refs → `backend/models/pricing`) + integration tests (`pie-harness-prompt`, `system-prompt-provider-payload`). | Revert. |
| **B2.7 — `transcript/` + `live-pipeline/`** | 7 files move: 4 into `transcript/` — the 2 deliberate renames (`transcript/model.ts`, `transcript/window.ts`), plus `durable-detail-store.ts` and `history-compaction.ts` co-located under `transcript/` — and 3 into `live-pipeline/`. The 2 existing `transcript/content.ts` / `transcript/types.ts` members are unchanged and are not part of the batch (folder totals stay 6 + 3, §6.2). | backend (root `sdk`/`server-types`, cold, worker, `session-opened`/`session-browser`) + `context-usage` + host (`core/session-opened-transcript`, `core/reducer/{streaming,live-pipeline}-handlers`) + webview/protocol `history-compaction` importers + test/backend/transcript. | Revert. |
| **B3 — host clusters** | `host/analytics-control/` (7), `host/aggregate-stats/` (5). | `extension-host.ts`, intra-cluster, flat `test/host/analytics-*` specifiers + `completed-history-cache`; documentation and comment references, including `docs/internal/ARCH-OVERVIEW.md`'s analytics-runtime path. | Revert. |
| **B4 — doc/skill refresh sweep** | Final stale-path audit (§14's multi-form inspection — the single boundary-aware grep is one candidate detector, not the completeness proof), verify ARCHITECTURE and ARCH-OVERVIEW maps already match the completed move batches, INDEX/plan-doc retirement note. B4 does not defer any path or ownership-map updates: each belongs to its owning move batch (§7.9). Docs only; no runtime files, no eslint cleanup, no new tests (§2.1 R9). Full `npm run verify` + `doctor` here as the final gate. | Docs only. | Revert. |

Ordering rationale: B1 first so later batches never touch `extension/`-spelled docs again; B2.0 before the backend moves so backend move batches write their final `shared/<family>/...` specifiers exactly once; B2.1 first among backend moves because `sdk/` has the widest fan-out (fails fast if the import-update procedure is wrong); the two deliberate renames land last (B2.7) so the pure-move pattern is proven first. Batch breadth rule: a batch may cover several small sibling folders only when the mechanical shape is identical (pure specifier updates in one reviewable commit with a bounded reference surface — e.g. B2.6); it must never mix move mechanics with behavioral changes or deletion cleanups, and no batch changes the same ownership domain twice.

---

## 13. Key tradeoffs

1. **Rename vs ambiguity.** `extension/` → `vscode-extension/` costs a one-time ~30-surface mechanical update; the payoff is permanent disambiguation from the Pi `extensions/` discovery root and an honest name for a package that already contains a backend, browser server, workers, and analytics. Rejected: keeping `extension/` (ambiguity persists), `pie-extension/` or `vscode/` (less precise).
2. **Root dispatch spine plus a role-named `coordinator/` folder.** `request-handler*` provably runs in workers too; putting the spine under a server-flavored folder would hide that. Round 2 keeps the spine at the backend root and names the coordinator-specific folder `coordinator/` so the folder states the process role rather than a dispatch responsibility the root spine owns. Rejected: spine inside `server/`/`coordinator/` (misleading ownership), `backend/shared/` (name collision with the two real `shared/` scopes).
3. **One `worker/` folder for both protocol sides, plus the prompt assembly.** The private protocol is the ownership boundary; splitting coordinator management and worker runtime into two folders would separate files that share one contract and diverge from `test/backend/worker/`. `system-prompts.ts` joins `worker/` because its only runtime consumer is the worker composition root — avoiding a single-file `prompts/` folder. A future split (e.g. protocol side) happens only if a verified sub-domain appears past the ~25–30-file threshold (§2.1 R3). Rejected: `worker/` + `worker-runtime/` split; a lone `prompts/` folder.
4. **`shared/` stays whole and grouped by families.** The kernel stays at the root (relative imports from seven `extensions/*` packages, doctor, analysis CLI) and is organized into cohesive cross-package families rather than left flat (round-2 direction). Moving extension-only members into the extension would fork contract families for zero capability; family-local helpers stay with their family (§7 rule 5). Revisit only if a real family split appears.
5. **Two deliberate leaf renames, everything else kept.** `transcript/model.ts` and `transcript/window.ts` are deliberate choices (file/directory ambiguity; folder-relative clarity), not technical requirements — and not doc-compatibility mechanisms, since docs follow moves in-batch. Everything else keeps its leaf name to minimize churn; no wholesale renames.
6. **Bundle/entry-name stability over source-name purity.** `backend/index.ts` computing child entry paths via `__dirname`, `backend.js`/`worker-entry.js` fixed names, and `requiredBuildFiles` are the installed contract; the plan buys organization without touching them.
7. **No barrels, no catch-alls, no package splitting, no grab bags.** Folders exist only where verified ownership exists; the backend root remains a small, meaningful set; root `shared/` gains families, not a `runtime-io/` misc drawer.
8. **Docs updated in-batch, not deferred.** Each move batch carries its doc references, so no commit leaves docs pointing at moved files (rule §7.9).
9. **Moves stay pure; cleanups stay separate.** The deprecated settings shim is moved (kept) rather than deleted in its batch, and the stale eslint glob and any structural-drift-test idea are out of scope: move commits contain moves and nothing else (§2.1 R4/R9).

---

## 14. Completion criteria

- All batches landed; final batch passes `npm run verify` (including explicit `sync-models --check`) + `npm run doctor`.
- Stale-path completion check. The boundary-aware grep is **one candidate detector, not a completeness proof**:
  `git grep -E "(^|[^[:alnum:]_/-])extension/(src|test|node_modules)" -- ':!node_modules'`
  (the leading character class keeps hits inside `vscode-extension/…` from matching). Completion is established by the §8 per-batch repository-wide inspections, re-run once at the end across **every old source-root form**: literal forward-slash `extension/…` references (including `extension/package.json`, `extension/package-lock.json`, and `extension/node_modules/…`), backslash `extension\…` spellings, split path segments (`"extension", "node_modules"`-style `join`/`resolve`/`new URL`/`createRequire`/`pathToFileURL` forms and regexes), and prose/comment/help-text references. Every hit is updated or recorded on the intentional allowlist — historical/plan references are allowed and enumerated (history docs, this plan while it exists).
- `docs/ARCHITECTURE.md`, `docs/internal/ARCH-OVERVIEW.md`, `skills/develop-pie/SKILL.md` file maps match the tree.
- This plan is updated with a completion note (or removed, per the `*_PLAN.md` convention) and `docs/INDEX.md` is adjusted.