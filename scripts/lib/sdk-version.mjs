// Pure helpers for reading the pi SDK pin from the extension lockfile and
// comparing semver-ish versions. Shared by scripts/bootstrap.mjs,
// scripts/doctor.mjs, and the shell installers (which invoke this file as a
// CLI: `node scripts/lib/sdk-version.mjs` prints the locked version).
//
// The extension lock is the source of truth for the SDK the pie backend loads;
// the global `pi` CLI is pinned to that same exact version so a `npm i -g`
// upgrade (or a different version on another machine) cannot silently swap
// the SDK out from under the backend. See README.md → "SDK version drift".

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const SDK_PACKAGE = '@earendil-works/pi-coding-agent';

/**
 * Read the exact version of the pi SDK that the extension lock pins.
 * @param {string} repoRoot - absolute path to the repo root
 * @returns {string} e.g. "0.80.6"
 * @throws if the lockfile or package entry is missing/malformed
 */
export function readPinnedSdkVersion(repoRoot) {
  const lockPath = path.join(repoRoot, 'extension', 'package-lock.json');
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read extension lockfile (${lockPath}): ${err.message}`);
  }

  // npm v3 lockfile shape: packages["node_modules/@earendil-works/pi-coding-agent"].version
  const packages = lock && typeof lock === 'object' ? lock.packages : undefined;
  if (packages && packages[`node_modules/${SDK_PACKAGE}`]) {
    const v = packages[`node_modules/${SDK_PACKAGE}`].version;
    if (typeof v === 'string' && v.length > 0) return v;
  }
  // npm v1/legacy lockfile shape: dependencies["@earendil-works/pi-coding-agent"].version
  if (lock && lock.dependencies && lock.dependencies[SDK_PACKAGE]) {
    const v = lock.dependencies[SDK_PACKAGE].version;
    if (typeof v === 'string' && v.length > 0) return v;
  }

  throw new Error(
    `${SDK_PACKAGE} not found in extension lockfile (${lockPath}). Run \`npm install\` in extension/ first.`,
  );
}

/**
 * Read the declared (range) dependency from extension/package.json, e.g. "^0.80.6".
 * Used by doctor to surface declared-vs-locked drift.
 * @param {string} repoRoot
 * @returns {string | null}
 */
export function readDeclaredSdkRange(repoRoot) {
  const pkgPath = path.join(repoRoot, 'extension', 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    return null;
  }
  const v = pkg && pkg.dependencies ? pkg.dependencies[SDK_PACKAGE] : undefined;
  return typeof v === 'string' && v.length > 0 ? v : null;
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

// When invoked directly as `node scripts/lib/sdk-version.mjs`, print the pinned
// version so shell installers can consume it without duplicating the parsing.
const invokedDirectly = process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const root = inferRepoRoot();
  try {
    process.stdout.write(`${readPinnedSdkVersion(root)}\n`);
  } catch (err) {
    console.error(String(err && err.message ? err.message : err));
    process.exit(1);
  }
}
