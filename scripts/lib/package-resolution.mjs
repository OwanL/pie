import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * Resolve the exact SDK and its private dependency graph through the SDK's
 * own Node resolution context. In particular, pi-ai is not resolved from an
 * accidental top-level copy in the application owner.
 */
export function resolveSdkPackages(options = {}) {
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

function ownerDependencyPaths(options, conditions) {
  const ownerRoot = resolveOwnerRoot(options);
  const manifest = JSON.parse(readFileSync(path.join(ownerRoot, 'package.json'), 'utf8'));
  const paths = {};
  for (const name of new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ])) {
    // SDK identities must come from the pinned private graph, never a hoisted copy.
    if (isSdkIdentitySpecifier(name)) continue;
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
 * checked-in config. Never introduces keys the base config does not declare.
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
 * exactly the specifiers the checked-in config redirects. For extension source
 * still outside its package owner, `includeOwnerDependencies` additionally maps
 * every owner dependency and SDK/Preact subpath to the owner (including the
 * compiler's declaration exports when `typescript` is true). The runtime
 * Preact dependency closure selects require exports consistently.
 *
 * A base config without its own `paths` produces a passthrough overlay unless
 * owner dependencies were explicitly requested. When `options.directory` is supplied
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
  const declaredPaths = readTsconfigJson(absoluteBase).compilerOptions?.paths;
  const helperPaths = options.typescript ? createTypeScriptResolution(options).paths : createTsxResolution(options).paths;
  const effectiveOptions = declaredPaths || options.includeOwnerDependencies
    ? effectiveTsconfigOptions(absoluteBase, options) : undefined;
  const basePaths = options.includeOwnerDependencies ? effectiveOptions?.paths ?? declaredPaths : declaredPaths;
  const ownerPaths = options.includeOwnerDependencies ? ownerDependencyPaths(options, options.typescript
    ? ['types', 'import', 'default', 'require'] : ['import', 'require', 'default']) : {};
  const overlayPaths = basePaths || options.includeOwnerDependencies
    ? {
      ...ownerPaths,
      ...overlayPathsFromBase(
        basePaths ?? {},
        { ...ownerPaths, ...helperPaths },
        effectiveOptions?.baseUrl ?? effectiveOptions?.pathsBasePath ?? path.dirname(absoluteBase),
      ),
      ...(options.includeOwnerDependencies ? helperPaths : {}),
    }
    : undefined;
  // TS resolves `types` references from the config/source ancestry, not from
  // compilerOptions.paths. Detached source and temp overlays need the owner's
  // @types explicitly; vite/client is a package subpath rather than an @types
  // package, so only configs which request it also need the owner module root.
  // Keep inherited typeRoots (already absolute after TS parses `extends`) and
  // leave the inherited `types` list unchanged.
  const ownerModules = path.join(resolveOwnerRoot(options), 'node_modules');
  const typeRoots = options.includeOwnerDependencies && options.typescript
    ? [...new Set([
      ...(effectiveOptions?.typeRoots ?? []).map((root) => path.normalize(root)),
      path.join(ownerModules, '@types'),
      ...(effectiveOptions?.types?.includes('vite/client') ? [ownerModules] : []),
    ])]
    : undefined;
  const configPath = path.join(directory, 'tsconfig.overlay.json');
  writeFileSync(configPath, JSON.stringify({
    extends: absoluteBase,
    ...(overlayPaths || typeRoots ? { compilerOptions: {
      ...(overlayPaths ? { paths: overlayPaths } : {}),
      ...(typeRoots ? { typeRoots } : {}),
    } } : {}),
  }, null, 2));
  let disposed = false;
  return Object.freeze({
    configPath,
    directory,
    dispose() {
      if (!ownsDirectory || disposed) return;
      disposed = true;
      rmSync(directory, { recursive: true, force: true });
    },
  });
}

/**
 * Rollup/Vite aliases for package imports from any source root. Export maps
 * preserve the host owner's installed package files and JSX/runtime subpaths.
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
  for (const name of new Set([
    ...Object.keys(ownerManifest.dependencies ?? {}),
    ...Object.keys(ownerManifest.devDependencies ?? {}),
  ])) {
    if (name === 'preact' || name === 'tailwindcss' || isSdkIdentitySpecifier(name)) continue;
    addPackageMappings(name, packageInfoFromOwner(ownerRoot, name, { allowEntryless: true }));
  }
  // The relocated frontend stylesheet cannot resolve the package owner's CSS
  // through source ancestry; alias Tailwind's style export, not its JS entry.
  const tailwindcss = packageInfoFromOwner(ownerRoot, 'tailwindcss');
  for (const mapping of exportMappings(tailwindcss, 'tailwindcss', ['style'])) {
    aliases.push({ find: mapping.key, replacement: mapping.replacement });
  }
  aliases.sort((left, right) => String(right.find).length - String(left.find).length);
  return aliases;
}
