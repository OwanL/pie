import * as path from 'node:path';

import type {
  BackendStartupPlatform,
  SessionHostPlatform,
} from '../../lib/platform-contracts/session-platform.js';
import { createCommandExecutor } from './command-execution';
import { resolveAgentDir, type ResolvedAgentDir } from './agent-dir-resolution';
import { initializeNormalProfile } from './normal-profile-initialization';
import {
  probeBackendNodeTarget,
  resolveNodePath,
} from './runtime-resolution';
import { resolveGenerationPiRuntime } from './pi-runtime-resolution';
import { resolvePieDevelopmentProfilePaths } from './host-coordinator';
import { appendPieLog } from '../../../lib/structured-logging/pie-logger';

function finishPreflightTiming(stage: string, started: number, outcome: 'success' | 'failure'): void {
  try {
    appendPieLog('info', 'startup', 'DEBUG-startup-preflight', {
      stage, durationMs: performance.now() - started, outcome,
    });
  } catch { /* Best-effort diagnostics preserve the original error. */ }
}

const DEVELOPMENT_RUNTIME_PATH_ENV = 'PIE_DEVELOPMENT_PI_RUNTIME';
const ALLOW_DEVELOPMENT_RUNTIME_ENV = 'PIE_ALLOW_DEVELOPMENT_RUNTIME';
const DEVELOPMENT_PI_WORKSPACE_ENV = 'PIE_DEVELOPMENT_PI_WORKSPACE';
const ALLOW_WORKSPACE_DEVELOPMENT_SDK_ENV = 'PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK';

/** The platform members consumed by host-owned preflight; deliberately excludes
 * the preflight port itself to keep the composition acyclic. */
type BackendStartupHost = Pick<SessionHostPlatform,
  'extensionPath' | 'getRuntimeOutputDirectory' | 'getSetting'>;

function applyDevelopmentProfileEnvironment(env: NodeJS.ProcessEnv): boolean {
  const paths = resolvePieDevelopmentProfilePaths(env);
  if (!paths) return false;
  env.PI_CODING_AGENT_DIR = paths.agentDir;
  env.PI_CODING_AGENT_AUTH_DIR = paths.authDir;
  env.PIE_DATA_DIR = paths.dataDir;
  env.PI_CODING_AGENT_SESSION_DIR = paths.sessionDir;
  // Development credentials live below the isolated agent directory. Never
  // inherit checkout-root auth as a fallback.
  delete env.PIE_ALLOW_IN_TREE_AUTH;
  return true;
}

export function prepareBackendEnvironment(
  host: BackendStartupHost,
  onNotice: (notice: string) => void,
  env: NodeJS.ProcessEnv,
): ResolvedAgentDir | undefined {
  if (applyDevelopmentProfileEnvironment(env)) return;

  const configuredAgentDir = (host.getSetting<string>('agentDir') ?? '').trim();
  const result = resolveAgentDir({
    configuredAgentDir,
    envAgentDir: env.PI_CODING_AGENT_DIR,
    extensionPath: host.extensionPath,
    localAppDataDir: env.LOCALAPPDATA ?? '',
  });

  // Always select Pie's root explicitly; never activate the SDK's ~/.pi/agent
  // fallback. This preflight only selects paths, and does not seed user files.
  env.PI_CODING_AGENT_DIR = result.agentDir;

  const settingRejected = result.rejections.some((rejection) => rejection.source === 'setting');
  if (settingRejected && result.source !== 'setting') {
    const sourceLabel = result.source === 'env'
      ? 'the PI_CODING_AGENT_DIR env var'
      : result.source === 'extension-relative'
        ? 'the checkout agent dir'
        : 'the normal Pie configuration home';
    const recoveryAdvice = result.source === 'normal'
      ? 'Clear the stale pie.agentDir setting to use the application default and clear this warning.'
      : 'Set pie.agentDir to this path, or re-run the installer, to clear this warning.';
    onNotice(
      `pie.agentDir points to a path that no longer exists${configuredAgentDir ? ` (${configuredAgentDir})` : ''}. `
      + `Recovering using ${sourceLabel} (${result.agentDir}). ${recoveryAdvice}`,
    );
  }

  if (host.getSetting<boolean>('allowInTreeAuth') ?? false) {
    env.PIE_ALLOW_IN_TREE_AUTH = '1';
  } else {
    delete env.PIE_ALLOW_IN_TREE_AUTH;
  }
  return result;
}

/** Compose the concrete host-owned implementation of backend runtime and
 * environment preflight. Both VS Code and standalone provide their actual
 * settings/output-directory adapters here. */
export function createBackendStartupPlatform(host: BackendStartupHost): BackendStartupPlatform {
  let environmentPrepared = false;
  return {
    prepareDevelopmentEnvironment: (onNotice = () => undefined) => {
      // Both composition roots hold host ownership before shared startup enters
      // here. Select once, before settings services can observe another root.
      const selection = prepareBackendEnvironment(host, onNotice, process.env);
      if (selection) initializeNormalProfile(selection);
      environmentPrepared = true;
    },
    resolveBackendLaunchPaths: async () => {
      const env = process.env;
      // Validate the development boundary before selecting any runtime route.
      // An SDK override is never permission to fall back to production state.
      resolvePieDevelopmentProfilePaths(env);
      const configuredNodePath = host.getSetting<string>('nodePath', 'nodePath');
      const nodePath = path.resolve(resolveNodePath({
        configuredPath: configuredNodePath,
        env,
      }));
      const exec = createCommandExecutor();
      const probeStarted = performance.now();
      let probeOutcome: 'success' | 'failure' = 'failure';
      let target: Awaited<ReturnType<typeof probeBackendNodeTarget>>;
      try {
        target = await probeBackendNodeTarget(nodePath, { exec });
        probeOutcome = 'success';
      } finally {
        finishPreflightTiming('node-target-probe', probeStarted, probeOutcome);
      }

      const developmentWorkspace = env[DEVELOPMENT_PI_WORKSPACE_ENV]?.trim();
      const developmentArtifactDir = env[DEVELOPMENT_RUNTIME_PATH_ENV]?.trim();
      if (developmentWorkspace && developmentArtifactDir) {
        throw new Error(`${DEVELOPMENT_PI_WORKSPACE_ENV} and ${DEVELOPMENT_RUNTIME_PATH_ENV} cannot be selected together.`);
      }
      if (developmentWorkspace) {
        if (!path.isAbsolute(developmentWorkspace)) {
          throw new Error(`${DEVELOPMENT_PI_WORKSPACE_ENV} must be an absolute Pi workspace root.`);
        }
        if (env[ALLOW_WORKSPACE_DEVELOPMENT_SDK_ENV] !== '1') {
          throw new Error(`${DEVELOPMENT_PI_WORKSPACE_ENV} requires ${ALLOW_WORKSPACE_DEVELOPMENT_SDK_ENV}=1.`);
        }
        const workspaceRoot = path.resolve(developmentWorkspace);
        return {
          nodePath,
          sdkPath: path.join(workspaceRoot, 'packages', 'coding-agent'),
          sdkRuntimeSelection: { kind: 'workspace-development', workspaceRoot },
        };
      }
      if (developmentArtifactDir && env[ALLOW_DEVELOPMENT_RUNTIME_ENV] !== '1') {
        throw new Error(
          `${DEVELOPMENT_RUNTIME_PATH_ENV} requires ${ALLOW_DEVELOPMENT_RUNTIME_ENV}=1.`,
        );
      }
      const verificationStarted = performance.now();
      let verificationOutcome: 'success' | 'failure' = 'failure';
      let runtime: Awaited<ReturnType<typeof resolveGenerationPiRuntime>>;
      try {
        runtime = await resolveGenerationPiRuntime({
          runtimeOutDir: host.getRuntimeOutputDirectory(),
          target,
          ...(developmentArtifactDir ? {
            developmentOverride: {
              artifactDir: developmentArtifactDir,
              allowDevelopmentRuntime: true,
            },
          } : {}),
        });
        verificationOutcome = 'success';
      } finally {
        finishPreflightTiming('sdk-artifact-verification', verificationStarted, verificationOutcome);
      }
      return {
        nodePath,
        sdkPath: runtime.sdkPath,
        sourceArtifactDescriptor: runtime,
      };
    },
    prepareBackendEnvironment: (onNotice) => {
      if (!environmentPrepared) prepareBackendEnvironment(host, onNotice, process.env);
    },
  };
}
