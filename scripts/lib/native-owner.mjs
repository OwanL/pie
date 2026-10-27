import { existsSync, lstatSync, readFileSync } from 'node:fs';
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

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolvePreparedModuleRoot(owner, value) {
  if (owner !== 'playwright') {
    throw new Error(`Prepared module resolution is unavailable for native dependency owner "${owner}"`);
  }
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError('moduleResolutionRoot must be an explicit absolute path inside the prepared Playwright payload');
  }
  const moduleRoot = path.resolve(value);
  const payloadRoot = path.dirname(moduleRoot);
  const toolRuntimeRoot = path.dirname(payloadRoot);
  const resourcesRoot = path.dirname(toolRuntimeRoot);
  if (path.basename(moduleRoot) !== 'node_modules' || path.basename(payloadRoot) !== 'playwright-runtime'
    || path.basename(toolRuntimeRoot) !== 'tool-runtimes' || path.basename(resourcesRoot) !== 'resources') {
    throw new Error('Prepared Playwright module resolution root must be resources/tool-runtimes/playwright-runtime/node_modules');
  }
  try {
    const info = lstatSync(moduleRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('not a regular directory');
  } catch (error) {
    throw new Error(`Prepared Playwright module owner is missing or invalid: ${moduleRoot}`, { cause: error });
  }
  return moduleRoot;
}

/** Resolve one of the stable native dependency owners from the repository root. */
export function resolveNativeOwnerRoot(owner, options = {}) {
  let root = options.repositoryRoot;
  const { moduleResolutionRoot } = options;
  const ownerPath = Object.hasOwn(NATIVE_DEPENDENCY_OWNERS, owner)
    ? NATIVE_DEPENDENCY_OWNERS[owner]
    : undefined;
  if (!ownerPath) {
    throw new Error(`Unknown native dependency owner "${owner}" (expected computer-use or playwright)`);
  }
  if (moduleResolutionRoot !== undefined) {
    if (root !== undefined) throw new TypeError('repositoryRoot and moduleResolutionRoot cannot both select a native dependency owner');
    return resolvePreparedModuleRoot(owner, moduleResolutionRoot);
  }
  if (root === undefined) {
    const copiedRuntimeLayout = path.basename(repositoryRoot) === 'tool-runtimes'
      && path.basename(path.dirname(repositoryRoot)) === 'resources';
    const marker = path.join(repositoryRoot, 'manifest.json');
    if (copiedRuntimeLayout || (existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')).codeOnly === true)) {
      throw new Error(`Native dependency owner "${owner}" preparation unavailable: code-only packaged tool runtimes have no implicit repository root`);
    }
    root = repositoryRoot;
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

function createPreparedOwnerRequire(ownerRoot) {
  const nativeRequire = createRequire(path.join(ownerRoot, 'package.json'));
  const resolveOwned = (specifier, options) => {
    const resolved = nativeRequire.resolve(specifier, options);
    if (!isWithin(ownerRoot, resolved)) {
      throw new Error(`Packaged Playwright dependency resolves outside its prepared owner: ${specifier}`);
    }
    return resolved;
  };
  const ownedRequire = (specifier, ...args) => {
    resolveOwned(specifier);
    return nativeRequire(specifier, ...args);
  };
  ownedRequire.resolve = resolveOwned;
  return ownedRequire;
}

/** Create Node's ordinary package resolver anchored to the selected sidecar. */
export function createNativeOwnerRequire(owner, options = {}) {
  const ownerRoot = resolveNativeOwnerRoot(owner, options);
  return options.moduleResolutionRoot === undefined
    ? createRequire(path.join(ownerRoot, 'package.json'))
    : createPreparedOwnerRequire(ownerRoot);
}
