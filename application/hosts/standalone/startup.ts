import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { ActivationStore } from '../../../analytics/authority/activation-store';
import { createCommandExecutor } from '../lib/command-execution';
import { resolveAgentDir, type ResolvedAgentDir } from '../lib/agent-dir-resolution';
import {
  minimumNodeVersionFromEngine,
  probeBackendNodeTarget,
  resolveCompatibleNodePath,
  resolveNodePath,
  type CommandExecutor,
} from '../lib/runtime-resolution';
import { resolveGenerationPiRuntime, type GenerationPiRuntimeDescriptor } from '../lib/pi-runtime-resolution';
import { resolvePieDataPaths, type PieDataRootPaths } from '../../../lib/data-root/pie-data-root';
import type { RuntimeGenerationIdentity } from '../../../analytics/authority/analytics-handoff-discovery';
import {
  acquireRuntimeGeneration,
  resolveRuntimeGeneration,
  type RuntimeLease,
} from '../vscode/runtime/runtime-generations.cjs';

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
  /** A real lease exists only when startup selected a managed generation. */
  runtimeLease?: Pick<RuntimeLease, 'release'>;
  /** Exact verified artifact snapshot for the selected backend Node target. */
  sourceArtifactDescriptor?: GenerationPiRuntimeDescriptor;
}

export interface ResolveStandaloneEnvironmentOptions {
  extensionPath: string;
  runtimeOutputDirectory?: string;
  dataRoot?: string;
  dependencies?: StandaloneDependencyPaths;
  /** Caller-owned environment fixture/embedding input; it never bypasses artifact verification. */
  environment?: StandaloneEnvironment;
  /** Explicit fixture-only escape hatch for tests that do not model installed artifacts. */
  skipValidation?: boolean;
  env?: NodeJS.ProcessEnv;
  exec?: CommandExecutor;
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
  options: {
    dependencies?: StandaloneDependencyPaths;
    env: NodeJS.ProcessEnv;
    exec: CommandExecutor;
  },
): Promise<{ dependencies: StandaloneDependencyPaths; sourceArtifactDescriptor: GenerationPiRuntimeDescriptor }> {
  const developmentArtifactDir = options.env.PIE_DEVELOPMENT_PI_RUNTIME?.trim();
  if (developmentArtifactDir && options.env.PIE_ALLOW_DEVELOPMENT_RUNTIME !== '1') {
    throw new StandaloneStartupError('PIE_DEVELOPMENT_PI_RUNTIME requires PIE_ALLOW_DEVELOPMENT_RUNTIME=1.');
  }
  const candidateSdkPath = path.join(
    developmentArtifactDir ?? path.join(runtimeOutputDirectory, 'pi-runtime'),
    'node_modules', '@earendil-works', 'pi-coding-agent',
  );
  const { nodeEngine } = validateSdk(candidateSdkPath);

  let nodePath: string;
  try {
    const configuredNodePath = options.dependencies?.nodePath
      ?? options.env.PI_NODE_PATH?.trim()
      ?? process.execPath;
    const minimumVersion = minimumNodeVersionFromEngine(nodeEngine);
    nodePath = minimumVersion
      ? await resolveCompatibleNodePath({
          configuredPath: configuredNodePath,
          env: options.env,
          exec: options.exec,
          minimumVersion,
        })
      : resolveNodePath({ configuredPath: configuredNodePath, env: options.env });
    // Bind probing and spawning to the same executable even when the backend
    // later changes cwd to the user's workspace.
    nodePath = path.resolve(nodePath);
  } catch (error) {
    throw new StandaloneStartupError(`Could not resolve a compatible Node.js runtime: ${error instanceof Error ? error.message : String(error)}`);
  }

  let sourceArtifactDescriptor: GenerationPiRuntimeDescriptor;
  try {
    const target = await probeBackendNodeTarget(nodePath, { exec: options.exec, env: options.env });
    sourceArtifactDescriptor = await resolveGenerationPiRuntime({
      runtimeOutDir: runtimeOutputDirectory,
      target,
      ...(developmentArtifactDir ? {
        developmentOverride: { artifactDir: developmentArtifactDir, allowDevelopmentRuntime: true },
      } : {}),
    });
  } catch (error) {
    throw new StandaloneStartupError(`Could not verify the standalone PI runtime artifact: ${error instanceof Error ? error.message : String(error)}`);
  }

  const resolvedAgentDir: ResolvedAgentDir = resolveAgentDir({
    envAgentDir: options.dependencies?.agentDir ?? options.env.PI_CODING_AGENT_DIR,
    extensionPath,
  });
  return {
    dependencies: {
      nodePath,
      // Explicit/global SDK overrides are deliberately ignored: the only SDK
      // accepted in production is the one bound by the verified artifact.
      sdkPath: sourceArtifactDescriptor.sdkPath,
      ...(resolvedAgentDir.agentDir ? { agentDir: resolvedAgentDir.agentDir } : {}),
    },
    sourceArtifactDescriptor,
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
 * HostRuntime. Production startup accepts only the verified Pi SDK artifact
 * selected from the chosen output directory and probes the exact backend Node.
 */
function normalizedPathIdentity(value: string): string {
  const resolved = path.resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function hasManagedRuntimeSelections(extensionPath: string): boolean {
  const directory = path.join(extensionPath, 'pie-runtime', 'selections');
  try {
    if (!statSync(directory).isDirectory()) {
      throw new StandaloneStartupError(`Managed runtime selections are unavailable: ${directory} (not a directory)`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function selectRuntimeOutput(options: {
  extensionPath: string;
  runtimeIdentity?: RuntimeGenerationIdentity;
  explicitRuntimeOutputDirectory?: string;
  injectedRuntimeOutputDirectory?: string;
}): Promise<{ runtimeOutputDirectory: string; runtimeLease?: Pick<RuntimeLease, 'release'> }> {
  if (options.explicitRuntimeOutputDirectory !== undefined) {
    return { runtimeOutputDirectory: path.resolve(options.explicitRuntimeOutputDirectory) };
  }

  const packagedOut = path.join(options.extensionPath, 'out');
  const injectedOutput = options.injectedRuntimeOutputDirectory
    ? path.resolve(options.injectedRuntimeOutputDirectory)
    : undefined;
  const hasManagedSelections = hasManagedRuntimeSelections(options.extensionPath);
  if (injectedOutput && normalizedPathIdentity(injectedOutput) !== normalizedPathIdentity(packagedOut)) {
    // A custom environment output is caller-owned unless it is exactly the
    // currently selected managed generation. Never claim arbitrary paths.
    if (options.runtimeIdentity && hasManagedSelections) {
      const selected = await resolveRuntimeGeneration({ extensionDir: options.extensionPath, identity: options.runtimeIdentity });
      if (selected.generation !== null && normalizedPathIdentity(selected.outDir) === normalizedPathIdentity(injectedOutput)) {
        const lease = await acquireRuntimeGeneration({ extensionDir: options.extensionPath, identity: options.runtimeIdentity });
        return { runtimeOutputDirectory: lease.outDir, runtimeLease: lease };
      }
    }
    return { runtimeOutputDirectory: injectedOutput };
  }

  if (!options.runtimeIdentity || !hasManagedSelections) {
    // Flat packages own their output for their install lifetime. Avoid even
    // entering the generation manager when no managed selection exists; in
    // particular, do not create manager state or trigger retention work.
    return { runtimeOutputDirectory: injectedOutput ?? packagedOut };
  }
  const selected = await resolveRuntimeGeneration({ extensionDir: options.extensionPath, identity: options.runtimeIdentity });
  if (selected.generation === null) return { runtimeOutputDirectory: selected.outDir };
  const lease = await acquireRuntimeGeneration({ extensionDir: options.extensionPath, identity: options.runtimeIdentity });
  return { runtimeOutputDirectory: lease.outDir, runtimeLease: lease };
}

export async function resolveStandaloneEnvironment(
  options: ResolveStandaloneEnvironmentOptions,
): Promise<StandaloneEnvironment> {
  const injectedEnvironment = options.environment;
  const extensionPath = path.resolve(options.extensionPath || injectedEnvironment?.paths.extensionPath || '');
  const runtimeIdentity = readRuntimeIdentity(extensionPath);
  const skipValidation = options.skipValidation === true;
  const runtimeSelection = skipValidation
    ? {
        runtimeOutputDirectory: path.resolve(options.runtimeOutputDirectory ?? injectedEnvironment?.paths.runtimeOutputDirectory ?? path.join(extensionPath, 'out')),
        ...(injectedEnvironment?.runtimeLease ? { runtimeLease: injectedEnvironment.runtimeLease } : {}),
      }
    : await selectRuntimeOutput({
        extensionPath,
        runtimeIdentity,
        ...(options.runtimeOutputDirectory !== undefined ? { explicitRuntimeOutputDirectory: options.runtimeOutputDirectory } : {}),
        ...(injectedEnvironment ? { injectedRuntimeOutputDirectory: injectedEnvironment.paths.runtimeOutputDirectory } : {}),
      });

  try {
    const paths = buildPaths(extensionPath, runtimeSelection.runtimeOutputDirectory);
    if (!skipValidation) validateBuild(paths);

    let dependencies: StandaloneDependencyPaths;
    let sourceArtifactDescriptor: GenerationPiRuntimeDescriptor | undefined;
    if (skipValidation) {
      dependencies = options.dependencies ?? injectedEnvironment?.dependencies ?? {
        nodePath: process.execPath,
        sdkPath: '',
      };
    } else {
      const injectedDependencies = options.dependencies ?? injectedEnvironment?.dependencies;
      const resolved = await resolveDependencies(extensionPath, runtimeSelection.runtimeOutputDirectory, {
        ...(injectedDependencies ? { dependencies: injectedDependencies } : {}),
        env: options.env ?? process.env,
        exec: options.exec ?? createCommandExecutor(),
      });
      dependencies = resolved.dependencies;
      sourceArtifactDescriptor = resolved.sourceArtifactDescriptor;
    }
    if (!skipValidation) {
      requireFile(dependencies.nodePath, 'Standalone Node.js runtime');
      validateSdk(dependencies.sdkPath);
      if (dependencies.agentDir) requireDirectory(dependencies.agentDir, 'PI agent directory');
    }

    const dataPaths = injectedEnvironment?.dataPaths ?? workspaceDataPaths(options.dataRoot, dependencies.agentDir);
    // Never accept identity injected by an embedding caller: the package manifest
    // is the authority used by the generation manager and activation checks.
    const environment = {
      paths,
      dependencies,
      dataPaths,
      ...(runtimeIdentity ? { runtimeIdentity } : {}),
      ...(runtimeSelection.runtimeLease ? { runtimeLease: runtimeSelection.runtimeLease } : {}),
      ...(sourceArtifactDescriptor ? { sourceArtifactDescriptor } : {}),
    };
    validateStandaloneRuntimeIdentity(environment);
    return environment;
  } catch (error) {
    await runtimeSelection.runtimeLease?.release().catch(() => undefined);
    throw error;
  }
}

/** Stable workspace key used by smoke tests and diagnostics without exposing
 * the path itself in a host-storage filename. */
export function standaloneWorkspaceKey(workspaceCwd: string): string {
  const normalizedPath = path.resolve(workspaceCwd).replaceAll('\\', '/');
  const normalized = process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}
