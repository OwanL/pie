import * as path from 'node:path';
import { realpath } from 'node:fs/promises';

import {
  PI_RUNTIME_PACKAGES,
  PI_RUNTIME_SDK_RELATIVE_PATH,
  verifyPiRuntimeArtifact,
} from '../../../../lib/pi-runtime/artifact.mjs';
import {
  currentBackendTarget,
  type SdkRuntimeSelection,
} from '../../lib/sdk-integration/sdk-runtime-selection.js';

/** SHAPE-ONLY descriptor for mock transport tests. Never verification evidence,
 * and never pass it to real SDK verification, import, or bootstrap. */
export function createSyntheticSourceTestSdkRuntime(sdkPath: string): SdkRuntimeSelection {
  if (!path.isAbsolute(sdkPath)) throw new TypeError('Synthetic SDK path must be absolute.');
  return {
    kind: 'source-artifact',
    descriptor: {
      schemaVersion: 1,
      artifactDir: path.join(path.dirname(sdkPath), 'synthetic-source-artifact'),
      sdkPath,
      cliPath: path.join(sdkPath, 'dist', 'cli.js'),
      identity: 'a'.repeat(64),
      manifest: {
        schemaVersion: 1,
        upstreamVersion: '0.80.6',
        upstreamCommit: 'b'.repeat(40),
        sourceTreeSha256: 'c'.repeat(64),
        lockSha256: 'd'.repeat(64),
        target: currentBackendTarget(),
        packages: Object.fromEntries(PI_RUNTIME_PACKAGES.map(name => [
          name, { version: '0.80.6', treeSha256: 'e'.repeat(64) },
        ])),
        payloadSha256: 'f'.repeat(64),
      },
    },
  };
}

/** Build a descriptor from a read-only immutable artifact for real child tests. */
export async function createSourceArtifactTestSdkRuntime(artifactDir: string): Promise<{
  readonly sdkPath: string;
  readonly sdkRuntime: SdkRuntimeSelection;
}> {
  const verified = await verifyPiRuntimeArtifact(artifactDir, { target: currentBackendTarget() });
  const sdkPath = await realpath(path.join(verified.artifactDir, PI_RUNTIME_SDK_RELATIVE_PATH));
  const cliPath = await realpath(path.join(sdkPath, 'dist', 'cli.js'));
  return {
    sdkPath,
    sdkRuntime: {
      kind: 'source-artifact',
      descriptor: {
        schemaVersion: 1,
        artifactDir: verified.artifactDir,
        sdkPath,
        cliPath,
        identity: verified.identity,
        manifest: verified.manifest,
      },
    },
  };
}
