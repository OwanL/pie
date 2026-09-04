import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Plain-Node adapter for the canonical TypeScript traversal policy.
 *
 * Root scripts run without a TypeScript loader, so parse only the intentionally
 * simple `dir: "..."` data literals instead of maintaining another exclusion
 * list. The adapter fails closed when the policy shape drifts.
 */
const policyPath = fileURLToPath(new URL('../../shared/traversal-policy.ts', import.meta.url));
const policySource = readFileSync(policyPath, 'utf8');
const PROTECTED_CLASSES = new Set([
  'dependencies', 'version-control', 'generated-build', 'caches', 'coverage',
  'runtime-data', 'sessions', 'logs', 'packaged-artifacts', 'temp-sdk-trees',
]);

export function parseProtectedDirectoryNames(source, sourceName = 'traversal policy') {
  const declaration = source.match(/PROTECTED_DIRECTORIES[^=]*=\s*\[([\s\S]*?)\n\s*\];/u);
  if (!declaration) throw new Error(`Cannot locate PROTECTED_DIRECTORIES in ${sourceName}`);
  const body = declaration[1].replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '');
  const entryPattern = /\{\s*dir:\s*(['"])([^'"]+)\1\s*,\s*className:\s*(['"])([^'"]+)\3\s*\}/gu;
  const entries = [...body.matchAll(entryPattern)];
  const residue = body.replace(entryPattern, '').replace(/[\s,]/gu, '');
  if (residue || entries.length === 0) {
    throw new Error(`Canonical traversal policy has an unsupported or unparsed entry in ${sourceName}`);
  }
  const names = entries.map((match) => match[2]);
  const invalidClass = entries.find((match) => !PROTECTED_CLASSES.has(match[4]));
  if (invalidClass || new Set(names).size !== names.length) {
    throw new Error(`Canonical traversal policy has an invalid class or duplicate directory in ${sourceName}`);
  }
  return names;
}

export const PROTECTED_DIRECTORY_NAMES = Object.freeze(parseProtectedDirectoryNames(policySource, policyPath));

const protectedDirectoryMatchers = PROTECTED_DIRECTORY_NAMES.map((name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    .replace(/\\\*/gu, '[^/\\\\]*')
    .replace(/\\\?/gu, '[^/\\\\]');
  return new RegExp(`^${escaped}$`, 'u');
});

/** Basename policy used by broad root walkers. */
export function isProtectedDirectoryName(name) {
  return protectedDirectoryMatchers.some((matcher) => matcher.test(name));
}
