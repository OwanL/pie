import { assertAnalyticsBackendContext, type AnalyticsBackendContext } from '../../../analytics/authority/backend-analytics-context.js';
import type { AnalyticsBackendDescriptor } from '../../../analytics/authority/activation.js';
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
  analyticsActivation?: AnalyticsBackendDescriptor;
  analyticsContext?: AnalyticsBackendContext;
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

const ANALYTICS_DESCRIPTOR_FLAGS = new Set([
  '--analyticsGenerationId',
  '--analyticsBuildId',
  '--analyticsManifestRevision',
  '--analyticsManifestSha256',
  '--analyticsWorkspaceId',
  '--analyticsHostInstanceId',
]);
const ANALYTICS_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ANALYTICS_SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export function parseArgs(argv: string[], environment: NodeJS.ProcessEnv = process.env): BackendArgs {
  let sdkPath = '';
  let cwd = process.cwd();
  let hostPid: number | undefined;
  let lifetimeFd: number | undefined;
  let backendGeneration = 1;
  const analyticsValues: Record<string, string> = {};
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
    if (ANALYTICS_DESCRIPTOR_FLAGS.has(arg)) {
      if (!value || ANALYTICS_DESCRIPTOR_FLAGS.has(value)) {
        throw new Error(`Missing value for ${arg}.`);
      }
      if (analyticsValues[arg] !== undefined) throw new Error(`Duplicate ${arg} argument.`);
      analyticsValues[arg] = value;
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

  const analyticsFlagNames = [
    '--analyticsGenerationId',
    '--analyticsBuildId',
    '--analyticsManifestRevision',
    '--analyticsManifestSha256',
    '--analyticsWorkspaceId',
    '--analyticsHostInstanceId',
  ] as const;
  const suppliedAnalyticsFlags = analyticsFlagNames.filter((flag) => analyticsValues[flag] !== undefined);
  let analyticsActivation: AnalyticsBackendDescriptor | undefined;
  if (suppliedAnalyticsFlags.length > 0) {
    if (suppliedAnalyticsFlags.length !== analyticsFlagNames.length) {
      throw new Error('Analytics activation descriptor must provide every field.');
    }
    const manifestRevision = Number(analyticsValues['--analyticsManifestRevision']);
    if (!Number.isSafeInteger(manifestRevision) || manifestRevision <= 0) {
      throw new Error('Invalid --analyticsManifestRevision argument.');
    }
    const generationId = analyticsValues['--analyticsGenerationId'];
    const manifestSha256 = analyticsValues['--analyticsManifestSha256'];
    if (!ANALYTICS_UUID_PATTERN.test(generationId)) throw new Error('Invalid --analyticsGenerationId argument.');
    if (!ANALYTICS_SHA256_PATTERN.test(manifestSha256)) throw new Error('Invalid --analyticsManifestSha256 argument.');
    if (!analyticsValues['--analyticsBuildId'] || !analyticsValues['--analyticsWorkspaceId']
      || !analyticsValues['--analyticsHostInstanceId']) {
      throw new Error('Analytics activation descriptor contains an empty field.');
    }
    analyticsActivation = {
      generationId,
      buildId: analyticsValues['--analyticsBuildId'],
      manifestRevision,
      manifestSha256,
      workspaceId: analyticsValues['--analyticsWorkspaceId'],
      hostInstanceId: analyticsValues['--analyticsHostInstanceId'],
    };
  }

  if (analyticsContext && suppliedAnalyticsFlags.length > 0) {
    throw new Error('Analytics context and activation descriptor are mutually exclusive.');
  }
  const common: BackendArgsCommon = {
    sdkPath,
    cwd,
    backendGeneration,
    ...(hostPid === undefined ? {} : { hostPid }),
    ...(lifetimeFd === undefined ? {} : { lifetimeFd }),
    ...(analyticsActivation === undefined ? {} : { analyticsActivation }),
    ...(analyticsContext === undefined ? {} : { analyticsContext }),
  };
  if (sourceArtifactDescriptor !== undefined) return { ...common, sourceArtifactDescriptor };
  return { ...common, sdkRuntimeSelection: sdkRuntimeSelection! };
}
