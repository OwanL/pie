import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import { once } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { writeRuntimeArtifactFixture } from '../../test/helpers/runtime-artifact';

import {
  PI_RUNTIME_SDK_RELATIVE_PATH,
} from '../../../../scripts/lib/pi-runtime-artifact.mjs';
import { computeNodeRuntimePayloadIdentity } from '../../../../lib/node-runtime/manifest.mjs';
import {
  publishRuntimeGeneration,
  RUNTIME_DIRECTORY,
  type RuntimeIdentity,
} from '../../vscode/runtime/runtime-generations.cjs';
import type { BackendClient } from '../../../backend/agent-connection/client';
import { startSessionBackend } from '../../../backend/agent-connection/startup';
import type { SessionService } from '../../../backend/session-actions/service';
import { SessionServiceState } from '../../../backend/session-actions/state';
import { createInitialArchState } from '../../../backend/conversation-state/arch-state';
import type { Event } from '../../../backend/conversation-state/events';
import { reducer } from '../../../backend/conversation-state/reducer';
import { parseArgs as parseCoordinatorBackendArgs } from '../../../../harness/agent-processes/coordinator/backend-args';
import { acquirePieHostOwnership } from '../../lib/host-coordinator';
import {
  resolveStandaloneEnvironment,
  type StandaloneEnvironment,
} from '../startup';
import { createStandaloneHostRuntimePlatform } from '../platform';
import { StandaloneHostStorage } from '../storage';
import {
  shutdownOwnedStandaloneHost,
  startStandalone,
  teardownAfterStandaloneStartupFailure,
} from '..';

const IDENTITY: RuntimeIdentity = { publisher: 'pie-test', name: 'standalone', version: '1.0.0' };
const TARGET = { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules };
async function put(root: string, relative: string, contents: string): Promise<void> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

async function makeOutput(outDir: string, options: { artifact?: boolean; tamper?: boolean; bundledNode?: boolean; target?: typeof TARGET } = {}): Promise<void> {
  const buildId = 'standalone-test-build';
  for (const relative of [
    'backend.js', 'worker-entry.js', 'analytics-recorder-worker.js', 'analytics-query-worker.js',
  ]) await put(outDir, relative, '// fixture\n');
  await put(outDir, 'pie-build-id.txt', `${buildId}\n`);
  await put(outDir, 'webview/panel/pie-build-id.txt', `${buildId}\n`);
  await put(outDir, 'webview/panel/.vite/manifest.json', JSON.stringify({
    panel: { file: 'assets/panel.js', isEntry: true, imports: [], dynamicImports: [], css: [], assets: [] },
  }));
  await put(outDir, 'webview/panel/assets/panel.js', '// renderer fixture\n');
  await put(outDir, 'webview/panel/.vite/unused.txt', 'fixture');
  await put(outDir, 'extension.js', '// extension fixture\n');

  if (options.bundledNode) {
    const nodeRuntimeDir = path.join(outDir, 'resources', 'node-runtime');
    const license = Buffer.from('Node.js license fixture');
    const executable = Buffer.from('bundled-node-fixture');
    await fs.mkdir(nodeRuntimeDir, { recursive: true });
    await fs.writeFile(path.join(nodeRuntimeDir, 'LICENSE'), license);
    await fs.writeFile(path.join(nodeRuntimeDir, 'node.exe'), executable);
    const identityFields = {
      schemaVersion: 1,
      kind: 'node-runtime',
      nodeVersion: '24.16.0',
      target: { platform: 'win32', arch: 'x64', nodeAbi: '137' },
      executable: 'node.exe',
      inventory: [
        { relativePath: 'LICENSE', sizeBytes: license.length, sha256: createHash('sha256').update(license).digest('hex') },
        { relativePath: 'node.exe', sizeBytes: executable.length, sha256: createHash('sha256').update(executable).digest('hex') },
      ],
      provenance: {
        kind: 'local-toolchain',
        archiveUrl: 'https://nodejs.org/download/release/v24.16.0/node-v24.16.0-win-x64.zip',
        archiveSha256: 'a'.repeat(64),
      },
    };
    const canonicalize = (value: unknown): unknown => Array.isArray(value)
      ? value.map(canonicalize)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonicalize(entry)]))
        : value;
    const manifest = {
      ...identityFields,
      payloadIdentity: computeNodeRuntimePayloadIdentity(identityFields),
    };
    await fs.writeFile(path.join(nodeRuntimeDir, 'manifest.json'), `${JSON.stringify(canonicalize(manifest), null, 2)}\n`);
  }

  if (options.artifact === false) return;
  const artifactDir = path.join(outDir, 'pi-runtime');
  await writeRuntimeArtifactFixture(artifactDir, options.target ?? TARGET);
  if (options.tamper) await put(artifactDir, `${PI_RUNTIME_SDK_RELATIVE_PATH}/dist/cli.js`, 'tampered\n');
}

async function fixture(t: test.TestContext, options: { selected?: boolean; artifact?: boolean; tamper?: boolean; bundledNode?: boolean; target?: typeof TARGET } = {}) {
  // The test runner gives each process a private LOCALAPPDATA. Seed the normal
  // agent home just as installation does, so tests that intentionally pass an
  // empty startup env exercise the real fallback rather than a missing fixture.
  const fixtureRoot = process.env.PIE_TEST_FIXTURE_ROOT;
  const localAppData = process.env.LOCALAPPDATA;
  if (fixtureRoot && localAppData && path.resolve(localAppData).toLowerCase().startsWith(`${path.resolve(fixtureRoot).toLowerCase()}${path.sep}`)) {
    const normalAgentDir = path.join(localAppData, 'pie');
    await fs.mkdir(normalAgentDir, { recursive: true });
    const settingsDefaults = await fs.readFile(path.resolve('settings.defaults.json'), 'utf8');
    try {
      await fs.writeFile(path.join(normalAgentDir, 'settings.json'), settingsDefaults, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-standalone-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const extensionPath = path.join(root, 'extension');
  await fs.mkdir(extensionPath, { recursive: true });
  await put(extensionPath, 'package.json', JSON.stringify(IDENTITY));
  const output = options.selected ? path.join(root, 'build-out') : path.join(extensionPath, 'out');
  await makeOutput(output, options);
  const publication = options.selected
    ? await publishRuntimeGeneration({ sourceOutDir: output, extensionDir: extensionPath, identity: IDENTITY })
    : undefined;
  return { root, extensionPath, output, publication };
}

function isolateStandaloneStartupEnvironment(): () => void {
  const keys = [
    'PI_SDK_PATH', 'PI_NODE_PATH', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_AUTH_DIR',
    'PI_CODING_AGENT_SESSION_DIR', 'PIE_DATA_DIR', 'PIE_ALLOW_IN_TREE_AUTH',
    'PIE_DEVELOPMENT_PROFILE_DIR', 'PIE_DEVELOPMENT_PI_RUNTIME', 'PIE_ALLOW_DEVELOPMENT_RUNTIME',
    'PIE_DEVELOPMENT_PI_WORKSPACE', 'PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK',
    'PIE_HOST_PROFILE', 'PIE_HOST_COORDINATOR_PORT',
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  return () => {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function artifactProbe(options: {
  target?: typeof TARGET;
  beforeProbe?: () => Promise<void>;
  commandPaths?: string[];
} = {}) {
  return async (command: string, args: string[]) => {
    options.commandPaths?.push(command);
    await options.beforeProbe?.();
    return {
      stdout: args[0] === '--version' ? 'v24.16.0' : JSON.stringify(options.target ?? TARGET),
      stderr: '',
      exitCode: 0,
    };
  };
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function leaseEntries(extensionPath: string): Promise<string[]> {
  try {
    return await fs.readdir(path.join(extensionPath, RUNTIME_DIRECTORY, 'leases'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

test('historical activation artifacts are inert without package identity while runtime validation stays mandatory', async (t) => {
  const prepared = await fixture(t);
  // A flat embedding need not provide a managed-generation identity.
  await put(prepared.extensionPath, 'package.json', '{}');
  const dataRoot = path.join(prepared.root, 'data');
  const stateDir = path.join(dataRoot, 'state');
  const artifacts = ['analytics-activation-v1.json', 'analytics-ever-active-v1.json'];
  for (const name of artifacts) await put(stateDir, name, 'malformed historical bytes');
  const options = {
    extensionPath: prepared.extensionPath, dataRoot,
    dependencies: { nodePath: process.execPath, sdkPath: '' },
    env: {}, exec: artifactProbe(),
  };
  const environment = await resolveStandaloneEnvironment(options);
  assert.equal(environment.runtimeIdentity, undefined);
  assert.ok(environment.sourceArtifactDescriptor);
  for (const name of artifacts) assert.equal(await fs.readFile(path.join(stateDir, name), 'utf8'), 'malformed historical bytes');
  await fs.rm(path.join(prepared.output, 'backend.js'));
  await assert.rejects(resolveStandaloneEnvironment(options), /Standalone backend bundle is unavailable/);
});

test('selected standalone generation is leased before SDK probing and released only after confirmed shutdown', async (t) => {
  const prepared = await fixture(t, { selected: true });
  assert.ok(prepared.publication);
  let sawLeaseBeforeProbe = false;
  const probedNodePaths: string[] = [];
  const env = await resolveStandaloneEnvironment({
    extensionPath: prepared.extensionPath,
    dependencies: { nodePath: process.execPath, sdkPath: path.join(prepared.root, 'external-sdk') },
    env: { ...process.env, PI_SDK_PATH: path.join(prepared.root, 'external-sdk') },
    exec: artifactProbe({
      commandPaths: probedNodePaths,
      beforeProbe: async () => {
        sawLeaseBeforeProbe = (await leaseEntries(prepared.extensionPath)).length === 1;
      },
    }),
  });

  assert.equal(sawLeaseBeforeProbe, true, 'the generation lease precedes SDK/artifact target probing');
  assert.deepEqual(probedNodePaths, [process.execPath], 'the artifact target comes from the exact configured backend Node');
  assert.equal(env.paths.runtimeOutputDirectory, prepared.publication.outDir);
  assert.ok(env.runtimeLease, 'selected managed output carries the manager-issued lease');
  assert.equal(env.dependencies.sdkPath, env.sourceArtifactDescriptor?.sdkPath,
    'standalone does not infer an external SDK and keeps its verified descriptor consistent');
  assert.notEqual(env.dependencies.sdkPath, path.join(prepared.root, 'external-sdk'));
  assert.deepEqual(JSON.parse(JSON.stringify(env.sourceArtifactDescriptor)), env.sourceArtifactDescriptor);
  const platform = createStandaloneHostRuntimePlatform({
    workspaceCwd: prepared.root,
    extensionPath: env.paths.extensionPath,
    runtimeOutputDirectory: env.paths.runtimeOutputDirectory,
    dataPaths: env.dataPaths,
    dependencies: env.dependencies,
    getBrowserServer: () => undefined,
  });
  assert.equal(platform.getRuntimeOutputDirectory(), env.paths.runtimeOutputDirectory);
  assert.equal(platform.getSetting<string>('nodePath'), env.dependencies.nodePath);
  assert.equal(platform.getSetting<string>('sdkPath'), env.sourceArtifactDescriptor?.sdkPath,
    'shared backend startup sees the same selected Node, output, and verified SDK descriptor');
  assert.equal((await leaseEntries(prepared.extensionPath)).length, 1);

  let ownershipReleased = false;
  await shutdownOwnedStandaloneHost({
    runtime: { shutdown: async () => undefined, backend: { stop: async () => undefined, dispose: () => undefined, isRuntimeLifetimeTeardownConfirmed: () => true } as never },
    browserServer: { stop: async () => undefined, dispose: () => undefined },
    ownership: { release: async () => { ownershipReleased = true; }, abort: () => undefined } as never,
    restoreEnvironment: () => undefined,
    runtimeLease: env.runtimeLease,
  });
  assert.equal(ownershipReleased, true);
  assert.deepEqual(await leaseEntries(prepared.extensionPath), [], 'confirmed teardown releases the generation lease');
});

test('standalone routes the bundled Node from the already-selected immutable generation', { skip: process.platform !== 'win32' }, async (t) => {
  const prepared = await fixture(t, { selected: true, bundledNode: true });
  const restoreEnvironment = isolateStandaloneStartupEnvironment();
  const profileDir = path.join(prepared.root, 'development-profile');
  let environment: StandaloneEnvironment | undefined;
  const probedNodePaths: string[] = [];
  try {
    environment = await resolveStandaloneEnvironment({
      extensionPath: prepared.extensionPath,
      env: {
        ...process.env,
        PIE_DEVELOPMENT_PROFILE_DIR: profileDir,
        PI_CODING_AGENT_DIR: path.join(profileDir, 'agent'),
        PI_CODING_AGENT_AUTH_DIR: path.join(profileDir, 'auth'),
        PIE_DATA_DIR: path.join(profileDir, 'data'),
        PI_CODING_AGENT_SESSION_DIR: path.join(profileDir, 'data', 'sessions'),
      },
      exec: artifactProbe({ commandPaths: probedNodePaths }),
    });
    const expectedNodePath = path.join(
      environment.paths.runtimeOutputDirectory,
      'resources', 'node-runtime', 'node.exe',
    );
    assert.equal(environment.paths.runtimeOutputDirectory, prepared.publication?.outDir,
      'startup keeps the previously selected immutable generation');
    assert.equal(environment.dependencies.nodePath, expectedNodePath,
      'bundled Node is resolved relative to that exact generation, not extension/out or a second generation lookup');
    assert.deepEqual(probedNodePaths, [expectedNodePath, expectedNodePath],
      'the selected Node is version-probed and target-probed before SDK startup');
  } finally {
    try {
      await environment?.runtimeLease?.release();
    } finally {
      restoreEnvironment();
    }
  }
});

test('standalone resolves a relative configured Node path to the exact absolute probe executable', async (t) => {
  const prepared = await fixture(t, { selected: true });
  const relativeNodePath = path.relative(process.cwd(), process.execPath);
  assert.ok(relativeNodePath && !path.isAbsolute(relativeNodePath),
    'the explicit fixture path must exercise a relative nodePath');
  const probedNodePaths: string[] = [];
  const env = await resolveStandaloneEnvironment({
    extensionPath: prepared.extensionPath,
    dependencies: { nodePath: relativeNodePath, sdkPath: '' },
    exec: artifactProbe({ commandPaths: probedNodePaths }),
  });

  try {
    const resolvedNodePath = path.resolve(relativeNodePath);
    assert.equal(env.dependencies.nodePath, resolvedNodePath,
      'the returned dependency path is absolute');
    assert.deepEqual(probedNodePaths, [resolvedNodePath],
      'artifact target probing executes the same absolute Node path returned to backend startup');
  } finally {
    await env.runtimeLease?.release();
  }
});

test('selected lease is retained when runtime or browser shutdown fails despite confirmed backend exit', { timeout: 5_000 }, async (t) => {
  const prepared = await fixture(t, { selected: true });
  const env = await resolveStandaloneEnvironment({
    extensionPath: prepared.extensionPath,
    dependencies: { nodePath: process.execPath, sdkPath: '' },
    exec: artifactProbe(),
  });
  assert.ok(env.runtimeLease);

  const failures = [
    {
      message: /runtime shutdown failed/,
      shutdown: async () => { throw new Error('runtime shutdown failed'); },
      stopBrowser: async () => undefined,
    },
    {
      message: /browser stop failed/,
      shutdown: async () => undefined,
      stopBrowser: async () => { throw new Error('browser stop failed'); },
    },
  ];
  try {
    for (const failure of failures) {
      let ownershipReleased = false;
      await assert.rejects(shutdownOwnedStandaloneHost({
        runtime: {
          shutdown: failure.shutdown,
          backend: { stop: async () => undefined, dispose: () => undefined } as never,
        },
        browserServer: { stop: failure.stopBrowser, dispose: () => undefined },
        ownership: { release: async () => { ownershipReleased = true; }, abort: () => undefined } as never,
        restoreEnvironment: () => undefined,
        backendStopConfirmTimeoutMs: 100,
        runtimeLease: env.runtimeLease,
      }), failure.message);
      assert.equal(ownershipReleased, true,
        'backend confirmation preserves the existing machine-wide ownership release behavior');
      assert.equal((await leaseEntries(prepared.extensionPath)).length, 1,
        'runtime or browser teardown failure must retain the selected generation lease');
    }
  } finally {
    await env.runtimeLease.release();
  }
});

test('selected lease is retained when browser stop outlives its grace despite confirmed backend exit', { timeout: 5_000 }, async (t) => {
  const prepared = await fixture(t, { selected: true });
  const env = await resolveStandaloneEnvironment({
    extensionPath: prepared.extensionPath,
    dependencies: { nodePath: process.execPath, sdkPath: '' },
    exec: artifactProbe(),
  });
  assert.ok(env.runtimeLease);
  let ownershipReleased = false;
  let browserStopStarted = false;

  try {
    await shutdownOwnedStandaloneHost({
      runtime: {
        shutdown: async () => undefined,
        backend: { stop: async () => undefined, dispose: () => undefined } as never,
      },
      browserServer: {
        stop: async () => {
          browserStopStarted = true;
          await new Promise<void>(() => undefined);
        },
        dispose: () => undefined,
      },
      ownership: { release: async () => { ownershipReleased = true; }, abort: () => undefined } as never,
      restoreEnvironment: () => undefined,
      shutdownTimeoutMs: 10,
      backendStopConfirmTimeoutMs: 100,
      runtimeLease: env.runtimeLease,
    });
    assert.equal(ownershipReleased, true);
    assert.equal(browserStopStarted, true, 'the timed-out browser stop is part of shutdown confirmation');
    assert.equal((await leaseEntries(prepared.extensionPath)).length, 1,
      'backend exit alone does not prove all generation-consuming producers have drained');
  } finally {
    await env.runtimeLease.release();
  }
});

test('selected lease releases when shutdown completes successfully within the post-timeout grace', { timeout: 5_000 }, async (t) => {
  const prepared = await fixture(t, { selected: true });
  const env = await resolveStandaloneEnvironment({
    extensionPath: prepared.extensionPath,
    dependencies: { nodePath: process.execPath, sdkPath: '' },
    exec: artifactProbe(),
  });
  assert.ok(env.runtimeLease);
  let browserStopped = false;

  await shutdownOwnedStandaloneHost({
    runtime: {
      shutdown: async () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
      backend: { stop: async () => undefined, dispose: () => undefined, isRuntimeLifetimeTeardownConfirmed: () => true } as never,
    },
    browserServer: {
      stop: async () => { browserStopped = true; },
      dispose: () => undefined,
    },
    ownership: { release: async () => undefined, abort: () => undefined } as never,
    restoreEnvironment: () => undefined,
    shutdownTimeoutMs: 10,
    backendStopConfirmTimeoutMs: 100,
    runtimeLease: env.runtimeLease,
  });

  assert.equal(browserStopped, true);
  assert.deepEqual(await leaseEntries(prepared.extensionPath), [],
    'a successful runtime shutdown and browser stop during grace permit lease release');
});

test('startup-failure teardown retains selected lease on shutdown failure or timeout despite confirmed backend exit', { timeout: 5_000 }, async (t) => {
  const prepared = await fixture(t, { selected: true });
  const env = await resolveStandaloneEnvironment({
    extensionPath: prepared.extensionPath,
    dependencies: { nodePath: process.execPath, sdkPath: '' },
    exec: artifactProbe(),
  });
  assert.ok(env.runtimeLease);

  const failures = [
    {
      shutdown: async () => { throw new Error('runtime shutdown failed'); },
      timeoutMs: 100,
    },
    {
      shutdown: async () => new Promise<void>(() => undefined),
      timeoutMs: 10,
    },
  ];
  try {
    for (const failure of failures) {
      const startupError = new Error('standalone startup failed');
      let ownershipAborted = false;
      await assert.rejects(teardownAfterStandaloneStartupFailure({
        runtime: {
          shutdown: failure.shutdown,
          backend: { stop: async () => undefined, dispose: () => undefined } as never,
        },
        browserServer: { stop: async () => undefined, dispose: () => undefined },
        ownership: { release: async () => undefined, abort: () => { ownershipAborted = true; } } as never,
        restoreEnvironment: () => undefined,
        shutdownTimeoutMs: failure.timeoutMs,
        backendStopConfirmTimeoutMs: 100,
        runtimeLease: env.runtimeLease,
      }, startupError), (error: unknown) => error === startupError);
      assert.equal(ownershipAborted, true,
        'confirmed backend exit preserves existing startup ownership abort handling');
      assert.equal((await leaseEntries(prepared.extensionPath)).length, 1,
        'failed or timed-out runtime teardown must retain the generation lease');
    }
  } finally {
    await env.runtimeLease.release();
  }
});

test('startStandalone acquires then releases the selected lease when host setup fails before any owned process starts', { timeout: 10_000 }, async (t) => {
  const prepared = await fixture(t, { selected: true });
  const port = await freePort();
  const invalidStateFile = path.join(prepared.root, 'state-root-is-a-file');
  await fs.writeFile(invalidStateFile, 'not a directory');
  const output = prepared.publication!.outDir;
  const injected: StandaloneEnvironment = {
    paths: {
      extensionPath: prepared.extensionPath,
      runtimeOutputDirectory: output,
      backendPath: path.join(output, 'backend.js'),
      analyticsRecorderWorkerPath: path.join(output, 'analytics-recorder-worker.js'),
      analyticsQueryWorkerPath: path.join(output, 'analytics-query-worker.js'),
      webviewAssetDirectory: path.join(output, 'webview', 'panel'),
    },
    dependencies: { nodePath: process.execPath, sdkPath: path.join(prepared.root, 'untrusted-sdk') },
    dataPaths: {
      rootDir: invalidStateFile, analyticsDir: invalidStateFile, sessionsDir: invalidStateFile,
      artifactsDir: invalidStateFile, stateDir: invalidStateFile, cacheDir: invalidStateFile,
    },
  };

  await assert.rejects(startStandalone({
    cwd: prepared.root,
    extensionPath: prepared.extensionPath,
    environment: injected,
    coordinatorPort: port,
    browserServerSettings: { allowLan: true },
  }), /not a directory|already exists|ENOTDIR|EEXIST/i);
  assert.deepEqual(await leaseEntries(prepared.extensionPath), [],
    'startup failure before an owned backend releases the manager-issued lease');
  const retry = await acquirePieHostOwnership({ kind: 'standalone', port, handoffTimeoutMs: 0 });
  assert.equal(retry.status, 'acquired', 'failed standalone setup also relinquishes coordinator ownership');
  if (retry.status === 'acquired') await retry.ownership.release();
});

test('selected generation lease is retained when owned backend teardown is ambiguous', { timeout: 5_000 }, async (t) => {
  const prepared = await fixture(t, { selected: true });
  const env = await resolveStandaloneEnvironment({
    extensionPath: prepared.extensionPath,
    dependencies: { nodePath: process.execPath, sdkPath: '' },
    exec: artifactProbe(),
  });
  assert.ok(env.runtimeLease);
  let stopBackend!: () => void;
  const pendingStop = new Promise<void>((resolve) => { stopBackend = resolve; });
  let ownershipReleased = false;
  await assert.rejects(shutdownOwnedStandaloneHost({
    runtime: { shutdown: async () => new Promise<never>(() => undefined), backend: { stop: () => pendingStop, dispose: () => undefined } as never },
    browserServer: { stop: async () => undefined, dispose: () => undefined },
    ownership: { release: async () => { ownershipReleased = true; }, abort: () => undefined } as never,
    restoreEnvironment: () => undefined,
    shutdownTimeoutMs: 10,
    backendStopConfirmTimeoutMs: 30,
    runtimeLease: env.runtimeLease,
  }), /did not confirm that the backend process exited/);
  assert.equal(ownershipReleased, false);
  assert.equal((await leaseEntries(prepared.extensionPath)).length, 1,
    'a lease must protect code while an owned backend may still be alive');
  stopBackend();
  await env.runtimeLease.release();
});

test('packaged flat runtime keeps package-install lifetime without GC or a lease', async (t) => {
  const prepared = await fixture(t);
  const staleGeneration = path.join(prepared.extensionPath, RUNTIME_DIRECTORY, 'generations', 'd'.repeat(64), 'preserve.txt');
  await fs.mkdir(path.dirname(staleGeneration), { recursive: true });
  await fs.writeFile(staleGeneration, 'must not be collected');

  const env = await resolveStandaloneEnvironment({
    extensionPath: prepared.extensionPath,
    dependencies: { nodePath: process.execPath, sdkPath: '' },
    exec: artifactProbe(),
  });

  assert.equal(env.paths.runtimeOutputDirectory, path.join(prepared.extensionPath, 'out'));
  assert.equal(env.runtimeLease, undefined);
  assert.equal((await fs.readFile(staleGeneration, 'utf8')), 'must not be collected',
    'resolving the flat package does not trigger runtime-generation GC');
  assert.deepEqual(await leaseEntries(prepared.extensionPath), []);
  await assert.rejects(fs.stat(path.join(prepared.extensionPath, RUNTIME_DIRECTORY, 'leases')),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    'flat package selection does not create manager lease state');
});

test('explicit standalone output is caller-owned, not leased or deleted', async (t) => {
  const prepared = await fixture(t, { selected: true });
  const explicitOutput = path.join(prepared.root, 'caller-owned-out');
  await makeOutput(explicitOutput);
  const sentinel = path.join(explicitOutput, 'caller-sentinel.txt');
  await fs.writeFile(sentinel, 'immutable caller output');

  const env = await resolveStandaloneEnvironment({
    extensionPath: prepared.extensionPath,
    runtimeOutputDirectory: explicitOutput,
    dependencies: { nodePath: process.execPath, sdkPath: '' },
    exec: artifactProbe(),
  });

  assert.equal(env.paths.runtimeOutputDirectory, explicitOutput);
  assert.equal(env.runtimeLease, undefined);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'immutable caller output');
  assert.deepEqual(await leaseEntries(prepared.extensionPath), [], 'explicit output never claims a managed lease');
});

test('standalone rejects missing, tampered, and wrong-target artifacts despite injected dependencies or environment', async (t) => {
  const missing = await fixture(t, { artifact: false });
  const injected: StandaloneEnvironment = {
    paths: {
      extensionPath: missing.extensionPath,
      runtimeOutputDirectory: missing.output,
      backendPath: path.join(missing.output, 'backend.js'),
      analyticsRecorderWorkerPath: path.join(missing.output, 'analytics-recorder-worker.js'),
      analyticsQueryWorkerPath: path.join(missing.output, 'analytics-query-worker.js'),
      webviewAssetDirectory: path.join(missing.output, 'webview', 'panel'),
    },
    dependencies: { nodePath: process.execPath, sdkPath: path.join(missing.root, 'fake-sdk') },
    dataPaths: {
      rootDir: missing.root, analyticsDir: missing.root, sessionsDir: missing.root,
      artifactsDir: missing.root, stateDir: missing.root, cacheDir: missing.root,
    },
  };
  await assert.rejects(resolveStandaloneEnvironment({
    extensionPath: missing.extensionPath,
    environment: injected,
    dependencies: injected.dependencies,
    env: { ...process.env, PI_SDK_PATH: injected.dependencies.sdkPath },
    exec: artifactProbe(),
  }), /PI SDK package is unavailable|runtime artifact/i);

  const tampered = await fixture(t, { tamper: true });
  await assert.rejects(resolveStandaloneEnvironment({
    extensionPath: tampered.extensionPath,
    dependencies: { nodePath: process.execPath, sdkPath: '' },
    exec: artifactProbe(),
  }), /hash mismatch/);

  const wrongTarget = await fixture(t, {
    target: { ...TARGET, arch: TARGET.arch === 'x64' ? 'arm64' : 'x64' },
  });
  await assert.rejects(resolveStandaloneEnvironment({
    extensionPath: wrongTarget.extensionPath,
    dependencies: { nodePath: process.execPath, sdkPath: '' },
    exec: artifactProbe(),
  }), /target\.arch mismatch/);
});

test('standalone platform forwards its independently verified selected artifact through shared startup and coordinator args', async (t) => {
  const prepared = await fixture(t, { selected: true });
  assert.ok(prepared.publication);
  const agentDir = path.join(prepared.root, 'agent');
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, 'settings.json'), '{}');

  const restoreEnvironment = isolateStandaloneStartupEnvironment();
  let environment: StandaloneEnvironment | undefined;
  try {
    environment = await resolveStandaloneEnvironment({
      extensionPath: prepared.extensionPath,
      dataRoot: path.join(prepared.root, 'data'),
      dependencies: { nodePath: process.execPath, sdkPath: path.join(prepared.root, 'untrusted-sdk'), agentDir },
      env: { ...process.env },
    });
    const verifiedDescriptor = environment.sourceArtifactDescriptor;
    assert.ok(verifiedDescriptor, 'selected output must supply an independently verified artifact descriptor');
    assert.equal(environment.paths.runtimeOutputDirectory, prepared.publication.outDir);
    assert.equal(verifiedDescriptor.artifactDir, await fs.realpath(path.join(environment.paths.runtimeOutputDirectory, 'pi-runtime')));
    assert.equal(environment.dependencies.nodePath, path.resolve(process.execPath));
    assert.equal(environment.dependencies.sdkPath, verifiedDescriptor.sdkPath);

    const platform = createStandaloneHostRuntimePlatform({
      workspaceCwd: prepared.root,
      extensionPath: environment.paths.extensionPath,
      runtimeOutputDirectory: environment.paths.runtimeOutputDirectory,
      dataPaths: environment.dataPaths,
      dependencies: environment.dependencies,
      storage: new StandaloneHostStorage({ stateDir: environment.dataPaths.stateDir, workspaceCwd: prepared.root }),
      getBrowserServer: () => undefined,
    });
    assert.equal(platform.getSetting<string>('sdkPath'), verifiedDescriptor.sdkPath);

    let archState = createInitialArchState();
    const dispatchArch = (event: Event): void => { archState = reducer(archState, event).state; };
    const calls: string[] = [];
    let backendStartArgs: {
      nodePath: string;
      sdkPath: string;
      sourceArtifactDescriptor?: unknown;
      analyticsContext: unknown;
      backendPath: string;
      cwd: string;
    } | undefined;
    let parsedCoordinatorArgs: ReturnType<typeof parseCoordinatorBackendArgs> | undefined;
    let releaseBackendStart!: () => void;
    const backendStartGate = new Promise<void>((resolve) => { releaseBackendStart = resolve; });
    let backendStartEntered!: () => void;
    const backendStartEnteredPromise = new Promise<void>((resolve) => { backendStartEntered = resolve; });
    const backend = {
      onEvent: () => ({ dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
      request: async (method: string) => {
        calls.push(`request:${method}`);
        return method === 'session.list' ? [] : {};
      },
      start: async (args: NonNullable<typeof backendStartArgs>) => {
        calls.push('backend.start');
        backendStartArgs = args;
        backendStartEntered();
        parsedCoordinatorArgs = parseCoordinatorBackendArgs([
          '--sdkPath', args.sdkPath,
          '--analyticsContext', JSON.stringify(args.analyticsContext),
          ...(args.sourceArtifactDescriptor === undefined
            ? []
            : ['--sourceArtifactDescriptor', JSON.stringify(args.sourceArtifactDescriptor)]),
        ]);
        await backendStartGate;
      },
      stop: async () => undefined,
      getGeneration: () => 1,
    } as unknown as BackendClient;
    const scheduleRender = (): void => undefined;
    const state = new SessionServiceState(backend, scheduleRender, () => archState, dispatchArch);
    const service = {
      loadPruningSettings: async () => undefined,
      loadToolResultPruningSettings: async () => undefined,
      loadSessionTitlesSettings: async () => undefined,
      schedulePrivateSessionCleanup: () => undefined,
    } as unknown as SessionService;

    const startup = startSessionBackend({
      getAnalyticsBackendContext: () => ({ mode: 'canonical-only', generationId: 'test', buildId: 'test', workspaceId: 'test', hostInstanceId: 'test' }),
      platform,
      backend,
      scheduleRender,
      events: { attach: () => calls.push('events.attach'), detach: () => calls.push('events.detach') } as never,
      state,
      service,
      openSession: () => undefined,
      getArchState: () => archState,
      dispatchArch,
    });
    await backendStartEnteredPromise;
    const runtimePrefsRequestedBeforeStartResolved = calls.includes('request:runtimePrefs.set');
    releaseBackendStart();
    await startup;

    assert.equal(runtimePrefsRequestedBeforeStartResolved, false,
      'runtimePrefs.set must wait until the fake backend start promise resolves');
    assert.ok(backendStartArgs, 'shared session startup must reach BackendClient.start');
    assert.equal(backendStartArgs.sdkPath, verifiedDescriptor.sdkPath);
    assert.equal(backendStartArgs.nodePath, environment.dependencies.nodePath);
    assert.deepEqual(backendStartArgs.sourceArtifactDescriptor, verifiedDescriptor);
    assert.equal(parsedCoordinatorArgs?.sdkPath, verifiedDescriptor.sdkPath);
    assert.deepEqual(parsedCoordinatorArgs?.sourceArtifactDescriptor, verifiedDescriptor,
      'coordinator parseArgs must receive the exact independently verified selected-output descriptor');
    assert.equal(parsedCoordinatorArgs?.sourceArtifactDescriptor?.identity, verifiedDescriptor.identity);
    assert.equal(parsedCoordinatorArgs?.sourceArtifactDescriptor?.sdkPath, verifiedDescriptor.sdkPath);
    assert.ok(calls.indexOf('backend.start') < calls.indexOf('request:runtimePrefs.set'));
  } finally {
    try {
      await environment?.runtimeLease?.release();
    } finally {
      restoreEnvironment();
    }
  }
});

test('standalone workspace SDK selection requires opt-in and emits an explicit workspace route', async (t) => {
  const prepared = await fixture(t, { artifact: false });
  const workspaceRoot = path.join(prepared.root, 'pi-workspace');
  await put(workspaceRoot, 'packages/coding-agent/package.json', JSON.stringify({
    name: '@earendil-works/pi-coding-agent',
    version: '0.80.6-dev',
  }));
  await put(workspaceRoot, 'packages/coding-agent/dist/index.js', 'export {}\n');
  const profileDir = path.join(prepared.root, 'development-profile');
  await put(prepared.root, 'settings.json', '{}'); // Valid checkout-relative candidate must still be ignored in development.
  const env = {
    ...process.env,
    PIE_DEVELOPMENT_PROFILE_DIR: profileDir,
    PI_CODING_AGENT_DIR: path.join(profileDir, 'agent'),
    PI_CODING_AGENT_AUTH_DIR: path.join(profileDir, 'auth'),
    PIE_DATA_DIR: path.join(profileDir, 'data'),
    PI_CODING_AGENT_SESSION_DIR: path.join(profileDir, 'data', 'sessions'),
    PIE_DEVELOPMENT_PI_WORKSPACE: workspaceRoot,
  };

  await assert.rejects(resolveStandaloneEnvironment({
    extensionPath: prepared.extensionPath,
    runtimeOutputDirectory: prepared.output,
    env: { ...process.env, PIE_DEVELOPMENT_PI_WORKSPACE: workspaceRoot },
    exec: artifactProbe(),
  }), /PIE_DEVELOPMENT_PROFILE_DIR is required/u);

  await assert.rejects(resolveStandaloneEnvironment({
    extensionPath: prepared.extensionPath,
    runtimeOutputDirectory: prepared.output,
    env,
    exec: artifactProbe(),
  }), /PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK=1/);

  const selected = await resolveStandaloneEnvironment({
    extensionPath: prepared.extensionPath,
    runtimeOutputDirectory: prepared.output,
    dependencies: { nodePath: process.execPath, sdkPath: '/ignored/external/sdk' },
    env: { ...env, PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK: '1' },
    exec: artifactProbe(),
  });
  assert.equal(selected.dependencies.sdkPath, path.join(workspaceRoot, 'packages', 'coding-agent'));
  assert.equal(selected.dependencies.agentDir, path.join(profileDir, 'agent'));
  assert.equal(selected.dataPaths.rootDir, path.join(profileDir, 'data'));
  assert.equal(selected.developmentProfilePaths?.authDir, path.join(profileDir, 'auth'));
  assert.equal(selected.developmentProfilePaths?.authFile, path.join(profileDir, 'auth', 'auth.json'));
  assert.deepEqual(selected.sdkRuntimeSelection, { kind: 'workspace-development', workspaceRoot });
  assert.equal(selected.sourceArtifactDescriptor, undefined, 'development must not fabricate production artifact identity');
});

test('standalone development artifact requires opt-in and then uses only the verified override descriptor', async (t) => {
  const prepared = await fixture(t, { artifact: false });
  const developmentArtifact = path.join(prepared.root, 'private-development-runtime');
  await makeOutput(developmentArtifact);
  const profileDir = path.join(prepared.root, 'development-profile');
  const env = {
    ...process.env,
    PIE_DEVELOPMENT_PROFILE_DIR: profileDir,
    PI_CODING_AGENT_DIR: path.join(profileDir, 'agent'),
    PI_CODING_AGENT_AUTH_DIR: path.join(profileDir, 'auth'),
    PIE_DATA_DIR: path.join(profileDir, 'data'),
    PI_CODING_AGENT_SESSION_DIR: path.join(profileDir, 'data', 'sessions'),
    PIE_DEVELOPMENT_PI_RUNTIME: path.join(developmentArtifact, 'pi-runtime'),
  };

  await assert.rejects(resolveStandaloneEnvironment({
    extensionPath: prepared.extensionPath,
    runtimeOutputDirectory: prepared.output,
    dependencies: { nodePath: process.execPath, sdkPath: '' },
    env,
    exec: artifactProbe(),
  }), /PIE_ALLOW_DEVELOPMENT_RUNTIME=1/);

  const verified = await resolveStandaloneEnvironment({
    extensionPath: prepared.extensionPath,
    runtimeOutputDirectory: prepared.output,
    dependencies: { nodePath: process.execPath, sdkPath: '' },
    env: { ...env, PIE_ALLOW_DEVELOPMENT_RUNTIME: '1' },
    exec: artifactProbe(),
  });
  assert.equal(verified.sourceArtifactDescriptor?.artifactDir, await fs.realpath(path.join(developmentArtifact, 'pi-runtime')));
  assert.equal(verified.dependencies.sdkPath, verified.sourceArtifactDescriptor?.sdkPath);
});
