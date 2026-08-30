// Pure helpers that map repo-relative file paths to test package ids and to the
// "global test-infrastructure/config" category. Shared by
// scripts/run-test-files.mjs (file -> package classification) and
// scripts/run-affected-tests.mjs (git-diff -> affected packages / select-all).
//
// The package<->directory mapping mirrors the PACKAGE_CONFIGS in
// scripts/run-tests.mjs: each package owns exactly one top-level directory
// (extension/, analysis/, or extensions/<id>/). The directory layout is the
// stable, low-drift source of truth; the ids must match run-tests.mjs because
// run-affected-tests.mjs forwards them as `--package <id>` flags.

/**
 * Each package and the repo-relative directory it owns.
 * Order is irrelevant — no directory is a prefix of another
 * (`extension/` vs `extensions/<id>/` differ at the char after `extension`).
 * @typedef {{ id: string, dir: string }} PackageDirective
 */
export const PACKAGE_DIRECTIVES = [
  { id: 'extension', dir: 'extension' },
  { id: 'analysis', dir: 'analysis' },
  { id: 'scripts', dir: 'scripts/test' },
  { id: 'cwd-skills', dir: 'extensions/cwd-skills' },
  { id: 'safeguard', dir: 'extensions/safeguard' },
  { id: 'skill-pruner', dir: 'extensions/skill-pruner' },
  { id: 'subagent', dir: 'extensions/subagent' },
  { id: 'ask-user', dir: 'extensions/ask-user' },
  { id: 'warm-bash', dir: 'extensions/warm-bash' },
  { id: 'copilot-model-discovery', dir: 'extensions/copilot-model-discovery' },
  { id: 'web-access-guard', dir: 'extensions/web-access-guard' },
  { id: 'tool-result-pruner', dir: 'extensions/tool-result-pruner' },
  { id: 'session-reviewer', dir: 'extensions/session-reviewer' },
  { id: 'deferred-triggers', dir: 'extensions/deferred-triggers' },
  { id: 'session-changes', dir: 'extensions/session-changes' },
  { id: 'computer-use', dir: 'extensions/computer-use' },
  { id: 'image-context-guard', dir: 'extensions/image-context-guard' },
];

/** All valid package ids (matches `node scripts/run-tests.mjs --list`). */
export const ALL_PACKAGE_IDS = PACKAGE_DIRECTIVES.map((entry) => entry.id);

/**
 * Repo-relative paths whose changes can affect the test run of MORE than one
 * package, or are the test tooling itself. A change here selects ALL packages.
 *
 * Categories:
 *  - test tooling: the runner, the custom reporter, the sibling DX scripts, the
 *    and shared script helpers (scripts/lib/). Script tests have their own
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
  'scripts/test-reporter.mjs',
  'package.json',
  'package-lock.json',
  '.nvmrc',
  '.node-version',
  '.githooks/pre-commit',
  '.githooks/pre-push',
]);

const GLOBAL_INFRA_PREFIXES = [
  'scripts/lib/',
  'shared/',
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
 * `packageIds` is the sorted, de-duplicated set of affected package ids
 * (possibly empty if no changed file maps to a package).
 *
 * @param {Iterable<string>} files - repo-relative, forward-slash paths
 * @returns {{ selectAll: boolean, packageIds: string[] }}
 */
export function mapFilesToPackages(files) {
  let selectAll = false;
  const ids = new Set();
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
    }
  }
  return {
    selectAll,
    packageIds: [...ids].sort(),
  };
}
