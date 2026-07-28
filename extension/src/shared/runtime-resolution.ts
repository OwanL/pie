import * as path from 'node:path';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandExecutor = (command: string, args: string[]) => Promise<CommandResult>;

interface CommonOptions {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (filePath: string) => boolean;
}

export interface ResolveNodePathOptions extends CommonOptions {
  configuredPath?: string;
}

export interface ResolveCompatibleNodePathOptions extends ResolveNodePathOptions {
  exec: CommandExecutor;
  minimumVersion: string;
}

export interface ResolveSdkPathOptions extends CommonOptions {
  configuredPath?: string;
  cachedPath?: string;
  /**
   * Repo-local candidate: the SDK installed as a pinned `dependencies` entry
   * of the extension (i.e. `<extension>/node_modules/@earendil-works/pi-coding-agent`).
   * Tried after explicit overrides (setting + env) but BEFORE the globalState
   * cache and `npm root -g`, so the SDK version is locked to the extension's
   * package-lock.json — cross-machine reproducible via `npm ci` and immune to
   * a `npm i -g` upgrade silently swapping the SDK out from under the backend.
   */
  localCandidatePath?: string;
  exec: CommandExecutor;
}

const defaultExists = (filePath: string): boolean => {
  try {
    return require('node:fs').existsSync(filePath);
  } catch {
    return false;
  }
};

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

function isValidSdkPath(sdkPath: string, exists: (filePath: string) => boolean): boolean {
  return exists(path.join(sdkPath, 'package.json')) && exists(path.join(sdkPath, 'dist', 'index.js'));
}

const GLOBAL_SDK_PACKAGE_PATHS = [
  ['@earendil-works', 'pi-coding-agent'],
  ['@mariozechner', 'pi-coding-agent'],
] as const;

function isLegacyGlobalSdkPath(sdkPath: string): boolean {
  const parts = sdkPath.split(/[\\/]+/);
  return parts.at(-2) === '@mariozechner' && parts.at(-1) === 'pi-coding-agent';
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
 * Resolve the directory of the installed PI SDK package.
 *
 * Candidate priority:
 *   1. `configuredPath` (`pie.sdkPath` setting — explicit override; validated)
 *   2. `PI_SDK_PATH` env var (explicit override; validated)
 *   3. `localCandidatePath` — the SDK pinned as an extension `dependency`
 *      (`<extension>/node_modules/@earendil-works/pi-coding-agent`); validated.
 *      This is the portable default: version-locked by package-lock.json, so
 *      `git pull` + `npm ci` reproduces the exact SDK on every machine.
 *   4. `cachedPath` (globalState cache from a previous start, unless it points
 *      at the legacy `@mariozechner` global package)
 *   5. `npm root -g` discovery of the maintained or legacy global package
 */
export async function resolveSdkPath(options: ResolveSdkPathOptions): Promise<string> {
  const exists = options.exists ?? defaultExists;

  const configuredPath = options.configuredPath;
  if (configuredPath) {
    if (!isValidSdkPath(configuredPath, exists)) {
      throw new Error(`Configured PI sdkPath is not a valid SDK install: ${configuredPath}`);
    }
    return configuredPath;
  }

  const envPath = options.env.PI_SDK_PATH;
  if (envPath) {
    if (!isValidSdkPath(envPath, exists)) {
      throw new Error(`PI_SDK_PATH is not a valid SDK install: ${envPath}`);
    }
    return envPath;
  }

  // 3. Repo-local pinned dependency (preferred over cache + npm root -g).
  const localCandidate = options.localCandidatePath;
  if (localCandidate && isValidSdkPath(localCandidate, exists)) {
    return localCandidate;
  }

  if (
    options.cachedPath &&
    !isLegacyGlobalSdkPath(options.cachedPath) &&
    isValidSdkPath(options.cachedPath, exists)
  ) {
    return options.cachedPath;
  }

  const npmRoot = await options.exec('npm', ['root', '-g']);
  if (npmRoot.exitCode !== 0) {
    throw new Error(
      `Failed to resolve the global PI SDK install via npm root -g: ${npmRoot.stderr || npmRoot.stdout}`,
    );
  }

  const npmRootPath = npmRoot.stdout.trim();
  for (const packagePath of GLOBAL_SDK_PACKAGE_PATHS) {
    const sdkPath = path.join(npmRootPath, ...packagePath);
    if (isValidSdkPath(sdkPath, exists)) {
      return sdkPath;
    }
  }

  throw new Error(
    'Could not find @earendil-works/pi-coding-agent or @mariozechner/pi-coding-agent in the global npm root. Set pie.sdkPath or PI_SDK_PATH.',
  );
}
