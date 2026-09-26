# Repository organization: architecture and migration handoff

**Status (2026-09-27):** B0–B8 migration acceptance criteria and final post-fix
verification are complete in the working tree. The full `npm run verify`,
isolated headless UI smoke, opt-in built-worker package smoke, and `npm run
doctor` passed; a flaky test retry and doctor warnings are recorded in the
[migration progress checkpoint](repository-organization-migration-progress.md).
This is not a claim of live restart or deployed behavior. No commit or push was
performed.

**Source baseline inspected:** `78e5c0d7` on 2026-09-24. At preparation time the
only pending changes were this plan, `docs/INDEX.md`, and the navigation-study
report. Recheck HEAD, instructions, and the working tree before execution;
this is not a guarantee that the checkout will remain at that baseline.

## 1. Start here

1. Read this plan, `AGENTS.md`, `skills/develop-pie/SKILL.md`, and the owning
   contracts through `docs/INDEX.md`. Paths here describe the pre-migration
   checkout unless explicitly shown as targets.
2. Execute B0's inventory and B1's resolution/test-routing preparation first.
   Do not start by bulk-moving `extension/`, `shared/`, or `extensions/`.
3. Follow the target ownership and dependency rules below. Refactoring, splitting
   mixed-owner files, and consolidating proven duplication are in scope;
   unrelated behavior changes, dependency upgrades, and new features are not.
4. Complete and verify one small batch at a time. Keep the migration manifest
   current, so another agent can resume without reconstructing intent.
5. Stop for a decision if preserving a contract requires a materially different
   architecture, package strategy, storage migration, or public behavior.

The goal is progressive narrowing by responsibility: find the subsystem, then
its concern, then its implementation. There is no two-children-per-folder rule,
no independent-runtime extraction, and no requirement for new npm packages.

## 2. Target directory architecture

This is the complete responsibility-level target. Files may implement small
leaf concerns without an otherwise empty directory. Do not fabricate components
or features merely to populate this tree. Local `test/` directories, individual
implementation files, and most manifests are omitted for readability.

```text
pie/
├── harness/
│   ├── agent-instructions/
│   │   ├── agents/
│   │   ├── skills/<skill-name>/
│   │   ├── prompts/
│   │   ├── agent-discovery/
│   │   ├── skill-discovery/
│   │   ├── skill-selection/
│   │   └── prompt-assembly/
│   ├── tools/
│   │   ├── ask-user/
│   │   ├── warm-bash/
│   │   ├── computer-use/
│   │   ├── deferred-triggers/
│   │   ├── playwright/
│   │   ├── request-capability/
│   │   ├── session-changes/
│   │   ├── session-control/
│   │   ├── subagent/
│   │   ├── catalog/
│   │   ├── selection/
│   │   ├── execution-safety/
│   │   ├── result-processing/
│   │   └── package-integrations/
│   │       ├── sdk-tools/
│   │       ├── web-access/
│   │       └── mcp/
│   ├── tool-and-skill-selection/
│   │   ├── prepass/
│   │   ├── lifecycle/
│   │   ├── recovery/
│   │   └── state/
│   ├── agent-processes/
│   │   ├── coordinator/
│   │   ├── workers/
│   │   ├── cold-browse-helper/
│   │   ├── context-inventory/
│   │   └── lib/
│   │       ├── rpc/
│   │       ├── process-lifecycle/
│   │       └── sdk-integration/
│   ├── session-storage/
│   │   ├── transcripts/
│   │   ├── metadata/
│   │   ├── catalog/
│   │   ├── ownership/
│   │   ├── lifecycle/
│   │   └── settings/
│   └── model-providers/
│       ├── catalog/
│       ├── model-discovery/
│       ├── pricing/
│       ├── authentication/
│       ├── concurrency/
│       ├── retry-and-failover/
│       ├── request-validation/
│       └── traffic-observation/
├── application/
│   ├── backend/
│   │   ├── composition/
│   │   ├── conversation-state/
│   │   │   ├── reducers/
│   │   │   ├── effects/
│   │   │   └── projections/
│   │   ├── session-actions/
│   │   ├── agent-connection/
│   │   ├── transcript-delivery/
│   │   ├── deferred-triggers/
│   │   ├── settings/
│   │   ├── file-changes/
│   │   ├── analytics-views/
│   │   └── checkpoints/
│   ├── frontend/
│   │   ├── shell/
│   │   ├── session-tabs/
│   │   ├── transcript/
│   │   ├── composer/
│   │   ├── file-changes/
│   │   ├── context-inspector/
│   │   ├── settings/
│   │   ├── analytics/
│   │   ├── notifications/
│   │   ├── transport/
│   │   ├── styles/
│   │   ├── assets/
│   │   └── lib/
│   │       ├── components/
│   │       ├── hooks/
│   │       └── formatting/
│   ├── hosts/
│   │   ├── browser/
│   │   │   ├── http/
│   │   │   ├── websocket/
│   │   │   ├── network-access/
│   │   │   ├── static-assets/
│   │   │   └── confirmations/
│   │   ├── vscode/
│   │   │   ├── activation/
│   │   │   ├── commands/
│   │   │   ├── sidebar/
│   │   │   ├── editor-integration/
│   │   │   └── runtime/                 # Loader compatibility exception (§5)
│   │   ├── standalone/
│   │   │   ├── cli/
│   │   │   ├── startup/
│   │   │   └── shutdown/
│   │   └── lib/
│   │       ├── platform-contracts/
│   │       ├── renderer-delivery/
│   │       └── asset-manifests/
│   └── lib/
│       ├── protocol/
│       └── validation/
├── analytics/
│   ├── contracts/
│   ├── capture/
│   ├── recording/
│   ├── storage/
│   ├── queries/
│   ├── projections/
│   ├── usage-accounting/
│   ├── authority/
│   ├── legacy/
│   └── analysis/
├── lib/
│   ├── data-root/
│   ├── managed-packages/
│   ├── structured-logging/
│   ├── sensitive-data/
│   └── temporary-files/
├── extensions/                          # Stable discovery adapters
│   ├── ask-user/
│   ├── computer-use/                    # Also existing dependency owner
│   ├── copilot-model-discovery/
│   ├── cwd-skills/
│   ├── deferred-triggers/
│   ├── image-context-guard/
│   ├── playwright/                      # Also existing dependency owner
│   ├── safeguard/
│   ├── session-changes/
│   ├── skill-pruner/
│   ├── subagent/
│   ├── tool-result-pruner/
│   ├── warm-bash/
│   └── web-access-guard/
├── scripts/
│   ├── build/
│   ├── install/
│   ├── verification/
│   ├── model-config/
│   ├── migrations/
│   ├── diagnostics/
│   └── lib/
├── test/
│   ├── integration/
│   ├── fixtures/
│   └── helpers/
├── docs/
│   ├── architecture/
│   ├── contracts/
│   ├── operations/
│   ├── plans/
│   └── research/
├── .vscode/
├── README.md
├── AGENTS.md
├── APPEND_SYSTEM.md                     # SDK conventional entry (§5)
├── package.json
├── package-lock.json
├── models.yaml
├── models.schema.json
├── models.json
├── model-profiles.yaml
├── settings.json
├── settings.defaults.json
├── install.bat
└── start-pie.bat
```

`docs/INDEX.md` remains the stable documentation entry point. Root configuration
and repository metadata not shown above are retained unless explicitly mapped.
Generated `out/`, dependency installations, packaged artifacts, and runtime-data
folders are not source owners and are not candidates for blanket relocation.

## 3. Ownership and dependency rules

### 3.1 Harness and application are different backends

- **Harness** owns agent execution, SDK integration, model/provider policy,
  session durability/ownership, callable tools, and agent-facing resources.
- **Application backend** owns user-facing state, actions, effects, projections,
  renderer-facing retrieval, and the connection to the agent backend.
- **Application frontend** is the shared passive Preact UI. It is not an agent
  backend, accounting authority, persistence layer, or second application store.
- **Hosts** adapt that one application to VS Code, browser delivery, and
  standalone startup. Browser HTTP/WebSocket and LAN policy are not harness code.
- **Analytics** owns capture contracts, recording/querying, accounting, and
  analytics authority machinery. Application adapters turn its results into
  UI state; harness adapters submit observations without waiting for persistence.

Source movement does not move runtime authority between processes. In particular,
`ColdSessionStore` and write-lease authority stay coordinator-owned even when
implemented under `session-storage/`; the cold helper stays read-only; each hot
root still has one worker and one write lease. Provider admission/circuit state
remains coordinator-authoritative, not independently installed in each worker.

### 3.2 Allowed dependencies and composition

| Consumer | Allowed boundary | Forbidden shortcut |
|---|---|---|
| Harness | Harness domains, inert analytics contracts, narrowly shared root helpers | Application backend/frontend or concrete host code |
| Frontend | Browser-safe application protocol/validation and pure presentation helpers | Node filesystem/process APIs, SDK runtime, analytics recorder, host adapters |
| Application backend | Application contracts, harness RPC contracts/client adapters, analytics services, injected platform ports | Concrete VS Code/browser/standalone implementations or frontend implementation |
| Concrete hosts | Shared application runtime, host-neutral contracts/delivery, appropriate adapter implementations | A second state store, reducer, or agent backend |
| Analytics core | Analytics contracts/components and low-level root helpers | Importing application state, host adapters, or harness execution code |
| Root `lib/` | Other low-level helpers/external libraries as appropriate | Importing domain implementations to make a cycle compile |
| Selection coordinator | Tool policy, skill policy, its single state/recovery authority | Policies importing the coordinator back |

These are module-level boundaries, not a requirement for packages. Type-only
imports must respect ownership too; do not hide a cycle behind a barrel export.
Domain-owned contracts remain with their owner and can be imported by consumers.
Do not create a global `types/`, `common/`, or `utils/` directory to avoid choosing.
Browser-safe contracts must have no transitive Node/runtime imports.

Concrete hosts construct platform services and inject them into shared composition.
The current `extension/src/host/runtime/host-runtime.ts` directly constructs `BrowserServer`;
extract that adapter seam rather than moving the dependency unchanged into the
application backend. Keep shared lifecycle logic single-implemented. Apply the
same rule to the VS Code logger, file/diff viewer, asset delivery, notifications,
and analytics handoff callbacks. Small interfaces/functions suffice; no DI framework.

Application-to-harness storage/lifecycle access already needed for orchestration
must use a narrow owner-exported interface, not reach into coordinator internals.
Move agent/backend JSONL and worker contracts to `harness/agent-processes/lib/rpc/`;
keep renderer commands/ViewState in `application/lib/protocol/`. Split mixed DTO
modules such as `extension/src/shared/protocol/sessions.ts` at the boundary:
backend capabilities must not import host-owned operation projections. Shared
JSON-safe shapes have one canonical definition, not mirrored declarations.

Analytics authority validation/supervision belongs in `analytics/authority/`;
application restart/drain and session handoff composition stays in
`application/backend/composition/` behind explicit ports. Do not move all
`analytics-*` filenames wholesale and introduce an analytics-to-application cycle.
Provider catalog/rate selection belongs in `harness/model-providers/pricing/`;
settlement accounting belongs in analytics. Pass captured rate snapshots and
facts across the boundary rather than making analytics import provider execution.

### 3.3 Lowest common owner, one implementation

- Share renderer-delivery and manifest code in `application/hosts/lib/`, not at
  repository root. Preserve independent per-renderer state and hub lifetimes.
- Place single-active-host coordination in a named module under `hosts/lib/`;
  it is shared hosting behavior, not a platform-contract declaration.
- All Pie-owned skill bundles stay together in `agent-instructions/skills/`,
  including tool-related skills. Python scripts, references, and assets move
  intact with their skill. They do not become tool implementation directories.
- Skill and tool policy are separate; orchestration/state/recovery remain one
  named `tool-and-skill-selection/` domain. Settings for that coordinator are
  named modules there, not a new independent settings authority.
- Root `lib/` is for demonstrated cross-root, low-level reuse. Named leaf modules
  such as error formatting or JSONL framing need not acquire an empty folder.
  Provider, prompt, analytics, and trigger policy do not become generic helpers.
- Prefer small named modules over layers of forwarding files. Temporary old-path
  exports must have a removal batch in the manifest. Permanent discovery shims
  are the explicit exception, not a pattern to apply to every moved source.

### 3.4 Behavior invariants

The current normative contracts remain authoritative. This plan is not a
replacement contract and does not loosen them. In particular preserve:

- Pure reducer, one effect-runner facade, reducer-owned operation lifecycle,
  explicitly addressed sessions/generations, and `Record`-based host collections.
- Passive renderer state, one logical projection, independent delivery/evidence
  state per renderer, and initiating-renderer routing for targeted responses.
- Existing JSONL limits, protocol versions, snapshot budgets, SDK patch identity,
  cold/hot transition fences, cancellation, and idempotent mutation semantics.
- Stable nine-tool catalog names and extension IDs. `session_control` remains
  backend-registered; `request_capability` remains a stateless injected adapter.
- One combined tool/skill prepass, one model call, one analytics observation and
  shared state module. Tool selection precedes skill-block rewriting because
  `setActiveTools` rebuilds the base prompt. Preserve `rebasePieToolPrompt`,
  `toolsRemain`, `toolPromptRefreshFailed` fail-open behavior, `recordKeptSkills`,
  and inherited skill state. Verify module identity through the discovered shim,
  not just policy-unit tests; duplicate bundles must not create duplicate state.
- History compaction, skill pruning, and tool-result pruning remain distinct.
- One manifest-selected analytics authority, exclusive legacy/canonical capture,
  fail-closed authority validation, existing privacy semantics and query bounds.
  No activation, dual capture across authorities, backfill, historical repricing,
  storage cutoff, or data cleanup is authorized by this migration.
- Deferred-trigger tool/registry separation and existing sidecar contract,
  including `PIE_TRIGGERS_DIR`, claims, and delivery semantics. Pure condition
  contracts have one tool-domain owner; the application owns its registry.
- Existing loopback default, explicit trusted-LAN opt-in, host priority/handoff,
  and protections. No internet authentication feature or new hardening project.

## 4. Concrete source-family mapping

These mappings resolve responsibility; B0 expands them into an exhaustive
file-level manifest. In these tables, **Backend** means `extension/src/backend/`;
`host/`, `webview/`, and `standalone/` source paths are relative to
`extension/src/`. Other source paths are repository-relative. A filename prefix
is not permission to sweep unrelated files into a target. Split rows below
require a small seam extraction first, with tests, followed by mechanical relocation.

### 4.1 Harness and shared contracts

| Current source | Target / disposition |
|---|---|
| `agents/*.md` | `harness/agent-instructions/agents/` |
| `skills/<name>/**` | `harness/agent-instructions/skills/<name>/**`, whole bundle |
| `tools/subagent/agents.ts` discovery logic | `harness/agent-instructions/agent-discovery/`; tool consumes loader |
| `extensions/cwd-skills/` implementation | `harness/agent-instructions/skill-discovery/`; root entry remains shim |
| `shared/pie-harness-prompt.ts`, backend `system-prompts.ts`, `context-files.ts` | `harness/agent-instructions/prompt-assembly/` |
| `tools/<tool>/**` | Corresponding `harness/tools/<tool>/`, preserving native sidecars and fixtures |
| `tools/index.ts`, catalog contracts | `harness/tools/catalog/`; backend factory composition stays at its execution owner |
| `extensions/skill-pruner/src/` | Shared lifecycle/prepass/recovery/state to `harness/tool-and-skill-selection/`; skill rules to `agent-instructions/skill-selection/`; tool rules to `tools/selection/` |
| `extensions/tool-result-pruner/` implementation | `harness/tools/result-processing/` |
| `extensions/safeguard/` implementation | `harness/tools/execution-safety/` |
| `extensions/image-context-guard/` implementation | `harness/model-providers/request-validation/`; outgoing-request projection, not durable transcript rewriting |
| `extensions/web-access-guard/` implementation | `harness/tools/package-integrations/web-access/`; preserve managed-package patching |
| `extensions/copilot-model-discovery/` implementation | `harness/model-providers/model-discovery/`; preserve refresh/codegen behavior and skip rules |
| Backend `mcp-config.ts` | `harness/tools/package-integrations/mcp/` |
| Backend `subagent-profiles.ts`, shared subagent context/policy | Named subagent/provider owners, not application shared code |
| Backend `index.ts`, `server*`, `request-handler*`, `coordinator-operations`, operation ledgers, extension-UI owner registry | `harness/agent-processes/coordinator/`; extract storage/provider responsibilities only at demonstrated seams |
| Backend `worker-entry`, `worker-runtime-*`, session-event adapters, turn accumulator, tool-progress, history-compaction adapter | `harness/agent-processes/workers/` |
| Backend `worker-protocol`, frame I/O, RPC DTOs/client plumbing | `harness/agent-processes/lib/rpc/` |
| Backend `worker-supervisor`, process-tree mechanics | `harness/agent-processes/lib/process-lifecycle/` |
| Backend `sdk*` and patch barriers | `harness/agent-processes/lib/sdk-integration/` |
| Backend `cold-browse-helper-*`, projection cache | `harness/agent-processes/cold-browse-helper/` |
| Backend `initial-context-estimate-*` | `harness/agent-processes/context-inventory/` |
| Backend transcript conversion/window/detail and durable browsing modules | `harness/session-storage/transcripts/`; application paging orchestration is separate |
| Backend session metadata/provenance/title persistence | `harness/session-storage/metadata/`; title request execution stays worker-side |
| Backend session catalog/index/directory | `harness/session-storage/catalog/` |
| Backend session ownership authority/manager fence | `harness/session-storage/ownership/` |
| Backend cold-session store, filesystem/session lifecycle, private-artifact cleanup | `harness/session-storage/lifecycle/`; ownership stays in coordinator process |
| Backend session settings, prompt-toggle and MCP-session artifacts | `harness/session-storage/settings/`; UI preference adapters stay application-owned |
| Backend auth/storage, provider gates/incidents/network policy/traffic observers/pricing | Respective `harness/model-providers/` concerns; process-specific IPC adapters stay process-owned |
| Root `shared/analytics/**`, legacy run-analytics contracts | `analytics/contracts/` (legacy contracts explicitly named) |
| Root shared prompt/pruned-skill/provider/subagent/trigger policies | Their named harness domains; never wholesale `lib/` |
| Root shared data-root/managed-package/redaction/temp-file helpers | Named root `lib/` concerns; migrate paired `.mjs`/`.d.mts` files together |
| Remaining root/extension shared helpers | Inspect callers and map individually; browser-safe leaves separated from runtime helpers |

At the inspected baseline there are nine git-tracked Pie skill bundles:
`add-provider`, `check-ui`, `codebase-maintenance`, `collaborative-development`,
`develop-pie`, `diagnose`, `grill-with-docs`, `pie-logs`, `query-analytics`.
Installed-package skills remain package-owned. The target does not authorize
inventing new Playwright/computer-use skill folders, copying third-party skills,
or splitting any Pie-owned tool skill that the execution inventory discovers.

### 4.2 Application and analytics

| Current source | Target / disposition |
|---|---|
| `host/runtime/host-runtime.ts` | `application/backend/composition/`, after extracting concrete-host construction |
| `host/core/` state/commands/events/reducer/effects/projection | `application/backend/conversation-state/` and named children |
| `host/session-service/` handlers, tab/message actions | `application/backend/session-actions/` |
| `host/backend/`, backend-ready/startup/runtime-preference adapters | `application/backend/agent-connection/` |
| Host transcript-window/helpers and detail retrieval/subscriptions | `application/backend/transcript-delivery/` |
| Host deferred-trigger registry/store | `application/backend/deferred-triggers/` |
| Host preference persistence and settings UI orchestration | `application/backend/settings/` |
| Host file-change derivation/file-diff service | `application/backend/file-changes/`; concrete editor viewer injected |
| Shared platform interfaces | `application/hosts/lib/platform-contracts/`, pure interfaces only |
| `host/renderers/**` plus sidebar sync/delivery/watchdog/readiness modules used by browser | `application/hosts/lib/renderer-delivery/` |
| `host/webview/published-generations.ts` and neutral asset-manifest reading | `application/hosts/lib/asset-manifests/` |
| `host/coordinator/host-coordinator.ts` | Named module in `application/hosts/lib/` |
| `host/browser-server/**` | Corresponding `application/hosts/browser/` concerns; retain one server implementation |
| `extension.ts`, `host/extension-host.ts`, VS Code commands/sidebar provider/editor integration | Corresponding `application/hosts/vscode/` concerns |
| `host/webview/assets.ts` (VS Code URI handling) | VS Code adapter, not shared manifest code |
| Sidebar completion-attention arbitration used by shared runtime | Application composition/state owner; actual notification/sound delivery is host/renderer-specific |
| `standalone/**` | `application/hosts/standalone/`; split CLI/start/stop along existing seams |
| `webview/panel/{transcript,composer,session-tabs}/` | Matching `application/frontend/` concerns |
| Remaining panel shell/context/system-prompts/file-change/stats/settings/style files | Matching frontend concerns; inspect shared components/hooks rather than bulk `lib/` |
| `webview/transport/**` | `application/frontend/transport/` |
| Renderer protocol/validation/browser ingress | `application/lib/{protocol,validation}/`; split away harness RPC types |
| `extension/src/analytics/` capture/usage/batch/tool-facet/execution-summary | `analytics/capture/` or `usage-accounting/` according to actual responsibility |
| Recorder supervisor/worker/SQLite recorder/lock retry | `analytics/recording/`; schema/storage mechanics can be named `analytics/storage/` modules |
| Query client/entries/workers; activity/provider projections | `analytics/queries/`, `analytics/projections/` |
| Activation store and authority-neutral validation/handoff machinery | `analytics/authority/` |
| Host analytics runtime/handoff/restart modules | Split analytics authority from application drain/session/host wiring; latter stays `application/backend/composition/` |
| Backend session-analytics/analytics-worker-transport | Harness producer adapters; consume analytics contracts |
| Host run-analytics, billable ledger/accounting, activity timeline, legacy timing/storage | `analytics/legacy/`; extract truly shared accounting helpers to `analytics/usage-accounting/` without merging authorities |
| Host stats-service and aggregate services | Split read/presentation adapter into `application/backend/analytics-views/` from legacy accounting/storage and canonical analytics services |
| `host/shared/checkpoint-*` used by analytics stores | `analytics/legacy/` storage owner, not application checkpoints just because currently under `host/` |
| Genuine application restore/checkpoint state | `application/backend/checkpoints/`; no folder needed if no standalone implementation remains |
| Root `analysis/**` tracked workspace | `analytics/analysis/**`, retaining its package/lock/tests/queries; do not relocate ignored data by directory move |

### 4.3 Tooling and documentation

| Current source | Target |
|---|---|
| `extension/scripts/{build,publication,runtime-publication,publish-renderer}*` | `scripts/build/` |
| Root bootstrap, dependency install, ensure-settings and existing install helpers | `scripts/install/` |
| Root test/typecheck/affected/fast runners, cost/reporting helpers | `scripts/verification/` |
| `scripts/sync-models.mjs` | `scripts/model-config/` |
| Root migration scripts | `scripts/migrations/`; relocation does not authorize running them |
| Root doctor family and analysis diagnostics | `scripts/diagnostics/` |
| Launcher supervisor | `application/hosts/standalone/startup/`; root launcher delegates to it |
| Script package registry, Git/subprocess/SDK-version helpers | `scripts/lib/`, still single authorities |
| `ARCHITECTURE.md`, state implementation mechanics, concise architecture overview | `docs/architecture/` |
| State/analytics/tool/session behavioral contracts | `docs/contracts/`; keep existing filenames where practical |
| MCP and setup/operational guidance | `docs/operations/` |
| Active browser/repository plans | `docs/plans/` |
| Navigation study, history, ideas, model research and rationale/evidence ledgers | `docs/research/`; retain evidence semantics and relative links |

Classify mixed documentation by its primary purpose, with links rather than
copies. Keep `docs/INDEX.md`, root `README.md`, and root `AGENTS.md` as entry
points. Update the moved develop-pie skill's relative links and the hardcoded
harness documentation paths in prompt assembly. Historical reports retain their
historical path examples; distinguish those from live navigation links.

## 5. Discovery, packages, and build contracts

These are compatibility details discovered after the responsibility tree, not
reasons to scatter implementations back into discovery/package directories.

### 5.1 Resource discovery

- Keep the repository root as Pie's agent/config directory. Do not point
  `PI_CODING_AGENT_DIR` at `harness/`; settings, models, auth and SDK conventions
  still resolve from the existing root.
- Register `harness/agent-instructions/skills` through the global `skills` array
  in both `settings.json` and `settings.defaults.json`, relative to the agent
  directory. Merge rather than overwrite existing paths, exclusions, or user
  selections. Remove the old tracked root skill bundles in that same batch.
- Authored prompt templates, when present, use
  `harness/agent-instructions/prompts` and the global `prompts` path array.
  These are templates, not automatic system-prompt additions. Do not create a
  fake prompt merely to make the folder exist.
- **Keep `APPEND_SYSTEM.md` at repository root.** The pinned SDK has a conventional
  special loader for it; moving it into template discovery changes semantics.
  Keep root `AGENTS.md` too. Neither is copied or additionally injected from the
  new prompts directory. This is the deliberate authored-content exception.
- Change Pie's user/global agent-definition loader to the new harness location;
  preserve generic project `agents/` walk-up and project-over-user precedence.
  Preserve generic cwd skill discovery, `.pi/` and `.agents/` rules, CLI paths,
  package resources, collision behavior, and reload semantics.
- Keep all root `extensions/<id>/index.ts` discovery entries and stable IDs.
  Move middleware implementations behind them too. Preserve enable/toggle
  behavior including `PIE_EXTENSION_TOGGLES_JSON`, order and hook registration.
- Verify discovery through the pinned SDK, not a simulated directory scan:
  ordinary load, reload, hot worker, cold inventory, and subagent paths must
  agree; explicitly assert no double instruction injection/duplicate skills.

Owning source anchors: pinned SDK `docs/{skills,settings,prompt-templates,
extensions}.md`, `dist/core/{package-manager,resource-loader}.js`, Pie
`tools/subagent/agents.ts`, `extensions/cwd-skills/index.ts`, backend resource
loading, and `shared/pie-harness-prompt.ts`. Re-read the installed pinned docs;
do not infer behavior from newer upstream Pi versions.

### 5.2 Package/dependency ownership

Use the existing package model, not npm workspaces or one package per domain:

| Owner | Target |
|---|---|
| Root orchestration package/lock | Repository root, unchanged identity |
| Existing extension manifest, lock, SDK/build/test dependencies | `application/hosts/vscode/` |
| Extension tsconfig, Vite, ESLint, Playwright and VSIX configs | Same package home, with explicit repository source/test roots |
| Native/browser dependency manifests and lockfiles | Existing `extensions/computer-use/` and `extensions/playwright/` |
| Analysis package and lock | `analytics/analysis/` |
| Tool/middleware TS/package metadata without independent installs | Respective implementation owner; registration/test identity remains explicit |

The VS Code directory remains a **toolchain/distribution owner**, not the owner
of all code it compiles. Move its manifest and lock together. Preserve package
name/publisher/version, engines, locked dependency graph, SDK nested `pi-ai`
identity and overrides. No version refresh, lockfile churn, workspace activation,
new global wrappers, or moving installed `node_modules` by hand.

**Resolution prerequisite:** source in `harness/`, `analytics/`, or application
siblings cannot naturally resolve all dependencies inside
`application/hosts/vscode/node_modules`. Before moving code, centralize explicit
owner-relative resolution for TypeScript, Vite, the registry's `tsx` configs,
and any unbundled Node/Jiti runtime path that needs it. Include type roots,
Preact JSX/subpath imports, nested SDK aliases and both Pi package-name spellings.
Use owner-based `createRequire`/resolved paths where runtime loading requires
it; TS aliases alone are not a runtime solution. Native tool sidecars continue
to resolve their own dependencies from their existing owners.

Prove representative imports from each future source root using the actual
compiler, bundler, test runner, and SDK extension loader before the first large
move. If that cannot be made reliable with the existing dependency owners, stop
and propose a separate dependency-ownership decision. Do not silently migrate
all dependencies into the root lockfile or install duplicate SDKs as a workaround.

### 5.3 Runtime assets and paths

- Preserve `main: ./runtime/bootstrap.cjs` and the installed package's relative
  `runtime/`, `out/`, `media/`, and `pie-runtime/` contracts. For this reason the
  target's loader concern uses checked-in `application/hosts/vscode/runtime/`,
  rather than the sketch's `runtime-loader/`. One canonical source, no symlink
  or duplicated loader tree and no new staging layer just for that rename.
- Generated build output belongs at `application/hosts/vscode/out/`. Preserve
  flat named bundle entries: extension, standalone, backend, worker-entry,
  analytics recorder/query workers, cold-browse helper, context-inventory worker,
  and the existing phase4 test extension. Preserve their emitted names and spawn
  resolution rather than coupling emitted names to source folders.
- Keep renderer output shape `out/webview/panel/.vite/manifest.json`, hashed
  chunks, worker URLs, and `/assets/` serving. Give shared source assets one
  hosts-level owner and stage package-relative assets where consumers expect them.
- Extend deterministic build-identity inputs and watch coverage to all relocated
  runtime source roots, shared sources, relevant configs and locks. Do not
  recursively scan dependencies, generated output, caches or data. Both build
  graphs must still agree on one identity and rebuild when an input changes.
- Preserve immutable runtime publication, leases, current/prior retention,
  installed folder/manifest/version validation, and renderer publication.
  No build may overwrite a loaded worker/host bundle or force a restart.
- Update package filters and tests so a VSIX actually contains all required
  loader, media, node entries/chunks and renderer assets. A compiling checkout
  with missing packaged resources is not a successful migration.
- Replace source-depth assumptions with explicit root seams: in particular
  `agent-dir-resolution.ts` currently assumes `extensionPath/..` is the repo.
  Keep configured agent-dir and environment precedence; preserve installed vs
  checkout resolution. Never use the user's current cwd as a universal fallback.
- Update root wrappers, installer, supervisor, SDK-version reader, doctor,
  native `dependency-owner.mjs`, config helpers, editor launch/tasks, ignore
  rules, test-impact registry, build fixtures and documentation together.
  Root npm command names and existing `--package` IDs remain stable.

## 6. Tests and architectural enforcement

- Unit/component tests move with the responsibility they test, generally to
  `<owner>/test/`. Cross-boundary suites go to root `test/integration/`; shared
  fixtures/helpers go to root `test/{fixtures,helpers}/` only when truly shared.
  Browser/perf/live suites retain their explicit opt-in classification.
- Do not blindly rename every old `extension/test/integration` test into the
  root integration group: inspect what it tests. Preserve behavior/coverage,
  skipped/live status, and explicit runner selection.
- Extend the existing `scripts/lib/test-packages.mjs` registry to support the
  distributed test roots and moved source ownership. It remains the only
  package/test/typecheck routing authority. Preserve IDs such as `extension`,
  `skill-pruner`, `subagent`, `analysis` and their aliases; logical verification
  groups need not be npm packages or correspond to one directory.
- Record baseline test enumeration and compare through the move manifest. Every
  existing test must be mapped, deliberately superseded with equivalent coverage,
  or explicitly retained; no suite silently disappears or runs twice.
- Update affected-test routing, coverage include/exclude roots, eslint scope,
  tsconfig includes, batching, fixture URLs and cwd assumptions. Test both changed
  and untracked new files, source renames/deletions, and cross-owner consumers.
  Unknown ownership must broaden verification, not select zero tests.
- Add focused architecture checks for forbidden import directions, browser-safe
  protocol closure, root extension shim destinations, stable tool registration,
  one canonical shared selector state, and no live imports of retired roots.
  Cover `.mjs`/`.cjs`, dynamic entry paths and package-owned resolution where
  applicable, not just static TypeScript imports.
- Inventory checks must fail for unmapped files and unregistered test/source
  roots. Named compatibility exceptions are an allowlist, not a broad exclusion
  of `extensions/` or all `shared` code from validation.

Use repository wrappers, not ad hoc `npx tsx`. Windows command-line length is a
known risk for broad test runs; preserve/adapt bounded file batching and verify
that the aggregate run actually covers its enumerated files. `spawn ENAMETOOLONG`
is a failure, not a passing suite. Any runner fix should be its own small change.

## 7. Execution batches

Each row is a milestone, **not one huge commit**. Split it into coherent smaller
patches where needed. Keep imports, tests, dynamic paths and live documentation
working at each checkpoint. Avoid moving source and redesigning its behavior in
the same patch. Temporary forwarding imports are allowed only with an explicit
removal owner/batch; none may duplicate state or implementation.

### B0. Baseline, inventory and migration manifest

- Inspect Git status; preserve pending documentation/user changes. If a branch
  switch is unsafe, ask rather than stashing/discarding. Use the primary checkout,
  not a worktree. Do not assume this planning handoff was committed.
- Enumerate tracked files with Git and relevant untracked source with scoped,
  Git-aware tools. Never traverse/move dependency, runtime-data or output trees.
- Create `docs/plans/repository-organization-migration-manifest.json` with one
  record per in-scope source/test/config/document: `source`, `targets`,
  `action` (`move`, `split`, `retain`, `consolidate`), `owner`, `batch`,
  `verification`, and `reason`. For splits identify symbols/responsibilities;
  consolidation records the surviving implementation. All untouched tracked
  roots receive explicit retain dispositions, not an accidental omission.
- Record the exact baseline commit, dirty-file disposition, test enumeration,
  package/lock owners, emitted entry/asset list, and runtime/discovery IDs.
- Run baseline model drift, typecheck, lint, full fast tests and non-publishing
  build; record pre-existing failures separately. Do not overwrite them with
  target-layout expectations.

**Exit:** exhaustive, no-collision manifest; every source has a named owner;
no runtime-data/generated subtree is queued for a move; discrepancies from the
inspected snapshot are resolved. Store execution evidence in a short sibling
`repository-organization-migration-progress.md`, not in temporary logs in source.

### B1. Prepare resolution, test routing and boundary seams

- Centralize package/config root resolution, update registry schema for multiple
  source/test roots, and add drift/coverage-of-inventory checks. Keep current
  paths operational while accepting planned paths.
- Prove future-root SDK, JSX, bundle, unbundled runtime and test resolution using
  small temporary fixtures under an OS temp directory; delete fixtures afterward.
- Establish the inert harness RPC vs renderer protocol boundary and host adapter
  ports required by §3. Separate these seam extractions from relocation diffs.
- Add regression assertions for selector lifecycle/order/state identity and
  resource discovery before their migration. Do not duplicate implementations.

**Exit:** old layout remains green; future roots have demonstrated dependency
resolution; affected/full test enumeration and boundary checks are trustworthy.

### B2. Relocate the distribution/toolchain shell and build orchestration

- Move only extension package/lock/configs/runtime assets to
  `application/hosts/vscode/`, and build helpers to `scripts/build/`. Existing
  `extension/src` and tests may remain temporarily at explicit old paths.
- Update scripts/installers/doctor/SDK root readers, native dependency-owner
  paths, package registry, output/launcher paths, compile entries and ignores.
- Use locked installs at new package owners. Do not move live dependency trees,
  revise dependency versions, activate a loader, or restart an installed host.
- Preserve installed main/asset/output contracts and verify packaged contents.

**Exit:** old source builds and tests using the new toolchain home; isolated
SDK/runtime resolution works; non-publishing build and VSIX inspection pass;
root command names and standalone launcher tests still work.

### B3. Move authored resources and their discovery loaders

- Move skills and agents intact; extract/move agent and skill discovery and
  prompt assembly. Update settings arrays and all loader/prompt/document links
  atomically with the resource moves. Root APPEND_SYSTEM/AGENTS remain.
- Update global-agent fixtures without changing generic project-directory rules.
- Verify real SDK load/reload, global/project precedence and exclusions, tool
  package resources, cold inventory, hot worker and subagent discovery.

**Exit:** identical logical resource catalog/precedence; no double prompt injection,
no skill bundle fragmentation, and fresh/reloaded processes see the new paths.

### B4. Move tools, middleware and the shared selector

- Move one tool at a time behind its unchanged root extension shim; update catalog
  source paths, TS/runtime configs, native sidecar entries and local tests.
- Move middleware to its named domains. Extract tool and skill policies from
  `skill-pruner` while preserving one orchestration/state/recovery authority.
- Keep backend registration and injected ports for session control/capability
  recovery. Keep native/browser dependency owners at their existing locations.

**Exit:** nine-tool catalog/IDs and toggles preserved; actual discovery invokes
one hook/prepass and shared state; selector ordering/recovery tests pass; sidecar
resolution/protocol/cleanup fixtures work without visible desktop control.

### B5. Move harness storage, providers and execution code

- Migrate storage/settings and provider policy as separate sub-batches, then
  process transport/SDK seams, helper processes, coordinator and workers.
- Keep coordinator/worker composition explicit. Extract mixed responsibilities
  from `server.ts`/`worker-runtime-host.ts` only as needed for target ownership;
  no size-driven rewrite or new execution mode.
- Move remaining harness-owned shared modules and paired runtime/type helpers.
  Keep analytics producer adapters at their execution owners.

**Exit:** cold browse/inventory, promotion, write ownership, replacement, provider
admission/cancellation, operation lineage, SDK patches and helper-entry tests
pass; no harness dependency on application implementation remains.

### B6. Move analytics and the retained analysis workspace

- Move analytics contracts/core/recorder/query/projection code. Separate authority
  mechanics from host restart/session-drain glue through the prepared ports.
- Separate stats presentation adapters from legacy accounting/storage. Preserve
  canonical and legacy state/authority boundaries; do not consolidate stores.
- Move tracked DuckDB workspace files and its package/lock to `analytics/analysis/`;
  update wrappers and explicit source resolution without moving existing data.

**Exit:** capture/query/authority/privacy/legacy-accounting tests and isolated
analysis fixtures pass; no active authority/config/data is changed; source moves
cannot silently redirect a query to a different durable data root.

### B7. Move application backend, hosting and frontend

- Move state/reducer/effect/session-action families in small slices.
- Extract shared renderer-delivery and manifest reading from sidebar code first;
  then move browser/VS Code/standalone adapters. Construct adapters outside the
  shared backend and inject ports; retain one shared lifecycle implementation.
- Move frontend by concern, with its component tests/styles/assets; retain
  browser-safe protocol imports and the same emitted renderer contract.
- Relocate integration tests and fixtures with explicit registry ownership.

**Exit:** state/sync/operation tests, independent-renderer delivery, browser ingress
and LAN policy, single-host arbitration, standalone start/stop and packaging
fixtures pass. No VS Code dependency leaks into standalone/shared backend;
no UI implementation is duplicated between hosts.

### B8. Finish tooling, documentation and retired-path removal

- Complete scripts grouping, local test relocation and remaining low-level helper
  placement. Move documentation to its categories and update every live link,
  index, instruction, example, fixture, script wrapper and editor configuration.
- Move this plan and progress/manifest links together. Update repository maps and
  the develop-pie skill. Keep the navigation-study report historical, not a claim
  of validated migration or benchmark superiority.
- Remove temporary compatibility exports and tracked retired roots
  `extension/`, `tools/`, `shared/`, `agents/`, `skills/`, `analysis/` only after
  manifest coverage and reference checks pass. `extensions/` intentionally stays.
  Ignored data/dependencies under an old directory are not authorization to delete
  or move that whole directory; report leftovers separately.

**Exit:** every manifest record settled; no unexplained live old-path references;
all tests remain discoverable; final checks below pass or are explicitly blocked.

## 8. Verification, rollback and completion

### Required verification

Use focused checks per batch, then the final broad gate. Keep root commands stable:

```text
npm run sync-models -- --check
npm run typecheck
npm run lint
npm run test:all
npm run extension:build:validate
npm run extension:package
```

Also run registry/affected-test selection checks, real resource-discovery/reload
fixtures, moved analysis/tool suites, and automated browser/standalone coverage
with temporary config/data roots. `test:all` is not evidence that opt-in browser,
perf, provider-paid, native-input or live-installation tests ran. Preserve existing
coverage configuration; use the release coverage gate only if this migration is
being qualified for release. Record skipped/unavailable gates and their impact.

Inspect the produced VSIX and exercise packaged-entry resolution in isolation;
source-only typechecking is insufficient. Test build/watch identity changes
across harness, shared contracts, backend, frontend and analytics roots. Test
startup-loader fallback/leases using fixtures, not by interrupting a live host.

Follow the develop-pie build/staging requirement when applicable, but distinguish
non-publishing validation, staged output, loaded runtime, and verified behavior.
Do not force restart, reinstall, activate a loader, run storage migrations,
change analytics authority, or use visible desktop-control tools as part of
routine validation. Live checks requiring user interaction/credentials or a
host handoff need an explicit coordinated window; disclose them if deferred.

### Rollback

- Make reviewable checkpoints according to the user's Git workflow; do not
  commit/push unrelated changes or assume permission to publish a branch.
- Roll back the failing code batch together with its registry/config/loader
  changes using a reviewed revert or preserved diff. Do not use destructive
  reset/clean against pre-existing or unknown changes.
- Source-only migration must not require rollback of runtime data. If a batch
  proposes such a change, it has exceeded this plan.
- Preserve installed immutable runtimes/leases. Source rollback is not a reason
  to delete an active generation or restart a live host.

### Definition of done

- Target ownership is reflected in source and tests, with one implementation per
  responsibility and only the documented discovery/packaging exceptions.
- Harness/application/analytics boundaries are enforced; no catch-all hides an
  unresolved owner or a duplicate mutable authority.
- Runtime/tool/resource identities, protocol/storage behavior and dependency
  versions are unchanged; all user-owned configuration fields are preserved.
- Build, package, install-path, SDK discovery/reload, test routing and documentation
  checks account for the new paths. Final results identify any unverified live gate.
- The manifest and progress record explain retained exceptions and any deferred
  work. Remove/archive the completed active plan according to `docs/INDEX.md`,
  retaining durable architectural rules in architecture documentation.

## 9. Evidence and limits

The [navigation study](../research/repository-organization-navigation-study-2026-09-24.md)
provided qualitative input from 25 synthetic navigation/placement probes. It did
not execute source code or validate a migration, and contained recorded negative
outcomes/protocol exceptions. Do not turn it into a speed ranking or success-rate
claim. The user subsequently accepted the responsibility tree; the source and
loader/build assessments used for this handoff do not replace B0/B1 verification.

Authoritative behavior references before relocation:
[architecture](../architecture/ARCHITECTURE.md), [state contract](../contracts/STATE_CONTRACT.md),
[analytics/storage contract](../contracts/ANALYTICS_IMPLEMENTATION_CONTRACT.md),
[tool catalog](../../harness/tools/README.md), and the pinned SDK docs referenced in §5.
