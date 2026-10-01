export {
  PI_RUNTIME_PACKAGES,
  PI_RUNTIME_SDK_RELATIVE_PATH,
  verifyPiRuntimeArtifact,
} from '../../lib/pi-runtime/artifact.mjs';
export type {
  PiRuntimeManifest,
  PiRuntimeProvenance,
  PiRuntimeTarget,
  VerifiedPiRuntimeArtifact,
} from '../../lib/pi-runtime/artifact.mjs';
import type { PiRuntimeProvenance, VerifiedPiRuntimeArtifact } from '../../lib/pi-runtime/artifact.mjs';

export function writePiRuntimeManifest(
  artifactDir: string,
  provenance: PiRuntimeProvenance,
): Promise<VerifiedPiRuntimeArtifact>;
