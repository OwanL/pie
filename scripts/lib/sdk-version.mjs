// Pure helpers for reading the Pi source version and comparing semver-ish
// versions. The in-tree package manifests are authoritative; host dependency
// ranges and lockfiles do not define the source-built Pi runtime version.
// Consumed by scripts/install/toolchain.mjs and scripts/build/pi-runtime.mjs.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const PI_SOURCE_PACKAGE_DIRS = ['tui', 'ai', 'agent', 'coding-agent'];

/**
 * Read the shared Pi source version from its four in-tree package manifests.
 * @param {string} repoRoot - absolute path to the repo root
 * @returns {string} e.g. "0.80.6"
 * @throws if any source manifest/version is missing or the versions disagree
 */
export function readPinnedPiSourceVersion(repoRoot) {
  const manifests = PI_SOURCE_PACKAGE_DIRS.map((directory) => {
    const manifestPath = path.join(repoRoot, 'harness', 'pi', 'packages', directory, 'package.json');
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      throw new Error(`Could not read Pi source package manifest (${manifestPath}): ${err.message}`);
    }
    const version = manifest && typeof manifest === 'object' ? manifest.version : undefined;
    if (typeof version !== 'string' || version.length === 0) {
      throw new Error(`Pi source package manifest has no version (${manifestPath})`);
    }
    return { directory, version };
  });

  const version = manifests[0].version;
  const mismatches = manifests.filter((manifest) => manifest.version !== version);
  if (mismatches.length > 0) {
    const detail = manifests.map(({ directory, version: value }) => `${directory}=${value}`).join(', ');
    throw new Error(`Pi source package versions do not match: ${detail}`);
  }
  return version;
}

/**
 * Coerce a version string into a clean "major.minor.patch" tuple array.
 * Strips leading ranges (^, ~, >, >=, <, <=, =, v) and any prerelease/build.
 * @param {string} input
 * @returns {number[]} e.g. [0, 80, 6]
 */
export function coerceVersion(input) {
  if (typeof input !== 'string') return [0, 0, 0];
  const cleaned = input.replace(/^[\^~>=<v ]+/, '').trim();
  const match = cleaned.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return [0, 0, 0];
  return [
    Number.parseInt(match[1], 10) || 0,
    Number.parseInt(match[2], 10) || 0,
    Number.parseInt(match[3], 10) || 0,
  ];
}

/**
 * Compare two version strings.
 * @returns {-1 | 0 | 1}
 */
export function compareVersions(a, b) {
  const ta = coerceVersion(a);
  const tb = coerceVersion(b);
  for (let i = 0; i < 3; i++) {
    if (ta[i] < tb[i]) return -1;
    if (ta[i] > tb[i]) return 1;
  }
  return 0;
}

/** True iff `actual` >= `minimum` (semver-ish, ranges stripped). */
export function gte(actual, minimum) {
  return compareVersions(actual, minimum) >= 0;
}

/** Repo root inferred from this file's location: scripts/lib/ -> ../.. */
export function inferRepoRoot() {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''));
  // scripts/lib/sdk-version.mjs -> repo root is two parents up
  return path.resolve(here, '..', '..');
}

// When invoked directly as `node scripts/lib/sdk-version.mjs`, print the
// in-tree Pi source version for command-line inspection.
const invokedDirectly = process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const root = inferRepoRoot();
  try {
    process.stdout.write(`${readPinnedPiSourceVersion(root)}\n`);
  } catch (err) {
    console.error(String(err && err.message ? err.message : err));
    process.exit(1);
  }
}
