import * as path from 'node:path';
import { existsSync, lstatSync } from 'node:fs';

import {
  computeNodeRuntimePayloadIdentity,
  readNodeRuntimeManifest,
} from '../../../lib/node-runtime/manifest.mjs';
import { createCommandExecutor } from './command-execution';
import type { CommandResult } from './command-result';
import type { GenerationPiRuntimeBackendNodeTarget } from './pi-runtime-resolution';

export type { CommandResult } from './command-result';

export interface CommandExecutorOptions {
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
}

export type CommandExecutor = (
  command: string,
  args: string[],
  options?: CommandExecutorOptions,
) => Promise<CommandResult>;

export interface ProbeBackendNodeTargetOptions {
  /** Injectable command seam; the production executor is bounded by defaults below. */
  exec?: CommandExecutor;
  /** Environment to copy before removing Node module/preload inference variables. */
  env?: NodeJS.ProcessEnv;
}

const BACKEND_NODE_PROBE_TIMEOUT_MS = 5_000;
const BACKEND_NODE_PROBE_MAX_BUFFER_BYTES = 16 * 1024;
export const BUNDLED_NODE_VERSION = '24.16.0';
export const BUNDLED_NODE_TARGET: GenerationPiRuntimeBackendNodeTarget = {
  platform: 'win32',
  arch: 'x64',
  nodeAbi: '137',
};

interface NodeRuntimeManifest {
  schemaVersion: 1;
  kind: 'node-runtime';
  nodeVersion: string;
  target: GenerationPiRuntimeBackendNodeTarget;
  executable: string;
  inventory: Array<{ relativePath: string; sizeBytes: number; sha256: string }>;
  provenance: unknown;
  payloadIdentity: string;
}

interface CommonOptions {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (filePath: string) => boolean;
}

export interface ResolveNodePathOptions extends CommonOptions {
  configuredPath?: string;
}

export interface ResolveStartupNodePathOptions extends ResolveNodePathOptions {
  /** Output directory already selected by startup; no generation lookup occurs here. */
  runtimeOutDir: string;
  /** Optional host-specific legacy default, used only after bundle absence. */
  legacyDefaultPath?: string;
}

export interface StartupNodePathSelection {
  nodePath: string;
  source: 'configured' | 'environment' | 'bundled' | 'path' | 'legacy';
  bundledManifest?: NodeRuntimeManifest;
}

export interface ResolveCompatibleNodePathOptions extends ResolveNodePathOptions {
  exec: CommandExecutor;
  minimumVersion: string;
}

const defaultExists = (filePath: string): boolean => {
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
};

function hasBundledNodeRuntimeDirectory(nodeRuntimeDir: string): boolean {
  const resourcesDir = path.dirname(nodeRuntimeDir);
  let resourcesStat;
  try {
    resourcesStat = lstatSync(resourcesDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (resourcesStat.isSymbolicLink() || !resourcesStat.isDirectory()) {
    throw new Error(`Bundled Node runtime resources path is not an ordinary directory: ${resourcesDir}`);
  }

  try {
    lstatSync(nodeRuntimeDir);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function ensureExistingPath(
  label: string,
  filePath: string | undefined,
  exists: (value: string) => boolean,
): string | undefined {
  if (!filePath) {
    return undefined;
  }

  if (!exists(filePath)) {
    throw new Error(`${label} does not exist: ${filePath}`);
  }

  return filePath;
}

function splitPathEnv(
  envPath: string | undefined,
  platform: NodeJS.Platform,
): string[] {
  if (!envPath) {
    return [];
  }

  return envPath
    .split(platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function findOnPath(
  executableName: string,
  envPath: string | undefined,
  platform: NodeJS.Platform,
  exists: (filePath: string) => boolean,
): string | undefined {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const names =
    platform === 'win32'
      ? [
          executableName,
          `${executableName}.exe`,
          `${executableName}.cmd`,
          `${executableName}.bat`,
        ]
      : [executableName];

  for (const dir of splitPathEnv(envPath, platform)) {
    for (const name of names) {
      const candidate = pathApi.join(dir, name);
      if (exists(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function findAllOnPath(
  executableName: string,
  envPath: string | undefined,
  platform: NodeJS.Platform,
  exists: (filePath: string) => boolean,
): string[] {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const names =
    platform === 'win32'
      ? [
          executableName,
          `${executableName}.exe`,
          `${executableName}.cmd`,
          `${executableName}.bat`,
        ]
      : [executableName];
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const dir of splitPathEnv(envPath, platform)) {
    for (const name of names) {
      const candidate = pathApi.join(dir, name);
      const identity = platform === 'win32' ? candidate.toLowerCase() : candidate;
      if (exists(candidate) && !seen.has(identity)) {
        seen.add(identity);
        candidates.push(candidate);
      }
    }
  }

  return candidates;
}

interface NodeVersion {
  major: number;
  minor: number;
  patch: number;
}

function sanitizedNodeProbeEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'NODE_OPTIONS' || key.toUpperCase() === 'NODE_PATH') {
      delete env[key];
    }
  }
  return env;
}

/**
 * Probe the exact Node executable selected for the backend. The child reports
 * its own artifact target (platform, architecture and modules ABI); ambient
 * NODE_OPTIONS/NODE_PATH cannot preload code or redirect module resolution.
 */
export async function probeBackendNodeTarget(
  nodePath: string,
  options: ProbeBackendNodeTargetOptions = {},
): Promise<GenerationPiRuntimeBackendNodeTarget> {
  if (typeof nodePath !== 'string' || nodePath.trim().length === 0) {
    throw new TypeError('Backend nodePath must be a nonempty executable path.');
  }
  const exec = options.exec ?? createCommandExecutor();
  const code = 'process.stdout.write(JSON.stringify({platform:process.platform,arch:process.arch,nodeAbi:process.versions.modules}))';
  const result = await exec(nodePath, ['-e', code], {
    env: sanitizedNodeProbeEnv(options.env ?? process.env),
    timeout: BACKEND_NODE_PROBE_TIMEOUT_MS,
    maxBuffer: BACKEND_NODE_PROBE_MAX_BUFFER_BYTES,
  });
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`Could not probe backend Node target with ${nodePath}${detail ? `: ${detail}` : '.'}`);
  }

  let target: unknown;
  try {
    target = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(`Backend Node target probe returned malformed JSON for ${nodePath}.`);
  }
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new Error(`Backend Node target probe returned an invalid target for ${nodePath}.`);
  }
  const fields = target as Record<string, unknown>;
  if (typeof fields.platform !== 'string' || !/^[a-z0-9_-]+$/u.test(fields.platform)
    || typeof fields.arch !== 'string' || !/^[a-z0-9_-]+$/u.test(fields.arch)
    || typeof fields.nodeAbi !== 'string' || !/^\d+$/u.test(fields.nodeAbi)) {
    throw new Error(`Backend Node target probe returned an invalid target for ${nodePath}.`);
  }
  return { platform: fields.platform, arch: fields.arch, nodeAbi: fields.nodeAbi };
}

function parseNodeVersion(value: string): NodeVersion | undefined {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareNodeVersions(left: NodeVersion, right: NodeVersion): number {
  return left.major - right.major
    || left.minor - right.minor
    || left.patch - right.patch;
}

/**
 * Extract the lower bound from the SDK's supported engine form (`>=x.y.z`).
 * Fail closed for other range shapes so a future SDK engine change cannot
 * silently put Pie back on an unsupported runtime.
 */
export function minimumNodeVersionFromEngine(nodeEngine: string | undefined): string | undefined {
  if (!nodeEngine) {
    return undefined;
  }
  const match = nodeEngine.trim().match(/^>=\s*v?(\d+\.\d+\.\d+)$/);
  if (!match) {
    throw new Error(
      `Unsupported PI SDK Node engine range "${nodeEngine}". Set pie.nodePath to a compatible Node executable.`,
    );
  }
  return match[1];
}

async function probeNodeVersion(
  nodePath: string,
  exec: CommandExecutor,
): Promise<{ raw: string; parsed?: NodeVersion }> {
  const result = await exec(nodePath, ['--version']);
  const raw = (result.stdout || result.stderr).trim();
  return {
    raw: raw || `exit ${result.exitCode}`,
    parsed: result.exitCode === 0 ? parseNodeVersion(raw) : undefined,
  };
}

/**
 * Resolve a Node executable that satisfies the pinned SDK's declared minimum.
 * Explicit setting/environment overrides remain authoritative and fail with an
 * actionable compatibility error. PATH discovery probes every candidate in
 * order instead of blindly choosing an older runtime that happens to appear
 * first (common with nvm/proto shims on Windows).
 */
export async function resolveCompatibleNodePath(
  options: ResolveCompatibleNodePathOptions,
): Promise<string> {
  const exists = options.exists ?? defaultExists;
  const platform = options.platform ?? process.platform;
  const required = parseNodeVersion(options.minimumVersion);
  if (!required) {
    throw new Error(`Invalid PI SDK minimum Node version: ${options.minimumVersion}`);
  }

  const configuredPath = ensureExistingPath(
    'Configured PI nodePath',
    options.configuredPath,
    exists,
  );
  const envPath = ensureExistingPath('PI_NODE_PATH', options.env.PI_NODE_PATH, exists);
  const explicit = configuredPath
    ? { path: configuredPath, label: 'Configured PI nodePath' }
    : envPath
      ? { path: envPath, label: 'PI_NODE_PATH' }
      : undefined;

  if (explicit) {
    const version = await probeNodeVersion(explicit.path, options.exec);
    if (version.parsed && compareNodeVersions(version.parsed, required) >= 0) {
      return explicit.path;
    }
    throw new Error(
      `${explicit.label} uses Node ${version.raw}, but the PI SDK requires Node >=${options.minimumVersion}. `
      + 'Install a compatible Node release or update pie.nodePath.',
    );
  }

  const candidates = findAllOnPath('node', options.env.PATH, platform, exists);
  const detected: string[] = [];
  for (const candidate of candidates) {
    const version = await probeNodeVersion(candidate, options.exec);
    detected.push(`${candidate} (${version.raw})`);
    if (version.parsed && compareNodeVersions(version.parsed, required) >= 0) {
      return candidate;
    }
  }

  throw new Error(
    `Could not find Node >=${options.minimumVersion} required by the PI SDK on PATH. `
    + `${detected.length > 0 ? `Detected: ${detected.join(', ')}. ` : ''}`
    + 'Set pie.nodePath or PI_NODE_PATH to a compatible Node executable.',
  );
}

export function resolveNodePath(options: ResolveNodePathOptions): string {
  const exists = options.exists ?? defaultExists;
  const platform = options.platform ?? process.platform;

  const configuredPath = ensureExistingPath(
    'Configured PI nodePath',
    options.configuredPath,
    exists,
  );
  if (configuredPath) {
    return configuredPath;
  }

  const envPath = ensureExistingPath('PI_NODE_PATH', options.env.PI_NODE_PATH, exists);
  if (envPath) {
    return envPath;
  }

  const fromPath = findOnPath('node', options.env.PATH, platform, exists);
  if (fromPath) {
    return fromPath;
  }

  throw new Error(
    'Could not find a standalone Node.js runtime. Set pie.nodePath, PI_NODE_PATH, or add node to PATH.',
  );
}

/**
 * Resolve startup's Node route while keeping legacy resolution byte-for-byte
 * unchanged whenever the bundled payload is absent. A present payload is
 * authoritative: invalid metadata or a missing executable is an error, never
 * a reason to fall back to ambient PATH.
 */
export async function resolveStartupNodePath(
  options: ResolveStartupNodePathOptions,
): Promise<StartupNodePathSelection> {
  const exists = options.exists ?? defaultExists;
  const configuredPath = ensureExistingPath('Configured PI nodePath', options.configuredPath, exists);
  if (configuredPath) return { nodePath: configuredPath, source: 'configured' };

  const envPath = ensureExistingPath('PI_NODE_PATH', options.env.PI_NODE_PATH, exists);
  if (envPath) return { nodePath: envPath, source: 'environment' };

  const nodeRuntimeDir = path.join(options.runtimeOutDir, 'resources', 'node-runtime');
  if (hasBundledNodeRuntimeDirectory(nodeRuntimeDir)) {
    const manifest = await readNodeRuntimeManifest(nodeRuntimeDir) as NodeRuntimeManifest;
    const { payloadIdentity, ...manifestWithoutIdentity } = manifest;
    const actualIdentity = computeNodeRuntimePayloadIdentity(manifestWithoutIdentity);
    if (actualIdentity !== payloadIdentity) {
      throw new Error('Invalid bundled Node runtime: payloadIdentity does not match its canonical manifest metadata.');
    }
    if (manifest.schemaVersion !== 1 || manifest.kind !== 'node-runtime') {
      throw new Error('Invalid bundled Node runtime: unsupported manifest identity.');
    }
    if (manifest.nodeVersion !== BUNDLED_NODE_VERSION) {
      throw new Error(`Bundled Node runtime must be ${BUNDLED_NODE_VERSION}; manifest declares ${manifest.nodeVersion}.`);
    }
    if (manifest.target.platform !== BUNDLED_NODE_TARGET.platform
      || manifest.target.arch !== BUNDLED_NODE_TARGET.arch
      || manifest.target.nodeAbi !== BUNDLED_NODE_TARGET.nodeAbi) {
      throw new Error(
        `Bundled Node runtime target must be ${BUNDLED_NODE_TARGET.platform}/${BUNDLED_NODE_TARGET.arch}/ABI ${BUNDLED_NODE_TARGET.nodeAbi}.`,
      );
    }
    if (manifest.executable !== 'node.exe') {
      throw new Error('Invalid bundled Node runtime: executable must be node.exe.');
    }
    const nodePath = path.join(nodeRuntimeDir, manifest.executable);
    if (!exists(nodePath)) {
      throw new Error(`Bundled Node runtime executable is unavailable: ${nodePath}`);
    }
    return { nodePath, source: 'bundled', bundledManifest: manifest };
  }

  if (options.legacyDefaultPath) {
    const nodePath = ensureExistingPath('Legacy PI Node runtime', options.legacyDefaultPath, exists);
    if (nodePath) return { nodePath, source: 'legacy' };
  }

  const nodePath = resolveNodePath({ ...options, exists });
  return { nodePath, source: 'path' };
}

/** Probe a chosen bundled Node's exact product version without ambient preloads. */
export async function probeBackendNodeVersion(
  nodePath: string,
  options: ProbeBackendNodeTargetOptions = {},
): Promise<string> {
  const exec = options.exec ?? createCommandExecutor();
  const result = await exec(nodePath, ['--version'], {
    env: sanitizedNodeProbeEnv(options.env ?? process.env),
    timeout: BACKEND_NODE_PROBE_TIMEOUT_MS,
    maxBuffer: BACKEND_NODE_PROBE_MAX_BUFFER_BYTES,
  });
  const version = (result.stdout || result.stderr).trim();
  if (result.exitCode !== 0 || !version) {
    throw new Error(`Could not read backend Node version with ${nodePath}${version ? `: ${version}` : '.'}`);
  }
  return version;
}

export function assertBundledNodeTarget(
  selection: StartupNodePathSelection,
  target: GenerationPiRuntimeBackendNodeTarget,
): void {
  if (selection.source !== 'bundled') return;
  const expected = selection.bundledManifest?.target;
  if (!expected) throw new Error('Invalid bundled Node runtime selection: validated manifest is missing.');
  if (target.platform !== expected.platform || target.arch !== expected.arch || target.nodeAbi !== expected.nodeAbi) {
    throw new Error(
      `Bundled Node runtime target mismatch: manifest requires ${expected.platform}/${expected.arch}/ABI ${expected.nodeAbi}, `
      + `but executable reports ${target.platform}/${target.arch}/ABI ${target.nodeAbi}.`,
    );
  }
}

export async function assertBundledNodeVersion(
  selection: StartupNodePathSelection,
  options: ProbeBackendNodeTargetOptions = {},
): Promise<void> {
  if (selection.source !== 'bundled') return;
  const version = await probeBackendNodeVersion(selection.nodePath, options);
  if (version !== `v${BUNDLED_NODE_VERSION}` && version !== BUNDLED_NODE_VERSION) {
    throw new Error(`Bundled Node runtime must be ${BUNDLED_NODE_VERSION}; executable reports ${version}.`);
  }
}
