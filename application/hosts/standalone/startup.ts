import { existsSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { createCommandExecutor } from '../lib/command-execution';
import { resolveAgentDir, type ResolvedAgentDir } from '../lib/agent-dir-resolution';
import {
  assertBundledNodeTarget,
  assertBundledNodeVersion,
  minimumNodeVersionFromEngine,
  probeBackendNodeTarget,
  resolveCompatibleNodePath,
  resolveStartupNodePath,
  type CommandExecutor,
} from '../lib/runtime-resolution';
import { resolveGenerationPiRuntime, type GenerationPiRuntimeDescriptor } from '../lib/pi-runtime-resolution';
import { resolvePieDataPaths, type PieDataRootPaths } from '../../../lib/data-root/pie-data-root';
import { resolvePieDevelopmentProfilePaths, type PieDevelopmentProfilePaths } from '../lib/host-coordinator';
import type { RuntimeGenerationIdentity } from '../../../analytics/authority/analytics-handoff-discovery';
import {
  RUNTIME_DIRECTORY,
  acquireRuntimeGeneration,
  resolveRuntimeGeneration,
  type RuntimeLease,
} from '../vscode/runtime/runtime-generations.cjs';

export interface StandaloneDependencyPaths {
  nodePath: string;
  sdkPath: string;
  agentDir?: string;
}

export interface WorkspaceDevelopmentSdkSelection {
  kind: 'workspace-development';
  workspaceRoot: string;
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
  developmentProfilePaths?: PieDevelopmentProfilePaths;
  runtimeIdentity?: RuntimeGenerationIdentity;
  /** A real lease exists only when startup selected a managed generation. */
  runtimeLease?: Pick<RuntimeLease, 'release'>;
  /** Exact verified artifact snapshot for the selected backend Node target. */
  sourceArtifactDescriptor?: GenerationPiRuntimeDescriptor;
  /** Explicit workspace SDK route; production continues to use the artifact descriptor. */
  sdkRuntimeSelection?: WorkspaceDevelopmentSdkSelection;
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
    developmentProfilePaths?: PieDevelopmentProfilePaths;
    env: NodeJS.ProcessEnv;
    exec: CommandExecutor;
  },
): Promise<{
  dependencies: StandaloneDependencyPaths;
  sourceArtifactDescriptor?: GenerationPiRuntimeDescriptor;
  sdkRuntimeSelection?: WorkspaceDevelopmentSdkSelection;
}> {
  const developmentWorkspace = options.env.PIE_DEVELOPMENT_PI_WORKSPACE?.trim();
  const developmentArtifactDir = options.env.PIE_DEVELOPMENT_PI_RUNTIME?.trim();
  if (developmentWorkspace && developmentArtifactDir) {
    throw new StandaloneStartupError('PIE_DEVELOPMENT_PI_WORKSPACE and PIE_DEVELOPMENT_PI_RUNTIME cannot be selected together.');
  }
  if (developmentWorkspace && !path.isAbsolute(developmentWorkspace)) {
    throw new StandaloneStartupError('PIE_DEVELOPMENT_PI_WORKSPACE must be an absolute Pi workspace root.');
  }
  if (developmentWorkspace && options.env.PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK !== '1') {
    throw new StandaloneStartupError('PIE_DEVELOPMENT_PI_WORKSPACE requires PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK=1.');
  }
  if (developmentArtifactDir && options.env.PIE_ALLOW_DEVELOPMENT_RUNTIME !== '1') {
    throw new StandaloneStartupError('PIE_DEVELOPMENT_PI_RUNTIME requires PIE_ALLOW_DEVELOPMENT_RUNTIME=1.');
  }
  const workspaceRoot = developmentWorkspace ? path.resolve(developmentWorkspace) : undefined;
  const candidateSdkPath = workspaceRoot
    ? path.join(workspaceRoot, 'packages', 'coding-agent')
    : path.join(
        developmentArtifactDir ?? path.join(runtimeOutputDirectory, 'pi-runtime'),
        'node_modules', '@earendil-works', 'pi-coding-agent',
      );
  const { nodeEngine } = validateSdk(candidateSdkPath);

  let nodeSelection: Awaited<ReturnType<typeof resolveStartupNodePath>>;
  let nodePath: string;
  try {
    nodeSelection = await resolveStartupNodePath({
      configuredPath: options.dependencies?.nodePath,
      env: { ...options.env, PI_NODE_PATH: options.env.PI_NODE_PATH?.trim() },
      runtimeOutDir: runtimeOutputDirectory,
      legacyDefaultPath: process.execPath,
    });
    // Preserve the selected output as authority; startup never re-resolves a
    // managed runtime generation to find the bundled payload.
    await assertBundledNodeVersion(nodeSelection, { exec: options.exec, env: options.env });
    const minimumVersion = minimumNodeVersionFromEngine(nodeEngine);
    nodePath = minimumVersion
      ? await resolveCompatibleNodePath({
          ...(nodeSelection.source === 'path' ? {} : { configuredPath: nodeSelection.nodePath }),
          env: options.env,
          exec: options.exec,
          minimumVersion,
        })
      : nodeSelection.nodePath;
    // Bind probing and spawning to the same executable even when the backend
    // later changes cwd to the user's workspace.
    nodePath = path.resolve(nodePath);
  } catch (error) {
    throw new StandaloneStartupError(`Could not resolve a compatible Node.js runtime: ${error instanceof Error ? error.message : String(error)}`);
  }

  let sourceArtifactDescriptor: GenerationPiRuntimeDescriptor | undefined;
  const sdkRuntimeSelection: WorkspaceDevelopmentSdkSelection | undefined = workspaceRoot
    ? { kind: 'workspace-development', workspaceRoot }
    : undefined;
  try {
    const target = await probeBackendNodeTarget(nodePath, { exec: options.exec, env: options.env });
    assertBundledNodeTarget(nodeSelection, target);
    if (!workspaceRoot) {
      sourceArtifactDescriptor = await resolveGenerationPiRuntime({
        runtimeOutDir: runtimeOutputDirectory,
        target,
        ...(developmentArtifactDir ? {
          developmentOverride: { artifactDir: developmentArtifactDir, allowDevelopmentRuntime: true },
        } : {}),
      });
    }
  } catch (error) {
    const runtimeLabel = workspaceRoot ? 'workspace-development Pi SDK' : 'standalone PI runtime artifact';
    throw new StandaloneStartupError(`Could not verify the ${runtimeLabel}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const resolvedAgentDir: ResolvedAgentDir | { agentDir: string } = options.developmentProfilePaths
    ? { agentDir: options.developmentProfilePaths.agentDir }
    : resolveAgentDir({
        envAgentDir: options.dependencies?.agentDir ?? options.env.PI_CODING_AGENT_DIR,
        extensionPath,
      });
  return {
    dependencies: {
      nodePath,
      // Production remains bound to the verified artifact; workspace mode is
      // selected only by its explicit opt-in and carries its own route below.
      sdkPath: sourceArtifactDescriptor?.sdkPath ?? candidateSdkPath,
      ...(resolvedAgentDir.agentDir ? { agentDir: resolvedAgentDir.agentDir } : {}),
    },
    ...(sourceArtifactDescriptor ? { sourceArtifactDescriptor } : {}),
    ...(sdkRuntimeSelection ? { sdkRuntimeSelection } : {}),
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
  const directory = path.join(extensionPath, RUNTIME_DIRECTORY, 'selections');
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
  const startupEnvironment = options.env ?? process.env;
  const suppliedDependencies = options.dependencies ?? injectedEnvironment?.dependencies;
  const extensionPath = path.resolve(options.extensionPath || injectedEnvironment?.paths.extensionPath || '');
  const runtimeIdentity = readRuntimeIdentity(extensionPath);
  let developmentProfilePaths: PieDevelopmentProfilePaths | undefined;
  try {
    developmentProfilePaths = resolvePieDevelopmentProfilePaths(startupEnvironment, {
      ...(suppliedDependencies?.agentDir ? { agentDir: suppliedDependencies.agentDir } : {}),
      ...(options.dataRoot ? { dataDir: options.dataRoot } : {}),
    });
  } catch (error) {
    throw new StandaloneStartupError(`Could not resolve the isolated development profile: ${error instanceof Error ? error.message : String(error)}`);
  }
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
    let sdkRuntimeSelection: WorkspaceDevelopmentSdkSelection | undefined = injectedEnvironment?.sdkRuntimeSelection;
    if (skipValidation) {
      dependencies = options.dependencies ?? injectedEnvironment?.dependencies ?? {
        nodePath: process.execPath,
        sdkPath: '',
      };
    } else {
      const injectedDependencies = options.dependencies ?? injectedEnvironment?.dependencies;
      const resolved = await resolveDependencies(extensionPath, runtimeSelection.runtimeOutputDirectory, {
        ...(injectedDependencies ? { dependencies: injectedDependencies } : {}),
        ...(developmentProfilePaths ? { developmentProfilePaths } : {}),
        env: startupEnvironment,
        exec: options.exec ?? createCommandExecutor(),
      });
      dependencies = resolved.dependencies;
      sourceArtifactDescriptor = resolved.sourceArtifactDescriptor;
      sdkRuntimeSelection = resolved.sdkRuntimeSelection;
    }
    if (developmentProfilePaths) {
      // The test/embedding skip-validation seam must not bypass profile
      // isolation for mutable SDK state.
      dependencies = { ...dependencies, agentDir: developmentProfilePaths.agentDir };
    }
    if (!skipValidation) {
      requireFile(dependencies.nodePath, 'Standalone Node.js runtime');
      validateSdk(dependencies.sdkPath);
      if (dependencies.agentDir && !developmentProfilePaths) requireDirectory(dependencies.agentDir, 'PI agent directory');
    }

    const dataPaths = developmentProfilePaths
      ? workspaceDataPaths(developmentProfilePaths.dataDir, developmentProfilePaths.agentDir)
      : injectedEnvironment?.dataPaths ?? workspaceDataPaths(options.dataRoot, dependencies.agentDir);
    // Never accept identity injected by an embedding caller: the package manifest
    // is the authority used by the generation manager.
    const environment = {
      paths,
      dependencies,
      dataPaths,
      ...(developmentProfilePaths ? { developmentProfilePaths } : {}),
      ...(runtimeIdentity ? { runtimeIdentity } : {}),
      ...(runtimeSelection.runtimeLease ? { runtimeLease: runtimeSelection.runtimeLease } : {}),
      ...(sourceArtifactDescriptor ? { sourceArtifactDescriptor } : {}),
      ...(sdkRuntimeSelection ? { sdkRuntimeSelection } : {}),
    };
    return environment;
  } catch (error) {
    await runtimeSelection.runtimeLease?.release().catch(() => undefined);
    throw error;
  }
}
