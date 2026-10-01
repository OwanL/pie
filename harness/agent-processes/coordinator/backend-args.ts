import type { AnalyticsBackendDescriptor } from '../../../analytics/authority/activation.js';
import type { GenerationPiRuntimeDescriptor } from '../../../lib/pi-runtime/artifact.mjs';
import { parseSdkRuntimeSelection } from '../lib/sdk-integration/sdk-runtime-selection';

// ─── Argument parsing ────────────────────────────────────────────────────────

export interface BackendArgs {
  sdkPath: string;
  cwd: string;
  /** Host-authoritative process generation, shared by public/detail/worker fences. */
  backendGeneration: number;
  /** Extension-host PID used to reap the backend after a host crash. */
  hostPid?: number;
  /** Dedicated inherited descriptor whose EOF proves the host disappeared. */
  lifetimeFd?: number;
  /** Verified generation-local Pi artifact selected by the production host. */
  sourceArtifactDescriptor?: GenerationPiRuntimeDescriptor;
  /** Immutable canonical analytics authority snapshot, supplied only by the
   * production host after its readiness probe succeeds. */
  analyticsActivation?: AnalyticsBackendDescriptor;
}

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

export function parseArgs(argv: string[]): BackendArgs {
  let sdkPath = '';
  let cwd = process.cwd();
  let hostPid: number | undefined;
  let lifetimeFd: number | undefined;
  let backendGeneration = 1;
  const analyticsValues: Record<string, string> = {};
  let sourceArtifactDescriptor: GenerationPiRuntimeDescriptor | undefined;
  let sourceArtifactDescriptorSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--sourceArtifactDescriptor') {
      if (sourceArtifactDescriptorSeen) throw new Error('Duplicate --sourceArtifactDescriptor argument.');
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
        if (selection.kind !== 'source-artifact') throw new Error('Expected a source-artifact selection.');
        sourceArtifactDescriptor = selection.descriptor;
      } catch (error) {
        const detail = error instanceof Error ? ` ${error.message}` : '';
        throw new Error(`Invalid --sourceArtifactDescriptor argument.${detail}`);
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

  return {
    sdkPath,
    cwd,
    backendGeneration,
    ...(hostPid === undefined ? {} : { hostPid }),
    ...(lifetimeFd === undefined ? {} : { lifetimeFd }),
    ...(sourceArtifactDescriptor === undefined ? {} : { sourceArtifactDescriptor }),
    ...(analyticsActivation === undefined ? {} : { analyticsActivation }),
  };
}
