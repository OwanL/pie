export interface PiRuntimeTarget {
  platform: string;
  arch: string;
  /** Node's native modules ABI, not the Node version string. */
  nodeAbi: string;
}

export interface PiRuntimeProvenance {
  upstreamVersion: string;
  upstreamCommit: string;
  sourceTreeSha256: string;
  lockSha256: string;
  target: PiRuntimeTarget;
}

export interface PiRuntimeManifest extends PiRuntimeProvenance {
  schemaVersion: 1;
  packages: Record<string, { version: string; treeSha256: string }>;
  payloadSha256: string;
}

/** Minimal JSON-serializable descriptor for independently verifying a Pi runtime artifact. */
export interface GenerationPiRuntimeDescriptor {
  schemaVersion: 1;
  artifactDir: string;
  sdkPath: string;
  cliPath: string;
  identity: string;
  manifest: PiRuntimeManifest;
}

export interface VerifiedPiRuntimeArtifact {
  manifest: PiRuntimeManifest;
  /** SHA-256 of canonical manifest JSON, including provenance. */
  identity: string;
  /** Canonical absolute artifact directory. */
  artifactDir: string;
  /** Canonical absolute SDK package directory, not its entry file. */
  sdkPath: string;
}

export const PI_RUNTIME_PACKAGES: readonly string[];
export const PI_RUNTIME_SDK_RELATIVE_PATH: string;

/** Inspect a materialized artifact and construct its manifest without writing. */
export function preparePiRuntimeManifest(
  artifactDir: string,
  provenance: PiRuntimeProvenance,
): Promise<VerifiedPiRuntimeArtifact>;

/** Read-only schema, target, package graph and complete payload verification. */
export function verifyPiRuntimeArtifact(
  artifactDir: string,
  options?: { target?: PiRuntimeTarget },
): Promise<VerifiedPiRuntimeArtifact>;
