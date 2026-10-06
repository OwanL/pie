import { createRequire } from 'node:module';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fingerprintCompiledPiOutputs } from '../../../../lib/development-runtime/compiled-output.mjs';
import type { GenerationPiRuntimeDescriptor, PiRuntimeTarget } from '../../../../lib/pi-runtime/artifact.mjs';
import { verifySdkRuntimeArtifactDescriptor } from './sdk-runtime-artifact';
import type { SdkLoadMode } from './sdk';

/** Required explicit runtime route on every internal SDK transport. */
export type SdkRuntimeSelection =
  | { kind: 'source-artifact'; descriptor: GenerationPiRuntimeDescriptor }
  | { kind: 'workspace-development'; workspaceRoot: string };

export const WORKSPACE_DEVELOPMENT_SDK_OPT_IN_ENV = 'PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK';

const WORKSPACE_PI_PACKAGES = [
  { name: '@earendil-works/pi-tui', directory: 'tui' },
  { name: '@earendil-works/pi-ai', directory: 'ai' },
  { name: '@earendil-works/pi-agent-core', directory: 'agent' },
  { name: '@earendil-works/pi-coding-agent', directory: 'coding-agent' },
] as const;
const TYPEBOX_CONSUMERS = ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent'] as const;
const MAX_PATH_LENGTH = 4096;
const MAX_COMPILED_OUTPUT_STAMP_BYTES = 4096;
const nodeModuleApi = createRequire(import.meta.url)('node:module') as {
  findPackageJSON(specifier: string, base: string): string | undefined;
};

export function assertWorkspaceDevelopmentSdkOptIn(environment: NodeJS.ProcessEnv = process.env): void {
  if (environment[WORKSPACE_DEVELOPMENT_SDK_OPT_IN_ENV] !== '1') {
    throw new Error(`Workspace-development SDK selection requires ${WORKSPACE_DEVELOPMENT_SDK_OPT_IN_ENV}=1.`);
  }
}

function fields(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every(key => typeof key === 'string' && keys.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'));
}
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const digest = (value: unknown) => text(value, 64) && /^[a-f0-9]{64}$/.test(value);

export function validateSdkRuntimeSelectionShape(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return 'sdkRuntime must be a discriminated object.';
  const kind = Object.getOwnPropertyDescriptor(value, 'kind')?.value;
  if (kind === 'source-artifact') {
    if (!fields(value, ['kind', 'descriptor'])) return 'sdkRuntime source selection has unsupported fields.';
    const descriptor = value.descriptor;
    if (!fields(descriptor, ['schemaVersion', 'artifactDir', 'sdkPath', 'cliPath', 'identity', 'manifest'])
      || descriptor.schemaVersion !== 1 || !digest(descriptor.identity)
      || !['artifactDir', 'sdkPath', 'cliPath'].every(key => text(descriptor[key]) && path.isAbsolute(descriptor[key] as string))) return 'sdkRuntime descriptor is invalid.';
    // Full bounded manifest schema and payload verification belong to E1 and run before every import.
    if (!fields(descriptor.manifest, ['schemaVersion', 'upstreamVersion', 'upstreamCommit', 'sourceTreeSha256', 'lockSha256', 'target', 'packages', 'payloadSha256'])) return 'sdkRuntime manifest has unsupported fields.';
    return undefined;
  }
  if (kind === 'workspace-development') {
    if (!fields(value, ['kind', 'workspaceRoot'])) return 'sdkRuntime workspace-development selection has unsupported fields.';
    if (!text(value.workspaceRoot, MAX_PATH_LENGTH) || !path.isAbsolute(value.workspaceRoot)) {
      return 'sdkRuntime workspaceRoot must be an absolute path.';
    }
    return undefined;
  }
  return 'sdkRuntime.kind must be source-artifact or workspace-development.';
}

export function parseSdkRuntimeSelection(value: unknown): SdkRuntimeSelection {
  const error = validateSdkRuntimeSelectionShape(value);
  if (error) throw new TypeError(error);
  return value as SdkRuntimeSelection;
}

export function currentBackendTarget(): PiRuntimeTarget {
  return { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules };
}

export function sdkRuntimeSdkPath(selection: SdkRuntimeSelection): string {
  const parsed = parseSdkRuntimeSelection(selection);
  return parsed.kind === 'source-artifact'
    ? parsed.descriptor.sdkPath
    : path.resolve(parsed.workspaceRoot, 'packages', 'coding-agent');
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function readJsonObject(filePath: string, label: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Workspace-development Pi runtime cannot read ${label}.`, { cause: error });
  }
  const result = asObject(parsed);
  if (!result) throw new Error(`Workspace-development Pi runtime ${label} must be a JSON object.`);
  return result;
}

async function requireCompiledFile(packageRoot: string, relativePath: string, label: string): Promise<void> {
  const parts = relativePath.split(/[\\/]/);
  let current = packageRoot;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      throw new Error(`Workspace-development Pi runtime is missing ${label}.`, { cause: error });
    }
    const finalPart = index === parts.length - 1;
    if (stat.isSymbolicLink() || (finalPart ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`Workspace-development Pi runtime ${label} must be compiled beneath its selected package root.`);
    }
  }
  const canonical = await realpath(current);
  const relative = path.relative(packageRoot, canonical);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Workspace-development Pi runtime ${label} escapes its selected package root.`);
  }
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function requireCompiledOutputStamp(workspaceRoot: string): Promise<void> {
  const cacheRoot = path.join(workspaceRoot, '.cache');
  const cacheStat = await lstat(cacheRoot).catch((error) => {
    throw new Error('Workspace-development Pi runtime requires an ordinary compiled-output stamp directory.', { cause: error });
  });
  if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink()) {
    throw new Error('Workspace-development Pi runtime compiled-output stamp directory must be ordinary.');
  }

  const stampPath = path.join(cacheRoot, 'build.json');
  const stampStat = await lstat(stampPath).catch((error) => {
    throw new Error('Workspace-development Pi runtime requires a complete compiled-output stamp.', { cause: error });
  });
  if (!stampStat.isFile() || stampStat.isSymbolicLink() || stampStat.nlink !== 1
      || stampStat.size > MAX_COMPILED_OUTPUT_STAMP_BYTES) {
    throw new Error('Workspace-development Pi runtime compiled-output stamp must be a bounded ordinary single-link file.');
  }

  let stamp: unknown;
  try {
    stamp = JSON.parse(await readFile(stampPath, 'utf8'));
  } catch (error) {
    throw new Error('Workspace-development Pi runtime compiled-output stamp is invalid.', { cause: error });
  }
  if (!fields(stamp, ['schema', 'inputFingerprint', 'compiledSha256', 'node'])
      || stamp.schema !== 1 || !digest(stamp.inputFingerprint) || !digest(stamp.compiledSha256)
      || stamp.node !== process.version) {
    throw new Error('Workspace-development Pi runtime compiled-output stamp is incomplete or does not match this Node version.');
  }

  let currentFingerprint: string;
  try {
    currentFingerprint = await fingerprintCompiledPiOutputs(workspaceRoot);
  } catch (error) {
    throw new Error('Workspace-development Pi runtime compiled output cannot be fingerprinted.', { cause: error });
  }
  if (currentFingerprint !== stamp.compiledSha256) {
    throw new Error('Workspace-development Pi runtime compiled output does not match its stamp.');
  }
}

function resolvePiDependencyFromOwner(packageRoot: string, dependency: string): string {
  const ownerEntry = pathToFileURL(path.join(packageRoot, 'dist', 'index.js')).href;
  const manifestPath = nodeModuleApi.findPackageJSON(dependency, ownerEntry);
  if (!manifestPath) throw new Error(`Workspace-development Pi dependency ${dependency} did not resolve to a package.`);
  return path.dirname(manifestPath);
}

export interface VerifiedWorkspaceDevelopmentSdkRoot {
  workspaceRoot: string;
  sdkPath: string;
  version: string;
  packageRoots: Readonly<Record<string, string>>;
}

/** Resolve and validate exactly the four compiled Pi packages selected by an
 * explicit Pi workspace root. No artifact identity or provenance is invented. */
export async function verifyWorkspaceDevelopmentSdkRoot(
  selection: Extract<SdkRuntimeSelection, { kind: 'workspace-development' }>,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedWorkspaceDevelopmentSdkRoot> {
  assertWorkspaceDevelopmentSdkOptIn(environment);
  const parsed = parseSdkRuntimeSelection(selection);
  if (parsed.kind !== 'workspace-development') throw new TypeError('A workspace-development SDK selection is required.');

  const workspaceRoot = await realpath(parsed.workspaceRoot);
  const workspaceManifest = await readJsonObject(path.join(workspaceRoot, 'package.json'), 'workspace package.json');
  const workspaces = workspaceManifest.workspaces;
  if (workspaceManifest.name !== 'pi-monorepo' || workspaceManifest.private !== true
      || !Array.isArray(workspaces) || !workspaces.includes('packages/*')) {
    throw new Error('Workspace-development Pi runtime root is not the expected Pi package workspace.');
  }
  await requireCompiledOutputStamp(workspaceRoot);

  const packageRoots: Record<string, string> = Object.create(null) as Record<string, string>;
  const manifests: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
  let version: string | undefined;
  for (const spec of WORKSPACE_PI_PACKAGES) {
    const packageRoot = path.join(workspaceRoot, 'packages', spec.directory);
    const packageStat = await lstat(packageRoot).catch((error) => {
      throw new Error(`Workspace-development Pi runtime is missing local package root ${spec.name}.`, { cause: error });
    });
    if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) {
      throw new Error(`Workspace-development Pi package root ${spec.name} must be a real local directory.`);
    }
    const canonicalRoot = await realpath(packageRoot);
    if (!samePath(packageRoot, canonicalRoot)) throw new Error(`Workspace-development Pi package root ${spec.name} is not canonical.`);

    const manifest = await readJsonObject(path.join(canonicalRoot, 'package.json'), `${spec.name}/package.json`);
    const rootExport = asObject(manifest.exports)?.['.'];
    if (manifest.name !== spec.name || typeof manifest.version !== 'string' || !manifest.version
        || (manifest.type !== undefined && manifest.type !== 'module')
        || !['./dist/index.js', 'dist/index.js'].includes(manifest.main as string)
        || (manifest.exports !== undefined
          && (!asObject(rootExport) || asObject(rootExport)?.import !== './dist/index.js'))) {
      throw new Error(`Workspace-development Pi package metadata or root exports are invalid for ${spec.name}.`);
    }
    if (version !== undefined && manifest.version !== version) {
      throw new Error('Workspace-development Pi package roots must have one shared version.');
    }
    version = manifest.version;
    await requireCompiledFile(canonicalRoot, 'dist/index.js', `${spec.name}/dist/index.js`);
    await requireCompiledFile(canonicalRoot, 'dist/index.d.ts', `${spec.name}/dist/index.d.ts`);

    packageRoots[spec.name] = canonicalRoot;
    manifests[spec.name] = manifest;
  }

  for (const spec of WORKSPACE_PI_PACKAGES) {
    const dependencies = asObject(manifests[spec.name].dependencies) ?? {};
    for (const localName of WORKSPACE_PI_PACKAGES.map((item) => item.name)) {
      if (!Object.hasOwn(dependencies, localName)) continue;
      let resolved: string;
      try {
        resolved = await realpath(resolvePiDependencyFromOwner(packageRoots[spec.name], localName));
      } catch (error) {
        throw new Error(`Workspace-development Pi runtime cannot resolve local dependency ${localName} from ${spec.name}.`, { cause: error });
      }
      if (!samePath(resolved, packageRoots[localName])) {
        throw new Error(`Workspace-development Pi dependency ${spec.name} -> ${localName} is not the selected local root.`);
      }
    }
  }

  let typeboxRoot: string | undefined;
  let typeboxVersion: string | undefined;
  for (const packageName of TYPEBOX_CONSUMERS) {
    const packageRoot = packageRoots[packageName];
    const declaration = asObject(manifests[packageName].dependencies)?.typebox;
    if (typeof declaration !== 'string' || !declaration) {
      throw new Error(`Workspace-development Pi package ${packageName} must declare TypeBox directly.`);
    }
    let resolvedRoot: string;
    try {
      const manifestPath = nodeModuleApi.findPackageJSON('typebox', pathToFileURL(path.join(packageRoot, 'dist', 'index.js')).href);
      if (!manifestPath) throw new Error('TypeBox package was not found.');
      resolvedRoot = await realpath(path.dirname(manifestPath));
    } catch (error) {
      throw new Error(`Workspace-development Pi package ${packageName} cannot resolve TypeBox.`, { cause: error });
    }
    const typeboxManifest = await readJsonObject(path.join(resolvedRoot, 'package.json'), 'TypeBox package.json');
    if (typeboxManifest.name !== 'typebox' || typeboxManifest.version !== declaration) {
      throw new Error(`Workspace-development Pi package ${packageName} resolves an incompatible TypeBox package.`);
    }
    if (typeboxRoot !== undefined && !samePath(typeboxRoot, resolvedRoot)) {
      throw new Error('Workspace-development Pi packages resolve different TypeBox installations.');
    }
    if (typeboxVersion !== undefined && typeboxVersion !== typeboxManifest.version) {
      throw new Error('Workspace-development Pi packages resolve different TypeBox versions.');
    }
    typeboxRoot = resolvedRoot;
    typeboxVersion = typeboxManifest.version as string;
  }

  const sdkPath = packageRoots['@earendil-works/pi-coding-agent'];
  for (const relative of [
    'dist/config.js',
    'dist/core/auth-storage.js',
    'dist/core/model-registry.js',
    'dist/core/session-manager.js',
  ]) await requireCompiledFile(sdkPath, relative, `pi-coding-agent/${relative}`);

  return { workspaceRoot, sdkPath, version: version!, packageRoots };
}

export async function verifySdkRuntimeSelection(
  sdkPath: string,
  selection: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SdkRuntimeSelection> {
  const parsed = parseSdkRuntimeSelection(selection);
  if (parsed.kind === 'workspace-development') {
    const verified = await verifyWorkspaceDevelopmentSdkRoot(parsed, environment);
    if (!path.isAbsolute(sdkPath) || !samePath(await realpath(sdkPath), verified.sdkPath)) {
      throw new Error('SDK path does not match workspace-development runtime selection.');
    }
    return { kind: 'workspace-development', workspaceRoot: verified.workspaceRoot };
  }
  const descriptor = await verifySdkRuntimeArtifactDescriptor(parsed.descriptor, currentBackendTarget());
  if (!path.isAbsolute(sdkPath) || await realpath(sdkPath) !== descriptor.sdkPath) throw new Error('SDK path does not match source runtime selection.');
  return { kind: parsed.kind, descriptor };
}

export function sdkRuntimeLoadMode(selection: SdkRuntimeSelection, surface: 'cold'): SdkLoadMode & { surface: 'cold' };
export function sdkRuntimeLoadMode(selection: SdkRuntimeSelection, surface: 'full'): SdkLoadMode & { surface: 'full' };
export function sdkRuntimeLoadMode(selection: SdkRuntimeSelection, surface: 'cold' | 'full'): SdkLoadMode {
  const parsed = parseSdkRuntimeSelection(selection);
  return parsed.kind === 'source-artifact'
    ? { mode: 'source-artifact', descriptor: parsed.descriptor, backendTarget: currentBackendTarget(), surface }
    : { mode: 'workspace-development', workspaceRoot: parsed.workspaceRoot, surface };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function assertSdkRuntimeAgreement(sdkPath: string, retained: SdkRuntimeSelection, requested?: unknown): void {
  if (sdkPath !== sdkRuntimeSdkPath(retained)) throw new Error('SDK path does not match retained runtime selection.');
  if (arguments.length >= 3 && canonical(parseSdkRuntimeSelection(requested)) !== canonical(retained)) throw new Error('SDK runtime selection does not match initialization.');
}
