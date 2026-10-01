# Pie productization: runtime ownership, providers and sessions

**Working document. Updated 2026-10-01.** Use this as the single discussion and planning authority for this initiative. Implementation is authorized; this is not an implemented contract. Deployment must be noninterrupting and respect the active manager session.

## How to use this document

- Grill the current direction, resolve open questions and revise the proposal here rather than creating parallel research or plan documents.
- Distinguish observed evidence, proposed behavior, decisions and completed implementation. Record consequential decisions with their reason and date.
- Keep the next exercise bounded and state its acceptance gate before implementation. Move settled runtime requirements into their owning contracts when implemented, linking rather than duplicating them here.
- Preserve the isolated experiment and its executable evidence. Do not treat passing fixture tests as production compatibility or a performance improvement.

## Current direction and status

**Decision (2026-10-01):** fully migrate Pi runtime source ownership into Pie from upstream **0.80.6**, as one coherent, versioned dependency, rather than fork one package and install the remaining Pi packages from npm. Build the required Pi packages locally from this single baseline; ordinary third-party dependencies can still come from npm. The selected destination is the complete staged migration through parity, delivery and deliberate cutover—not a source-only spike as the entire scope.

**Current implementation status (2026-10-01):** The user authorized full package-to-source migration from Pi 0.80.6 into `harness/pi/` and accepts retaining the license notice after explanation. The pristine upstream subtree is committed as `44caef3a15f1cba7d6e23c1333fa87fcdcb4e42f` (subtree squash commit `f7979c415246a6562b0c25e579a9ac9c53714949`); its Git tree `f9837ef1ebcd94df34dfcea70121e05db3f36a28` exactly matches the tree at upstream tag commit `2b3fda9921b5590f285165287bd442a25817f17b`. The MIT notice, including `Copyright (c) 2025 Mario Zechner`, is retained verbatim. The source import is separate from all semantic ports.

The primary manager session coordinates bounded child work and is the sole Git owner after import. Keep at most three child sessions open at once and close each after its handoff. New child sessions use `openai-codex/gpt-6.1-sol`, delegate bounded implementation/review to subagents, and send concise completion/blocker handoffs; keep detailed evidence in child context. The private pristine-build proof and read-only migration audit are complete: all four core packages compile without source edits, and offline SDK imports resolve to that source graph. The first semantic port (retry classification and durable terminal-event ordering) passes isolated source-runtime tests; the standard test wrapper now supports explicit candidate selection at `be9c32fb`. The artifact verifier, nonpublishing build-output isolation and materialized Windows x64 runtime builder are implemented and tested. Single-read open and exclusive fsynced v3 cold-header creation are ported at `6b6a5378`; isolated native source tests pass together with terminal tests (24 cases). The same 24 cases now pass the sanitized, network-denied `test:file --sdk-path harness/pi/packages/coding-agent` route. A complete isolated source-bound Pie build passes at `93a7f6fa`, including copied-artifact verification and SDK/TypeBox graph selection. Typed ownership/replacement source implementation and generation-contained startup design are in progress. **Do not interrupt the active manager session.** The user allows noninterrupting deployment, but current manager policy forbids mutating the active SDK or publishing/restarting hosts; safe immutable staging will be evaluated later. No runtime switch, runtime installation, parity proof or deployment has occurred.

**Source ownership and modification scope are separate.** Importing all Pi source does not mean rewriting every package. Preserve upstream structure and concentrate Pie changes where required for existing behavior. Do not flatten the source into unrelated Pie files or replace the agent engine at the same time.

There are three related but independent workstreams:

| Workstream | Intended outcome | Current state |
| --- | --- | --- |
| Runtime source ownership | Make core changes in typed source, not installed-file transformations and private-method patches. | Full Pi 0.80.6 migration authorized on `feat/pi-source-0.80.6`; pristine subtree import committed at `44caef3a`. Private pristine-build/import proof and the read-only audit are complete. Terminal durability/retry ports, artifact verification and Windows x64 materialization pass focused checks; consumer integration and further semantic ports remain. No runtime switch or deployment; full parity is unproved. |
| Provider/model management | Users connect accounts/endpoints and manage models without editing the checkout. | Research/proposal only. No new setup flow or migration implemented. |
| Session responsiveness | Ordinary browsing does not wait on avoidable runtime/inventory initialization. | Retained logs inspected. Controlled deferred-inventory experiment and live UI verification not performed. |

The all-source proposal supersedes the initial recommendation to fork only `pi-coding-agent` while installing upstream `pi-ai`/`pi-agent-core`. The compatibility spike argues against a wholesale switch to `AgentHarness`.

### Boundaries

- No initial session-format change, agent-engine rewrite or general extension-runtime replacement.
- No unrelated migration of all settings, analytics or storage.
- No automatic model downloads, inference probes, default changes or agent-pool enrollment.
- Copying Pi does not itself fix session latency or turn provider listing into capability/account-entitlement evidence.

## Evidence and implications

### Model setup is source-maintenance work today

The supplied [model-addition session](../../data/outcomes/sessions/2026-09-30T04-01-40-462Z_01a0f079-aa6e-7ce4-ac03-73a61faa47b1.jsonl) took about **4 minutes 44 seconds** from one request to the final response. Adding one model required schema inspection, repeated metadata research, provider-qualified edits, generation and verification.

- The user said OpenAI, but the configured route was `openai-codex`, not direct OpenAI API access. Credentials, access and billing differ.
- [`models.yaml`](../../models.yaml) combines connections, capabilities, pricing and selection policy. Synchronization generates several surfaces; Copilot discovery also writes the source catalog.
- [`models.schema.json`](../../models.schema.json) requires pricing/policy metadata even though the [pricing core](../../harness/model-providers/pricing/pricing-core.ts) distinguishes unknown from genuine zero.
- Duplicate model IDs across providers require provider-qualified identity. The [catalog projection](../../harness/model-providers/catalog/model-catalog.ts) also joins registry models to generated agent profiles; replacing the picker list alone is insufficient.
- Existing Copilot discovery has TTL, locking and rollback machinery worth reusing. Its parser requires prices, and its availability persistence precedes the catalog transaction, so rollback is not a complete restoration of the previous availability view.

Most of this friction is Pie-owned. Provider productization can proceed independently of source ownership.

### Pie already changes Pi's core semantics

The [SDK patch barrier](../../harness/agent-processes/lib/sdk-integration/sdk-patch-barrier.ts) has exact-version/fingerprint checks, process locking and worker validation. Those safeguards are deliberate, but the arrangement carries source-level maintenance responsibilities without source-level editing.

Existing changes include persistence-before-terminal-event ordering and stable entry IDs; malformed response/retry classification; durable creation and write ownership; single-read opening and session replacement; interrupted continuation, overflow-context reconstruction and history-compaction scheduling/customization. The retry delta touches `pi-ai`, not only coding-agent. Prototype changes in [`sdk.ts`](../../harness/agent-processes/lib/sdk-integration/sdk.ts) depend on private runtime methods.

Owning source makes these changes normal code and tests. It does not remove responsibility for upstream integration, provider/OAuth churn, build tooling or release verification.

### Recorded session-open delay is not just JSONL loading

Retained timing records from September 28–30 showed:

| Recorded stage | Samples | Median | 95th percentile |
| --- | ---: | ---: | ---: |
| Session-open handler acknowledgement readiness | 24 | 6.06 s | 9.69 s |
| Cold browse helper open | 45 | 29 ms | 316 ms |
| Initial-context inventory discovery total, where present | 60 | 6.25 s | 14.56 s |

These are different populations, not additive stage medians or a controlled benchmark. They describe recorded running generations, not proof the latest checkout was loaded, and do not measure renderer completion. Source logs were `%TEMP%/pie-logs/pie.log` and `.1`; those rotate, so the summary is retained here.

For coordinator PID 23196, request `req-226`, September 28 at 02:26:53–02:27:00: initial cold open **2.65 ms**, inventory response **6,452.81 ms** plus guardian startup **719.37 ms**, final cold open **7.81 ms**, handler acknowledgement **7,224.23 ms**.

At inspection, [`buildSessionOpenedPayload`](../../harness/agent-processes/coordinator/server.ts) awaited fresh inventory between initial and final cold snapshots. Non-empty cold sessions also requested inventory; only inclusion of the empty-session estimate depended on emptiness. The [inventory worker](../../harness/agent-processes/context-inventory/initial-context-estimate-worker.ts) constructs an in-memory runtime, loads resources and binds extensions. The [client](../../harness/agent-processes/context-inventory/initial-context-estimate-client.ts) serializes discoveries and retires each worker; prewarming imports SDK code rather than caching a completed inventory. Its recorded setup-stage median was 4.12 s and import/preload median 1.48 s.

This strongly implicates awaited inventory in some slow opens. Pie owns the orchestration; Pi contributes the expensive initialization. Genuine Pi costs remain: synchronous persistence, whole-file loading and a double-read already reduced to one by Pie's patch. Pie's catalog/index normally avoids Pi's expensive full-session listing fallback. Async interfaces alone do not guarantee fast browsing.

## Completed compatibility experiment

The isolated clone is `C:/dev/repos/pie-runtime-experiment`, branch `experiment/agent-harness-compatibility`, starting at committed revision `2ed0005339fe5f91536383350d2cca8e40c7a7fb`. It excludes the main checkout's concurrent uncommitted work and privately installs the locked Pi 0.80.6 dependency graph.

Nine offline probes and the owning typecheck passed. Some probes deliberately assert incompatibilities:

| Area | Demonstrated | Limit |
| --- | --- | --- |
| Execution | Mocked provider/auth, real Pie `session_control` through a small context adapter, tool round trip and cancellation. | No live protocol, backend, OAuth or discovery validation. |
| Event ordering | A gated async assistant append keeps `message_end` unpublished until completion. | Not crash-durable storage or production I/O stress. |
| Extension hook | The real safeguard handler blocks a synthetic write before stub execution through a minimal registration/context bridge. | Headless single-hook adapter, not general discovery, UI, commands or extension-runner parity. |
| History | Shared message/model/thinking fields and tested compacted-history context match legacy v3 fixtures. | Core adds active-tool state; custom entries, nested summaries and old-version migration are not exhaustively covered. |
| Branch persistence | Live branch context matches, but core writes a `leaf` record that legacy reopening does not interpret as a selected-leaf target. | Shared v3 headers do not establish storage interoperability; migration or an adapter would be necessary. |
| Ownership seam | Injected async storage rejects a simulated stale append before committing it. | Not proof of Pie's production lease/crash/concurrent-writer guarantees. |

Public `AgentHarness` has no direct zero-prompt continuation method or coding-agent-style session replacement runtime. Its public custom-compaction hook is useful, but idle-only `compact()` and default preparation do not cover Pie's proactive scheduling. Those latter conclusions include source inspection, not execution of every compaction path. These gaps make wholesale migration a larger project than source-owning the current runtime.

Executable evidence remains in the clone's `agent-harness-execution-experiment.test.ts` and `agent-harness-session-experiment.test.ts` under `harness/agent-processes/lib/sdk-integration/test/`. Reproduce **from the clone**, without deploying:

```bash
npm run test:file -- harness/agent-processes/lib/sdk-integration/test/agent-harness-execution-experiment.test.ts harness/agent-processes/lib/sdk-integration/test/agent-harness-session-experiment.test.ts
npm --prefix application/hosts/vscode run typecheck:agent-processes-sdk-integration
```

### Isolation for further work

The restrictions above describe the completed AgentHarness compatibility experiment in its clone, not the now-authorized source migration. Migration work is on `feat/pi-source-0.80.6`; candidate checks use private artifacts. The pristine-build proof made no tracked-source edits; subsequent semantic ports deliberately change owned source files. Current manager policy forbids mutating the active SDK or publishing/restarting hosts. Evaluate safe immutable staging later, without interrupting the active manager session. The completed probes used in-memory credentials/providers and network-denied execution tests; no real session operation or deployment occurred.

The clone baseline may now lag active development. Select a later committed baseline explicitly before porting current fixes; do not copy another agent's partially edited checkout indiscriminately.

## Proposed design

### Runtime source ownership

1. Keep the imported Pi source tied to an exact upstream revision with provenance, license, useful upstream tests and original package boundaries intact.
2. Build the required Pi runtime packages locally as one matched set. Target no published Pi runtime packages in the shipped graph; retain ordinary third-party npm dependencies. Avoid competing package identities/schema registries in workers, tools and extensions.
3. Port existing transforms/prototype behavior into source with parity tests, one semantic change at a time. Preserve SDK-facing APIs, history format, ownership, event ordering, continuation and runtime replacement initially.
4. Remove startup mutation/prototype patches only when local source supplies their behavior. Preserve runtime identity verification and immutable deployment safeguards that remain useful.
5. Keep a reviewable delta against upstream and deliberately integrate fixes. Decide update ownership/cadence rather than treating the import as a one-time untraceable copy.

Pi's [0.80.6 MIT license](https://github.com/earendil-works/pi/blob/v0.80.6/LICENSE) permits modification/commercial distribution with notices preserved. Dependency notices and provider OAuth/subscription terms are separate obligations. Build/release maintenance broadens even if behavioral changes stay narrow; no credible duration estimate follows from the initial spike.

### Migration planning context: 2026-10-01

**Initial planning record (2026-10-01):** the user selected a **full migration to Pi 0.80.6 source inside Pie**, rather than a separate fork repository or a limited compatibility spike as the final scope. The migration branch is `feat/pi-source-0.80.6`, created from pre-migration checkpoint `11afa12952495ec3bb1261d61bd5e9df668b2485`. At that point, directory, import method, build layout and implementation authorization were unresolved. The later authorization and completed subtree import supersede those status details; see the current status above and implementation readiness below.

**Historical authorization at initial planning:** preparation only was authorized then. This is superseded: full implementation is now authorized, with current noninterrupting-deployment restrictions stated above.

#### What the migration actually replaces

Checkout inspection on October 1, not evidence of the currently loaded runtime:

- The [host manifest](../../application/hosts/vscode/package.json) declares `@earendil-works/pi-coding-agent` as `^0.80.6`; its lock pins **0.80.6**. Installed coding-agent and its nested `pi-ai`, `pi-agent-core` and `pi-tui` are all 0.80.6. These four packages are the initial build-set candidate, not a reason to ship every upstream application. Keep upstream source boundaries; verify build-time dependencies before finalizing the set.
- The [root installer](../../scripts/install/install-dependencies.mjs) manages separate dependency roots; the root currently disables npm workspaces. “Put source in Pie” does not automatically mean “convert all Pie packages to a monorepo workspace.” Decide the smallest local build/linking arrangement explicitly.
- The [computer-use lock](../../extensions/computer-use/package-lock.json) independently resolves Pi 0.82.0 through non-optional peers. This does **not** establish that production uses that copy. Playwright's Pi peers are optional. Audit extension/sidecar/test resolution as well as the backend; changing only the host lock cannot establish one runtime graph.
- The patch barrier accepts specific 0.80.6 source fingerprints and mutates coding-agent session/runtime files plus `pi-ai` retry code. [`sdk.ts`](../../harness/agent-processes/lib/sdk-integration/sdk.ts) additionally patches private methods in memory and can import private compaction paths. Repointing the SDK path at a fresh source build is not a complete migration.
- [SDK version helpers](../../scripts/lib/sdk-version.mjs), bootstrap and doctor assume a published package/version. [Package resolution](../../scripts/lib/package-resolution.mjs) also owns current/legacy aliases and nested Pi/TypeBox identity. These assumptions need explicit replacements, not just different dependency names.
- The [build](../../scripts/build/build.mjs) writes an absolute checkout SDK path into `out/sdk-local-path.json`. [Startup](../../application/backend/agent-connection/startup.ts) accepts explicit SDK paths and has local/global resolution alternatives. VSIX packaging uses `--no-dependencies` and its [inclusion rules](../../application/hosts/vscode/.vscodeignore) do not ship the installed SDK tree. Source ownership therefore needs a distribution plan, not merely a local build that happens to work.

This inventory was recorded while the checkout had substantial concurrent uncommitted work, including SDK integration changes. At the user's explicit request, all pending Pie changes were checkpointed and pushed as `11afa129` before creating the migration branch. Use that committed Pie baseline when reconciling the required patch delta; do not substitute the older experimental clone's source snapshot.

#### In-tree import choices considered

| Mechanism | Benefit | Cost / question |
| --- | --- | --- |
| Git subtree-style import | One checkout and atomic Pie/runtime changes; upstream merges retain an explicit source boundary. | **Selected at `harness/pi/`.** Validate the repeatable upstream update/conflict workflow. |
| Tracked source snapshot with exact provenance | Simple checkout and no extra Git tooling for ordinary development. | Updates need an explicit three-way baseline/delta process; replacing a directory from a tarball must not erase local changes or make their history opaque. |
| Submodule or separately released fork | Separate upstream history or artifact release boundary. | Not the selected direction: adds separate-repository commits/initialization or publishing before Pie can consume changes. Revisit only if in-tree maintenance proves unsuitable. |

**Decision and completed import:** use a Git subtree-style import at `harness/pi/`, preserving upstream layout, license and useful tests. The pristine 0.80.6 import is committed as `44caef3a15f1cba7d6e23c1333fa87fcdcb4e42f` from squash commit `f7979c415246a6562b0c25e579a9ac9c53714949`; tree `f9837ef1ebcd94df34dfcea70121e05db3f36a28` matches the tree at upstream tag commit `2b3fda9921b5590f285165287bd442a25817f17b`. This replaces the earlier `vendor/pi/` location proposal. Importing source does not require building/shipping unrelated upstream frontends or changing Pie's application architecture.

Keep the clean upstream import and each Pie semantic change reviewable separately. Record the upstream URL, exact commit/tag, import method, local change rationale and retained test commands. The selected source baseline is Pi **0.80.6**, tag commit `2b3fda9921b5590f285165287bd442a25817f17b` (see the dated comparison below). Newer-release research remains historical rationale for this choice, not an open baseline selection or a request to reconsider the target absent new evidence.

Preserve the four public Pi package names and existing SDK imports while making installation resolve them to the local matched set. Renaming every import is a separate cost, not a prerequisite for ownership. Confirm that package manifests, shrinkwraps, export maps, extension loading and build aliases cannot pull an upstream Pi package back into the shipped graph. Avoid maintaining two editable copies of source or generated `dist` code.

**Selected artifact direction:** materialize the four core packages, ordinary dependencies, assets and notices at `<generation>/out/pi-runtime/{manifest.json,node_modules/}`, without workspace symlinks. The SDK package is `pi-runtime/node_modules/@earendil-works/pi-coding-agent`; its `dist/cli.js` supplies the local CLI. Production hosts must verify and use their generation's artifact, not fall back to registry/global/cached Pi. An explicit development override must identify another verified artifact. Keep old complete generations for rollback. The artifact manifest binds upstream provenance, source and lock fingerprints, target platform/architecture/Node ABI, package hashes and payload hash; the containing generation also hashes it.

Keep the imported upstream lock as build-tool authority and a dedicated `harness/pi-runtime` lock as runtime-dependency authority. The selected runtime install mechanism uses deterministic manifest-only local tarballs, derived from upstream metadata without shrinkwrap/lifecycle scripts. A private prototype verified that sibling resolution stays local and ordinary source edits do not refresh the dependency lock. Install with scripts and bin links disabled, then copy compiled code/assets/notices into the four materialized packages and hash the complete payload. The actual Windows x64 graph is validated at `74085bc7`: four local Pi packages plus 123 ordinary packages, matching Pi/TypeBox resolution, private/public SDK imports, themes, Photon WASM, TUI native helper and direct offline CLI. No lifecycle preparation was needed. Other platforms and application integration remain unproved; the tested snapshot includes persistence edits not yet semantically accepted. Do not add a second editable source or package-manifest authority.

Build-output isolation is implemented at `97398845`: `npm run extension:build:validate -- --output-dir "<new absolute external directory>"` contains build outputs/caches and disables publication; it rejects activation/watch and unsafe destinations. Focused private fixtures and the full source-bound isolated Pie build pass. Add `--pi-runtime "<verified artifact directory>"` to bind typecheck, bundling and copied runtime payload to the artifact; this input requires output isolation. Host startup/adapter integration and full semantic parity remain later gates. Without this override, `extension:build:validate` still overwrites shared `out` and is unsafe for this migration.

#### Baseline comparison: historical rationale for the selected 0.80.6 source

**October 1 research:** official [GitHub release metadata](https://api.github.com/repos/earendil-works/pi/releases/latest) and the [npm latest manifest](https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest) both identify **0.99.2**, released September 30, as latest stable. This is a dated observation, not a moving version to consume. Research covered release notes and tagged source, followed by a deeper comparison of session, provider/auth, SDK service and extension/tool boundaries. No alternative source baseline has been built or behavior-tested in Pie; the existing installed 0.80.6 packages and separately documented offline compatibility probes do not validate the proposed source import/build or migration. **Correction to the initial shortlist:** 0.80.10 is not a conservative patch upgrade; 0.80.8 already introduces the major model/auth runtime break.

| Candidate | Exact tag commit | Reason to evaluate / limitation |
| --- | --- | --- |
| [0.80.6](https://github.com/earendil-works/pi/releases/tag/v0.80.6), July 9 | `2b3fda9921b5590f285165287bd442a25817f17b` | **Selected source baseline.** Exact installed API and behavioral control; separates source ownership from newer architectural migrations. Cost: Pie must track omitted fixes and later refactors itself. |
| [0.80.10](https://github.com/earendil-works/pi/releases/tag/v0.80.10), July 16 | `8dc78834cde4e329284cf505f9e3f99763df5529` | Already requires ModelRuntime/auth/service-factory migration. Session-manager and retry source are byte-identical to 0.80.6, so it pays that migration cost without newer session fixes. Weak default unless its specific provider changes justify stopping here. |
| [0.82.1](https://github.com/earendil-works/pi/releases/tag/v0.82.1), July 25 | `b4f293684bba718d59cc1157679bcf6157b3a7f5` | Adds full provider registration and OpenRouter/Kimi OAuth, retaining the earlier ModelRuntime break. Possible provider-focused checkpoint before later context changes; not a compatibility shortcut. |
| [0.87.1](https://github.com/earendil-works/pi/releases/tag/v0.87.1), September 22 | `f07218c4d4bbc12bef056a7058c3dd49dfe41abe` | Gets canonical context/recovery and improved opening without native MCP/codemode packages. Still incurs both auth and session-context migrations; justify choosing it over 0.99.2 with a concrete 0.99-specific cost, not presumed automatic MCP activation. |
| [0.99.2](https://github.com/earendil-works/pi/releases/tag/v0.99.2), September 30 | `005af57d88ee23b33778f343a9595b32e67ff788` | Best candidate for adopting the newer architecture and current upstream fixes together. Biggest initial port/build surface; built-in tools can remain uninstantiated in the SDK path, but their packages/APIs still exist. |

**Useful upstream changes, and what they do not prove:**

- The [avoid-duplicate-reads fix](https://github.com/earendil-works/pi/commit/f1c587dde39025c75d7397bc14532d8fa5c001d9) first appears in **0.81.0**. In [0.87.1 opening](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/core/session-manager.ts#L1000-L1033), normal open uses a bounded header scan plus one full load; the large-header fallback reuses preloaded entries. This avoids the old duplicate full-file load, but is not literally one physical read. Pie already supplies the outcome through its transform; a source port should replace, not stack with, that implementation.
- [0.87 context edits](https://github.com/earendil-works/pi/releases/tag/v0.87.0) persist model-context omission/replacement without rewriting raw transcript history. Retry/overflow recovery uses them to omit abandoned attempts. This overlaps Pie's overflow-context patch, but does not establish equivalent interrupted continuation or history-compaction policy.
- The [0.87.1 retry classifier](https://github.com/earendil-works/pi/blob/v0.87.1/packages/ai/src/utils/retry.ts#L72-L110) includes `stream ended before a terminal response event` and capped delays. Targeted 0.87.1/0.99.2 inspection still found no equivalents for Pie's `upstream stream stalled`, `upstream header phase stalled` and `upstream transport circuit open` phrases.
- Targeted [0.87.1](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/core/agent-session.ts) and [0.99.2](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/src/core/agent-session.ts) source still publishes `message_end` before persistence. Pie's post-persistence notification/stable entry ID and cross-process ownership/transfer protocol remain required deltas. The existing public compaction hook does not replace Pie's soft/hard scheduling or summary-model policy.
- [0.99.0](https://github.com/earendil-works/pi/releases/tag/v0.99.0) persists new sessions on the first user message rather than waiting for an assistant response. Useful, but not equivalent to Pie's durable creation before any prompt. [0.99.2](https://github.com/earendil-works/pi/releases/tag/v0.99.2) also fixes prompt/model lookup scaling; release notes are not proof of lower Pie session-open latency.

**Compatibility boundaries worth investigating, not reasons to reject newer releases automatically:**

- The [0.80.7–0.80.10 changelog](https://github.com/earendil-works/pi/blob/v0.80.10/packages/coding-agent/CHANGELOG.md) records breaking changes even within 0.80.x. **0.80.7** replaces `compat.sendSessionIdHeader` with `sessionAffinityFormat` and introduces dynamic tool loading. **0.80.8** removes exported `AuthStorage`/old SDK session options, introduces async `ModelRuntime`, makes registry refresh async, and centralizes auth and dynamic catalogs. **0.80.9–10** add Kimi K3/deferred-tool/adaptive-thinking fixes and provider metadata changes. Version numbering is not a reliable proxy for migration size.
- [0.83](https://github.com/earendil-works/pi/releases/tag/v0.83.0) removes TypeBox APIs used by some extensions. [0.84](https://github.com/earendil-works/pi/releases/tag/v0.84.0) further changes registry/provider APIs, core session/repository contracts and upstream RPC streaming shapes. Check which surfaces Pie actually consumes rather than assuming every upstream CLI/RPC break affects Pie's own backend protocol.
- [0.86](https://github.com/earendil-works/pi/releases/tag/v0.86.0) changes custom streams from `Context` to `TranscriptContext`. [0.87](https://github.com/earendil-works/pi/releases/tag/v0.87.0) makes `SessionManager` canonical for provider context: assigning `agent.state.messages` no longer replaces future request history. It also replaces `shouldStopAfterTurn` with `finishTurn` and changes extension boundary dispatch. Pie's private-method patches must be re-expressed against these semantics, not mechanically transplanted.
- **Session version 3 does not guarantee backward semantics.** 0.87 adds `context_edit` entries without bumping `CURRENT_SESSION_VERSION`. A 0.80.6 reader can parse the file yet ignore an omission and replay a failed message into provider context. Test cross-version projection, branch/import/export and rollback explicitly. If preserving old-reader semantics needs translation or suppression of new entries, resolve that tradeoff before adopting those newer entries; selecting 0.80.6 as the baseline does not waive the current no-session-format-migration boundary.
- [0.99's build](https://github.com/earendil-works/pi/blob/v0.99.2/package.json) uses TypeScript 7/ES2024 and Node type stripping for source execution. Its declared Node minimum remains 22.19.0, which Pie's pinned Node 24.16.0 meets; that is not build verification. Reuse the upstream package build deliberately rather than assuming Pie's existing compiler configuration builds it unchanged.
- The [0.87.1 manifest](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/package.json) already adds `@earendil-works/chord` and an unbundled-plus-bundle build. [0.99.2](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/package.json) additionally depends on `pi-mcp`, `pi-codemode` and `quickjs-wasi`. Thus the four-package 0.80.6 inventory is **not** either newer candidate's complete local graph. Chord's observed use is experimental server services; MCP client and codemode executor activation can be lazy. Disabled features do not remove install/build dependencies.
- **MCP overlap is controllable, not an inevitable upgrade blocker.** In the inspected [0.99.2 SDK service path](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/src/core/agent-session-services.ts), resource-loader factories come from caller options; the [loader](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/src/core/resource-loader.ts) defaults them to empty. Pie's [runtime factory](../../harness/agent-processes/workers/runtime-factory.ts) supplies no built-in factories. Preserving that construction does not auto-instantiate native MCP/codemode/tool-search; ordinary configured extensions still load. The CLI supplies built-ins separately, where `-builtin:mcp`, `-builtin:codemode` and `-builtin:tool-search` exclusions can disable them. Verify every Pie creation path rather than extrapolating a tested upgrade from this source inspection.
- If enabled by any extension, 0.99 `ctx.executeTool()` emits nested execution events with `parentToolCallId`, but no standalone child transcript result; bounded child records live on the parent result. Pie's [tool event bridge](../../harness/agent-processes/workers/session-event-content-tool.ts) currently marks starts as top-level and expects durable result entries. It needs an adapter before using that API. Pie's child-session subagents are a different mechanism. The `tool_call` safeguard hook still applies; hiding a tool with `setActiveTools()` is not a hard disable for new `codemode`/`deferred` exposures. Native nested execution/tool exposure is a feature-stack decision, not a free replacement for Pie's [MCP adapter](../operations/MCP.md) or tool selection.

##### What the newer auth/runtime design would buy, and cost

`ModelRuntime` is relevant to the provider-productization workstream: it centralizes request auth, supports provider-owned discovery and persists dynamic catalogs. That can reduce custom infrastructure later. It does not by itself implement Pie's multiple-connection identity, user policy, unknown-price accounting or shared catalog revisions.

Concrete migration seams already visible in source:

- Pie's [`SdkModule`](../../harness/agent-processes/lib/sdk-integration/sdk.ts), [coordinator](../../harness/agent-processes/coordinator/server.ts) and service consumers construct `AuthStorage`/`ModelRegistry.create()` and consume `services.modelRegistry`. [0.80.10 services](https://github.com/earendil-works/pi/blob/v0.80.10/packages/coding-agent/src/core/agent-session-services.ts) instead accept/return `modelRuntime`; the registry is a compatibility facade without the old factory. Registry refresh callers must await completion before reading models. Merely retaining a class named `ModelRegistry` does not preserve this API.
- [Copilot discovery](../../harness/model-providers/model-discovery/index.ts) directly calls `registry.authStorage.get/set` to store availability. Newer [CredentialStore](https://github.com/earendil-works/pi/blob/v0.99.2/packages/ai/src/auth/types.ts) uses async `read/modify/delete`; `modify` serializes writes with refresh. Adapt availability updates without overwriting a rotated OAuth credential. A small compatibility wrapper may help, but cannot make async initialization and refresh synchronous.
- Pie's compaction customization reaches `_modelRegistry`/`_getCompactionRequestAuth`; newer code uses `_modelRuntime`/`_getSummarizationRequestAuth`. Translate the summary-model/auth behavior into a typed seam rather than restoring every old private method.
- Newer OpenAI ChatGPT sign-in is a separate `openai` auth mode, with its own issued client ID/scopes; `openai-codex` remains distinct. The [OAuth implementation](https://github.com/earendil-works/pi/blob/v0.99.2/packages/ai/src/auth/oauth/openai-chatgpt.ts) is not permission to relabel old tokens or historical provider identity. The credential contract is still provider-keyed, not proof of separate API-key/OAuth records or multiple user connections under one provider.

##### Selective ports into a 0.80.6 source fork

Here “current version” means Pie's **pinned 0.80.6**; latest upstream is 0.99.2. Starting from the pin and adapting upstream changes is a serious alternative to forward-porting Pie onto the latest release. Assess source changes by dependency, not by release number:

| Change | Port assessment | Benefit and necessary proof |
| --- | --- | --- |
| Duplicate session-read fix, first shipped 0.81.0 | **Locally bounded:** `SessionManager.open`, constructor/load path. [Upstream commit](https://github.com/earendil-works/pi/commit/f1c587dde39025c75d7397bc14532d8fa5c001d9). | Replace Pie's existing transform with source behavior, preserving migration, invalid/empty files, large headers and cwd overrides. This is maintenance simplification, not a newly earned latency gain over patched Pie. |
| First-user-message persistence, shipped 0.99.0 | **Bounded but overlaps Pie semantics:** `_persist` changes from requiring an assistant to accepting a user or assistant. [Upstream commit](https://github.com/earendil-works/pi/commit/ff72faba28d10c86611863d0aaa5d3122f2d8cb0). | Review against eager header creation, `flushed` state, prepared writes and agent-originated send durability. Does not replace atomic creation, lease fencing or post-persistence terminal events. |
| Empty text parts accompanying images in OpenAI-compatible requests | **Narrow provider adaptation:** port the filter/test from [0.87.1 request conversion](https://github.com/earendil-works/pi/blob/v0.87.1/packages/ai/src/api/openai-completions.ts), not the entire newer adapter with `TranscriptContext`. | Useful for affected image requests; prove output payloads and preserve ordinary mixed text/image messages. |
| Header-only auth / Anthropic bearer-token support | **Small coordinated change, not a one-line provider fix:** [provider auth](https://github.com/earendil-works/pi/blob/v0.82.1/packages/ai/src/providers/anthropic.ts) and [session auth checks](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/src/core/agent-session.ts) must agree. | Only prioritize if needed by a supported connection. Test prompt, summary and compaction paths: 0.80.6 can reject credentials that supply headers without an API key. |
| Malformed extension command registration | **Self-contained:** validate command name and handler in [0.99.2 extension loader](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/src/core/extensions/loader.ts). | Fail the bad extension at load rather than crash later on slash-command input. No new tool APIs/packages needed; retain valid registrations. |
| Provider/model metadata | **Data adaptation where protocol already works.** | Reconcile selected changes through Pie's `models.yaml` authority, not by replacing it with upstream generated catalogs. Protocol/auth fixes are separate from listing a new model. |
| Canonical context edits and actionable continuation boundaries, 0.87 | **Coordinated architecture stack:** [introduction commit](https://github.com/earendil-works/pi/commit/466db0fecdc20996a553116984d18c0d362b035a) spans entry types, projection, request construction and lifecycle. | Valuable durable context edits, but needs token/compaction accounting, transcript/cold readers, branch/rollback semantics and Pie's zero-prompt continuation adapted together. Not a sensible isolated bug-fix cherry-pick. |
| ModelRuntime/auth/discovery, 0.80.8 onward; native MCP/codemode/nested tools, 0.99 | **Feature stacks.** | Adopt only for an explicit product need with their callers, tests and package dependencies. Do not transplant a newest `pi-ai` package under old coding-agent to obtain isolated features. |

The 0.80.9 “unsaved session cannot clone/fork” guard is small upstream, but Pie intentionally supports durable cold creation and session-fork flows. Do not blindly import that restriction; determine whether a malformed-input diagnostic is useful without removing supported behavior. Likewise, Pie's continuation is a custom `continueAfterInterruption()` path, not upstream `continueRecent()` (which selects a file); later extension continuation hooks do not automatically replace it.

##### Strategy tradeoff and selected route

| Route | Main advantage | Main liability / when to choose |
| --- | --- | --- |
| **0.80.6 source import + Pie semantic ports + selective upstream changes** | Separates removing patch machinery from auth/history/tool redesign; gives clear parity checkpoints and preserves known readers. | We own identifying and adapting relevant upstream fixes. Divergence grows if we indefinitely defer structural changes while copying features that depend on them. Best near-term fit if source ownership is the priority. |
| **0.99.2 source import + forward-port Pie** | Starts near upstream with current fixes and foundations useful for later provider work; avoids rebuilding new architecture piece by piece. | Larger initial migration across auth/services, session context, extension events and packaging. Still must port Pie durability/ownership/compaction/continuation. Best if adopting those foundations soon is itself a goal. |
| **Intermediate release** | Can stop before a specific unwanted change, such as 0.87 context semantics or 0.99 tool APIs. | Often pays most migration costs while still missing later fixes. Choose only after identifying the exact boundary being avoided; 0.80.10 is not a low-risk fallback. |

**Selected route:** migrate to **0.80.6 source inside Pie**, port required Pie semantics and selectively adopt tested upstream changes where they fit, then complete matched build/resolution, distribution and cutover work in stages. This is a full migration destination, not a decision to stop after a source-only parity landing point. The historical comparison favored 0.80.6 because the actual source shows a major migration begins at 0.80.8, while several useful fixes are separable. A 0.99.2 forward port remains an alternative considered and not selected. This inspection identifies migration work, but does not measure its implementation duration.

Maintain an explicit delta per adopted change: upstream commit/tag, prerequisite changes, reason for adaptation, test evidence and any deliberately omitted behavior. Keep pristine import, Pie-required semantic changes and upstream ports in distinct commits. A direct cherry-pick is appropriate only when its prerequisites and source layout fit; otherwise retain attribution and adapt the implementation/test to the fork. All built Pi packages still come from **one coherent fork revision**, not a mixture of published release versions.

Track important deferred fixes and periodically compare the cumulative backport burden with a coordinated upstream merge. Providers/OAuth need ongoing review even when no feature is requested. Subtree import does not make this automatic: selective ports may conflict or duplicate work on a later merge, so reconcile them explicitly. This is ordinary source maintenance with provenance, not a new collection of startup rewrite scripts.

Current gates: turn the completed private pristine-build/import proof into reproducible materialized artifacts, settle the shared identity/resolution contract, and port the semantic delta in bounded slices. Import, prefix and upstream baseline are settled; behavioral parity, portable distribution and safe staging are not yet proved. The audit found network-backed catalog generation in upstream default builds, registry Pi siblings in coding-agent shrinkwrap, and shared-output writes even in Pie's validation-only build; the candidate pipeline must avoid those paths. API history/compare requests hit GitHub rate limits during research, so no complete commit-dependency graph, all-fix inventory or measured port-effort estimate is claimed.

##### Rough effort budget

Requested October 1. These are **low-confidence planning judgments**, not measured estimates or a delivery commitment. Assume one experienced maintainer familiar with Pie, agent assistance for bounded implementation/test work, and a stable committed Pie baseline. Person-days describe engineering effort, not autonomous agent runtime; calendar time depends on review availability and concurrent changes.

For **0.80.6 source adoption with existing behavior preserved**, budget roughly **10–20 engineering days**, or **2–4 focused working weeks** for one maintainer:

| Work | Planning allowance |
| --- | --- |
| Import/provenance, local package graph and repeatable source build | 2–4 days |
| Move installed-file/prototype patches into typed source and port their regression coverage | 3–6 days |
| Bind SDK delivery/identity to runtime generations; adapt resolution, installer/doctor and rollback | 2–4 days |
| Integration verification, packaged/standalone checks, failure cases and cleanup | 3–6 days |

The original **1–3 day feasibility-slice** allowance covered clean source builds and one real session persistence/event-ordering path with disposable fixtures. Private pristine-build/import proof is complete; semantic parity is not proved. Re-estimate after these gates rather than treating the initial allowance as remaining work. Keep packaging/Windows dependency issues, private-runtime seam changes and ownership/replacement failures visible; any of these can move the total outside the range.

A direct **0.99.2 adoption** has a provisional **20–40 engineering-day / 4–8 week** allowance because auth/service construction, context/history compatibility and newer event/build contracts join the same effort. Confidence is lower still: the treatment of `context_edit` and rollback must be decided before this becomes a scoped estimate. This is not an estimate for implementing all new upstream features.

**Relative to the recent analytics rework:** use the full canonical analytics redesign as the comparator, not just the latest reliability fixes. That work included authority switching, typed capture, recorder/query helpers, SQLite schema/projections, privacy/deletion, lifecycle fencing and application integration. A 0.80.6 parity fork is narrower and reuses existing semantics/tests; a rough scope judgment is **around half to two-thirds of that effort**, with fewer new product/storage decisions but similarly sensitive integration and recovery checks. A 0.99.2 forward port is **in the same broad size class as the analytics redesign**, potentially larger if history compatibility or provider/tool migrations expand. These ratios are not measured from logged hours or commit size, and the analytics source/contract does not establish deployment status. Agent-assisted elapsed time cannot be inferred from the person-day budgets above.

Both ranges exclude provider-setup UI/config migration, a new session format, latency work and broad upstream feature adoption. Selective upstream fixes should follow parity as separately sized tasks. Agent assistance can reduce mechanical editing and test-writing time, but compatibility decisions and proving failure/rollback behavior remain the main uncertainty. Do not promise a speedup multiplier or parallelize changes to the same runtime files merely to fit the budget.

#### What belongs in the fork versus Pie

Port required runtime behavior into typed Pi source; keep Pie's coordinator, session ownership authority, analytics and model policy in their existing owners. Where Pi needs Pie-specific authority, prefer a small typed hook/adapter over importing Pie host or coordinator implementation into the source tree. Do not use the migration to design a general replacement extension framework.

| Behavior to carry forward | Existing evidence / migration gate |
| --- | --- |
| Persistence before terminal publication, stable entry IDs, malformed-response and stream retry handling | [`backend-sdk.test.ts`](../../harness/agent-processes/lib/sdk-integration/test/backend-sdk.test.ts) and [terminal durability tests](../../test/integration/sdk-terminal-durability.test.ts). Add a real `AgentSession` event-pipeline test with a gated append; direct `SessionManager` persistence and source-transform checks alone do not prove publication ordering. |
| Durable non-overwriting creation, single-read open, migration/cwd/invalid-file behavior and atomic model/thinking settings | [Barrier regressions](../../harness/agent-processes/lib/sdk-integration/test/sdk-patch-barrier.test.ts), [process cases](../../harness/agent-processes/lib/sdk-integration/test/sdk-patch-barrier-processes.test.ts) and [single-read patch tests](../../harness/agent-processes/lib/sdk-integration/test/sdk-session-open-patch.test.ts). Carry semantic fixtures over; transform-shape assertions can retire with the transform. |
| Writer fencing, quiescence, transfer/readiness and new/switch/session-fork/import/self-reopen behavior | [Ownership authority tests](../../harness/session-storage/ownership/test/session-ownership-authority.test.ts). Run equivalent real-runtime paths against the source-built packages, including stale writers and ambiguous transfer failures. “Session fork” here means branching a conversation, not adopting a source fork. |
| Zero-prompt interrupted continuation and overflow-context reconstruction | [`backend-sdk.test.ts`](../../harness/agent-processes/lib/sdk-integration/test/backend-sdk.test.ts). Preserve transcript boundaries, completed replies and bounded recovery; expand source-runtime reopen coverage where current synthetic fixtures are insufficient. |
| History-compaction scheduling, customization and summary-model selection | [History-compaction regressions](../../harness/agent-processes/lib/sdk-integration/test/sdk-history-compaction-patch.test.ts). Prove proactive scheduling and native overflow interaction on the source-built runtime, not merely that a public custom-compaction callback exists. |

These tests are starting evidence, not a claim they were run in this planning session or already accept a source fork. For each behavior, classify the delta as required product semantics, an upstream candidate, or a workaround now satisfied upstream. Only remove it after parity evidence. Startup file mutation, patch locks/markers and prototype interception can disappear once redundant; write-ownership fencing, compatibility checks and runtime identity still have jobs to do.

#### Build, distribution and rollback proposal

- Build required Pi packages from one pinned source baseline with locked ordinary third-party dependencies. A clean checkout build must not rely on an existing global Pi install or a developer's previously patched `node_modules`.
- Make the built SDK graph part of the immutable Pie runtime generation, or bind it to an equally immutable, verified artifact with the same lifetime. Prefer generation-contained delivery initially; validate assets, dynamic imports, extension loading and any native dependencies before choosing bundling versus copied package trees.
- Record both upstream provenance and Pie's local source/build identity. An unchanged upstream `0.80.6` version string cannot distinguish the fork from npm or distinguish two different Pie deltas.
- Resolve the same intended graph in coordinator, workers, inventory helpers, cold browsing and extension/sidecar consumers that load Pi. Add package-resolution assertions. Ordinary packaged startup must not silently fall back to globally installed upstream Pi; decide separately whether explicit SDK overrides remain a development-only escape hatch with compatibility checks.
- Test the packaged artifact away from the source checkout and without global Pi. Include cold start, tools/extensions, history reopening and ownership/continuation checks. Both VS Code and standalone delivery need an explicit answer; a VS Code-only local-path success is insufficient.
- Treat host code and SDK as one rollback unit. Today's generation hashes cover `out/`, not SDK files reached through an external absolute path. [Runtime generations](../../application/hosts/vscode/runtime/runtime-generations.cjs) and the [startup loader](../../application/hosts/vscode/runtime/bootstrap.cjs) preserve leased generations and do not blindly retry an older generation after activation has begun and may have side effects. Retain that safety; do not promise automatic rollback after arbitrary startup failure.

No session-format migration is approved. Reopening the same disposable fixture sessions with the prior matched runtime must check equivalent context/branch semantics, not merely successful parsing; newer upstream can add meaningful entries without changing the format version. Never test rollback on live user data or interpret retaining an old host build as proof its externally resolved SDK is unchanged.

#### Implementation readiness and current gates

**Initial readiness assessment (2026-10-01, historical):** the destination and 0.80.6 baseline were selected while implementation was still unauthorized. That status is superseded by the current implementation authorization and completed import recorded above.

The pre-migration checkpoint `11afa12952495ec3bb1261d61bd5e9df668b2485` was pushed to `origin/master`, and branch `feat/pi-source-0.80.6` was created from it. The affected development tests passed (35 package groups), and generated model configuration passed its drift check at that checkpoint. This is historical checkpoint evidence, not source-fork parity or release qualification; no claim is made here about later pushes.

The experimental clone remains at `2ed00053` with its instruction changes and two compatibility probes preserved as evidence. Its source snapshot is older than the migration baseline. The earlier `vendor/pi/` suggestion is superseded by the completed subtree import at `harness/pi/`. The pristine source-build/import proof is complete; portable materialization, full package/resolution design and the update workflow remain to be proved or settled.

**Current next gates:** complete the materialized artifact/identity design and required semantic ports, using the completed pristine-build proof and read-only audit. Keep child edit ownership bounded and non-overlapping; prove parity, distribution and rollback. Full session ownership/continuation parity remains required. No runtime switch, runtime installation, parity proof or deployment has occurred. The user permits noninterrupting deployment, but current manager policy forbids active-SDK mutation and host publication/restart; evaluate safe immutable staging later, without interrupting the active manager session.

Distribution, installer/doctor transition and rollback design remain open before integration/cutover. The source baseline, Pie checkpoint, import path and subtree method are selected; build layout, runtime resolution and the safe immutable staging approach remain to be determined.

#### Staged migration sequence and gates

1. **Preparation and pristine import — complete:** branch from checkpoint `11afa129`; subtree import at `harness/pi/`, with provenance and matching upstream tree, committed as recorded above.
2. **Private clean build/import proof — complete; materialization pending:** `pi-tui`, `pi-ai`, `pi-agent-core` and `pi-coding-agent` compile in that order from retained 0.80.6 catalogs. Offline headless import observed 76 core-resolution edges inside `harness/pi`; tracked source and sampled live SDK fingerprints were unchanged. Portable dependency materialization and permanent tooling remain pending. This is not Pie behavioral parity; do not mutate the active SDK.
3. **Port the semantic delta in small slices:** add typed seams where needed, retain behavioral fixtures and run real source-runtime paths. Keep patched npm runtime and candidate runtime as separate test configurations; never patch the fork a second time to make it pass. Complete required session ownership, continuation and event-ordering parity; this is not optional scope for the full migration.
4. **Prove delivery and rollback:** package without checkout/global-SDK dependencies, bind SDK identity to runtime identity, verify both host routes and old/new fixture compatibility. Keep the known-good matched runtime available until acceptance.
5. **Evaluate immutable staging and complete deliberate cutover:** retire installed-file/prototype patching only after parity. Update installer/doctor/version reporting and development docs together. Noninterrupting deployment is authorized, but no active SDK mutation or host publication/restart is permitted under current manager policy; evaluate a safe immutable staging route later. Never interrupt the active manager session.

For ongoing maintenance, propose small reviewable upstream integrations, triggered by relevant fixes/provider changes plus a periodic review whose cadence is still open. Each update should show the upstream revision, local-delta disposition, affected API/history/provider behavior, focused parity results and a recoverable prior artifact. Preserve notices. General fixes can be proposed upstream; Pie-specific policy need not be. Owning source replaces brittle patch mechanics with ordinary maintenance; it does not eliminate that work.

### Provider/model ownership

Separate these concepts, even if the first version shares one user-config document:

| Concept | Authority |
| --- | --- |
| Integration: protocol, supported auth and discovery adapter | Shipped Pie/Pi source or explicitly installed extension. |
| Connection: stable ID, endpoint/account, enabled state and secret reference | User config outside the checkout. |
| Credentials | Existing credential authority, not normal settings/model metadata. |
| Discovery and enrichment snapshots | Rebuildable connection/account/endpoint-scoped cache. |
| Visibility, defaults, role pools, concurrency and explicit overrides | User-owned preferences. |
| Resolved model/pricing used by a request | Request-time revision/provenance retained with usage where required. |

Connection identity is not integration identity: personal and work accounts must not overwrite each other. Preserve existing `(provider, model ID)` history attribution. Renaming a built-in OAuth provider is not proof that multiple accounts work; verify credential/connection mapping.

Resolution rules:

- Discovery provides observed availability; metadata supplements cannot grant account access. Provider-served capabilities/limits outrank generic metadata; validated user overrides remain visible and preserved.
- Integration code owns compatibility and auth routing. Remote metadata must not install code or redirect credential destinations. Do not guess capabilities or quality tiers from names.
- User policy alone controls defaults, visibility and role pools. Discovery does not silently enroll models in automatic routing.
- Keep one resolved catalog revision across coordinator, workers, picker, routing/concurrency and pricing. Apply updates between requests, not by mutating in-flight models.
- Reuse current authentication/streaming behavior. The coding-agent registry's `refresh()` reloads config, not generic network discovery; lower-level `createProvider({ refreshModels })`/`Models.refresh()` support dynamic catalogs. Bridge deliberately: file entries merge with built-ins, whereas extension model registration replaces a provider list. Do not resurrect unavailable models through fallback merging.
- A generated user-local `models.json` may be a temporary projection, not a second editable authority. Preserve unknown capabilities/prices separately from SDK placeholder defaults.

### Setup, refresh and pricing

**Add connection** should choose the integration/auth mode, collect relevant endpoint/auth inputs, validate and discover, explain ready/incomplete models, then optionally set defaults/role pools. Keep manual IDs when listing is unavailable. Reachability, configured auth, successful listing and successful inference are distinct facts; offer an explicit minimal inference/tool test with a billing notice, not automatic probes of every model.

UI and agents use the same backend operations. Agents see credential status, never values; login/secret entry occurs through dedicated UI or external secret references, not chat transcripts. Include reconnect, refresh, disable/remove and headless schema-backed setup. Disabling a connection is not credential deletion. Preserve passive UI/reducer/effect design and both VS Code/standalone auth cancellation/callback flows.

Refresh only connected, enabled providers: after connection changes, when stale on startup/use, periodically while active and on request. Serve last-known-good cache immediately and refresh with bounded timeouts/backoff/deduplication. Keep useful state on offline/auth failure. Distinguish incomplete listings from complete success; vanished models become unavailable without deleting history/preferences. Account/endpoint changes invalidate access claims.

Pricing is optional. Distinguish **unknown**, **explicit zero/included** and **estimated rates** with source/time. Keep token counts when money is unknown; totals must identify partially unpriced usage. Unknown or SDK placeholder-zero prices must not win cheapest-model routing. Preserve request-time pricing, existing history and tier/cache rates; do not reprice past requests on refresh. Budget/routing behavior for unknown prices needs an explicit decision.

### Provider-specific evidence

These are starting points from the September 30 research, not live account-access guarantees:

| Connection | Discovery approach and constraint |
| --- | --- |
| OpenAI API | API-key [`GET /v1/models`](https://developers.openai.com/api/reference/resources/models/methods/list) lists IDs, not full capabilities/prices. Enrich metadata and exclude unsupported model types. |
| ChatGPT/Codex | Reuse current OAuth; [subscription and API access differ](https://developers.openai.com/codex/auth). Live discovery for the existing route is unresolved; [Codex `model/list`](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) may be a bundled catalog, not entitlement evidence. |
| Copilot | Reuse the existing authenticated discovery adapter; move persistence outside the repository and stop requiring prices. |
| Ollama | [`/api/tags`](https://docs.ollama.com/api/tags) and [`/api/show`](https://docs.ollama.com/api-reference/show-model-details) expose installed models/capabilities. Distinguish model maximum from configured context and local from cloud auth/cost. Do not download automatically. |
| Umans | [Documented](https://app.umans.ai/offers/code/docs) compatible inference plus `/v1/models` and `/v1/models/info`. Prior inspection of the public info response found limits, capability/reasoning metadata and playground entries, but no structured token prices. Public presence does not prove gated access. Review its [Pi extension](https://github.com/umans-ai/pi-provider-umans); do not silently adopt its separate vision-handoff behavior. |
| Other compatible endpoints | Configuration-only protocol/endpoint/auth, optional listing and manual IDs. New OAuth or protocols require executable integration, not an `oauth` configuration flag. |

[Models.dev](https://github.com/anomalyco/models.dev#api) is optional cached enrichment with provenance, not availability authority or executable configuration. Provider-specific mappings matter; identical model names can have different serving facts/prices. Missing enrichment must not erase user configuration.

### Session responsiveness

Compare ordinary cold open with inventory deferred for the same session/cwd/model. Measure **transcript-ready**, **inventory-ready** and execution readiness separately, including cold/hot switches, large histories, repeated opens and invalidation.

Proposed behavior: publish valid history promptly and load optional inventory afterward, with explicit pending/stale status and revision/session fencing. Do not weaken history/write consistency or execution authorization to improve apparent latency. Cache only data with a defined invalidation model; do not blindly share stateful extension instances. Attribution among disk parsing, extension initialization, queueing and renderer work still needs measurement.

## Planning gates and unresolved questions

The full Pi 0.80.6 source migration is authorized; this is not a delivery schedule. The pristine source import at `harness/pi/` is complete. Private pristine-build/import proof and read-only semantic-delta/build/deployment-safety audits are complete; semantic ports and artifact design are underway. Behavior-preserving parity, distribution and safe immutable staging remain unproved. Noninterrupting deployment is authorized, but current manager policy forbids active-SDK mutation and host publication/restart; the active manager session must not be interrupted.

1. **Portable artifact and controlled resolution:** build on the pristine compile/import proof to materialize the matched package graph and exclude published-Pi fallback without modifying the active SDK.
2. **Behavior-preserving source migration:** port the required extension/runtime/history/continuation/write semantics in reviewable slices; remove patch machinery only when genuinely redundant. Keep rollback to the existing packaged runtime. Do not combine with a storage-format change.
3. **Delivery and staging:** establish package/build layout, runtime identity, installer/doctor transition, and a safe immutable staging/rollback path. Prove any eventual deployment does not interrupt the active manager session.
4. **Independent session-readiness workstream (not a prerequisite for Pi source ownership):** demonstrate reduced transcript-ready latency without stale/mixed inventory or changed execution semantics.
5. **Independent provider bridge/configuration workstream:** prove one dynamic provider and OAuth connection, account-ID mapping, shared revisions, unknown-price accounting, offline behavior and a reversible configuration migration before broader rollout.

Questions to resolve:

- Which packages must be built/shipped, and how should build/package/module resolution and immutable runtime identity work?
- Who owns upstream updates, what triggers them, and what tests are the release/rollback gate?
- Which existing patches represent required product semantics versus replaceable implementation workarounds?
- What is the user-config schema/location and OAuth connection-ID mapping? What live Codex discovery mechanism is supported?
- What metadata is sufficient for selection, and what happens to price-dependent routing/budgets when prices are unknown?
- What invalidates cached inventory, and which readiness guarantees are required by UI versus execution?

## Acceptance and contracts

Runtime source ownership is successful when the shipped Pi graph comes from one identifiable source baseline, core changes are reviewable typed code, and existing extensions/history/ownership/event ordering remain compatible without installed-SDK mutation.

Provider management is successful when setup/refresh leave the checkout unchanged; unused providers receive no discovery calls; supported models can appear without a Pie release; unknown pricing works end-to-end; failures preserve useful state; UI/agent setup agree; preferences survive refresh; and historical model/pricing attribution is stable.

Session work is successful when controlled measurements show faster transcript readiness without correctness regressions. No latency target has been agreed yet.

The [architecture](../architecture/ARCHITECTURE.md), [state contract](../contracts/STATE_CONTRACT.md) and [analytics contract](../contracts/ANALYTICS_IMPLEMENTATION_CONTRACT.md) remain authoritative. This initiative does not change active analytics authority or authorize a session-storage cutoff. Required contract updates belong to the implementation that changes behavior, not this planning document.
