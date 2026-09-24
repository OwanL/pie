// Authoritative package identity/path registry for the pie repo.
//
// Every runner that needs "which packages exist and how do they run" consumes
// this module instead of maintaining its own package list:
//  - scripts/run-tests.mjs        (per-package test/coverage configs, fast grouping)
//  - scripts/run-test-files.mjs   (focused file -> package classification + tsx config)
//  - scripts/run-affected-tests.mjs / scripts/lib/test-impact.mjs (changed files -> packages)
//  - scripts/run-fast-batched-tests.mjs (root/analysis/subagent/... fast batch modes)
//  - scripts/run-typechecks.mjs   (typecheck projects + compiler selection)
//  - scripts/run-package-group.mjs (root package.json `extensions:*` scripts)
//  - scripts/test/package-registry-drift.test.mjs (fails when any runner or root
//    package script diverges from this registry)
//
// The registered package directory (`dir`) is the install/package owner: the
// place that carries the package.json/lockfile and compiler selection. It is
// deliberately distinct from the verification identity (`id`): routing of
// source and test files uses the explicit `sourceRoots`/`testRoots` schema
// below, which defaults to `dir` (+`ownedDirs`) and `<dir>/test` so the
// current single-root layout keeps classifying identically. Distributed
// future roots (see the repository organization plan) are declared per entry;
// they route as soon as files appear, before or after their directory is
// created. Most extension packages live under `extensions/<id>/`; migrated
// tools use explicit group metadata. `ownedDirs` routes compatibility adapters
// and extracted implementation files to their existing test owner. Everything
// else a runner needs — test cwd, tsx/tsc compiler, batching and concurrency —
// is explicit metadata below so runner adapters never re-derive it locally.

/**
 * Registry entry for one testable package.
 *
 * @typedef {object} PackageEntry
 * @property {string} id Canonical package id (also the `--package` flag value).
 * @property {string} dir Repo-relative directory the package owns (forward slashes).
 * @property {string[]} [aliases] Additional accepted ids (e.g. `--package analytics`).
 * @property {string[]} [groups] Explicit named group membership; otherwise extension packages
 *   are included in the `extensions` group when their directory is under `extensions/`.
 * @property {string[]} [ownedDirs] Additional repo-relative paths whose source changes
 *   are classified and dependency-scanned as this package (e.g. a discovery shim).
 * @property {string[]} [sourceRoots] Additional repo-relative source roots routed to
 *   this verification id (forward slashes). Additive on top of `dir` + `ownedDirs`;
 *   `dir` remains the install/package owner and always routes. Declared planned
 *   roots may be created by a later migration batch and route as soon as files
 *   appear, so early declaration cannot silently select zero tests.
 * @property {string[]} [testRoots] Additional repo-relative test-file roots routed to
 *   this verification id. Additive on top of the default `<testDir>`; distributed
 *   or cross-boundary test suites are declared here instead of being hidden under
 *   the install owner directory.
 * @property {string[]} [optionalTestRoots] Explicitly planned test roots that may
 *   not exist yet. Only these roots may be skipped by fast batch runners.
 * @property {string} [testCwd] Repo-relative cwd for test runs; absent = repo root.
 *   Set this only for packages that require a package-local test cwd; all other
 *   package test globs are resolved from the repo root.
 * @property {string} [tsxConfig] Repo-relative tsconfig passed as tsx `--tsconfig`
 *   (packages that resolve the embedded pi SDK's nested typebox via path aliases).
 * @property {{ config: string, compiler: string }} [typecheck] Repo-relative project
 *   tsconfig and tsc binary for scripts/run-typechecks.mjs. Absent = no TS project
 *   (the `scripts` package is plain .mjs).
 * @property {{ batches: number }} [fastBatch] File-batch count for the package's
 *   run-fast-batched-tests.mjs mode (mode name = package id). Absent = no dedicated
 *   batch mode.
 * @property {string} [testDir] Repo-relative test-file root walked by the fast
 *   batch runner; defaults to `<dir>/test`. Only `scripts` overrides it because
 *   its package directory is itself the test directory.
 * @property {number} [fastConcurrency] `--test-concurrency` used in fast mode.
 *   Absent = Node's default. Repo-root packages share the root group budget (3).
 */

/**
 * Each package, in canonical registration order. This order drives
 * `run-tests.mjs --list`, per-package execution order, the root fast-batch
 * composition, and the typecheck project order.
 *
 * @type {PackageEntry[]}
 */
export const PACKAGE_REGISTRY = [
  {
    id: 'extension',
    dir: 'application/hosts/vscode',
    sourceRoots: ['extension'],
    testRoots: ['extension/test'],
    testDir: 'extension/test',
    testCwd: 'extension',
    tsxConfig: 'application/hosts/vscode/tsconfig.json',
    typecheck: { config: 'application/hosts/vscode/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 8,
  },
  {
    id: 'analysis',
    dir: 'analysis',
    aliases: ['analytics'],
    testCwd: 'analysis',
    // Planned distributed roots (migration batch B6): the retained analysis
    // workspace moves under `analytics/analysis` while `analysis` stays the
    // install/package owner until that batch lands. Both generations route to
    // this verification id now; `analytics/analysis` has no files until B6.
    sourceRoots: ['analytics/analysis'],
    testRoots: ['analytics/analysis/test'],
    optionalTestRoots: ['analytics/analysis/test'],
    typecheck: { config: 'analysis/tsconfig.json', compiler: 'analysis/node_modules/typescript/bin/tsc' },
    fastBatch: { batches: 4 },
    fastConcurrency: 2,
  },
  {
    id: 'scripts',
    dir: 'scripts/test',
    testDir: 'scripts/test',
    fastConcurrency: 3,
  },
  {
    id: 'cwd-skills',
    dir: 'extensions/cwd-skills',
    typecheck: { config: 'extensions/cwd-skills/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'safeguard',
    dir: 'extensions/safeguard',
    typecheck: { config: 'extensions/safeguard/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'skill-pruner',
    dir: 'extensions/skill-pruner',
    ownedDirs: ['tools/request-capability'],
    typecheck: { config: 'extensions/skill-pruner/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'subagent',
    dir: 'tools/subagent',
    groups: ['extensions'],
    ownedDirs: ['extensions/subagent'],
    tsxConfig: 'tools/subagent/tsconfig.json',
    typecheck: { config: 'tools/subagent/tsconfig.release.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastBatch: { batches: 4 },
    fastConcurrency: 4,
  },
  {
    id: 'ask-user',
    dir: 'tools/ask-user',
    groups: ['extensions'],
    ownedDirs: ['extensions/ask-user'],
    typecheck: { config: 'tools/ask-user/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'warm-bash',
    dir: 'tools/warm-bash',
    groups: ['extensions'],
    ownedDirs: ['extensions/warm-bash'],
    typecheck: { config: 'tools/warm-bash/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'copilot-model-discovery',
    dir: 'extensions/copilot-model-discovery',
    typecheck: { config: 'extensions/copilot-model-discovery/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'web-access-guard',
    dir: 'extensions/web-access-guard',
    typecheck: { config: 'extensions/web-access-guard/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'tool-result-pruner',
    dir: 'extensions/tool-result-pruner',
    typecheck: { config: 'extensions/tool-result-pruner/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'deferred-triggers',
    dir: 'tools/deferred-triggers',
    groups: ['extensions'],
    ownedDirs: ['extensions/deferred-triggers'],
    typecheck: { config: 'tools/deferred-triggers/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'session-changes',
    dir: 'tools/session-changes',
    groups: ['extensions'],
    ownedDirs: ['extensions/session-changes'],
    typecheck: { config: 'tools/session-changes/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 3,
  },
  {
    id: 'computer-use',
    dir: 'tools/computer-use',
    groups: ['extensions'],
    ownedDirs: ['extensions/computer-use'],
    tsxConfig: 'tools/computer-use/tsconfig.runtime.json',
    typecheck: { config: 'tools/computer-use/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastBatch: { batches: 3 },
    fastConcurrency: 2,
  },
  {
    id: 'image-context-guard',
    dir: 'extensions/image-context-guard',
    tsxConfig: 'extensions/image-context-guard/tsconfig.json',
    typecheck: { config: 'extensions/image-context-guard/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastConcurrency: 1,
  },
  {
    id: 'playwright',
    dir: 'tools/playwright',
    groups: ['extensions'],
    ownedDirs: ['extensions/playwright'],
    tsxConfig: 'tools/playwright/tsconfig.runtime.json',
    typecheck: { config: 'tools/playwright/tsconfig.json', compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' },
    fastBatch: { batches: 2 },
  },
];

/** All valid package ids in registration order (matches `run-tests.mjs --list`). */
export const ALL_PACKAGE_IDS = PACKAGE_REGISTRY.map((entry) => entry.id);

/**
 * Named package groups consumable by scripts/run-package-group.mjs and the
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
 * The packages merged into the single "root" fast-batch runner: they share the
 * repo-root cwd, need no tsx path aliases, and have no dedicated batch mode.
 * run-fast-batched-tests.mjs walks exactly these directories; run-tests.mjs
 * switches to `root` batch mode only when all of them are selected together.
 */
export const ROOT_BATCH_PACKAGE_IDS = PACKAGE_REGISTRY
  .filter((entry) => !entry.testCwd && !entry.tsxConfig && !entry.fastBatch)
  .map((entry) => entry.id);

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
 * classification-precedence order: the install/package owner dir first, then
 * owned dirs, then any explicitly declared (planned or distributed) roots.
 * For every currently registered package without explicit `sourceRoots` this
 * is exactly `[dir, ...ownedDirs]`, so enumeration is unchanged.
 * @param {PackageEntry} entry
 * @returns {string[]}
 */
export function packageSourceRoots(entry) {
  return [...new Set([entry.dir, ...(entry.ownedDirs ?? []), ...(entry.sourceRoots ?? [])])];
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
 * Repo-relative test roots explicitly allowed to be absent before a planned migration.
 * @param {PackageEntry} entry
 * @returns {string[]}
 */
export function packageOptionalTestRoots(entry) {
  return [...new Set(entry.optionalTestRoots ?? [])];
}

/**
 * Repo-relative test-file root for a package (walked by the fast batch runner).
 * Defaults to `<dir>/test`; only `scripts` overrides it because its package
 * directory is itself the test directory.
 * @param {PackageEntry} entry
 * @returns {string}
 */
export function packageTestDir(entry) {
  return entry.testDir ?? `${entry.dir}/test`;
}

/**
 * Fast-batch metadata for run-fast-batched-tests.mjs, or null when the package
 * has no dedicated batch mode.
 * @param {PackageEntry} entry
 * @returns {{ mode: string, testDir: string, testDirs: string[], optionalTestDirs: string[], batches: number, tsxConfig: string | null, testCwd: string | null } | null}
 */
export function fastBatchMetadata(entry) {
  if (!entry.fastBatch) return null;
  return {
    mode: entry.id,
    testDir: packageTestDir(entry),
    // Every routed test root is walked; only explicitly planned roots may be absent.
    testDirs: packageTestRoots(entry),
    optionalTestDirs: packageOptionalTestRoots(entry),
    batches: entry.fastBatch.batches,
    tsxConfig: entry.tsxConfig ?? null,
    testCwd: entry.testCwd ?? null,
  };
}

/**
 * Typecheck project for scripts/run-typechecks.mjs, or null when the package
 * has no TypeScript project.
 * @param {PackageEntry} entry
 * @returns {{ id: string, config: string, compiler: string } | null}
 */
export function typecheckProjectFor(entry) {
  if (!entry.typecheck) return null;
  return { id: entry.id, config: entry.typecheck.config, compiler: entry.typecheck.compiler };
}

/**
 * The shared/ source tree has no own package.json; it is typechecked with the
 * extension's TypeScript and consumed by extension, analysis, and several
 * extensions/*. It is not a test package, but it is always the first
 * typecheck project.
 */
export const SHARED_TYPECHECK_PROJECT = {
  id: 'shared',
  config: 'shared/tsconfig.json',
  compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc',
};

/** Full typecheck project list in canonical order (shared first). */
export const TYPECHECK_PROJECTS = [
  SHARED_TYPECHECK_PROJECT,
  ...PACKAGE_REGISTRY
    .map(typecheckProjectFor)
    .filter((project) => project !== null),
];

/**
 * Package/directory pairs — the classification view of the registry used by
 * test-impact.mjs and run-test-files.mjs. Built from every package's routed
 * source roots (`dir` + `ownedDirs` + explicit `sourceRoots`) and test roots,
 * in registration order with per-package de-duplication, so distributed and
 * planned roots classify to their verification id like any package dir.
 * `ownedDirs` include compatibility adapters and implementation files whose
 * tests remain with another package.
 * @typedef {{ id: string, dir: string }} PackageDirective
 * @type {PackageDirective[]}
 */
export const PACKAGE_DIRECTIVES = PACKAGE_REGISTRY.flatMap((entry) => {
  const directives = [];
  const seen = new Set();
  for (const root of [...packageSourceRoots(entry), ...packageTestRoots(entry)]) {
    if (seen.has(root)) continue;
    seen.add(root);
    directives.push({ id: entry.id, dir: root });
  }
  return directives;
});

/**
 * Repo-relative paths whose changes can affect the test run of MORE than one
 * package, or are the test tooling itself. A change here selects ALL packages.
 *
 * Categories:
 *  - test tooling: the runners, the custom reporter, the group adapter, and
 *    shared script helpers (scripts/lib/). Script tests have their own
 *    package so changing one does not rerun every product package.
 *  - root toolchain config: root package.json / lockfile (provide tsx used by the
 *    extensions/* packages + @types/node) and the node version pins.
 *  - cross-cutting shared source: shared/ is imported at runtime by extension,
 *    analysis, and several extensions/*, so it has no single owning package.
 */
const GLOBAL_INFRA_EXACT_PATHS = new Set([
  'scripts/run-tests.mjs',
  'scripts/run-test-files.mjs',
  'scripts/run-affected-tests.mjs',
  'scripts/run-fast-extension-tests.mjs',
  'scripts/run-fast-batched-tests.mjs',
  'scripts/run-package-group.mjs',
  'scripts/test-reporter.mjs',
  'package.json',
  'package-lock.json',
  '.node-version',
  // Shared tool eligibility/assembly affects primary, child, and inventory runtimes.
  'tools/index.ts',
  'tools/backend.ts',
  'tools/tsconfig.json',
  'application/hosts/vscode/tsconfig.json',
]);

/** File extensions treated as routable code for ownership checks. */
const CODE_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.jsx'];

/**
 * True for a repo-relative code file that no package routes and that is not
 * global test infrastructure. Such a file is "unknown ownership": affected-test
 * routing must broaden verification (run everything) instead of silently
 * selecting zero tests. Root maintenance scripts (`scripts/*.mjs`) are owned by
 * the `scripts` package and never count as unknown.
 * @param {string} filePath - repo-relative path with forward slashes
 * @returns {boolean}
 */
export function isUnownedCodeSource(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return false;
  }
  if (isGlobalTestInfra(filePath)) return false;
  if (classifyFileToPackage(filePath)) return false;
  if (filePath.startsWith('scripts/') && filePath.endsWith('.mjs')) return false;
  return CODE_SOURCE_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

const GLOBAL_INFRA_PREFIXES = [
  'scripts/lib/',
  'shared/',
  // Discovery shims and backend tools cross package boundaries. Keep their
  // integration coverage selected while the tool migration is incremental.
  'extensions/ask-user/',
  'tools/session-control/',
];

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

/**
 * True if a repo-relative, forward-slash path is global test-infrastructure /
 * config (a change here selects ALL packages).
 * @param {string} filePath
 * @returns {boolean}
 */
export function isGlobalTestInfra(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return false;
  }
  if (GLOBAL_INFRA_EXACT_PATHS.has(filePath)) {
    return true;
  }
  return GLOBAL_INFRA_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

/**
 * Reduce a list of changed file paths to a run plan.
 *
 * If ANY file is global test-infrastructure/config, `selectAll` is true and
 * `packageIds` is the full set (caller should run all packages). Otherwise
 * `packageIds` is the sorted, de-duplicated set of affected package ids.
 * Changed code files under no registered root are unknown ownership: they
 * set `selectAll` and are listed in `unowned` so verification broadens
 * instead of silently selecting zero tests. Non-code paths (docs, settings,
 * manifests outside packages) stay ignored.
 *
 * @param {Iterable<string>} files - repo-relative, forward-slash paths
 * @returns {{ selectAll: boolean, packageIds: string[], unowned: string[] }}
 */
export function mapFilesToPackages(files) {
  let selectAll = false;
  const ids = new Set();
  const unowned = [];
  for (const file of files) {
    if (isGlobalTestInfra(file)) {
      selectAll = true;
      continue;
    }
    const id = classifyFileToPackage(file);
    if (id) {
      ids.add(id);
    } else if (file.startsWith('scripts/') && file.endsWith('.mjs')) {
      // Root maintenance scripts (typecheck/model sync/install/doctor/etc.)
      // are exercised by the scripts package. The cross-package test
      // runners and scripts/lib were already promoted to selectAll above.
      ids.add('scripts');
    } else if (isUnownedCodeSource(file)) {
      // Unknown ownership must broaden, never select zero tests.
      selectAll = true;
      unowned.push(file);
    }
  }
  return {
    selectAll,
    packageIds: [...ids].sort(),
    unowned,
  };
}
