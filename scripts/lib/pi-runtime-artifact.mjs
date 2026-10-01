// Build-facing manifest writer; artifact inspection and verification stay shared/read-only.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { preparePiRuntimeManifest } from '../../lib/pi-runtime/artifact.mjs';

export {
  PI_RUNTIME_PACKAGES,
  PI_RUNTIME_SDK_RELATIVE_PATH,
  verifyPiRuntimeArtifact,
} from '../../lib/pi-runtime/artifact.mjs';

/**
 * Hash an explicitly supplied, fully materialized artifact and write manifest.json.
 * No source lookup, installs, imports or network access. Only manifest.json is
 * written; existing manifests are replaced. Caller must prevent concurrent writes.
 * @param {string} artifactDir The pi-runtime directory containing node_modules.
 * @param {import('../../lib/pi-runtime/artifact.mjs').PiRuntimeProvenance} provenance Explicit provenance and build target.
 * @returns {Promise<import('../../lib/pi-runtime/artifact.mjs').VerifiedPiRuntimeArtifact>}
 */
export async function writePiRuntimeManifest(artifactDir, provenance) {
  const verified = await preparePiRuntimeManifest(artifactDir, provenance);
  await writeFile(path.join(verified.artifactDir, 'manifest.json'), `${JSON.stringify(verified.manifest, null, 2)}\n`);
  return verified;
}
