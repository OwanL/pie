// Authoritative package identity/path registry for the pie repo.
//
// Every runner that needs "which packages exist and how do they run" consumes
// this module instead of maintaining its own package list:
//  - scripts/verification/run-tests.mjs (per-package test/coverage configs)
//  - scripts/verification/run-test-files.mjs (focused file -> package classification + tsx config)
//  - scripts/verification/run-typechecks.mjs (typecheck projects + compiler selection)
//  - scripts/verification/run-package-group.mjs (root package.json `extensions:*` scripts)
//  - scripts/verification/test/package-registry-drift.test.mjs (fails when any runner or root
//    package script diverges from this registry)
//
// The registered package directory (`dir`) is the install/package owner: the
// place that carries the package.json/lockfile and compiler selection. It is
// deliberately distinct from the verification identity (`id`): routing of
// source and test files uses the explicit `sourceRoots`/`testRoots` schema
// below, which defaults to `dir` (+`ownedDirs` and retired route roots) and `<dir>/test` so the
// current single-root layout keeps classifying identically. Distributed
// future roots (see the repository organization plan) are declared per entry;
// they route as soon as files appear, before or after their directory is
// created. Most extension packages live under `extensions/<id>/`; migrated
// tools use explicit group metadata. `ownedDirs` routes compatibility adapters
// and extracted implementation files to their existing test owner. `retiredSourceDirs`
// retain absent historical paths only for rename/delete routing. Everything else a
// runner needs — test cwd, tsx/tsc compiler and concurrency — is explicit
// metadata below so runner adapters never re-derive it locally.

/**
 * Registry entry for one testable package.
 *
 * @typedef {object} PackageEntry
 * @property {string} id Canonical package id (also the `--package` flag value).
 * @property {string} dir Repo-relative directory the package owns (forward slashes).
 * @property {string[]} [aliases] Additional accepted ids (e.g. `--package analytics`).
 * @property {string[]} [groups] Explicit named group membership; otherwise extension packages
 *   are included in the `extensions` group when their directory is under `extensions/`.
 * @property {string[]} [ownedDirs] Additional live repo-relative paths whose source changes
 *   are classified and dependency-scanned as this package (e.g. a discovery shim).
 * @property {string[]} [retiredSourceDirs] Absent historical source paths kept routable
 *   solely for Git rename/delete records; unlike `ownedDirs`, these are not live roots.
 * @property {string[]} [sourceRoots] Additional repo-relative source roots routed to
 *   this verification id (forward slashes). Additive on top of `dir`, `ownedDirs`, and
 *   `retiredSourceDirs`;
 *   `dir` remains the install/package owner and always routes. Declared planned
 *   roots may be created by a later migration batch and route as soon as files
 *   appear, so early declaration cannot silently select zero tests.
 * @property {string[]} [testRoots] Additional repo-relative test-file roots routed to
 *   this verification id. Additive on top of the default `<testDir>`; distributed
 *   or cross-boundary test suites are declared here instead of being hidden under
 *   the install owner directory.
 * @property {string[]} [testFiles] Explicit repo-relative test files routed to this
 *   verification id when a shared integration directory contains distinct owners.
 * @property {string[]} [sdkIndependentTestFiles] Exact repo-relative test files that do
 *   not import or exercise the selected Pi SDK and may skip runtime acquisition in `test:file`.
 * @property {string[]} [optionalTestRoots] Explicitly planned test roots that may
 *   not exist yet. These are distinguished from required live test roots.
 * @property {string} [testCwd] Repo-relative cwd for test runs; absent = repo root.
 *   Set this only for packages that require a package-local test cwd; all other
 *   package test globs are resolved from the repo root.
 * @property {'root'} [testTsx] Use the repository-root tsx CLI instead of the
 *   package-local/owner CLI when its newer ESM loader is required by a routed source.
 * @property {string} [tsxConfig] Repo-relative tsconfig passed as tsx `--tsconfig`
 *   (packages that resolve the embedded pi SDK's nested typebox via path aliases).
 * @property {boolean} [includeOwnerDependencies] Resolve dependencies from the
 *   registered application dependency owner for this package's tsx and TypeScript runs.
 * @property {{ config: string, compiler: string }} [typecheck] Repo-relative project
 *   tsconfig and tsc binary for scripts/verification/run-typechecks.mjs. Absent = no TS project
 *   (the `scripts` package is plain .mjs).
 * @property {string} [testDir] Repo-relative default test-file root;
 *   defaults to `<dir>/test`. `scripts` overrides it so its legacy
 *   root test directory remains registered alongside the grouped test roots.
 * @property {number} [fastConcurrency] `--test-concurrency` used in fast mode.
 *   Absent = Node's default.
 */

/**
 * Each package, in canonical registration order. This order drives
 * `run-tests.mjs --list`, per-package execution order, and the typecheck project order.
 *
 * @type {PackageEntry[]}
 */
export const PACKAGE_REGISTRY = [
  {
    id: 'extension',
    dir: 'application/hosts/vscode',
    sourceRoots: ['harness/agent-instructions/prompt-assembly', 'application/lib/protocol',
      'application/lib/composer', 'application/lib/session-tabs', 'application/lib/transcript',
      'application/lib/platform-contracts', 'application/lib/renderer-delivery', 'application/lib/test',
      'application/frontend', 'application/hosts', 'test/integration/browser', 'test/integration/large-detail.e2e.ts'],
    // Keep the deleted extension/ prefix routable for outstanding Git rename/deletion records.
    retiredSourceDirs: ['extension'],
    testRoots: [
      'harness/agent-instructions/prompt-assembly/test',
      'application/frontend/composer/test',
      'application/frontend/lib/formatting/test',
      'application/frontend/session-tabs/test',
      'application/frontend/transcript/test',
      'application/lib/protocol/test',
      'application/lib/test',
      'application/hosts/test',
      'application/hosts/lib/test',
      'application/hosts/standalone/test',
      'application/hosts/standalone/startup/test',
      'application/hosts/vscode/test',
      'test/integration/perf',
    ],
    testFiles: [
      'test/integration/backend-runtime-prefs.test.ts',
      'test/integration/perf/auto-follow-reflow.test.ts',
      'test/integration/perf/webview-render-count.test.ts',
      'test/integration/worker-detail-webview-seam.test.ts',
      'test/integration/capability-seam.test.ts',
      'test/integration/protocol-envelope-contract.test.ts',
      'test/integration/chat-message-parts.test.ts',
      'test/integration/runtime-trace-bridge.test.ts',
      'test/integration/tool-result-format.test.ts',
      'test/integration/pie-harness-prompt.artifact.test.ts',
      'test/integration/system-prompt-provider-payload.artifact.test.ts',
    ],
    sdkIndependentTestFiles: [
      'application/hosts/test/asset-manifests/bootstrap.test.ts',
      'application/hosts/test/asset-manifests/runtime-generations.test.ts',
      'application/hosts/test/asset-manifests/runtime-scan-concurrency.test.ts',
      'application/hosts/test/asset-manifests/runtime-copy-concurrency.test.ts',
    ],
    testDir: 'application/frontend/test',
    testCwd: 'application/hosts/vscode',
    // The host-local TSX version classifies cross-owner harness TypeScript as
    // CommonJS; use the root CLI for correct ESM named exports without changing
    // protected package dependencies.
    testTsx: 'root',
    tsxConfig: 'application/hosts/vscode/tsconfig.json',
    includeOwnerDependencies: true,
    typecheck: { config: 'application/hosts/vscode/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 8,
  },
  {
    id: 'analysis',
    dir: 'analytics/analysis',
    aliases: ['analytics'],
    retiredSourceDirs: ['analysis'], // Retired source identity remains routable for changed/deleted paths.
    testCwd: 'analytics/analysis',
    typecheck: { config: 'analytics/analysis/tsconfig.json', compiler: 'analytics/analysis/node_modules/typescript/bin/tsc' },
    fastConcurrency: 2,
  },
  {
    id: 'scripts',
    dir: 'scripts',
    sdkIndependentTestFiles: [
      'scripts/lib/test/package-resolution.test.mjs',
      'scripts/lib/test/unbundled-owner-resolution.test.mjs',
      'scripts/install/test/source-pi-cli.test.mjs',
    ],
    testDir: 'scripts/test',
    testRoots: [
      'scripts/build/test',
      'scripts/development/test',
      'scripts/diagnostics/test',
      'scripts/install/test',
      'scripts/lib/test',
      'scripts/migrations/test',
      'scripts/model-config/test',
      'scripts/verification/test',
    ],
    fastConcurrency: 3,
  },
  {
    id: 'lib',
    dir: 'lib',
    testRoots: [
      'lib/data-root/test',
      'lib/process-lifecycle/test',
      'lib/sensitive-data/test',
      'lib/structured-logging/test',
      'lib/temporary-files/test',
      'lib/transcript/test',
    ],
    fastConcurrency: 3,
  },
  {
    id: 'cwd-skills',
    dir: 'extensions/cwd-skills',
    // B3: the implementation, tests, and typecheck project moved to
    // harness/agent-instructions/skill-discovery; the stable root SDK entry
    // stays in extensions/cwd-skills as a thin adapter.
    ownedDirs: ['harness/agent-instructions/skill-discovery'],
    testDir: 'harness/agent-instructions/skill-discovery/test',
    typecheck: { config: 'harness/agent-instructions/skill-discovery/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'safeguard',
    dir: 'harness/tools/execution-safety',
    groups: ['extensions'],
    // B4: middleware implementation moved to harness/tools/execution-safety
    // (with the canonical traversal policy); the stable root SDK entry stays
    // in extensions/safeguard as a thin adapter.
    ownedDirs: ['extensions/safeguard'],
    typecheck: { config: 'harness/tools/execution-safety/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'skill-pruner',
    dir: 'harness/tool-and-skill-selection',
    groups: ['extensions'],
    // B4: selector lifecycle/state/prepass moved to its shared owner; the stable
    // extensions/skill-pruner discovery adapter and request-capability tool keep
    // routing to the same package identity.
    ownedDirs: ['extensions/skill-pruner', 'harness/tools/request-capability'],
    sourceRoots: ['tools/request-capability'],
    testRoots: [
      'harness/tool-and-skill-selection/prepass/test',
      'harness/tool-and-skill-selection/state/test',
      'harness/tool-and-skill-selection/recovery/test',
      'harness/tool-and-skill-selection/lifecycle/test',
      'extensions/skill-pruner/test',
    ],
    testFiles: ['test/integration/dynamic-tool-activation.artifact.test.ts'],
    typecheck: { config: 'harness/tool-and-skill-selection/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'model-provider-authentication',
    dir: 'harness/model-providers/authentication',
    groups: ['extensions'],
    fastConcurrency: 3,
  },
  {
    id: 'model-provider-concurrency',
    dir: 'harness/model-providers/concurrency',
    groups: ['extensions'],
    tsxConfig: 'application/hosts/vscode/tsconfig.json',
    fastConcurrency: 3,
  },
  {
    id: 'model-provider-pricing',
    dir: 'harness/model-providers/pricing',
    groups: ['extensions'],
    tsxConfig: 'application/hosts/vscode/tsconfig.json',
    fastConcurrency: 3,
  },
  {
    id: 'model-provider-traffic-observation',
    dir: 'harness/model-providers/traffic-observation',
    groups: ['extensions'],
    tsxConfig: 'application/hosts/vscode/tsconfig.json',
    fastConcurrency: 3,
  },
  {
    id: 'agent-processes-coordinator',
    dir: 'harness/agent-processes/coordinator',
    ownedDirs: ['harness/model-providers/retry-and-failover'],
    groups: ['extensions'],
    testFiles: [
      'test/integration/backend-expected-cancellation-log.test.ts',
      'test/integration/backend-diagnostics-trace.test.ts',
      'test/integration/backend-analytics-activation.test.ts',
      'test/integration/backend-session-worker-liveness.test.ts',
      'test/integration/worker-runtime-analytics-router.test.ts',
    ],
    tsxConfig: 'application/hosts/vscode/tsconfig.json',
    typecheck: { config: 'harness/agent-processes/coordinator/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 1,
  },
  {
    id: 'session-control',
    dir: 'harness/tools/session-control',
    groups: ['extensions'],
    tsxConfig: 'application/hosts/vscode/tsconfig.json',
    fastConcurrency: 3,
  },
  {
    id: 'tool-catalog',
    dir: 'harness/tools/catalog',
    groups: ['extensions'],
    testFiles: ['test/integration/tool-catalog.test.ts'],
    tsxConfig: 'application/hosts/vscode/tsconfig.json',
    fastConcurrency: 1,
  },
  {
    id: 'subagent',
    dir: 'harness/tools/subagent',
    groups: ['extensions'],
    // Keep the discovery adapter and extracted agent-discovery tests under the same owner.
    ownedDirs: ['extensions/subagent', 'harness/agent-instructions/agent-discovery'],
    retiredSourceDirs: ['tools/subagent'],
    testRoots: ['harness/agent-instructions/agent-discovery/test'],
    tsxConfig: 'harness/tools/subagent/tsconfig.json',
    typecheck: { config: 'harness/tools/subagent/tsconfig.release.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 4,
  },
  {
    id: 'ask-user',
    dir: 'harness/tools/ask-user',
    groups: ['extensions'],
    // The retired source identity stays routable for rename/delete diffs.
    ownedDirs: ['extensions/ask-user'],
    retiredSourceDirs: ['tools/ask-user'],
    typecheck: { config: 'harness/tools/ask-user/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'warm-bash',
    dir: 'harness/tools/warm-bash',
    groups: ['extensions'],
    // The retired source identity stays routable for rename/delete diffs.
    ownedDirs: ['extensions/warm-bash'],
    retiredSourceDirs: ['tools/warm-bash'],
    typecheck: { config: 'harness/tools/warm-bash/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'copilot-model-discovery',
    dir: 'extensions/copilot-model-discovery',
    testDir: 'harness/model-providers/model-discovery/test',
    ownedDirs: ['harness/model-providers/model-discovery'],
    typecheck: { config: 'harness/model-providers/model-discovery/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'web-access-guard',
    dir: 'harness/tools/package-integrations/web-access',
    groups: ['extensions'],
    ownedDirs: ['extensions/web-access-guard'],
    typecheck: { config: 'harness/tools/package-integrations/web-access/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'tool-result-pruner',
    dir: 'harness/tools/result-processing',
    groups: ['extensions'],
    // B4: middleware implementation moved to harness/tools/result-processing;
    // the stable root SDK entry stays in extensions/tool-result-pruner.
    ownedDirs: ['extensions/tool-result-pruner'],
    typecheck: { config: 'harness/tools/result-processing/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'deferred-triggers',
    dir: 'harness/tools/deferred-triggers',
    groups: ['extensions'],
    // The retired source identity stays routable for rename/delete diffs.
    ownedDirs: ['extensions/deferred-triggers'],
    retiredSourceDirs: ['tools/deferred-triggers'],
    typecheck: { config: 'harness/tools/deferred-triggers/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'session-changes',
    dir: 'harness/tools/session-changes',
    groups: ['extensions'],
    // The retired source identity stays routable for rename/delete diffs.
    ownedDirs: ['extensions/session-changes'],
    retiredSourceDirs: ['tools/session-changes'],
    typecheck: { config: 'harness/tools/session-changes/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'computer-use',
    dir: 'harness/tools/computer-use',
    groups: ['extensions'],
    // The retired source identity stays routable for rename/delete diffs; native dependencies remain extension-owned.
    ownedDirs: ['extensions/computer-use'],
    retiredSourceDirs: ['tools/computer-use'],
    tsxConfig: 'harness/tools/computer-use/tsconfig.runtime.json',
    typecheck: { config: 'harness/tools/computer-use/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 2,
  },
  {
    id: 'model-provider-request-validation',
    dir: 'harness/model-providers/request-validation',
    tsxConfig: 'harness/model-providers/request-validation/tsconfig.json',
    typecheck: { config: 'harness/model-providers/request-validation/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 1,
  },
  {
    id: 'playwright',
    dir: 'harness/tools/playwright',
    groups: ['extensions'],
    // The retired source identity stays routable for rename/delete diffs; browser dependencies remain extension-owned.
    ownedDirs: ['extensions/playwright'],
    retiredSourceDirs: ['tools/playwright'],
    tsxConfig: 'harness/tools/playwright/tsconfig.runtime.json',
    typecheck: { config: 'harness/tools/playwright/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
  },
  {
    id: 'session-storage-transcripts',
    dir: 'harness/session-storage/transcripts',
    // B5: transcript storage moved out of extension/src/backend; cold browse
    // and real-SDK transcript integrations remain co-owned with their owners.
    testFiles: [
      'test/integration/backend-cold-session-browse.test.ts',
      'test/integration/real-sdk-image-persistence.artifact.test.ts',
      'test/integration/sdk-terminal-durability.artifact.test.ts',
    ],
    tsxConfig: 'application/hosts/vscode/tsconfig.json',
    typecheck: { config: 'harness/session-storage/transcripts/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'session-storage-settings',
    dir: 'harness/session-storage/settings',
    // B5: session-scoped settings stores moved out of extension/src/backend.
    // The settings co-ownership of the mcp config/override RPC split keeps the
    // package-integrations/mcp regression test routed here.
    testRoots: ['harness/tools/package-integrations/mcp/test'],
    testFiles: ['test/integration/history-compaction-settings.test.ts'],
    // Test tsconfig carries the yaml dependency-owner alias for the backend
    // request-handler chain; source-only typecheck excludes test roots.
    tsxConfig: 'harness/session-storage/settings/tsconfig.json',
    typecheck: { config: 'harness/session-storage/settings/tsconfig.release.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'agent-processes-context-inventory',
    dir: 'harness/agent-processes/context-inventory',
    groups: ['extensions'],
    tsxConfig: 'harness/agent-processes/context-inventory/tsconfig.json',
    typecheck: { config: 'harness/agent-processes/context-inventory/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 2,
  },
  {
    id: 'agent-processes-process-lifecycle',
    dir: 'harness/agent-processes/lib/process-lifecycle',
    groups: ['extensions'],
    tsxConfig: 'harness/agent-processes/lib/process-lifecycle/tsconfig.json',
    typecheck: { config: 'harness/agent-processes/lib/process-lifecycle/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 2,
  },
  {
    id: 'agent-processes-rpc',
    dir: 'harness/agent-processes/lib/rpc',
    groups: ['extensions'],
    tsxConfig: 'harness/agent-processes/lib/rpc/tsconfig.json',
    typecheck: { config: 'harness/agent-processes/lib/rpc/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'agent-processes-workers',
    dir: 'harness/agent-processes/workers',
    groups: ['extensions'],
    // B5: worker execution and its isolated-runtime tests. Source-only typecheck
    // excludes tests and carries explicit SDK/yaml aliases.
    tsxConfig: 'harness/agent-processes/workers/tsconfig.json',
    typecheck: { config: 'harness/agent-processes/workers/tsconfig.release.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'agent-processes-sdk-integration',
    dir: 'harness/agent-processes/lib/sdk-integration',
    groups: ['extensions'],
    tsxConfig: 'harness/agent-processes/lib/sdk-integration/tsconfig.json',
    typecheck: { config: 'harness/agent-processes/lib/sdk-integration/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 2,
  },
  {
    id: 'model-provider-catalog',
    dir: 'harness/model-providers/catalog',
    sourceRoots: ['harness/model-providers/management', 'harness/model-providers/runtime', 'application/backend/provider-management'],
    testRoots: ['harness/model-providers/management/test', 'harness/model-providers/runtime/test', 'application/backend/test/provider-management'],
    testFiles: ['test/integration/backend-model-profiles.test.ts'],
    tsxConfig: 'application/hosts/vscode/tsconfig.json',
    typecheck: { config: 'harness/model-providers/catalog/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'session-storage-lifecycle',
    dir: 'harness/session-storage/lifecycle',
    tsxConfig: 'application/hosts/vscode/tsconfig.json',
    typecheck: { config: 'harness/session-storage/lifecycle/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'session-storage-catalog',
    dir: 'harness/session-storage/catalog',
    testFiles: ['test/integration/backend-session-directory.test.ts'],
    tsxConfig: 'application/hosts/vscode/tsconfig.json',
    typecheck: { config: 'harness/session-storage/catalog/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'session-storage-ownership',
    dir: 'harness/session-storage/ownership',
    testRoots: ['harness/session-storage/test'],
    testFiles: ['test/integration/session-runtime-crash-matrix.test.ts'],
    tsxConfig: 'application/hosts/vscode/tsconfig.json',
    typecheck: { config: 'harness/session-storage/ownership/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'session-storage-metadata',
    dir: 'harness/session-storage/metadata',
    tsxConfig: 'application/hosts/vscode/tsconfig.json',
    typecheck: { config: 'harness/session-storage/metadata/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    // B6: the analytics runtime tree (contracts/capture/recording/storage/
    // queries/projections/usage-accounting/authority) with its distributed
    // test roots. The retained `analytics` alias stays on `analysis`; the
    // standalone DuckDB workspace remains its own `analysis` package.
    id: 'analytics-runtime',
    dir: 'analytics/contracts',
    sourceRoots: [
      'analytics/authority',
      'application/backend/analytics-views',
      'analytics/capture',
      'analytics/projections',
      'analytics/queries',
      'analytics/recording',
      'analytics/storage',
      'analytics/usage-accounting',
      'application/backend/composition',
    ],
    testDir: 'analytics/test',
    testRoots: [
      'analytics/authority/test',
      'analytics/contracts/test',
      'analytics/capture/tool-call-analysis/test',
      'application/backend/test/composition',
      'application/backend/test/analytics-views',
      'application/backend/analytics-views/test',
      // Opt-in performance suites moved from extension/test/perf (B6); the
      // .perf.ts files stay opt-in and are intentionally not covered by the
      // package testGlobs above. The perf root itself now routes to the
      // extension package (B7 frontend owners).
    ],
    tsxConfig: 'application/hosts/vscode/tsconfig.json',
    includeOwnerDependencies: true,
    typecheck: { config: 'analytics/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 2,
  },
  // B7: application backend owners. Source/test routing is explicit per owner
  // because `application/backend/analytics-views` and
  // `application/backend/test/{composition,analytics-views}` remain analytics-
  // runtime claims; composition sources co-route to analytics-runtime above.
  // All owners share one typecheck project (`application/backend/tsconfig.json`),
  // registered on the conversation-state entry.
  {
    id: 'conversation-state',
    dir: 'application/backend/conversation-state',
    sourceRoots: ['application/backend/test/helpers', 'application/backend/dictation'],
    testRoots: ['application/backend/test/conversation-state', 'application/backend/conversation-state/test', 'application/backend/test/dictation'],
    testFiles: ['test/integration/sync-contract.test.ts', 'application/backend/conversation-state/reducers/dictation-handlers.test.ts'],
    tsxConfig: 'application/hosts/vscode/tsconfig.json',
    includeOwnerDependencies: true,
    typecheck: { config: 'application/backend/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'session-actions',
    dir: 'application/backend/session-actions',
    testDir: 'application/backend/test/session-actions',
    tsxConfig: 'application/hosts/vscode/tsconfig.json',
    fastConcurrency: 3,
  },
  {
    id: 'agent-connection',
    dir: 'application/backend/agent-connection',
    testDir: 'application/backend/test/agent-connection',
    testRoots: ['application/backend/agent-connection/test'],
    tsxConfig: 'application/hosts/vscode/tsconfig.json',
    includeOwnerDependencies: true,
    fastConcurrency: 3,
  },
  {
    id: 'deferred-triggers-backend',
    dir: 'application/backend/deferred-triggers',
    testDir: 'application/backend/test/deferred-triggers',
    tsxConfig: 'application/hosts/vscode/tsconfig.json',
    fastConcurrency: 3,
  },
  {
    id: 'application-settings',
    dir: 'application/backend/settings',
    testDir: 'application/backend/test/settings',
    testRoots: ['application/backend/settings/test'],
    tsxConfig: 'application/hosts/vscode/tsconfig.json',
    fastConcurrency: 3,
  },
  {
    id: 'file-changes',
    dir: 'application/backend/file-changes',
    testDir: 'application/backend/test/file-changes',
    testRoots: ['application/backend/file-changes/test'],
    tsxConfig: 'application/hosts/vscode/tsconfig.json',
    fastConcurrency: 3,
  },
  {
    id: 'transcript-delivery',
    dir: 'application/backend/transcript-delivery',
    testDir: 'application/backend/test/transcript-delivery',
    tsxConfig: 'application/hosts/vscode/tsconfig.json',
    fastConcurrency: 3,
  },
  {
    id: 'application-validation',
    dir: 'application/lib/validation',
    tsxConfig: 'application/hosts/vscode/tsconfig.json',
    fastConcurrency: 3,
  },
  {
    id: 'cold-browse-helper',
    dir: 'harness/agent-processes/cold-browse-helper',
    groups: ['extensions'],
    tsxConfig: 'application/hosts/vscode/tsconfig.json',
    typecheck: { config: 'harness/agent-processes/cold-browse-helper/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
];

/** All valid package ids in registration order (matches `run-tests.mjs --list`). */
export const ALL_PACKAGE_IDS = PACKAGE_REGISTRY.map((entry) => entry.id);

/**
 * Named package groups consumable by scripts/verification/run-package-group.mjs and the
 * matching root package.json scripts (`extensions:test`, `extensions:typecheck`).
 * Group membership is derived from the registry so it cannot drift.
 *
 * @type {Record<string, string[]>}
 */
export const PACKAGE_GROUPS = {
  extensions: PACKAGE_REGISTRY.filter((entry) =>
    entry.groups?.includes('extensions') ?? entry.dir.startsWith('extensions/'),
  ).map((entry) => entry.id),
};

/**
 * Resolve a registry entry by id or alias.
 * @param {string} id package id or alias
 * @returns {PackageEntry | null}
 */
export function resolvePackageEntry(id) {
  for (const entry of PACKAGE_REGISTRY) {
    if (entry.id === id || entry.aliases?.includes(id)) return entry;
  }
  return null;
}

/**
 * Repo-relative cwd for a package's test run (null = repo root).
 * @param {PackageEntry} entry
 * @returns {string | null}
 */
export function packageTestCwd(entry) {
  return entry.testCwd ?? null;
}

/**
 * Repo-relative source roots routed to a package's verification id, in
 * classification-precedence order: install-owner dir, live owned dirs, retired
 * historical dirs, then explicitly declared (planned or distributed) roots.
 * Retired source dirs remain routable for rename/delete analysis but are not
 * validated as active filesystem roots.
 * @param {PackageEntry} entry
 * @returns {string[]}
 */
export function packageSourceRoots(entry) {
  return [...new Set([entry.dir, ...(entry.ownedDirs ?? []), ...(entry.retiredSourceDirs ?? []), ...(entry.sourceRoots ?? [])])];
}

/**
 * Repo-relative test-file roots routed to a package's verification id: the
 * default `<testDir>` first, then any explicitly declared distributed roots.
 * @param {PackageEntry} entry
 * @returns {string[]}
 */
export function packageTestRoots(entry) {
  return [...new Set([packageTestDir(entry), ...(entry.testRoots ?? [])])];
}

/**
 * Explicit test files routed individually where shared directory ownership is
 * not granular enough.
 * @param {PackageEntry} entry
 * @returns {string[]}
 */
export function packageTestFiles(entry) {
  return [...new Set(entry.testFiles ?? [])];
}

/**
 * Exact repo-relative test files that may use `test:file` without selecting or
 * building a verified Pi runtime. This is intentionally file metadata, not a
 * directory or filename-pattern rule.
 * @param {PackageEntry} entry
 * @returns {string[]}
 */
export function packageSdkIndependentTestFiles(entry) {
  return [...new Set(entry.sdkIndependentTestFiles ?? [])];
}

/** All exact test files eligible for the SDK-independent `test:file` path. */
export const SDK_INDEPENDENT_TEST_FILES = Object.freeze(PACKAGE_REGISTRY.flatMap(packageSdkIndependentTestFiles));
const SDK_INDEPENDENT_TEST_FILE_SET = new Set(SDK_INDEPENDENT_TEST_FILES);

/**
 * Whether the exact repo-relative file is registered as SDK-independent.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isSdkIndependentTestFile(filePath) {
  return typeof filePath === 'string' && SDK_INDEPENDENT_TEST_FILE_SET.has(filePath);
}

/**
 * Repo-relative test roots explicitly allowed to be absent before a planned migration.
 * @param {PackageEntry} entry
 * @returns {string[]}
 */
export function packageOptionalTestRoots(entry) {
  return [...new Set(entry.optionalTestRoots ?? [])];
}

/**
 * Repo-relative default test-file root for a package.
 * Defaults to `<dir>/test`; distributed layouts may override it.
 * @param {PackageEntry} entry
 * @returns {string}
 */
export function packageTestDir(entry) {
  return entry.testDir ?? `${entry.dir}/test`;
}

/**
 * Typecheck project for scripts/verification/run-typechecks.mjs, or null when the package
 * has no TypeScript project.
 * @param {PackageEntry} entry
 * @returns {{ id: string, config: string, compiler: string } | null}
 */
export function typecheckProjectFor(entry) {
  if (!entry.typecheck) return null;
  return {
    id: entry.id,
    config: entry.typecheck.config,
    compiler: entry.typecheck.compiler,
    ...(entry.includeOwnerDependencies ? { includeOwnerDependencies: true } : {}),
  };
}

/** Full typecheck project list in canonical registry order. */
export const TYPECHECK_PROJECTS = PACKAGE_REGISTRY
  .map(typecheckProjectFor)
  .filter((project) => project !== null);

/**
 * Package/directory pairs — the classification view of the registry used by
 * run-test-files.mjs. Built from every package's routed
 * source roots (`dir` + live/retired owned paths + explicit `sourceRoots`) and test roots,
 * in registration order with per-package de-duplication, so distributed and
 * planned roots classify to their verification id like any package dir.
 * `ownedDirs` include live compatibility adapters and implementation files whose
 * tests remain with another package; retired roots only preserve historical routing.
 * @typedef {{ id: string, dir: string }} PackageDirective
 * @type {PackageDirective[]}
 */
export const PACKAGE_DIRECTIVES = PACKAGE_REGISTRY.flatMap((entry) => {
  const directives = [];
  const seen = new Set();
  for (const root of [...packageSourceRoots(entry), ...packageTestRoots(entry), ...packageTestFiles(entry)]) {
    if (seen.has(root)) continue;
    seen.add(root);
    directives.push({ id: entry.id, dir: root });
  }
  return directives;
});

/**
 * Classify a repo-relative, forward-slash path to its owning package id.
 * @param {string} filePath - repo-relative path with forward slashes
 * @returns {string | null} package id, or null if the file is not under any package directory
 */
export function classifyFileToPackage(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return null;
  }
  for (const { id, dir } of PACKAGE_DIRECTIVES) {
    if (filePath === dir || filePath.startsWith(`${dir}/`)) {
      return id;
    }
  }
  return null;
}
