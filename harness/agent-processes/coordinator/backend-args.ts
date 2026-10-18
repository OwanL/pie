import { assertAnalyticsBackendContext, type AnalyticsBackendContext } from '../../../analytics/authority/backend-analytics-context.js';
import path from 'node:path';
import type { GenerationPiRuntimeDescriptor } from '../../../lib/pi-runtime/artifact.mjs';
import {
  assertWorkspaceDevelopmentSdkOptIn,
  parseSdkRuntimeSelection,
  sdkRuntimeSdkPath,
  type SdkRuntimeSelection,
} from '../lib/sdk-integration/sdk-runtime-selection';

// ─── Argument parsing ────────────────────────────────────────────────────────

interface BackendArgsCommon {
  sdkPath: string;
  cwd: string;
  /** Host-authoritative process generation, shared by public/detail/worker fences. */
  backendGeneration: number;
  /** Extension-host PID used to reap the backend after a host crash. */
  hostPid?: number;
  /** Dedicated inherited descriptor whose EOF proves the host disappeared. */
  lifetimeFd?: number;
  /** Immutable canonical analytics authority snapshot, supplied only by the
   * production host after its readiness probe succeeds. */
  analyticsContext: AnalyticsBackendContext;
}

export type BackendArgs = BackendArgsCommon & (
  | {
      /** Verified generation-local Pi artifact selected by the production host. */
      sourceArtifactDescriptor: GenerationPiRuntimeDescriptor;
      sdkRuntimeSelection?: never;
    }
  | {
      /** Explicit runtime route for development launches; never synthesized from a path. */
      sdkRuntimeSelection: SdkRuntimeSelection;
      sourceArtifactDescriptor?: never;
    }
);

export function parseArgs(argv: string[], environment: NodeJS.ProcessEnv = process.env): BackendArgs {
  let sdkPath = '';
  let cwd = process.cwd();
  let hostPid: number | undefined;
  let lifetimeFd: number | undefined;
  let backendGeneration = 1;
  let analyticsContext: AnalyticsBackendContext | undefined;
  let sourceArtifactDescriptor: GenerationPiRuntimeDescriptor | undefined;
  let sourceArtifactDescriptorSeen = false;
  let sdkRuntimeSelection: SdkRuntimeSelection | undefined;
  let sdkRuntimeSelectionSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--analyticsContext') {
      if (analyticsContext !== undefined) throw new Error('Duplicate --analyticsContext argument.');
      if (!value || value.startsWith('--')) throw new Error('Missing value for --analyticsContext.');
      const parsed: unknown = JSON.parse(value);
      assertAnalyticsBackendContext(parsed);
      analyticsContext = parsed;
      index += 1;
      continue;
    }
    if (arg === '--sourceArtifactDescriptor') {
      if (sourceArtifactDescriptorSeen) throw new Error('Duplicate --sourceArtifactDescriptor argument.');
      if (sdkRuntimeSelectionSeen) throw new Error('Duplicate SDK runtime selection argument.');
      sourceArtifactDescriptorSeen = true;
      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --sourceArtifactDescriptor.');
      }
      let descriptor: unknown;
      try {
        descriptor = JSON.parse(value);
      } catch {
        throw new Error('Malformed JSON for --sourceArtifactDescriptor.');
      }
      try {
        const selection = parseSdkRuntimeSelection({ kind: 'source-artifact', descriptor });
        if (selection.kind !== 'source-artifact') throw new TypeError('Source artifact selection expected.');
        sourceArtifactDescriptor = selection.descriptor;
      } catch (error) {
        const detail = error instanceof Error ? ` ${error.message}` : '';
        throw new Error(`Invalid --sourceArtifactDescriptor argument.${detail}`);
      }
      index += 1;
      continue;
    }
    if (arg === '--sdkRuntimeSelection') {
      if (sdkRuntimeSelectionSeen || sourceArtifactDescriptorSeen) throw new Error('Duplicate SDK runtime selection argument.');
      sdkRuntimeSelectionSeen = true;
      if (!value || value.startsWith('--')) throw new Error('Missing value for --sdkRuntimeSelection.');
      let selection: unknown;
      try {
        selection = JSON.parse(value);
      } catch {
        throw new Error('Malformed JSON for --sdkRuntimeSelection.');
      }
      try {
        sdkRuntimeSelection = parseSdkRuntimeSelection(selection);
        if (sdkRuntimeSelection.kind === 'workspace-development') assertWorkspaceDevelopmentSdkOptIn(environment);
      } catch (error) {
        const detail = error instanceof Error ? ` ${error.message}` : '';
        throw new Error(`Invalid --sdkRuntimeSelection argument.${detail}`);
      }
      index += 1;
      continue;
    }
    if (arg === '--sdkPath' && value) {
      sdkPath = value;
      index += 1;
      continue;
    }
    if (arg === '--cwd' && value) {
      cwd = value;
      index += 1;
      continue;
    }
    if (arg === '--hostPid' && value) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        hostPid = parsed;
      }
      index += 1;
      continue;
    }
    if (arg === '--backendGeneration' && value) {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error('Invalid --backendGeneration argument.');
      }
      backendGeneration = parsed;
      index += 1;
      continue;
    }
    if (arg === '--lifetimeFd' && value) {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 3) {
        throw new Error('Invalid --lifetimeFd argument.');
      }
      lifetimeFd = parsed;
      index += 1;
    }
  }

  if (!sdkPath) {
    throw new Error('Missing required --sdkPath argument.');
  }
  if (!sourceArtifactDescriptor && !sdkRuntimeSelection) {
    throw new Error('Missing required --sourceArtifactDescriptor argument or --sdkRuntimeSelection argument.');
  }
  if (sdkRuntimeSelection?.kind === 'workspace-development') {
    const expectedSdkPath = sdkRuntimeSdkPath(sdkRuntimeSelection);
    const actual = path.resolve(sdkPath);
    const expected = path.resolve(expectedSdkPath);
    if (!path.isAbsolute(sdkPath)
        || (process.platform === 'win32' ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected)) {
      throw new Error('--sdkPath does not identify the selected workspace-development Pi package root.');
    }
  }

  if (analyticsContext === undefined) {
    throw new Error('Missing required --analyticsContext argument.');
  }

  const common: BackendArgsCommon = {
    sdkPath,
    cwd,
    backendGeneration,
    ...(hostPid === undefined ? {} : { hostPid }),
    ...(lifetimeFd === undefined ? {} : { lifetimeFd }),
    analyticsContext,
  };
  if (sourceArtifactDescriptor !== undefined) return { ...common, sourceArtifactDescriptor };
  return { ...common, sdkRuntimeSelection: sdkRuntimeSelection! };
}
