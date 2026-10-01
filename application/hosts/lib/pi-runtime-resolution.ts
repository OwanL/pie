import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import {
  verifyPiRuntimeArtifact,
  type GenerationPiRuntimeDescriptor,
  type PiRuntimeTarget,
} from '../../../lib/pi-runtime/artifact.mjs';

export type { GenerationPiRuntimeDescriptor } from '../../../lib/pi-runtime/artifact.mjs';

export interface GenerationPiRuntimeDevelopmentOverride {
  artifactDir: string;
  /** Required explicit policy opt-in; development artifacts are never ambiently selected. */
  allowDevelopmentRuntime: true;
}

/** Node platform/architecture/ABI for the backend process that loads Pi. */
export type GenerationPiRuntimeBackendNodeTarget = PiRuntimeTarget;

export interface ResolveGenerationPiRuntimeOptions {
  /** Absolute output directory; the default artifact is exactly `<runtimeOutDir>/pi-runtime`. */
  runtimeOutDir: string;
  /** Backend Node target, not necessarily the editor/host Node target. */
  target: GenerationPiRuntimeBackendNodeTarget;
  developmentOverride?: GenerationPiRuntimeDevelopmentOverride;
}

export type GenerationPiRuntimePolicyErrorCode = 'development-override-not-opted-in';

export class GenerationPiRuntimePolicyError extends Error {
  readonly code: GenerationPiRuntimePolicyErrorCode;

  constructor(code: GenerationPiRuntimePolicyErrorCode, message: string) {
    super(message);
    this.name = 'GenerationPiRuntimePolicyError';
    this.code = code;
  }
}

/**
 * Resolve and verify the generated Pi artifact. There is intentionally no
 * environment, cache, package-local, global-install, or source-checkout fallback.
 */
export async function resolveGenerationPiRuntime(
  { runtimeOutDir, target, developmentOverride }: ResolveGenerationPiRuntimeOptions,
): Promise<GenerationPiRuntimeDescriptor> {
  if (typeof runtimeOutDir !== 'string' || !path.isAbsolute(runtimeOutDir)) {
    throw new TypeError('runtimeOutDir must be an absolute path');
  }

  if (target === undefined || target === null) {
    throw new TypeError('An explicit backend Node target is required');
  }

  if (developmentOverride !== undefined
    && developmentOverride?.allowDevelopmentRuntime !== true) {
    throw new GenerationPiRuntimePolicyError(
      'development-override-not-opted-in',
      'developmentOverride requires allowDevelopmentRuntime: true',
    );
  }

  const artifactDir = developmentOverride === undefined
    ? path.join(runtimeOutDir, 'pi-runtime')
    : developmentOverride.artifactDir;
  if (typeof artifactDir !== 'string' || !path.isAbsolute(artifactDir)) {
    throw new TypeError('Pi runtime artifact path must be absolute');
  }

  const verified = await verifyPiRuntimeArtifact(artifactDir, { target });
  const sdkPath = await realpath(verified.sdkPath);
  const cliPath = await realpath(path.join(sdkPath, 'dist', 'cli.js'));
  return {
    schemaVersion: 1,
    artifactDir: verified.artifactDir,
    sdkPath,
    cliPath,
    identity: verified.identity,
    manifest: verified.manifest,
  };
}
