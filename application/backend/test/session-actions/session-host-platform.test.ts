/**
 * Focused tests for the session service's platform-neutral host seam
 * (`session-service/platform.ts`): the VS Code composition supplies the
 * production adapter; these tests pin the adapter contract the service and
 * startup rely on — persisted storage keys, workspace cwd, the exact
 * `pie` → `piAssistant` setting fallback, runtime output directory, and
 * backend startup ordering — without importing `vscode`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BackendClient } from '../../agent-connection/client';
import { startSessionBackend } from '../../agent-connection/startup';
import { SessionService } from '../../session-actions/service';
import { SessionServiceState } from '../../session-actions/state';
import { selectRuntimeSetting, type SessionHostPlatform } from '../../../hosts/lib/platform-contracts/session-platform';
import { PI_RUNTIME_PACKAGES, PI_RUNTIME_SDK_RELATIVE_PATH } from '../../../../lib/pi-runtime/artifact.mjs';
import { writePiRuntimeManifest } from '../../../../scripts/lib/pi-runtime-artifact.mjs';
import { resolveGenerationPiRuntime } from '../../../hosts/lib/pi-runtime-resolution';
import { createInitialArchState, type ArchState } from '../../conversation-state/arch-state';
import { reducer } from '../../conversation-state/reducer';
import type { Event } from '../../conversation-state/events';
import { NOOP_RUN_OBSERVER } from '../../analytics-views';
import type { PruningSettings } from '../../../lib/protocol/index.js';
import { parseArgs as parseCoordinatorBackendArgs } from '../../../../harness/agent-processes/coordinator/backend-args';

const PRUNING_STORAGE_KEY = 'pruningSettings';
const PI_RUNTIME_ASSETS = [
  'dist/cli.js', 'dist/rpc-entry.js',
  'dist/modes/interactive/theme/dark.json',
  'dist/modes/interactive/theme/light.json',
  'dist/modes/interactive/theme/theme-schema.json',
  'dist/modes/interactive/assets/clankolas.png',
  'dist/core/export-html/template.html',
  'dist/core/export-html/template.css',
  'dist/core/export-html/template.js',
  'dist/core/export-html/vendor/marked.min.js',
  'dist/core/export-html/vendor/highlight.min.js',
];

function makeStore() {
  const values = new Map<string, unknown>();
  return {
    values,
    get<T>(key: string): T | undefined {
      return values.get(key) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
  };
}

interface PlatformFixture {
  platform: SessionHostPlatform;
  storage: ReturnType<typeof makeStore>;
  pieSettings: Map<string, unknown>;
  legacySettings: Map<string, unknown>;
}

function createPlatformFixture(overrides: Partial<SessionHostPlatform> = {}): PlatformFixture {
  const storage = makeStore();
  const pieSettings = new Map<string, unknown>();
  const legacySettings = new Map<string, unknown>();
  const platform: SessionHostPlatform = {
    storage,
    extensionPath: '/test-extension',
    getRuntimeOutputDirectory: () => '/test-out',
    getWorkspaceCwd: () => '/test-workspace',
    getSetting: <T>(name: string, fallbackName?: string): T | undefined => {
      if (fallbackName === undefined) return pieSettings.get(name) as T | undefined;
      return selectRuntimeSetting(
        pieSettings.get(name) as string | undefined,
        legacySettings.get(`piAssistant.${fallbackName}`) as string | undefined,
      ) as unknown as T | undefined;
    },
    requestWindowAttention: () => undefined,
    ...overrides,
  };
  return { platform, storage, pieSettings, legacySettings };
}

async function createGenerationRuntimeFiles(
  runtimeOutDir: string,
  target = { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules },
): Promise<string> {
  const artifactDir = path.join(runtimeOutDir, 'pi-runtime');
  for (const packageName of PI_RUNTIME_PACKAGES) {
    const packageDir = path.join(artifactDir, 'node_modules', packageName);
    fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: packageName, version: '0.80.6' }));
    fs.writeFileSync(path.join(packageDir, 'dist', 'index.js'), 'export {};\n');
    fs.writeFileSync(path.join(packageDir, 'LICENSE'), 'fixture license\n');
  }
  const sdkDir = path.join(artifactDir, PI_RUNTIME_SDK_RELATIVE_PATH);
  for (const relative of PI_RUNTIME_ASSETS) {
    const file = path.join(sdkDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `fixture:${relative}\n`);
  }
  await writePiRuntimeManifest(artifactDir, {
    upstreamVersion: '0.80.6',
    upstreamCommit: '2b3fda9921b5590f285165287bd442a25817f17b',
    sourceTreeSha256: 'a'.repeat(64),
    lockSha256: 'b'.repeat(64),
    target,
  });
  return path.join(artifactDir, PI_RUNTIME_SDK_RELATIVE_PATH);
}

async function createGenerationRuntime(runtimeOutDir: string): Promise<{
  sdkPath: string;
  descriptor: Awaited<ReturnType<typeof resolveGenerationPiRuntime>>;
}> {
  await createGenerationRuntimeFiles(runtimeOutDir);
  const descriptor = await resolveGenerationPiRuntime({
    runtimeOutDir,
    target: { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules },
  });
  return { sdkPath: descriptor.sdkPath, descriptor };
}

function createTempRoot(t: { after: (fn: () => void) => void }): string {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pie-startup-')));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  return tempRoot;
}

function isolateRuntimeOverrideEnvironment(): () => void {
  const keys = ['PI_SDK_PATH', 'PIE_DEVELOPMENT_PI_RUNTIME', 'PIE_ALLOW_DEVELOPMENT_RUNTIME'] as const;
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

async function withIsolatedStartupEnvironment<T>(run: () => Promise<T>): Promise<T> {
  const restoreRuntimeEnvironment = isolateRuntimeOverrideEnvironment();
  const keys = ['PI_CODING_AGENT_DIR', 'PIE_ALLOW_IN_TREE_AUTH'] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    return await run();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    restoreRuntimeEnvironment();
  }
}

function makeDispatch(initial: ArchState) {
  let current = initial;
  const dispatched: Event[] = [];
  const dispatchArch = (event: Event): void => {
    dispatched.push(event);
    current = reducer(current, event).state;
  };
  const getArchState = (): ArchState => current;
  return { dispatched, dispatchArch, getArchState };
}

async function attemptStartupWithFakeBackend(fixture: PlatformFixture): Promise<{
  calls: string[];
  dispatched: Event[];
  startArgs?: { nodePath: string; sdkPath: string; sourceArtifactDescriptor?: unknown };
}> {
  fixture.storage.update('openTabPaths', ['/test-workspace/session-a.jsonl']);
  fixture.storage.update('activeSessionPath', '/test-workspace/session-a.jsonl');
  const { dispatched, dispatchArch, getArchState } = makeDispatch(createInitialArchState());
  const scheduleRender = (): void => undefined;
  const calls: string[] = [];
  let startArgs: { nodePath: string; sdkPath: string; sourceArtifactDescriptor?: unknown } | undefined;
  const backend = {
    onEvent: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
    request: async () => [],
    start: async (args: NonNullable<typeof startArgs>) => {
      calls.push('backend.start');
      startArgs = args;
    },
    stop: async () => undefined,
    getGeneration: () => 1,
  } as unknown as BackendClient;
  await startSessionBackend({
    platform: fixture.platform,
    backend,
    scheduleRender,
    events: {
      attach: () => { calls.push('events.attach'); },
      detach: () => { calls.push('events.detach'); },
    } as never,
    state: new SessionServiceState(backend, scheduleRender, getArchState, dispatchArch, 0),
    service: {
      loadPruningSettings: async () => undefined,
      loadToolResultPruningSettings: async () => undefined,
      loadSessionTitlesSettings: async () => undefined,
      schedulePrivateSessionCleanup: () => undefined,
    } as never,
    openSession: () => undefined,
    getArchState,
    dispatchArch,
  });
  return { calls, dispatched, startArgs };
}

test('selectRuntimeSetting preserves the exact pie → piAssistant trimmed fallback', () => {
  assert.equal(selectRuntimeSetting(' /sdk ', '/legacy/sdk'), '/sdk');
  assert.equal(selectRuntimeSetting(undefined, '/legacy/sdk'), '/legacy/sdk');
  // A blank pie value defers to the legacy root setting, matching the
  // historical `pie.value?.trim() || piAssistant.value?.trim()` chain.
  assert.equal(selectRuntimeSetting('   ', ' /legacy/sdk '), '/legacy/sdk');
  assert.equal(selectRuntimeSetting('   ', '   '), undefined);
  assert.equal(selectRuntimeSetting(undefined, undefined), undefined);
});

test('startSessionBackend uses the generation artifact, attaches before spawn, then defers runtime prefs until ready', async (t) => {
  const tempRoot = createTempRoot(t);
  const runtimeOutDir = path.join(tempRoot, 'out');
  const expectedRuntime = await createGenerationRuntime(runtimeOutDir);
  const nodePath = path.relative(process.cwd(), process.execPath);

  const fixture = createPlatformFixture({ getRuntimeOutputDirectory: () => runtimeOutDir });
  fixture.pieSettings.set('sdkPath', '/ignored/configured-sdk');
  fixture.pieSettings.set('nodePath', nodePath);
  fixture.storage.update('openTabPaths', ['/test-workspace/session-a.jsonl']);
  fixture.storage.update('activeSessionPath', '/test-workspace/session-a.jsonl');

  const { dispatched, dispatchArch, getArchState } = makeDispatch(createInitialArchState());
  const scheduleRender = (): void => undefined;
  const calls: string[] = [];
  let startArgs: {
    nodePath: string;
    sdkPath: string;
    sourceArtifactDescriptor?: unknown;
    backendPath: string;
    cwd: string;
  } | undefined;
  let parsedCoordinatorArgs: ReturnType<typeof parseCoordinatorBackendArgs> | undefined;
  const backend = {
    onEvent: () => { calls.push('event-attached'); return { dispose: () => undefined }; },
    onExit: () => { calls.push('exit-attached'); return { dispose: () => undefined }; },
    request: async (method: string) => { calls.push(`request:${method}`); return {}; },
    start: async (args: NonNullable<typeof startArgs>) => {
      calls.push('backend.start');
      startArgs = args;
      // Exercise coordinator parsing of the verified descriptor without spawning a live host.
      parsedCoordinatorArgs = parseCoordinatorBackendArgs([
        '--sdkPath', args.sdkPath,
        ...(args.sourceArtifactDescriptor
          ? ['--sourceArtifactDescriptor', JSON.stringify(args.sourceArtifactDescriptor)]
          : []),
      ]);
    },
    stop: async () => undefined,
    getGeneration: () => 1,
  } as unknown as BackendClient;
  const events = {
    attach: () => { calls.push('events.attach'); },
    detach: () => { calls.push('events.detach'); },
  } as never;
  const service = {
    loadPruningSettings: async () => undefined,
    loadToolResultPruningSettings: async () => undefined,
    loadSessionTitlesSettings: async () => undefined,
    schedulePrivateSessionCleanup: () => undefined,
  } as unknown as SessionService;
  const openedSessionPaths: string[] = [];

  const restoreRuntimeEnvironment = isolateRuntimeOverrideEnvironment();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousInTreeAuth = process.env.PIE_ALLOW_IN_TREE_AUTH;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PIE_ALLOW_IN_TREE_AUTH;
  try {
    await startSessionBackend({
      platform: fixture.platform,
      backend,
      scheduleRender,
      events,
      state: new SessionServiceState(backend, scheduleRender, getArchState, dispatchArch, 0),
      service,
      openSession: (sessionPath) => { openedSessionPaths.push(sessionPath); calls.push('openSession'); },
      getArchState,
      dispatchArch,
    });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousInTreeAuth === undefined) delete process.env.PIE_ALLOW_IN_TREE_AUTH;
    else process.env.PIE_ALLOW_IN_TREE_AUTH = previousInTreeAuth;
    restoreRuntimeEnvironment();
  }

  assert.ok(
    calls.indexOf('events.attach') < calls.indexOf('backend.start'),
    'backend event handlers must attach before the spawn request',
  );
  assert.ok(startArgs, 'backend.start must be reached with a resolvable runtime');
  assert.equal(startArgs.cwd, '/test-workspace');
  assert.equal(startArgs.sdkPath, expectedRuntime.sdkPath);
  assert.deepEqual(startArgs.sourceArtifactDescriptor, expectedRuntime.descriptor);
  assert.deepEqual(parsedCoordinatorArgs?.sourceArtifactDescriptor, expectedRuntime.descriptor);
  assert.equal(startArgs.nodePath, process.execPath);
  assert.equal(startArgs.backendPath, path.join(runtimeOutDir, 'backend.js'));
  assert.ok(calls.indexOf('backend.start') < calls.indexOf('request:runtimePrefs.set'));
  assert.ok(calls.indexOf('request:runtimePrefs.set') < calls.indexOf('openSession'));

  const cwdEvent = dispatched.find((event) => event.kind === 'WorkspaceCwdChanged') as { workspaceCwd: string } | undefined;
  assert.equal(cwdEvent?.workspaceCwd, '/test-workspace');
  const restoreEvent = dispatched.find((event) => event.kind === 'OpenTabsChanged') as
    | { openTabPaths: string[]; pinnedTabPaths: string[] }
    | undefined;
  assert.ok(restoreEvent, 'restore plan must read persisted tabs through platform.storage');
  assert.deepEqual(restoreEvent.openTabPaths, ['/test-workspace/session-a.jsonl']);
  assert.equal(
    dispatched.find((event) => event.kind === 'BackendReadyChanged') !== undefined,
    true,
  );
  assert.deepEqual(openedSessionPaths, ['/test-workspace/session-a.jsonl']);
  // The generation artifact is re-verified on every start and is never cached.
  assert.equal(fixture.storage.get('resolvedSdkPath'), undefined);
});

test('startSessionBackend reports BackendReadyChanged{ready:false} and detaches when the backend fails to start', async (t) => {
  const tempRoot = createTempRoot(t);
  const runtimeOutDir = path.join(tempRoot, 'out');
  await createGenerationRuntime(runtimeOutDir);
  const nodePath = process.execPath;

  const fixture = createPlatformFixture({ getRuntimeOutputDirectory: () => runtimeOutDir });
  fixture.pieSettings.set('nodePath', nodePath);

  const { dispatched, dispatchArch, getArchState } = makeDispatch(createInitialArchState());
  const scheduleRender = (): void => undefined;
  const backend = {
    onEvent: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
    request: async () => ({}),
    start: async () => { throw new Error('spawn refused'); },
    stop: async () => undefined,
    getGeneration: () => 1,
  } as unknown as BackendClient;

  const restoreRuntimeEnvironment = isolateRuntimeOverrideEnvironment();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    await startSessionBackend({
      platform: fixture.platform,
      backend,
      scheduleRender,
      events: { attach: () => undefined, detach: () => undefined } as never,
      state: new SessionServiceState(backend, scheduleRender, getArchState, dispatchArch, 0),
      service: {
        loadPruningSettings: async () => undefined,
        loadToolResultPruningSettings: async () => undefined,
        loadSessionTitlesSettings: async () => undefined,
        schedulePrivateSessionCleanup: () => undefined,
      } as never,
      openSession: () => undefined,
      getArchState,
      dispatchArch,
    });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    restoreRuntimeEnvironment();
  }

  assert.ok(dispatched.some((event) => event.kind === 'BackendReadyChanged' && event.ready === false));
  assert.ok(dispatched.some((event) => event.kind === 'NoticeShown' && (event.notice ?? '').includes('spawn refused')));
});

test('startSessionBackend fails closed when the selected Node target mismatches the generation artifact', async (t) => {
  const tempRoot = createTempRoot(t);
  const runtimeOutDir = path.join(tempRoot, 'out');
  const wrongAbi = process.versions.modules === '0' ? '1' : '0';
  await createGenerationRuntimeFiles(runtimeOutDir, {
    platform: process.platform,
    arch: process.arch,
    nodeAbi: wrongAbi,
  });
  const fixture = createPlatformFixture({ getRuntimeOutputDirectory: () => runtimeOutDir });
  fixture.pieSettings.set('nodePath', process.execPath);
  const { dispatched, dispatchArch, getArchState } = makeDispatch(createInitialArchState());
  const scheduleRender = (): void => undefined;
  const calls: string[] = [];
  const backend = {
    onEvent: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
    request: async () => ({}),
    start: async () => { calls.push('backend.start'); },
    stop: async () => undefined,
    getGeneration: () => 1,
  } as unknown as BackendClient;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const restoreRuntimeEnvironment = isolateRuntimeOverrideEnvironment();
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    await startSessionBackend({
      platform: fixture.platform,
      backend,
      scheduleRender,
      events: {
        attach: () => { calls.push('events.attach'); },
        detach: () => { calls.push('events.detach'); },
      } as never,
      state: new SessionServiceState(backend, scheduleRender, getArchState, dispatchArch, 0),
      service: {
        loadPruningSettings: async () => undefined,
        loadToolResultPruningSettings: async () => undefined,
        loadSessionTitlesSettings: async () => undefined,
        schedulePrivateSessionCleanup: () => undefined,
      } as never,
      openSession: () => undefined,
      getArchState,
      dispatchArch,
    });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    restoreRuntimeEnvironment();
  }

  assert.deepEqual(calls, [], 'a target mismatch must stop before event attachment or backend spawn');
  assert.ok(dispatched.some((event) => (
    event.kind === 'NoticeShown' && (event.notice ?? '').includes('target.nodeAbi mismatch')
  )));
});

test('startSessionBackend ignores legacy SDK candidates and uses the verified generation artifact', async (t) => {
  const tempRoot = createTempRoot(t);
  const runtimeOutDir = path.join(tempRoot, 'out');
  const expectedRuntime = await createGenerationRuntime(runtimeOutDir);
  const nodePath = process.execPath;

  const fixture = createPlatformFixture({ getRuntimeOutputDirectory: () => runtimeOutDir });
  // The old SDK settings and environment variable are not candidate fallbacks.
  fixture.pieSettings.set('sdkPath', '   ');
  fixture.pieSettings.set('nodePath', '   ');
  fixture.legacySettings.set('piAssistant.sdkPath', '/legacy/pi-sdk');
  fixture.legacySettings.set('piAssistant.nodePath', nodePath);

  const { dispatchArch, getArchState } = makeDispatch(createInitialArchState());
  const scheduleRender = (): void => undefined;
  let startArgs: { nodePath: string; sdkPath: string; sourceArtifactDescriptor?: unknown } | undefined;
  const backend = {
    onEvent: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
    request: async () => ({}),
    start: async (args: NonNullable<typeof startArgs>) => { startArgs = args; },
    stop: async () => undefined,
    getGeneration: () => 1,
  } as unknown as BackendClient;

  const restoreRuntimeEnvironment = isolateRuntimeOverrideEnvironment();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_SDK_PATH = '/ambient/pi-sdk';
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    await startSessionBackend({
      platform: fixture.platform,
      backend,
      scheduleRender,
      events: { attach: () => undefined, detach: () => undefined } as never,
      state: new SessionServiceState(backend, scheduleRender, getArchState, dispatchArch, 0),
      service: {
        loadPruningSettings: async () => undefined,
        loadToolResultPruningSettings: async () => undefined,
        loadSessionTitlesSettings: async () => undefined,
        schedulePrivateSessionCleanup: () => undefined,
      } as never,
      openSession: () => undefined,
      getArchState,
      dispatchArch,
    });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    restoreRuntimeEnvironment();
  }

  assert.ok(startArgs, 'backend.start must be reached using the generation artifact');
  assert.equal(startArgs.sdkPath, expectedRuntime.sdkPath);
  assert.deepEqual(startArgs.sourceArtifactDescriptor, expectedRuntime.descriptor);
  assert.equal(startArgs.nodePath, nodePath);
  assert.equal(fixture.storage.get('resolvedSdkPath'), undefined);
});

test('startSessionBackend fails closed when a development artifact is selected without opt-in', async (t) => {
  const tempRoot = createTempRoot(t);
  const runtimeOutDir = path.join(tempRoot, 'out');
  const defaultRuntime = await createGenerationRuntime(runtimeOutDir);
  const developmentRuntime = await createGenerationRuntime(path.join(tempRoot, 'development'));
  const fixture = createPlatformFixture({ getRuntimeOutputDirectory: () => runtimeOutDir });
  fixture.pieSettings.set('nodePath', process.execPath);
  const { dispatched, dispatchArch, getArchState } = makeDispatch(createInitialArchState());
  const scheduleRender = (): void => undefined;
  let started = false;
  const backend = {
    onEvent: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
    request: async () => ({}),
    start: async () => { started = true; },
    stop: async () => undefined,
    getGeneration: () => 1,
  } as unknown as BackendClient;
  const restoreRuntimeEnvironment = isolateRuntimeOverrideEnvironment();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PIE_DEVELOPMENT_PI_RUNTIME = developmentRuntime.descriptor.artifactDir;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    await startSessionBackend({
      platform: fixture.platform,
      backend,
      scheduleRender,
      events: { attach: () => undefined, detach: () => undefined } as never,
      state: new SessionServiceState(backend, scheduleRender, getArchState, dispatchArch, 0),
      service: {
        loadPruningSettings: async () => undefined,
        loadToolResultPruningSettings: async () => undefined,
        loadSessionTitlesSettings: async () => undefined,
        schedulePrivateSessionCleanup: () => undefined,
      } as never,
      openSession: () => undefined,
      getArchState,
      dispatchArch,
    });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    restoreRuntimeEnvironment();
  }

  assert.equal(started, false, 'the valid default artifact must not mask an unapproved explicit override');
  assert.ok(dispatched.some((event) => (
    event.kind === 'NoticeShown'
    && (event.notice ?? '').includes('PIE_ALLOW_DEVELOPMENT_RUNTIME=1')
  )));
  assert.notEqual(defaultRuntime.descriptor.artifactDir, developmentRuntime.descriptor.artifactDir);
});

test('startSessionBackend fails closed before event attachment when the generation artifact is missing', async (t) => {
  const tempRoot = createTempRoot(t);
  const runtimeOutDir = path.join(tempRoot, 'out');
  fs.mkdirSync(runtimeOutDir, { recursive: true });
  const fixture = createPlatformFixture({ getRuntimeOutputDirectory: () => runtimeOutDir });
  fixture.pieSettings.set('nodePath', process.execPath);

  const attempt = await withIsolatedStartupEnvironment(() => attemptStartupWithFakeBackend(fixture));

  assert.deepEqual(attempt.calls, [], 'a missing artifact must stop before event attachment or backend spawn');
  assert.ok(attempt.dispatched.some((event) => (
    event.kind === 'NoticeShown' && (event.notice ?? '').includes('setup error')
  )));
});

test('startSessionBackend rejects a tampered development artifact before event attachment', async (t) => {
  const tempRoot = createTempRoot(t);
  const runtimeOutDir = path.join(tempRoot, 'out');
  const defaultRuntime = await createGenerationRuntime(runtimeOutDir);
  const developmentRuntime = await createGenerationRuntime(path.join(tempRoot, 'development'));
  fs.writeFileSync(path.join(developmentRuntime.sdkPath, 'dist', 'cli.js'), 'tampered private artifact\n');
  const fixture = createPlatformFixture({ getRuntimeOutputDirectory: () => runtimeOutDir });
  fixture.pieSettings.set('nodePath', process.execPath);

  const attempt = await withIsolatedStartupEnvironment(async () => {
    process.env.PIE_DEVELOPMENT_PI_RUNTIME = developmentRuntime.descriptor.artifactDir;
    process.env.PIE_ALLOW_DEVELOPMENT_RUNTIME = '1';
    return attemptStartupWithFakeBackend(fixture);
  });

  assert.deepEqual(attempt.calls, [], 'a tampered override must not fall back to the valid default artifact');
  assert.ok(attempt.dispatched.some((event) => (
    event.kind === 'NoticeShown' && (event.notice ?? '').includes('package hash mismatch')
  )));
  assert.notEqual(defaultRuntime.descriptor.artifactDir, developmentRuntime.descriptor.artifactDir);
});

test('startSessionBackend starts with the verified development override when both opt-in flags are set', async (t) => {
  const tempRoot = createTempRoot(t);
  const runtimeOutDir = path.join(tempRoot, 'out');
  const defaultRuntime = await createGenerationRuntime(runtimeOutDir);
  const developmentRuntime = await createGenerationRuntime(path.join(tempRoot, 'development'));
  const fixture = createPlatformFixture({ getRuntimeOutputDirectory: () => runtimeOutDir });
  fixture.pieSettings.set('nodePath', process.execPath);

  const attempt = await withIsolatedStartupEnvironment(async () => {
    process.env.PIE_DEVELOPMENT_PI_RUNTIME = developmentRuntime.descriptor.artifactDir;
    process.env.PIE_ALLOW_DEVELOPMENT_RUNTIME = '1';
    return attemptStartupWithFakeBackend(fixture);
  });

  assert.ok(attempt.startArgs, 'the verified development artifact must reach backend.start');
  assert.ok(attempt.calls.includes('backend.start'));
  assert.equal(attempt.startArgs.sdkPath, developmentRuntime.descriptor.sdkPath);
  assert.deepEqual(attempt.startArgs.sourceArtifactDescriptor, developmentRuntime.descriptor);
  assert.notEqual(defaultRuntime.descriptor.artifactDir, developmentRuntime.descriptor.artifactDir);
});

test('SessionService persists settings families through platform.storage with unchanged keys', async () => {
  const fixture = createPlatformFixture();
  const backend = new BackendClient();
  const { dispatched, dispatchArch, getArchState } = makeDispatch(createInitialArchState());
  const service = new SessionService(
    fixture.platform,
    backend,
    () => undefined,
    () => undefined,
    dispatchArch,
    getArchState,
  );

  const persisted: PruningSettings = {
    mode: 'off',
    skillCeiling: 0,
    toolCeiling: 0,
    skillAlwaysKeep: [],
    toolAlwaysKeep: [],
    model: '',
    provider: '',
    thinkingLevel: 'medium',
  };
  fixture.storage.update(PRUNING_STORAGE_KEY, persisted);

  await service.loadPruningSettings();
  assert.ok(dispatched.some((event) => (
    event.kind === 'PruningSettingsChanged'
    && (event.pruningSettings as PruningSettings).mode === 'off'
  )), 'loadPruningSettings must restore from platform.storage');

  await service.setPruningSettings({ ...persisted, skillCeiling: 5 });
  const stored = fixture.storage.get<PruningSettings>(PRUNING_STORAGE_KEY);
  assert.equal(stored?.skillCeiling, 5, 'setPruningSettings must persist under the unchanged pruningSettings key');
});