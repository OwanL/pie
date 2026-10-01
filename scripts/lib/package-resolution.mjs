import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The application distribution and its npm dependency owner are deliberately
 * explicit. Native tools keep their existing sidecar owners and are not
 * redirected through this module.
 */
export const PACKAGE_LAYOUTS = Object.freeze({
  current: Object.freeze({
    distribution: ['application', 'hosts', 'vscode'],
    dependencies: ['application', 'hosts', 'vscode'],
  }),
  planned: Object.freeze({
    distribution: ['application', 'hosts', 'vscode'],
    dependencies: ['application', 'hosts', 'vscode'],
  }),
});

const PI_PACKAGE_NAMES = Object.freeze([
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-tui',
]);
const LEGACY_PI_PACKAGE_NAMES = Object.freeze([
  '@mariozechner/pi-coding-agent',
  '@mariozechner/pi-agent-core',
  '@mariozechner/pi-ai',
  '@mariozechner/pi-tui',
]);
const PI_PACKAGE_ALIASES = new Map(LEGACY_PI_PACKAGE_NAMES.map((name, index) => [name, PI_PACKAGE_NAMES[index]]));
// Specifier spellings that normalize to the SDK's nested TypeBox package,
// mirroring the alias treatment in createTypeScriptResolution/createTsxResolution.
const SDK_SPECIFIER_ALIASES = new Map([...PI_PACKAGE_ALIASES, ['@sinclair/typebox', 'typebox']]);

function resolveAbsoluteRoot(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path; package resolution never falls back to process.cwd()`);
  }
  return path.resolve(value);
}

/**
 * Resolve the current or planned host package roots relative to this module,
 * never relative to the caller's working directory.
 *
 * `repositoryRoot` is an explicit test/embedding seam and must be absolute.
 */
export function resolvePackageRoots(layout = 'current', { repositoryRoot: root = repositoryRoot } = {}) {
  const definition = PACKAGE_LAYOUTS[layout];
  if (!definition) {
    throw new Error(`Unknown package layout "${layout}" (expected current or planned)`);
  }
  const absoluteRepositoryRoot = resolveAbsoluteRoot(root, 'repositoryRoot');
  const distributionRoot = path.join(absoluteRepositoryRoot, ...definition.distribution);
  const dependencyOwnerRoot = path.join(absoluteRepositoryRoot, ...definition.dependencies);
  return Object.freeze({
    repositoryRoot: absoluteRepositoryRoot,
    distributionRoot,
    dependencyOwnerRoot,
  });
}

function resolveOwnerRoot(options = {}) {
  if (options.dependencyOwnerRoot !== undefined) {
    return resolveAbsoluteRoot(options.dependencyOwnerRoot, 'dependencyOwnerRoot');
  }
  return resolvePackageRoots(options.layout ?? 'current', {
    repositoryRoot: options.repositoryRoot ?? repositoryRoot,
  }).dependencyOwnerRoot;
}

/** Create a Node resolver anchored to the selected package owner. */
export function createOwnerRequire(options = {}) {
  return createRequire(path.join(resolveOwnerRoot(options), 'package.json'));
}

/**
 * Specifiers whose runtime identity must come from the SDK's private nested
 * graph rather than the dependency owner's node_modules: owned Pi spellings
 * and the TypeBox spellings participate in `===` identity checks, so a hoisted
 * owner copy would split identities with the SDK graph. Every other specifier
 * keeps plain owner-first resolution; there is no global catch-all.
 */
const SDK_IDENTITY_SPECIFIER_NAMES = Object.freeze([
  ...PI_PACKAGE_NAMES,
  ...LEGACY_PI_PACKAGE_NAMES,
  'typebox',
  '@sinclair/typebox',
]);

function isSdkIdentitySpecifier(specifier) {
  return SDK_IDENTITY_SPECIFIER_NAMES.some(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  );
}

/**
 * Resolve a runtime module from the selected owner without relying on source
 * ancestry. Identity-sensitive spellings always resolve through the canonical
 * SDK nested graph, even when the owner hoists its own copy; all other
 * specifiers resolve from the owner directly.
 */
export function resolveOwnerModule(specifier, options = {}) {
  if (typeof specifier !== 'string' || specifier.length === 0) {
    throw new TypeError('specifier must be a non-empty package specifier');
  }
  if (isSdkIdentitySpecifier(specifier)) {
    return resolveSdkModule(specifier, options);
  }
  return createOwnerRequire(options).resolve(specifier);
}

function packageInfoAt(root, packageName, conditions = ['import', 'require', 'default'], { allowEntryless = false } = {}) {
  const absoluteRoot = path.resolve(root);
  const manifestPath = path.join(absoluteRoot, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Expected ${packageName} package manifest at ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== packageName) {
    throw new Error(`Expected ${packageName} at ${manifestPath}, found ${manifest.name ?? '(unnamed package)'}`);
  }
  const rootTarget = manifest.exports && typeof manifest.exports === 'object'
    ? exportValueForCondition(manifest.exports['.'] ?? manifest.exports, conditions)
    : undefined;
  const entryTarget = rootTarget ?? manifest.module ?? manifest.main ?? manifest.types;
  if (typeof entryTarget !== 'string' && !allowEntryless) {
    throw new Error(`No resolvable package entry for ${packageName} in ${manifestPath}`);
  }
  return Object.freeze({
    name: packageName,
    entry: typeof entryTarget === 'string' ? path.resolve(absoluteRoot, entryTarget) : undefined,
    root: absoluteRoot,
    manifest,
  });
}

function packageInfoFromOwner(ownerRoot, packageName, options) {
  return packageInfoAt(path.join(ownerRoot, 'node_modules', ...packageName.split('/')), packageName, undefined, options);
}

/** Find a package root through the supplied require context's Node search paths. */
function packageRootFromRequire(packageRequire, packageName, context, { allowMissing = false } = {}) {
  const searchPaths = packageRequire.resolve.paths(packageName) ?? [];
  for (const modulesRoot of searchPaths) {
    const packageRoot = path.join(modulesRoot, ...packageName.split('/'));
    const manifestPath = path.join(packageRoot, 'package.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      throw new Error(`Invalid ${packageName} manifest in candidate SDK graph at ${manifestPath}: ${error.message}`, { cause: error });
    }
    if (manifest.name !== packageName) {
      throw new Error(`Expected ${packageName} in candidate SDK graph at ${manifestPath}, found ${manifest.name ?? '(unnamed package)'}`);
    }
    return realpathSync(packageRoot);
  }
  if (allowMissing) return undefined;
  throw new Error(`Candidate SDK graph at ${context} cannot resolve ${packageName} through its Node module search paths (${searchPaths.join(path.delimiter)})`);
}

function coherentPiPackageDependencies(sdk, piPackages) {
  const selectedRoots = new Map(PI_PACKAGE_NAMES.map((name) => [
    name,
    realpathSync(name === sdk.name ? sdk.root : piPackages[name].root),
  ]));
  const owners = PI_PACKAGE_NAMES.map((name) => [name, name === sdk.name ? sdk : piPackages[name]]);
  for (const [ownerName, ownerPackage] of owners) {
    const ownerRequire = createRequire(path.join(ownerPackage.root, 'package.json'));
    for (const dependencyName of Object.keys(ownerPackage.manifest.dependencies ?? {})) {
      const selectedRoot = selectedRoots.get(dependencyName);
      if (!selectedRoot) continue;
      const resolvedRoot = packageRootFromRequire(ownerRequire, dependencyName, ownerPackage.root);
      if (resolvedRoot !== selectedRoot) {
        throw new Error(`Incoherent SDK Pi package resolution: ${ownerName} resolves ${dependencyName} at ${resolvedRoot}, but the selected SDK root is ${selectedRoot}`);
      }
    }
  }
}

function coherentTypeboxPackage(sdk, sdkRequire, piPackages) {
  const typeboxPackage = packageInfoAt(packageRootFromRequire(sdkRequire, 'typebox', sdk.root), 'typebox');
  const typeboxRoot = realpathSync(typeboxPackage.root);
  for (const [ownerName, ownerPackage] of [
    ['@earendil-works/pi-coding-agent', sdk],
    ...Object.entries(piPackages).filter(([name]) => name !== 'typebox'),
  ]) {
    const ownerRequire = createRequire(path.join(ownerPackage.root, 'package.json'));
    const ownerTypeboxRoot = packageRootFromRequire(ownerRequire, 'typebox', ownerPackage.root);
    if (ownerTypeboxRoot !== typeboxRoot) {
      throw new Error(`Incoherent SDK TypeBox resolution: ${ownerName} resolves typebox at ${ownerTypeboxRoot}, but @earendil-works/pi-coding-agent resolves it at ${typeboxRoot}`);
    }
  }
  return typeboxPackage;
}

/**
 * Resolve the exact SDK and its private dependency graph. An explicit sdkPath
 * is the candidate's package directory; all of its Pi packages and TypeBox
 * must resolve from that package's own Node context, never from the host owner.
 */
export function resolveSdkPackages(options = {}) {
  if (options.sdkPath !== undefined) {
    const sdkPath = resolveAbsoluteRoot(options.sdkPath, 'sdkPath');
    const sdk = packageInfoAt(sdkPath, '@earendil-works/pi-coding-agent');
    const sdkRequire = createRequire(path.join(sdk.root, 'package.json'));
    const nested = Object.fromEntries(
      PI_PACKAGE_NAMES.slice(1).map((name) => [name, packageInfoAt(
        packageRootFromRequire(sdkRequire, name, sdk.root),
        name,
      )]),
    );
    coherentPiPackageDependencies(sdk, nested);
    nested.typebox = coherentTypeboxPackage(sdk, sdkRequire, nested);
    return Object.freeze({
      sdk,
      sdkRequire,
      packages: Object.freeze(nested),
      piAi: nested['@earendil-works/pi-ai'],
    });
  }

  const ownerRoot = resolveOwnerRoot(options);
  const sdk = packageInfoFromOwner(ownerRoot, '@earendil-works/pi-coding-agent');
  const sdkRequire = createRequire(sdk.entry);
  const nested = Object.fromEntries(
    PI_PACKAGE_NAMES.slice(1).map((name) => [name, packageInfoAt(
      path.join(sdk.root, 'node_modules', ...name.split('/')),
      name,
    )]),
  );
  nested.typebox = packageInfoAt(path.join(sdk.root, 'node_modules', 'typebox'), 'typebox');
  return Object.freeze({
    sdk,
    sdkRequire,
    packages: Object.freeze(nested),
    piAi: nested['@earendil-works/pi-ai'],
  });
}

/** Create a require resolver anchored to the selected SDK entry point. */
export function createSdkRequire(options = {}) {
  return resolveSdkPackages(options).sdkRequire;
}

/**
 * Absolute path of the dependency owner's TypeScript compiler entry. Registry
 * typecheck projects keep declaring which owner provides the compiler; this
 * helper owns the owner-relative resolution of the binary itself so callers
 * never re-derive `node_modules` depth from process.cwd() or repo-relative
 * string concatenation.
 */
export function resolveTypeScriptCompiler(options = {}) {
  return createOwnerRequire(options).resolve('typescript/bin/tsc');
}

/** Resolve the test CLI from the application dependency owner, not source ancestry. */
export function resolveOwnerTsx(options = {}) {
  return path.join(resolveOwnerRoot(options), 'node_modules', 'tsx', 'dist', 'cli.mjs');
}

/** Resolve a runtime module from the selected SDK's own dependency graph. */
function resolvePackageExport(packageInfo, suffix, conditions = ['import', 'require', 'default']) {
  const exports = packageInfo.manifest.exports;
  if (!exports || typeof exports !== 'object' || Array.isArray(exports)) return undefined;
  const exportKey = suffix ? `.${suffix}` : '.';
  let exportValue = exports[exportKey];
  let capture;
  if (exportValue === undefined) {
    for (const [pattern, value] of Object.entries(exports)) {
      const star = pattern.indexOf('*');
      if (star < 0) continue;
      const prefix = pattern.slice(0, star);
      const suffixPattern = pattern.slice(star + 1);
      if (!exportKey.startsWith(prefix) || !exportKey.endsWith(suffixPattern)) continue;
      exportValue = value;
      capture = exportKey.slice(prefix.length, exportKey.length - suffixPattern.length);
      break;
    }
  }
  const target = exportValueForCondition(exportValue, conditions);
  return target ? path.resolve(packageInfo.root, target.replace('*', capture ?? '')) : undefined;
}

export function resolveSdkModule(specifier, options = {}) {
  if (typeof specifier !== 'string' || specifier.length === 0) {
    throw new TypeError('specifier must be a non-empty package specifier');
  }
  const normalized = [...SDK_SPECIFIER_ALIASES].reduce(
    (value, [legacyName, currentName]) => value === legacyName || value.startsWith(`${legacyName}/`)
      ? `${currentName}${value.slice(legacyName.length)}`
      : value,
    specifier,
  );
  const { sdk, packages } = resolveSdkPackages(options);
  const packageName = PI_PACKAGE_NAMES.find((name) => normalized === name || normalized.startsWith(`${name}/`))
    ?? (normalized === 'typebox' || normalized.startsWith('typebox/') ? 'typebox' : undefined);
  if (!packageName) return createSdkRequire(options).resolve(specifier);
  const packageInfo = packageName === '@earendil-works/pi-coding-agent'
    ? sdk
    : packages[packageName];
  const suffix = normalized.slice(packageName.length);
  return resolvePackageExport(packageInfo, suffix) ?? (!suffix
    ? packageInfo.entry
    : createSdkRequire(options).resolve(specifier));
}

function exportValueForCondition(value, conditions) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  for (const condition of conditions) {
    if (Object.hasOwn(value, condition)) {
      const target = exportValueForCondition(value[condition], conditions);
      if (target !== undefined) return target;
    }
  }
  return undefined;
}

function typeVersionTarget(manifest, subpath) {
  const versionRules = manifest.typesVersions && Object.values(manifest.typesVersions);
  for (const rules of versionRules ?? []) {
    for (const [pattern, targets] of Object.entries(rules)) {
      const star = pattern.indexOf('*');
      const matches = star < 0
        ? subpath === pattern
        : subpath.startsWith(pattern.slice(0, star)) && subpath.endsWith(pattern.slice(star + 1));
      if (!matches || !Array.isArray(targets) || typeof targets[0] !== 'string') continue;
      const capture = star < 0
        ? ''
        : subpath.slice(pattern.slice(0, star).length, subpath.length - pattern.slice(star + 1).length);
      return targets[0].replace('*', capture);
    }
  }
  return undefined;
}

function exportMappings(packageInfo, packageName, conditions) {
  const mappings = [];
  const exports = packageInfo.manifest.exports;
  if (typeof exports === 'string' || (exports && typeof exports === 'object' && !Array.isArray(exports))) {
    const entries = typeof exports === 'string' || !Object.keys(exports).some((key) => key.startsWith('.'))
      ? [['.', exports]] : Object.entries(exports);
    for (const [exportKey, exportValue] of entries) {
      const suffix = exportKey === '.' ? '' : exportKey.slice(2);
      const typeFallback = conditions.includes('types')
        ? (suffix ? typeVersionTarget(packageInfo.manifest, suffix) : packageInfo.manifest.types)
        : undefined;
      const target = (conditions.includes('types') ? exportValueForCondition(exportValue, ['types']) : undefined)
        ?? typeFallback
        ?? exportValueForCondition(exportValue, conditions);
      if (!target || !target.startsWith('./')) continue;
      mappings.push({
        key: suffix ? `${packageName}/${suffix}` : packageName,
        find: suffix.includes('*') ? new RegExp(`^${packageName}/${suffix.replace('*', '(.+)')}$`) : undefined,
        replacement: path.resolve(packageInfo.root, target),
      });
    }
  }
  if (mappings.length === 0 && !exports) {
    const entry = conditions.includes('types')
      ? packageInfo.manifest.types ?? packageInfo.manifest.module ?? packageInfo.manifest.main
      : packageInfo.manifest.module ?? packageInfo.manifest.main;
    if (entry) mappings.push({ key: packageName, replacement: path.resolve(packageInfo.root, entry) });
    else if (existsSync(path.join(packageInfo.root, 'index.js'))) {
      // Node's implicit root, with an adjacent declaration for compiler overlays.
      const declaration = path.join(packageInfo.root, 'index.d.ts');
      mappings.push({ key: packageName, replacement: conditions.includes('types') && existsSync(declaration)
        ? declaration : path.join(packageInfo.root, 'index.js') });
    }
  }
  return mappings;
}

function piAliases(options) {
  const { sdk, packages } = resolveSdkPackages(options);
  const byCurrentName = new Map([
    ['@earendil-works/pi-coding-agent', sdk],
    ...Object.entries(packages),
  ]);
  return LEGACY_PI_PACKAGE_NAMES.map((legacyName, index) => ({
    name: legacyName,
    package: byCurrentName.get(PI_PACKAGE_NAMES[index]),
  })).concat([...byCurrentName].map(([name, packageInfo]) => ({ name, package: packageInfo })));
}

/**
 * TypeScript compiler options shared by moved source roots and registry-owned
 * tsconfigs. Paths point at package declaration exports; type roots stay with
 * the application dependency owner. JSX uses Preact's automatic runtime.
 */
export function createTypeScriptResolution(options = {}) {
  const ownerRoot = resolveOwnerRoot(options);
  const preact = packageInfoFromOwner(ownerRoot, 'preact');
  const paths = {};
  const addPackageMappings = (packageName, packageInfo) => {
    for (const mapping of exportMappings(packageInfo, packageName, ['types', 'import', 'default', 'require'])) {
      paths[mapping.key] = [mapping.replacement];
    }
  };
  for (const { name, package: packageInfo } of piAliases(options)) {
    addPackageMappings(name, packageInfo);
  }
  const { packages } = resolveSdkPackages(options);
  addPackageMappings('typebox', packages.typebox);
  addPackageMappings('@sinclair/typebox', packages.typebox);
  addPackageMappings('preact', preact);
  return Object.freeze({
    baseUrl: ownerRoot,
    paths: Object.freeze(paths),
    typeRoots: Object.freeze([path.join(ownerRoot, 'node_modules', '@types')]),
    jsxImportSource: 'preact',
  });
}

/**
 * Runtime module aliases for tsx configs. Unlike compiler paths, targets use
 * executable exports so fixtures outside the package tree do not depend on
 * ancestor node_modules lookup. Preact uses require exports throughout the
 * test graph so mixed tsx/Node module conditions cannot split its singleton.
 */
export function createTsxResolution(options = {}) {
  const ownerRoot = resolveOwnerRoot(options);
  const preact = packageInfoFromOwner(ownerRoot, 'preact');
  const paths = {};
  const addPackageMappings = (packageName, packageInfo, conditions = ['import', 'require', 'default']) => {
    for (const mapping of exportMappings(packageInfo, packageName, conditions)) {
      paths[mapping.key] = [mapping.replacement];
    }
  };
  for (const { name, package: packageInfo } of piAliases(options)) {
    addPackageMappings(name, packageInfo);
  }
  const { packages } = resolveSdkPackages(options);
  addPackageMappings('typebox', packages.typebox);
  addPackageMappings('@sinclair/typebox', packages.typebox);
  addPackageMappings('preact', preact, ['require', 'default']);
  return Object.freeze({
    baseUrl: ownerRoot,
    paths: Object.freeze(paths),
  });
}

// Node's Preact import and require exports each install their own hooks/options
// singleton. Tests execute both transpiled CJS and ESM through tsx; pin the
// whole Preact test graph to the owner's require exports, including consumers
// which import Preact internally (render-to-string and testing-library/preact).
const PREACT_RUNTIME_PACKAGES = new Set(['preact', 'preact-render-to-string', '@testing-library/preact']);

function runtimeConditionsForPackage(name, conditions) {
  return !conditions.includes('types') && PREACT_RUNTIME_PACKAGES.has(name)
    ? ['require', 'default'] : conditions;
}

/** Runtime dependencies of the candidate SDK and their package roots. */
function sdkRuntimeDependencyGraph(options) {
  if (options.sdkPath === undefined) return { names: new Set(), roots: new Map(), packageRoots: new Set() };
  const { sdk } = resolveSdkPackages(options);
  const names = new Set();
  const roots = new Map();
  const visitedRoots = new Set();
  const pending = [sdk.root];
  while (pending.length > 0) {
    const packageRoot = pending.pop();
    const canonicalRoot = realpathSync(packageRoot);
    if (visitedRoots.has(canonicalRoot)) continue;
    visitedRoots.add(canonicalRoot);
    const manifestPath = path.join(canonicalRoot, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const packageRequire = createRequire(manifestPath);
    for (const name of new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ])) {
      names.add(name);
      const dependencyRoot = packageRootFromRequire(packageRequire, name, canonicalRoot, { allowMissing: true });
      if (!dependencyRoot) continue;
      if (!roots.has(name)) roots.set(name, new Set());
      roots.get(name).add(dependencyRoot);
      pending.push(dependencyRoot);
    }
  }
  return { names, roots, packageRoots: visitedRoots };
}

function isWithinDirectory(filePath, directory) {
  const relative = path.relative(directory, filePath);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function vitePieSourceImporter(importer, sourceRoot, candidatePackageRoots) {
  if (typeof importer !== 'string' || importer.startsWith('\0')) return false;
  const importerPath = path.resolve(importer.split('?', 1)[0]);
  if (!isWithinDirectory(importerPath, sourceRoot)) return false;

  const issuerPaths = [importerPath];
  try {
    issuerPaths.push(realpathSync(importerPath));
  } catch {
    // Vite virtualized or not-yet-written files are still classified by their
    // resolved source path; ordinary package issuers are real files.
  }
  if (issuerPaths.some((issuerPath) => issuerPath.split(path.sep).includes('node_modules'))) return false;
  for (const packageRoot of candidatePackageRoots) {
    if (issuerPaths.some((issuerPath) => isWithinDirectory(issuerPath, packageRoot))) return false;
  }
  return true;
}

function candidateViteDependencyAliases(options, conditions, sdkGraph) {
  if (options.sdkPath === undefined) return [];
  const { sdk, sdkRequire } = resolveSdkPackages(options);
  const sourceRoot = resolvePackageRoots(options.layout ?? 'current', {
    repositoryRoot: options.repositoryRoot ?? repositoryRoot,
  }).repositoryRoot;
  const aliases = [];
  for (const name of [...sdkGraph.names].sort()) {
    // Pi and TypeBox aliases are identity-sensitive; Preact retains its
    // established owner-wide alias. Ordinary SDK dependencies are scoped to
    // Pie-owned repository sources so package issuers keep native nested resolution.
    if (isSdkIdentitySpecifier(name) || name === 'preact') continue;
    const packageRoot = packageRootFromRequire(sdkRequire, name, sdk.root, { allowMissing: true });
    const aliasRoot = packageRoot ?? path.join(sdk.root, 'node_modules', ...name.split('/'));
    const packageInfo = packageRoot
      ? packageInfoAt(packageRoot, name, conditions, { allowEntryless: true })
      : undefined;
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const find = new RegExp(`^${escapedName}(?:/(.*))?$`);
    aliases.push({
      find,
      replacement: path.join(aliasRoot, '$1'),
      async customResolver(source, importer) {
        const queryIndex = source.indexOf('?');
        const sourcePath = queryIndex < 0 ? source : source.slice(0, queryIndex);
        const query = queryIndex < 0 ? '' : source.slice(queryIndex);
        const relative = path.relative(aliasRoot, path.resolve(sourcePath));
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error(`Invalid candidate Vite alias target for ${name}: ${source}`);
        }
        const suffix = relative.split(path.sep).filter(Boolean).join('/');
        const specifier = `${name}${suffix ? `/${suffix}` : ''}`;
        if (!vitePieSourceImporter(importer, sourceRoot, sdkGraph.packageRoots)) {
          const resolved = await this.resolve(specifier + query, importer, { skipSelf: true });
          if (resolved) return resolved;
          throw new Error(`Native importer resolution failed for ${specifier} from ${importer ?? '(entry)'}`);
        }
        if (!packageInfo) {
          throw new Error(`Candidate SDK graph at ${sdk.root} cannot resolve Pie-source import ${specifier}`);
        }
        let target;
        if (packageInfo.manifest.exports) {
          target = resolvePackageExport(packageInfo, suffix, conditions);
          if (!target && !suffix && typeof packageInfo.manifest.exports === 'string') target = packageInfo.entry;
          if (!target) {
            throw new Error(`Candidate SDK package ${name} does not export Pie-source import ${specifier}`);
          }
        } else if (suffix) {
          target = path.resolve(packageInfo.root, ...suffix.split('/'));
        } else {
          target = packageInfo.entry ?? packageInfo.root;
        }
        const resolved = await this.resolve(target + query, importer, { skipSelf: true });
        if (!resolved) {
          throw new Error(`Candidate SDK package ${name} could not resolve Pie-source import ${specifier} to ${target}`);
        }
        return resolved;
      },
    });
  }
  return aliases;
}

function candidateMappingForAliasKey(aliasKey, mappings) {
  const exact = mappings.find((mapping) => mapping.key === aliasKey);
  if (exact) return exact.replacement;
  const aliasStar = aliasKey.indexOf('*');
  const aliasPrefix = aliasStar < 0 ? aliasKey : aliasKey.slice(0, aliasStar);
  const aliasSuffix = aliasStar < 0 ? '' : aliasKey.slice(aliasStar + 1);
  const matches = [];
  for (const mapping of mappings) {
    const star = mapping.key.indexOf('*');
    if (star < 0) continue;
    const prefix = mapping.key.slice(0, star);
    const suffix = mapping.key.slice(star + 1);
    if (aliasStar < 0) {
      if (!aliasKey.startsWith(prefix) || !aliasKey.endsWith(suffix)) continue;
      const capture = aliasKey.slice(prefix.length, aliasKey.length - suffix.length);
      matches.push({ score: prefix.length + suffix.length, target: path.normalize(mapping.replacement.replaceAll('*', capture)) });
    } else {
      if (!aliasPrefix.startsWith(prefix) || !aliasSuffix.endsWith(suffix)) continue;
      const capture = `${aliasPrefix.slice(prefix.length)}*${aliasSuffix.slice(0, aliasSuffix.length - suffix.length)}`;
      matches.push({ score: prefix.length + suffix.length, target: path.normalize(mapping.replacement.replaceAll('*', capture)) });
    }
  }
  matches.sort((left, right) => right.score - left.score);
  if (matches.length > 1 && matches[0].score === matches[1].score && matches[0].target !== matches[1].target) {
    throw new Error(`Ambiguous candidate SDK path aliases for ${aliasKey}: ${matches.filter(({ score }) => score === matches[0].score).map(({ target }) => target).join(', ')}`);
  }
  return matches[0]?.target;
}

function candidateRuntimeDependencyPaths(options, conditions, declaredPaths = {}, ownerPaths = {}, helperPaths = {}) {
  const { names, roots } = sdkRuntimeDependencyGraph(options);
  const ownerRoot = resolveOwnerRoot(options);
  const ownerRequire = createOwnerRequire(options);
  const paths = {};
  const mappingsByName = new Map();
  // Restrict candidate redirects to aliases already exposed by the base,
  // owner, or helper config; native ancestry preserves nested transitive versions.
  const exposedAliasKeys = new Set([
    ...Object.keys(declaredPaths ?? {}),
    ...Object.keys(ownerPaths ?? {}).filter((key) => ![...names].some((name) => key === name || key.startsWith(`${name}/`))),
    ...Object.keys(helperPaths ?? {}),
  ]);
  const dependencyForAlias = (aliasKey) => [...names]
    .filter((candidateName) => (!isSdkIdentitySpecifier(candidateName) || candidateName === 'typebox')
      && (aliasKey === candidateName || aliasKey.startsWith(`${candidateName}/`)))
    .sort((left, right) => right.length - left.length)[0];
  const neededNames = new Set([...exposedAliasKeys].map(dependencyForAlias).filter(Boolean));
  for (const name of neededNames) {
    const packageRoots = roots.get(name);
    if (!packageRoots?.size) {
      const hostRoot = packageRootFromRequire(ownerRequire, name, ownerRoot, { allowMissing: true });
      if (hostRoot) {
        throw new Error(`Candidate SDK graph declares runtime dependency ${name} but cannot resolve it; the host owner also resolves it at ${hostRoot}`);
      }
      continue;
    }
    if (packageRoots.size > 1) {
      throw new Error(`Ambiguous candidate SDK runtime dependency ${name}: resolved to ${[...packageRoots].join(', ')}`);
    }
    if (isSdkIdentitySpecifier(name) && name !== 'typebox') continue;
    const packageInfo = packageInfoAt([...packageRoots][0], name, undefined, { allowEntryless: true });
    const mappings = exportMappings(packageInfo, name, runtimeConditionsForPackage(name, conditions));
    if (!packageInfo.manifest.exports) mappings.push({ key: `${name}/*`, replacement: path.join(packageInfo.root, '*') });
    mappingsByName.set(name, mappings);
    for (const mapping of mappings) paths[mapping.key] = [mapping.replacement];
  }
  for (const aliasKey of exposedAliasKeys) {
    const name = dependencyForAlias(aliasKey);
    if (!name) continue;
    const replacement = candidateMappingForAliasKey(aliasKey, mappingsByName.get(name) ?? []);
    if (!replacement) {
      throw new Error(`Candidate SDK runtime dependency ${name} cannot resolve exposed path alias ${aliasKey}; refusing to retain its host target`);
    }
    paths[aliasKey] = [replacement];
  }
  return paths;
}

function ownerDependencyPaths(options, conditions) {
  const ownerRoot = resolveOwnerRoot(options);
  const manifest = JSON.parse(readFileSync(path.join(ownerRoot, 'package.json'), 'utf8'));
  const sdkGraph = sdkRuntimeDependencyGraph(options);
  const sdkDependencies = sdkGraph.names;
  const candidate = options.sdkPath !== undefined ? resolveSdkPackages(options) : undefined;
  const paths = {};
  for (const name of new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ])) {
    // SDK identities and candidate SDK runtime dependencies must not be
    // redirected to a potentially different host-owner copy.
    if (isSdkIdentitySpecifier(name)) continue;
    if (sdkDependencies.has(name)) {
      // Compiler declaration resolution keeps its existing @types/package
      // ancestry. These extra aliases are only for ordinary executable imports.
      if (conditions.includes('types')) continue;
      // Relocated Pie sources need direct owner imports even when candidate
      // mode excludes the owner's installed copy. Only alias a single graph
      // root: tsx also applies paths to workspace package issuers, so exposing
      // a dependency with nested versions would flatten their resolution.
      if ((sdkGraph.roots.get(name)?.size ?? 0) > 1) continue;
      const root = packageRootFromRequire(candidate.sdkRequire, name, candidate.sdk.root, { allowMissing: true });
      if (!root || !sdkGraph.roots.get(name)?.has(root)) {
        throw new Error(`Candidate SDK graph at ${candidate.sdk.root} cannot resolve Pie-source import ${name}`);
      }
      const info = packageInfoAt(root, name, undefined, { allowEntryless: true });
      for (const mapping of exportMappings(info, name, runtimeConditionsForPackage(name, conditions))) {
        paths[mapping.key] = [mapping.replacement];
      }
      if (!info.manifest.exports) paths[`${name}/*`] = [path.join(root, '*')];
      continue;
    }
    // Owner dependency enumeration includes config-only packages without an entry.
    // Still require the installed manifest; SDK identity resolution remains strict.
    const packageInfo = packageInfoFromOwner(ownerRoot, name, { allowEntryless: true });
    const typechecking = conditions.includes('types');
    const declarationPackage = path.join(ownerRoot, 'node_modules', '@types', ...name.replace(/^@/, '').replace('/', '__').split('/'));
    for (const mapping of exportMappings(packageInfo, name, runtimeConditionsForPackage(name, conditions))) {
      // TS does not walk back from absolute paths aliases to discover a
      // package's @types sibling. Give untyped owner packages their installed
      // declaration entry, and prefer adjacent declarations over JS exports.
      const declaration = mapping.replacement.replace(/\.(?:mjs|cjs|js)$/u, '.d.ts');
      paths[mapping.key] = [typechecking && mapping.key === name && existsSync(path.join(declarationPackage, 'index.d.ts'))
        ? path.join(declarationPackage, 'index.d.ts')
        : typechecking && (existsSync(declaration) || mapping.replacement.includes('*')) ? declaration
          : mapping.replacement];
    }
    // Packages without export maps may still expose subpaths.
    if (!packageInfo.manifest.exports) {
      paths[`${name}/*`] = [path.join(packageInfo.root, '*')];
    }
  }
  return paths;
}

function readTsconfigJson(configPath) {
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

/**
 * Overlay paths keep the base redirection set: helper-derived absolute
 * targets where the helper covers the specifier, and otherwise targets
 * resolved against the same baseUrl (or declaring config directory) as the
 * checked-in config. Candidate SDK mode also adds every SDK and TypeBox
 * mapping, including when the base config does not declare those aliases.
 */
function overlayPathsFromBase(declaredPaths, helperPaths, pathsBase) {
  const paths = {};
  for (const [key, targets] of Object.entries(declaredPaths)) {
    const helperTargets = helperPaths[key];
    paths[key] = helperTargets
      ? [...helperTargets]
      : targets.map((target) => path.isAbsolute(target) ? target : path.resolve(pathsBase, target));
  }
  return paths;
}

/**
 * Get the effective paths and their declaring base (including `extends`),
 * without walking config `include` globs.
 */
function effectiveTsconfigOptions(configPath, options) {
  const typescript = createOwnerRequire(options)('typescript');
  const parsed = typescript.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...typescript.sys,
    readDirectory: () => [],
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(typescript.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  return parsed?.options;
}

/**
 * Generate a temporary tsconfig overlay for a tsx test run.
 *
 * The overlay `extends` the registry-declared base config, so strict mode,
 * include/exclude, module settings, and every other checked-in compiler
 * option keep their original meaning (relative config values retain the
 * declaring config's directory/baseUrl semantics). Its `compilerOptions.paths`
 * preserve the base config's redirection set exactly: each declared alias is
 * re-pointed through the helper-derived owner-relative runtime resolution (both Pi
 * spellings, the TypeBox spellings, and Preact become explicit absolute
 * paths under the dependency owner), and any specifier the helper does not
 * model keeps its base target anchored to the original config semantics. No
 * new aliases are added by default, so test-time module hooks keep intercepting
 * exactly the specifiers the checked-in config redirects. Explicit `sdkPath`
 * mode additionally adds every candidate SDK and TypeBox mapping, including
 * inherited config paths, and maps only candidate runtime dependencies
 * exposed by inherited or helper aliases, plus executable direct owner imports
 * selected from the SDK context only when the graph has one root for that name.
 * Dependencies with nested versions retain native candidate ancestry. For
 * extension source still outside its package owner, `includeOwnerDependencies`
 * additionally maps owner dependencies which are not in the candidate SDK
 * runtime dependency closure (including the compiler's declaration exports
 * when `typescript` is true). The runtime Preact dependency closure selects
 * require exports consistently.
 *
 * A base config without its own `paths` produces a passthrough overlay unless
 * owner dependencies or an explicit candidate `sdkPath` were requested. When `options.directory` is supplied
 * the overlay is written there and the caller owns cleanup (the fast batch
 * runner writes into its existing temp directory); otherwise a private
 * OS-temp directory is created and `dispose()` removes it again.
 */
export function createTsconfigOverlay(baseConfigPath, options = {}) {
  const absoluteBase = resolveAbsoluteRoot(baseConfigPath, 'baseConfigPath');
  if (!existsSync(absoluteBase)) {
    throw new Error(`Base tsconfig for overlay does not exist: ${absoluteBase}`);
  }
  const ownsDirectory = options.directory === undefined;
  const directory = ownsDirectory
    ? mkdtempSync(path.join(os.tmpdir(), 'pie-tsx-overlay-'))
    : resolveAbsoluteRoot(options.directory, 'directory');
  let generated = false;
  try {
    const declaredPaths = readTsconfigJson(absoluteBase).compilerOptions?.paths;
    const candidateSdk = options.sdkPath !== undefined;
    const helperPaths = options.typescript ? createTypeScriptResolution(options).paths : createTsxResolution(options).paths;
    const effectiveOptions = declaredPaths || options.includeOwnerDependencies || candidateSdk || options.typescript
      ? effectiveTsconfigOptions(absoluteBase, options) : undefined;
    const basePaths = options.includeOwnerDependencies || candidateSdk ? effectiveOptions?.paths ?? declaredPaths : declaredPaths;
    const conditions = options.typescript
      ? ['types', 'import', 'default', 'require'] : ['import', 'require', 'default'];
    const ownerPaths = options.includeOwnerDependencies ? ownerDependencyPaths(options, conditions) : {};
    const candidateRuntimePaths = candidateSdk
      ? candidateRuntimeDependencyPaths(options, conditions, basePaths ?? {}, ownerPaths, helperPaths)
      : {};
    const candidateSdkPaths = candidateSdk
      ? Object.fromEntries(Object.entries(helperPaths).filter(([specifier]) => isSdkIdentitySpecifier(specifier)))
      : {};
    const overlayPaths = basePaths || options.includeOwnerDependencies || candidateSdk
      ? {
        ...ownerPaths,
        ...overlayPathsFromBase(
          basePaths ?? {},
          { ...ownerPaths, ...helperPaths, ...candidateRuntimePaths },
          effectiveOptions?.baseUrl ?? effectiveOptions?.pathsBasePath ?? path.dirname(absoluteBase),
        ),
        ...(options.includeOwnerDependencies ? helperPaths : {}),
        ...candidateRuntimePaths,
        ...candidateSdkPaths,
      }
      : undefined;
    // TS resolves `types` references from the config/source ancestry, not from
    // compilerOptions.paths. Detached source and temp overlays need the owner's
    // @types explicitly; vite/client is a package subpath rather than an @types
    // package, so only configs which request it also need the owner module root.
    // Keep inherited typeRoots (already absolute after TS parses `extends`) and
    // leave the inherited `types` list unchanged.
    const ownerModules = path.join(resolveOwnerRoot(options), 'node_modules');
    // With no explicit typeRoots, relocating a TS config also relocates its
    // default @types ancestry. Preserve the base config's native search roots,
    // not the temporary overlay's ancestry or an unrelated dependency owner.
    const defaultTypeRoots = options.typescript && effectiveOptions?.typeRoots === undefined
      ? createOwnerRequire(options)('typescript').getEffectiveTypeRoots(effectiveOptions ?? {}, {
        getCurrentDirectory: () => path.dirname(absoluteBase),
      })?.map((root) => path.normalize(root))
      : undefined;
    const typeRoots = options.includeOwnerDependencies && options.typescript
      ? [...new Set([
        ...(effectiveOptions?.typeRoots ?? []).map((root) => path.normalize(root)),
        path.join(ownerModules, '@types'),
        ...(effectiveOptions?.types?.includes('vite/client') ? [ownerModules] : []),
      ])]
      : defaultTypeRoots;
    const configPath = path.join(directory, 'tsconfig.overlay.json');
    writeFileSync(configPath, JSON.stringify({
      extends: absoluteBase,
      ...(overlayPaths || typeRoots ? { compilerOptions: {
        ...(overlayPaths ? { paths: overlayPaths } : {}),
        ...(typeRoots ? { typeRoots } : {}),
      } } : {}),
    }, null, 2));
    let disposed = false;
    const overlay = Object.freeze({
      configPath,
      directory,
      dispose() {
        if (!ownsDirectory || disposed) return;
        disposed = true;
        rmSync(directory, { recursive: true, force: true });
      },
    });
    generated = true;
    return overlay;
  } finally {
    if (!generated && ownsDirectory) rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Rollup/Vite aliases for package imports from any source root. Export maps
 * preserve the host owner's installed package files and JSX/runtime subpaths.
 * Candidate SDK runtime aliases use Vite's alias-entry `customResolver` to
 * redirect Pie-owned repository sources outside dependency/package roots;
 * dependency importers resume native resolution. The result remains the alias
 * array consumed by Vite configs.
 */
export function createViteAliases(options = {}) {
  const ownerRoot = resolveOwnerRoot(options);
  const conditions = options.conditions ?? ['browser', 'import', 'default', 'require'];
  const preact = packageInfoFromOwner(ownerRoot, 'preact');
  const aliases = [];
  const addPackageMappings = (packageName, packageInfo) => {
    for (const mapping of exportMappings(packageInfo, packageName, conditions)) {
      aliases.push(mapping.find
        ? { find: mapping.find, replacement: mapping.replacement.replaceAll('*', '$1') }
        : { find: mapping.key, replacement: mapping.replacement });
    }
  };
  for (const { name, package: packageInfo } of piAliases(options)) {
    addPackageMappings(name, packageInfo);
  }
  const { packages } = resolveSdkPackages(options);
  addPackageMappings('typebox', packages.typebox);
  addPackageMappings('@sinclair/typebox', packages.typebox);
  addPackageMappings('preact', preact);
  // Relocated source roots cannot resolve packages by node_modules ancestry.
  // Alias the direct owner dependencies (runtime and build/test packages) from
  // the host manifest, while leaving SDK identities and native sidecar owners
  // on their existing resolution paths.
  const ownerManifest = JSON.parse(readFileSync(path.join(ownerRoot, 'package.json'), 'utf8'));
  const sdkGraph = sdkRuntimeDependencyGraph(options);
  const sdkDependencies = sdkGraph.names;
  for (const name of new Set([
    ...Object.keys(ownerManifest.dependencies ?? {}),
    ...Object.keys(ownerManifest.devDependencies ?? {}),
  ])) {
    if (name === 'preact' || name === 'tailwindcss' || isSdkIdentitySpecifier(name) || sdkDependencies.has(name)) continue;
    addPackageMappings(name, packageInfoFromOwner(ownerRoot, name, { allowEntryless: true }));
  }
  // The relocated frontend stylesheet cannot resolve the package owner's CSS
  // through source ancestry; alias Tailwind's style export, not its JS entry.
  const tailwindcss = packageInfoFromOwner(ownerRoot, 'tailwindcss');
  for (const mapping of exportMappings(tailwindcss, 'tailwindcss', ['style'])) {
    aliases.push({ find: mapping.key, replacement: mapping.replacement });
  }
  aliases.push(...candidateViteDependencyAliases(options, conditions, sdkGraph));
  aliases.sort((left, right) => String(right.find).length - String(left.find).length);
  return aliases;
}
