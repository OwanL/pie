import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { ActivationStore } from '../analytics/activation-store';
import { createCommandExecutor } from '../shared/exec-command';
import { resolveAgentDir, type ResolvedAgentDir } from '../shared/agent-dir-resolution';
import {
  minimumNodeVersionFromEngine,
  resolveCompatibleNodePath,
  resolveNodePath,
  resolveSdkPath,
} from '../shared/runtime-resolution';
import { resolvePieDataPaths, type PieDataRootPaths } from '../../../shared/pie-data-root';
import type { RuntimeGenerationIdentity } from '../host/analytics-handoff-discovery';

export interface StandaloneDependencyPaths {
  nodePath: string;
  sdkPath: string;
  agentDir?: string;
}

export interface StandaloneRuntimePaths {
  extensionPath: string;
  runtimeOutputDirectory: string;
  backendPath: string;
  analyticsRecorderWorkerPath: string;
  analyticsQueryWorkerPath: string;
  webviewAssetDirectory: string;
  iconPath?: string;
}

export interface StandaloneEnvironment {
  paths: StandaloneRuntimePaths;
  dependencies: StandaloneDependencyPaths;
  dataPaths: PieDataRootPaths;
  runtimeIdentity?: RuntimeGenerationIdentity;
}

export interface ResolveStandaloneEnvironmentOptions {
  extensionPath: string;
  runtimeOutputDirectory?: string;
  dataRoot?: string;
  dependencies?: StandaloneDependencyPaths;
  skipValidation?: boolean;
}

export class StandaloneStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StandaloneStartupError';
  }
}

function requireDirectory(directory: string, label: string): void {
  try {
    if (!statSync(directory).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw new StandaloneStartupError(`${label} is unavailable: ${directory} (${error instanceof Error ? error.message : String(error)})`);
  }
}

function requireFile(filePath: string, label: string): void {
  try {
    if (!statSync(filePath).isFile()) throw new Error('not a file');
  } catch (error) {
    throw new StandaloneStartupError(`${label} is unavailable: ${filePath} (${error instanceof Error ? error.message : String(error)})`);
  }
}

function readSdkManifestPath(runtimeOutputDirectory: string): string | undefined {
  const manifestPath = path.join(runtimeOutputDirectory, 'sdk-local-path.json');
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { sdkPath?: unknown };
    return typeof parsed.sdkPath === 'string' && parsed.sdkPath.trim().length > 0
      ? parsed.sdkPath.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function readRuntimeIdentity(extensionPath: string): RuntimeGenerationIdentity | undefined {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(extensionPath, 'package.json'), 'utf8')) as Record<string, unknown>;
    const publisher = packageJson.publisher;
    const name = packageJson.name;
    const version = packageJson.version;
    if (typeof publisher !== 'string' || typeof name !== 'string' || typeof version !== 'string') return undefined;
    if (!publisher || !name || !version) return undefined;
    return { publisher, name, version };
  } catch {
    return undefined;
  }
}

function validateBuild(paths: StandaloneRuntimePaths): void {
  requireDirectory(paths.extensionPath, 'Standalone extension root');
  requireDirectory(paths.runtimeOutputDirectory, 'Standalone runtime output');
  requireFile(paths.backendPath, 'Standalone backend bundle');
  requireFile(path.join(paths.runtimeOutputDirectory, 'worker-entry.js'), 'Standalone worker bundle');
  requireFile(paths.analyticsRecorderWorkerPath, 'Standalone analytics recorder worker');
  requireFile(paths.analyticsQueryWorkerPath, 'Standalone analytics query worker');
  requireDirectory(paths.webviewAssetDirectory, 'Standalone webview assets');
  requireFile(path.join(paths.webviewAssetDirectory, '.vite', 'manifest.json'), 'Standalone webview manifest');
}

function validateSdk(sdkPath: string): { nodeEngine?: string } {
  const packagePath = path.join(sdkPath, 'package.json');
  requireFile(packagePath, 'PI SDK package');
  requireFile(path.join(sdkPath, 'dist', 'index.js'), 'PI SDK entry');
  try {
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as { engines?: { node?: unknown } };
    return {
      nodeEngine: typeof packageJson.engines?.node === 'string' ? packageJson.engines.node : undefined,
    };
  } catch (error) {
    throw new StandaloneStartupError(`PI SDK package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function resolveDependencies(
  extensionPath: string,
  runtimeOutputDirectory: string,
): Promise<StandaloneDependencyPaths> {
  const exec = createCommandExecutor();
  const configuredSdkPath = process.env.PI_SDK_PATH?.trim() || undefined;
  const localCandidatePath = readSdkManifestPath(runtimeOutputDirectory)
    ?? path.join(extensionPath, 'node_modules', '@earendil-works', 'pi-coding-agent');
  let sdkPath: string;
  try {
    sdkPath = await resolveSdkPath({
      configuredPath: configuredSdkPath,
      localCandidatePath,
      env: process.env as NodeJS.ProcessEnv,
      exec,
    });
  } catch (error) {
    throw new StandaloneStartupError(`Could not resolve the PI SDK: ${error instanceof Error ? error.message : String(error)}`);
  }

  const { nodeEngine } = validateSdk(sdkPath);
  let nodePath: string;
  try {
    const configuredNodePath = process.env.PI_NODE_PATH?.trim() || process.execPath;
    const minimumVersion = minimumNodeVersionFromEngine(nodeEngine);
    nodePath = minimumVersion
      ? await resolveCompatibleNodePath({
          configuredPath: configuredNodePath,
          env: process.env as NodeJS.ProcessEnv,
          exec,
          minimumVersion,
        })
      : resolveNodePath({
          configuredPath: configuredNodePath,
          env: process.env as NodeJS.ProcessEnv,
        });
  } catch (error) {
    throw new StandaloneStartupError(`Could not resolve a compatible Node.js runtime: ${error instanceof Error ? error.message : String(error)}`);
  }

  const resolvedAgentDir: ResolvedAgentDir = resolveAgentDir({
    configuredAgentDir: process.env.PI_CODING_AGENT_DIR,
    envAgentDir: process.env.PI_CODING_AGENT_DIR,
    extensionPath,
  });
  return {
    nodePath,
    sdkPath,
    ...(resolvedAgentDir.agentDir ? { agentDir: resolvedAgentDir.agentDir } : {}),
  };
}

function buildPaths(extensionPath: string, runtimeOutputDirectory: string): StandaloneRuntimePaths {
  const webviewAssetDirectory = path.join(runtimeOutputDirectory, 'webview', 'panel');
  const iconPath = path.join(extensionPath, 'media', 'icon.svg');
  return {
    extensionPath,
    runtimeOutputDirectory,
    backendPath: path.join(runtimeOutputDirectory, 'backend.js'),
    analyticsRecorderWorkerPath: path.join(runtimeOutputDirectory, 'analytics-recorder-worker.js'),
    analyticsQueryWorkerPath: path.join(runtimeOutputDirectory, 'analytics-query-worker.js'),
    webviewAssetDirectory,
    ...(existsSync(iconPath) ? { iconPath } : {}),
  };
}

function workspaceDataPaths(dataRoot: string | undefined, agentDir: string | undefined): PieDataRootPaths {
  try {
    return resolvePieDataPaths({
      ...(dataRoot !== undefined ? { dataDir: dataRoot } : {}),
      ...(agentDir !== undefined ? { agentDir } : {}),
    });
  } catch (error) {
    throw new StandaloneStartupError(`Could not resolve the Pie data root: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Preserve canonical activation authority even when a test/embedding caller
 * supplies an already-resolved environment object. */
export function validateStandaloneRuntimeIdentity(environment: Pick<StandaloneEnvironment, 'dataPaths' | 'runtimeIdentity'>): void {
  const activation = new ActivationStore({ stateDir: environment.dataPaths.stateDir }).read();
  if (activation.authority === 'canonical' && environment.runtimeIdentity === undefined) {
    throw new StandaloneStartupError(
      'Canonical analytics activation requires a readable extension runtime identity (publisher/name/version).',
    );
  }
}

/**
 * Resolve and validate everything the standalone process owns before creating
 * HostRuntime.  The dependency resolver follows the same SDK/node/agent
 * precedence as the VS Code startup path, but uses the current checkout's
 * pinned SDK and the launching Node executable as portable defaults.
 */
export async function resolveStandaloneEnvironment(
  options: ResolveStandaloneEnvironmentOptions,
): Promise<StandaloneEnvironment> {
  const extensionPath = path.resolve(options.extensionPath);
  const runtimeOutputDirectory = path.resolve(options.runtimeOutputDirectory ?? path.join(extensionPath, 'out'));
  const paths = buildPaths(extensionPath, runtimeOutputDirectory);
  if (!options.skipValidation) validateBuild(paths);

  const dependencies = options.dependencies
    ?? await resolveDependencies(extensionPath, runtimeOutputDirectory);
  if (!options.skipValidation) {
    requireFile(dependencies.nodePath, 'Standalone Node.js runtime');
    validateSdk(dependencies.sdkPath);
    if (dependencies.agentDir) requireDirectory(dependencies.agentDir, 'PI agent directory');
  }

  const dataPaths = workspaceDataPaths(options.dataRoot, dependencies.agentDir);
  const runtimeIdentity = readRuntimeIdentity(extensionPath);
  // A canonical manifest is already an authority decision. Do not turn an
  // unavailable runtime identity into a legacy-looking standalone host.
  const environment = { paths, dependencies, dataPaths, ...(runtimeIdentity ? { runtimeIdentity } : {}) };
  validateStandaloneRuntimeIdentity(environment);
  return environment;
}

/** Stable workspace key used by smoke tests and diagnostics without exposing
 * the path itself in a host-storage filename. */
export function standaloneWorkspaceKey(workspaceCwd: string): string {
  const normalizedPath = path.resolve(workspaceCwd).replaceAll('\\', '/');
  const normalized = process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}
