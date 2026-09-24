import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Native sidecar dependencies keep their existing extension-local owners. */
export const NATIVE_DEPENDENCY_OWNERS = Object.freeze({
  'computer-use': Object.freeze(['extensions', 'computer-use']),
  playwright: Object.freeze(['extensions', 'playwright']),
});

function resolveRepositoryRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError('repositoryRoot must be an absolute path; native dependency ownership never falls back to process.cwd()');
  }
  return path.resolve(value);
}

/** Resolve one of the stable native dependency owners from the repository root. */
export function resolveNativeOwnerRoot(owner, { repositoryRoot: root = repositoryRoot } = {}) {
  const ownerPath = Object.hasOwn(NATIVE_DEPENDENCY_OWNERS, owner)
    ? NATIVE_DEPENDENCY_OWNERS[owner]
    : undefined;
  if (!ownerPath) {
    throw new Error(`Unknown native dependency owner "${owner}" (expected computer-use or playwright)`);
  }
  return path.join(resolveRepositoryRoot(root), ...ownerPath);
}

/** Resolve a path owned by a native sidecar without re-deriving its root. */
export function resolveNativeOwnerPath(owner, relativeSegments, options = {}) {
  if (!Array.isArray(relativeSegments) || relativeSegments.some((segment) => typeof segment !== 'string')) {
    throw new TypeError('relativeSegments must be an array of path segments');
  }
  const ownerRoot = resolveNativeOwnerRoot(owner, options);
  const target = path.resolve(ownerRoot, ...relativeSegments);
  if (target !== ownerRoot && !target.startsWith(`${ownerRoot}${path.sep}`)) {
    throw new Error(`Native owner path escapes ${owner}: ${relativeSegments.join(path.sep)}`);
  }
  return target;
}

/** Create Node's ordinary package resolver anchored to the selected sidecar. */
export function createNativeOwnerRequire(owner, options = {}) {
  return createRequire(path.join(resolveNativeOwnerRoot(owner, options), 'package.json'));
}
