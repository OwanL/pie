import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs } from '../backend-args.js';

const sourceArtifactDescriptor = {
  schemaVersion: 1,
  artifactDir: '/runtime/pi-runtime',
  sdkPath: '/runtime/pi-runtime/node_modules/@earendil-works/pi-coding-agent',
  cliPath: '/runtime/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
  identity: 'a'.repeat(64),
  manifest: {
    schemaVersion: 1,
    upstreamVersion: '0.80.6',
    upstreamCommit: 'b'.repeat(40),
    sourceTreeSha256: 'c'.repeat(64),
    lockSha256: 'd'.repeat(64),
    target: { platform: 'win32', arch: 'x64', nodeAbi: '127' },
    packages: {},
    payloadSha256: 'e'.repeat(64),
  },
};

test('parseArgs carries the host-authoritative backend generation and validates it', () => {
  assert.deepEqual(
    parseArgs(['--sdkPath', '/sdk', '--cwd', '/work', '--backendGeneration', '7', '--hostPid', '123', '--lifetimeFd', '3']),
    { sdkPath: '/sdk', cwd: '/work', backendGeneration: 7, hostPid: 123, lifetimeFd: 3 },
  );
  assert.equal(parseArgs(['--sdkPath', '/sdk']).backendGeneration, 1);
  assert.throws(
    () => parseArgs(['--sdkPath', '/sdk', '--backendGeneration', '0']),
    /Invalid --backendGeneration/,
  );
  assert.throws(
    () => parseArgs(['--sdkPath', '/sdk', '--lifetimeFd', '2']),
    /Invalid --lifetimeFd/,
  );
});

test('parseArgs carries a source artifact descriptor and rejects missing, duplicate, malformed, or invalid values', () => {
  const encoded = JSON.stringify(sourceArtifactDescriptor);
  assert.deepEqual(
    parseArgs(['--sdkPath', sourceArtifactDescriptor.sdkPath, '--sourceArtifactDescriptor', encoded]).sourceArtifactDescriptor,
    sourceArtifactDescriptor,
  );
  assert.throws(
    () => parseArgs(['--sdkPath', '/sdk', '--sourceArtifactDescriptor']),
    /Missing value for --sourceArtifactDescriptor/,
  );
  assert.throws(
    () => parseArgs(['--sdkPath', '/sdk', '--sourceArtifactDescriptor', '--cwd', '/work']),
    /Missing value for --sourceArtifactDescriptor/,
  );
  assert.throws(
    () => parseArgs(['--sdkPath', '/sdk', '--sourceArtifactDescriptor', '{']),
    /Malformed JSON for --sourceArtifactDescriptor/,
  );
  assert.throws(
    () => parseArgs(['--sdkPath', '/sdk', '--sourceArtifactDescriptor', '{}']),
    /Invalid --sourceArtifactDescriptor argument/,
  );
  assert.throws(
    () => parseArgs([
      '--sdkPath', '/sdk',
      '--sourceArtifactDescriptor', encoded,
      '--sourceArtifactDescriptor', encoded,
    ]),
    /Duplicate --sourceArtifactDescriptor argument/,
  );
});

test('parseArgs carries a complete analytics descriptor and rejects partial or malformed snapshots', () => {
  const args = [
    '--sdkPath', '/sdk', '--cwd', '/work',
    '--analyticsGenerationId', '2f6e2b1c-9d4a-4e7b-8c3f-1a2b3c4d5e6f',
    '--analyticsBuildId', 'build-1',
    '--analyticsManifestRevision', '4',
    '--analyticsManifestSha256', 'a'.repeat(64),
    '--analyticsWorkspaceId', 'workspace-1',
    '--analyticsHostInstanceId', 'host-1',
  ];
  assert.deepEqual(parseArgs(args).analyticsActivation, {
    generationId: '2f6e2b1c-9d4a-4e7b-8c3f-1a2b3c4d5e6f',
    buildId: 'build-1',
    manifestRevision: 4,
    manifestSha256: 'a'.repeat(64),
    workspaceId: 'workspace-1',
    hostInstanceId: 'host-1',
  });
  assert.throws(
    () => parseArgs(args.slice(0, -2)),
    /must provide every field/,
  );
  assert.throws(
    () => parseArgs(args.map((value, index) => index === args.indexOf('--analyticsManifestRevision') + 1 ? '0' : value)),
    /Invalid --analyticsManifestRevision/,
  );
});
