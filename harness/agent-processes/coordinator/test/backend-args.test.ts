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

const context = { mode: 'canonical-only', generationId: 'capture', buildId: 'build', workspaceId: 'workspace', hostInstanceId: 'host' } as const;
const sourceArgsWithoutContext = [
  '--sdkPath', sourceArtifactDescriptor.sdkPath,
  '--sourceArtifactDescriptor', JSON.stringify(sourceArtifactDescriptor),
];

const sourceArgs = [...sourceArgsWithoutContext, '--analyticsContext', JSON.stringify(context)];

test('parseArgs carries the host-authoritative backend generation and validates it', () => {
  assert.deepEqual(
    parseArgs([...sourceArgs, '--cwd', '/work', '--backendGeneration', '7', '--hostPid', '123', '--lifetimeFd', '3']),
    { sdkPath: sourceArtifactDescriptor.sdkPath, sourceArtifactDescriptor, cwd: '/work', backendGeneration: 7, hostPid: 123, lifetimeFd: 3, analyticsContext: context },
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
    parseArgs(sourceArgs).sourceArtifactDescriptor,
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
      () => new BackendServer({ analyticsContext: { mode: 'canonical-only', generationId: 'test-capture', buildId: 'test-build', workspaceId: 'test-workspace', hostInstanceId: 'test-host' }, sdkPath: '/sdk', cwd: '/work', sourceArtifactDescriptor: descriptor }),
      /descriptor is invalid/,
    );
  }
  assert.throws(
    // Exercise an untyped caller omitting the now-required constructor field.
    () => new BackendServer({ analyticsContext: { mode: 'canonical-only', generationId: 'test-capture', buildId: 'test-build', workspaceId: 'test-workspace', hostInstanceId: 'test-host' }, sdkPath: '/sdk', cwd: '/work' } as ConstructorParameters<typeof BackendServer>[0]),
    /descriptor is invalid/,
  );
});

test('coordinator accepts an explicit workspace-development route only with the development environment opt-in', () => {
  const workspaceRoot = '/work/pi';
  const sdkPath = '/work/pi/packages/coding-agent';
  const sdkRuntimeSelection = { kind: 'workspace-development', workspaceRoot };
  const args = ['--sdkPath', sdkPath, '--sdkRuntimeSelection', JSON.stringify(sdkRuntimeSelection), '--analyticsContext', JSON.stringify(context)];
  assert.deepEqual(parseArgs(args, { [WORKSPACE_DEVELOPMENT_SDK_OPT_IN_ENV]: '1' }), {
    sdkPath, cwd: process.cwd(), backendGeneration: 1, sdkRuntimeSelection, analyticsContext: context,
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
    assert.throws(() => new BackendServer({ analyticsContext: { mode: 'canonical-only', generationId: 'test-capture', buildId: 'test-build', workspaceId: 'test-workspace', hostInstanceId: 'test-host' },
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

test('retired analytics descriptor flags cannot admit a backend writer', () => {
  assert.throws(() => parseArgs([
    ...sourceArgsWithoutContext,
    '--analyticsGenerationId', 'old-generation',
    '--analyticsBuildId', 'old-build',
    '--analyticsManifestRevision', '1',
    '--analyticsManifestSha256', 'a'.repeat(64),
    '--analyticsWorkspaceId', 'old-workspace',
    '--analyticsHostInstanceId', 'old-host',
  ]), /Missing required --analyticsContext/);
});

test('parseArgs carries canonical-only context without activation evidence and rejects partial context', () => {
  const args = sourceArgs;
  assert.deepEqual(parseArgs(args).analyticsContext, context);
  assert.throws(() => parseArgs(sourceArgsWithoutContext), /Missing required --analyticsContext/);
  assert.throws(() => new BackendServer({ sdkPath: '/sdk', cwd: '/work', sourceArtifactDescriptor,
    workerEntryPath: '/worker.js' } as ConstructorParameters<typeof BackendServer>[0]), /context/i);
  assert.throws(() => parseArgs([...args, '--analyticsContext', JSON.stringify(context)]), /Duplicate/);
  for (const field of Object.keys(context)) {
    const partial = { ...context } as Record<string, unknown>;
    delete partial[field];
    assert.throws(() => parseArgs([...sourceArgsWithoutContext, '--analyticsContext', JSON.stringify(partial)]), /context/);
  }
});
