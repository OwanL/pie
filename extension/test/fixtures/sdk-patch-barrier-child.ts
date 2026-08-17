import { ensureSdkPatchBarrier } from '../../src/backend/sdk-patch-barrier';

async function main(): Promise<void> {
  const sdkPath = process.argv[2];
  const trustedRoot = process.argv[3];
  const lockRoot = process.argv[4];
  const fixtureFingerprints = process.argv[5];
  if (!sdkPath || !trustedRoot || !lockRoot || !fixtureFingerprints) {
    throw new Error('Expected sdkPath, trustedRoot, lockRoot, and fixture fingerprints.');
  }
  process.env.PIE_TRUSTED_SDK_ROOT = trustedRoot;
  process.env.PIE_SDK_PATCH_FIXTURE_FINGERPRINTS = fixtureFingerprints;

  const identity = await ensureSdkPatchBarrier(sdkPath, { lockRoot });
  process.stdout.write(`${JSON.stringify(identity)}\n`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
