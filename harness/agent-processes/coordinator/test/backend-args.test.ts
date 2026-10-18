import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs } from '../backend-args.js';
import { BackendServer } from '../server.js';
import { WORKSPACE_DEVELOPMENT_SDK_OPT_IN_ENV } from '../../lib/sdk-integration/sdk-runtime-selection.js';

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

const sourceArgs = [
  '--sdkPath', sourceArtifactDescriptor.sdkPath,
  '--sourceArtifactDescriptor', JSON.stringify(sourceArtifactDescriptor),
];

test('parseArgs carries the host-authoritative backend generation and validates it', () => {
  assert.deepEqual(
    parseArgs([...sourceArgs, '--cwd', '/work', '--backendGeneration', '7', '--hostPid', '123', '--lifetimeFd', '3']),
    { sdkPath: sourceArtifactDescriptor.sdkPath, sourceArtifactDescriptor, cwd: '/work', backendGeneration: 7, hostPid: 123, lifetimeFd: 3 },
  );
  assert.equal(parseArgs(sourceArgs).backendGeneration, 1);
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

test('coordinator boundaries reject missing and legacy artifact input without SDK startup', () => {
  assert.throws(() => parseArgs(['--sdkPath', '/sdk']), /Missing required --sourceArtifactDescriptor/);
  assert.throws(() => parseArgs([]), /Missing required --sdkPath/);
  const legacy = { kind: 'legacy-patched', patchIdentity: {} };
  assert.throws(
    () => parseArgs(['--sdkPath', '/sdk', '--sourceArtifactDescriptor', JSON.stringify(legacy)]),
    /Invalid --sourceArtifactDescriptor argument/,
  );
  for (const descriptor of [undefined, null, {}, legacy]) {
    assert.throws(
      () => new BackendServer({ sdkPath: '/sdk', cwd: '/work', sourceArtifactDescriptor: descriptor }),
      /descriptor is invalid/,
    );
  }
  assert.throws(
    // Exercise an untyped caller omitting the now-required constructor field.
    () => new BackendServer({ sdkPath: '/sdk', cwd: '/work' } as ConstructorParameters<typeof BackendServer>[0]),
    /descriptor is invalid/,
  );
});

test('coordinator accepts an explicit workspace-development route only with the development environment opt-in', () => {
  const workspaceRoot = '/work/pi';
  const sdkPath = '/work/pi/packages/coding-agent';
  const sdkRuntimeSelection = { kind: 'workspace-development', workspaceRoot };
  const args = ['--sdkPath', sdkPath, '--sdkRuntimeSelection', JSON.stringify(sdkRuntimeSelection)];
  assert.deepEqual(parseArgs(args, { [WORKSPACE_DEVELOPMENT_SDK_OPT_IN_ENV]: '1' }), {
    sdkPath, cwd: process.cwd(), backendGeneration: 1, sdkRuntimeSelection,
  });
  assert.throws(() => parseArgs(args, {}), new RegExp(`${WORKSPACE_DEVELOPMENT_SDK_OPT_IN_ENV}=1`));
  assert.throws(() => parseArgs(['--sdkPath', '/sdk', '--sdkRuntimeSelection', '{'], {
    [WORKSPACE_DEVELOPMENT_SDK_OPT_IN_ENV]: '1',
  }), /Malformed JSON for --sdkRuntimeSelection/);
  assert.throws(() => parseArgs(['--sdkPath', '/sdk', '--sdkRuntimeSelection', JSON.stringify({
    kind: 'workspace-development', workspaceRoot: 'relative',
  })], { [WORKSPACE_DEVELOPMENT_SDK_OPT_IN_ENV]: '1' }), /workspaceRoot must be an absolute path/);
  assert.throws(() => parseArgs([
    ...sourceArgs, '--sdkRuntimeSelection', JSON.stringify(sdkRuntimeSelection),
  ], { [WORKSPACE_DEVELOPMENT_SDK_OPT_IN_ENV]: '1' }), /Duplicate SDK runtime selection/);
  assert.throws(() => parseArgs([
    '--sdkPath', '/sdk', '--sdkRuntimeSelection', JSON.stringify(sdkRuntimeSelection),
  ], { [WORKSPACE_DEVELOPMENT_SDK_OPT_IN_ENV]: '1' }), /does not identify the selected workspace-development/);
});

test('BackendServer direct workspace-development selection also requires the explicit opt-in', () => {
  const sdkRuntimeSelection = { kind: 'workspace-development', workspaceRoot: '/work/pi' };
  const previous = process.env[WORKSPACE_DEVELOPMENT_SDK_OPT_IN_ENV];
  delete process.env[WORKSPACE_DEVELOPMENT_SDK_OPT_IN_ENV];
  try {
    assert.throws(() => new BackendServer({
      sdkPath: '/work/pi/packages/coding-agent',
      sdkRuntimeSelection,
      cwd: '/work',
      workerEntryPath: '/worker.js',
    }), new RegExp(`${WORKSPACE_DEVELOPMENT_SDK_OPT_IN_ENV}=1`));
  } finally {
    if (previous === undefined) delete process.env[WORKSPACE_DEVELOPMENT_SDK_OPT_IN_ENV];
    else process.env[WORKSPACE_DEVELOPMENT_SDK_OPT_IN_ENV] = previous;
  }
});

test('parseArgs carries canonical-only context without activation evidence and rejects partial context', () => {
  const context = { mode: 'canonical-only', generationId: 'capture', buildId: 'build', workspaceId: 'workspace', hostInstanceId: 'host' };
  const args = [...sourceArgs, '--analyticsContext', JSON.stringify(context)];
  assert.deepEqual(parseArgs(args).analyticsContext, context);
  assert.equal(parseArgs(args).analyticsActivation, undefined);
  assert.equal(parseArgs(sourceArgs).analyticsContext, undefined);
  assert.throws(() => parseArgs([...args, '--analyticsContext', JSON.stringify(context)]), /Duplicate/);
  for (const field of Object.keys(context)) {
    const partial = { ...context } as Record<string, unknown>;
    delete partial[field];
    assert.throws(() => parseArgs([...sourceArgs, '--analyticsContext', JSON.stringify(partial)]), /context/);
  }
});

test('parseArgs carries a complete analytics descriptor and rejects partial or malformed snapshots', () => {
  const args = [
    ...sourceArgs, '--cwd', '/work',
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
  assert.throws(() => parseArgs([...args, '--analyticsContext', JSON.stringify({ mode: 'canonical-only', generationId: 'capture', buildId: 'build', workspaceId: 'workspace', hostInstanceId: 'host' })]), /mutually exclusive/);
  assert.throws(
    () => parseArgs(args.slice(0, -2)),
    /must provide every field/,
  );
  assert.throws(
    () => parseArgs(args.map((value, index) => index === args.indexOf('--analyticsManifestRevision') + 1 ? '0' : value)),
    /Invalid --analyticsManifestRevision/,
  );
});
