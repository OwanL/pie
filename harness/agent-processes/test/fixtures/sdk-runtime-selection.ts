import * as path from 'node:path';
import { realpath } from 'node:fs/promises';

import {
  PI_RUNTIME_SDK_RELATIVE_PATH,
  verifyPiRuntimeArtifact,
} from '../../../../lib/pi-runtime/artifact.mjs';
import {
  currentBackendTarget,
  type SdkRuntimeSelection,
} from '../../lib/sdk-integration/sdk-runtime-selection.js';
import {
  SDK_PATCH_IDENTITY_VERSION,
  type SdkPatchIdentity,
} from '../../lib/sdk-integration/sdk-patch-barrier.js';
import {
  SDK_SESSION_MANAGER_RELATIVE_PATH,
  SDK_SESSION_OWNERSHIP_MANAGER_PATCH_VERSION,
  SDK_SESSION_REPLACEMENT_RUNTIME_PATCH_VERSION,
  SDK_SESSION_RUNTIME_RELATIVE_PATH,
} from '../../lib/sdk-integration/sdk-session-ownership-patch.js';

/** Syntactically valid transport-only identity; never used to load an SDK. */
export function createLegacyTestSdkRuntime(sdkPath: string): SdkRuntimeSelection {
  const file = (patchVersion: number, relativePath: string, sha256: string) => ({
    patchVersion,
    relativePath,
    sha256,
  });
  const patchIdentity: SdkPatchIdentity = {
    identityVersion: SDK_PATCH_IDENTITY_VERSION,
    sdkPath,
    sdkVersion: '0.80.6',
    terminalDurability: file(3, 'dist/core/agent-session.js', 'a'.repeat(64)),
    retryClassifier: file(1, 'node_modules/@earendil-works/pi-ai/dist/utils/retry.js', 'b'.repeat(64)),
    coldCreateDurability: file(2, SDK_SESSION_MANAGER_RELATIVE_PATH, 'c'.repeat(64)),
    sessionOwnershipAdapter: file(
      SDK_SESSION_OWNERSHIP_MANAGER_PATCH_VERSION,
      SDK_SESSION_MANAGER_RELATIVE_PATH,
      'd'.repeat(64),
    ),
    sessionReplacementAdapter: file(
      SDK_SESSION_REPLACEMENT_RUNTIME_PATCH_VERSION,
      SDK_SESSION_RUNTIME_RELATIVE_PATH,
      'e'.repeat(64),
    ),
  };
  return { kind: 'legacy-patched', patchIdentity };
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
