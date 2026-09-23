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

import { BackendClient } from '../../../src/host/backend/client';
import { startSessionBackend } from '../../../src/host/session-service/startup';
import { SessionService } from '../../../src/host/session-service/service';
import { SessionServiceState } from '../../../src/host/session-service/state';
import { selectRuntimeSetting, type SessionHostPlatform } from '../../../src/host/session-service/platform';
import { createInitialArchState, type ArchState } from '../../../src/host/core/arch-state';
import { reducer } from '../../../src/host/core/reducer';
import type { Event } from '../../../src/host/core/events';
import { NOOP_RUN_OBSERVER } from '../../../src/host/stats-service';
import type { PruningSettings } from '../../../src/shared/protocol';

const PRUNING_STORAGE_KEY = 'pruningSettings';

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

/** A valid-looking local SDK candidate (no `engines.node`, so no Node
 *  version probing needs an executor). */
function createLocalSdkDir(root: string): string {
  const sdkDir = path.join(root, 'sdk');
  fs.mkdirSync(path.join(sdkDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({ name: 'pi-coding-agent' }));
  fs.writeFileSync(path.join(sdkDir, 'dist', 'index.js'), 'export {};\n');
  return sdkDir;
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

test('selectRuntimeSetting preserves the exact pie → piAssistant trimmed fallback', () => {
  assert.equal(selectRuntimeSetting(' /sdk ', '/legacy/sdk'), '/sdk');
  assert.equal(selectRuntimeSetting(undefined, '/legacy/sdk'), '/legacy/sdk');
  // A blank pie value defers to the legacy root setting, matching the
  // historical `pie.value?.trim() || piAssistant.value?.trim()` chain.
  assert.equal(selectRuntimeSetting('   ', ' /legacy/sdk '), '/legacy/sdk');
  assert.equal(selectRuntimeSetting('   ', '   '), undefined);
  assert.equal(selectRuntimeSetting(undefined, undefined), undefined);
});

test('startSessionBackend resolves runtime paths through the platform adapter and attaches events before spawn', async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pie-startup-')));
  const sdkDir = createLocalSdkDir(tempRoot);
  const nodePath = path.join(tempRoot, 'fake-node');
  fs.writeFileSync(nodePath, '#!/bin/sh\n');

  const fixture = createPlatformFixture();
  fixture.pieSettings.set('sdkPath', sdkDir);
  fixture.pieSettings.set('nodePath', nodePath);
  fixture.storage.update('openTabPaths', ['/test-workspace/session-a.jsonl']);
  fixture.storage.update('activeSessionPath', '/test-workspace/session-a.jsonl');

  const { dispatched, dispatchArch, getArchState } = makeDispatch(createInitialArchState());
  const scheduleRender = (): void => undefined;
  const calls: string[] = [];
  let startArgs: {
    nodePath: string;
    sdkPath: string;
    backendPath: string;
    cwd: string;
  } | undefined;
  const backend = {
    onEvent: () => { calls.push('event-attached'); return { dispose: () => undefined }; },
    onExit: () => { calls.push('exit-attached'); return { dispose: () => undefined }; },
    request: async () => ({}),
    start: async (args: NonNullable<typeof startArgs>) => {
      calls.push('backend.start');
      startArgs = args;
    },
    stop: async () => undefined,
    getGeneration: () => 1,
  } as unknown as BackendClient;
  const events = {
    attach: () => { calls.push('events.attach'); },
    detach: () => { calls.push('events.detach'); },
  } as never;
  const service = new SessionService(
    fixture.platform,
    backend,
    scheduleRender,
    () => undefined,
    dispatchArch,
    getArchState,
  );
  const openedSessionPaths: string[] = [];

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
      openSession: (sessionPath) => { openedSessionPaths.push(sessionPath); },
      getArchState,
      dispatchArch,
    });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousInTreeAuth === undefined) delete process.env.PIE_ALLOW_IN_TREE_AUTH;
    else process.env.PIE_ALLOW_IN_TREE_AUTH = previousInTreeAuth;
  }

  assert.ok(
    calls.indexOf('events.attach') < calls.indexOf('backend.start'),
    'backend event handlers must attach before the spawn request',
  );
  assert.ok(startArgs, 'backend.start must be reached with a resolvable runtime');
  assert.equal(startArgs.cwd, '/test-workspace');
  assert.equal(startArgs.sdkPath, sdkDir);
  assert.equal(startArgs.nodePath, nodePath);
  assert.equal(startArgs.backendPath, path.join('/test-out', 'backend.js'));

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
  // The configured paths are re-discovered cheaply every start; the storage
  // cache must stay untouched for the local candidate.
  assert.equal(fixture.storage.get('resolvedSdkPath'), undefined);
});

test('startSessionBackend reports BackendReadyChanged{ready:false} and detaches when the backend fails to start', async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pie-startup-')));
  const sdkDir = createLocalSdkDir(tempRoot);
  const nodePath = path.join(tempRoot, 'fake-node');
  fs.writeFileSync(nodePath, '#!/bin/sh\n');

  const fixture = createPlatformFixture();
  fixture.pieSettings.set('sdkPath', sdkDir);
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
  }

  assert.ok(dispatched.some((event) => event.kind === 'BackendReadyChanged' && event.ready === false));
  assert.ok(dispatched.some((event) => event.kind === 'NoticeShown' && (event.notice ?? '').includes('spawn refused')));
});

test('startSessionBackend defers blank pie settings to the legacy piAssistant root settings', async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pie-startup-')));
  const sdkDir = createLocalSdkDir(tempRoot);
  const nodePath = path.join(tempRoot, 'fake-node');
  fs.writeFileSync(nodePath, '#!/bin/sh\n');

  const fixture = createPlatformFixture();
  // Blank pie values (whitespace-only) must defer to the legacy fallback.
  fixture.pieSettings.set('sdkPath', '   ');
  fixture.pieSettings.set('nodePath', '   ');
  fixture.legacySettings.set('piAssistant.sdkPath', sdkDir);
  fixture.legacySettings.set('piAssistant.nodePath', nodePath);

  const { dispatchArch, getArchState } = makeDispatch(createInitialArchState());
  const scheduleRender = (): void => undefined;
  let startArgs: { nodePath: string; sdkPath: string } | undefined;
  const backend = {
    onEvent: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
    request: async () => ({}),
    start: async (args: NonNullable<typeof startArgs>) => { startArgs = args; },
    stop: async () => undefined,
    getGeneration: () => 1,
  } as unknown as BackendClient;

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
  }

  assert.ok(startArgs, 'backend.start must be reached through the legacy fallback');
  assert.equal(startArgs.sdkPath, sdkDir);
  assert.equal(startArgs.nodePath, nodePath);
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