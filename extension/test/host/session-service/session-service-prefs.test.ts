/**
 * Regression tests for SessionService preference handling.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { EventEmitter } from 'node:events';

import { createInitialArchState } from '../../../src/host/core/arch-state';
import type { ArchState } from '../../../src/host/core/arch-state';
import type { Event } from '../../../src/host/core/events';
import { NOOP_RUN_OBSERVER } from '../../../src/host/stats-service';
import type { SessionService as SessionServiceType } from '../../../src/host/session-service/service';
import type { BackendClient as BackendClientType } from '../../../src/host/backend/client';

function installVscodeMock() {
  const moduleWithLoad = Module as typeof Module & { _load: (...args: any[]) => unknown };
  const originalLoad = moduleWithLoad._load;

  class VSCodeEventEmitter<TValue> {
    private readonly emitter = new EventEmitter();

    readonly event = (listener: (value: TValue) => void) => {
      this.emitter.on('event', listener);
      return { dispose: () => this.emitter.off('event', listener) };
    };

    fire(value: TValue): void {
      this.emitter.emit('event', value);
    }

    dispose(): void {
      this.emitter.removeAllListeners();
    }
  }

  moduleWithLoad._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'vscode') {
      return {
        version: '1.102.3-test',
        EventEmitter: VSCodeEventEmitter,
        Uri: { file: (fsPath: string) => ({ fsPath }) },
        window: {
          showWarningMessage: async () => undefined,
          showInformationMessage: async () => undefined,
          showErrorMessage: async () => undefined,
        },
        workspace: {
          workspaceFolders: undefined,
          name: 'test-workspace',
          getConfiguration: () => ({
            get: () => undefined,
          }),
        },
        commands: { executeCommand: async () => undefined },
        env: { appName: 'test-app' },
        Disposable: class { dispose() {} },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  return () => {
    moduleWithLoad._load = originalLoad;
  };
}

let SessionServiceCtor: typeof SessionServiceType;
let BackendClientCtor: typeof BackendClientType;

let uninstallVscodeMock: (() => void) | undefined;

test.before(async () => {
  uninstallVscodeMock = installVscodeMock();
  const [{ SessionService }, { BackendClient }] = await Promise.all([
    import('../../../src/host/session-service/service'),
    import('../../../src/host/backend/client'),
  ]);
  SessionServiceCtor = SessionService;
  BackendClientCtor = BackendClient;
});

function createExtensionContext() {
  return {
    globalState: {
      values: new Map<string, unknown>(),
      async update(key: string, value: unknown) {
        if (value === undefined) {
          this.values.delete(key);
        } else {
          this.values.set(key, value);
        }
      },
      get<T>(key: string): T | undefined {
        return this.values.get(key) as T | undefined;
      },
    },
    workspaceState: {
      async update() { /* no-op */ },
    },
  } as any;
}

function makeHarness() {
  const context = createExtensionContext();
  const backend = new BackendClientCtor();
  const dispatched: Event[] = [];
  const archState: ArchState = createInitialArchState();

  const getArchState = () => archState;
  const dispatchArch = (event: Event) => {
    dispatched.push(event);
  };

  const service = new SessionServiceCtor(
    context,
    backend,
    () => { /* scheduleRender */ },
    () => { /* postImperative */ },
    dispatchArch,
    getArchState,
    undefined,
    NOOP_RUN_OBSERVER,
  );

  return { context, backend, service, dispatched, getArchState };
}

test('setPrefs persists prefs without dispatching a recursive SetPrefs command', async () => {
  const { service, dispatched, context } = makeHarness();

  await service.setPrefs({ autoExpandReasoning: true, composerInitialRows: 4 });

  const setPrefsCommands = dispatched.filter(
    (e) => e.kind === 'Command' && e.cmd.kind === 'SetPrefs',
  );

  assert.equal(
    setPrefsCommands.length,
    0,
    'SessionService.setPrefs must not dispatch a SetPrefs command (would recurse through EffectRunner)',
  );

  const persisted = context.globalState.get('chatPrefs');
  assert.equal(persisted?.autoExpandReasoning, true);
  assert.equal(persisted?.composerInitialRows, 4);
});

test('setPrefs no longer dispatches UnreadFinishedSessionsChanged (reducer owns the clear)', async () => {
  const { service, dispatched, context } = makeHarness();

  await service.setPrefs({ suppressCompletionNotifications: true });

  // Phase 2 cutover: the unread-finished-sessions clear moved from this effect
  // handler into the reducer's SetPrefs Command handler, so service.setPrefs
  // must NOT dispatch UnreadFinishedSessionsChanged.
  const unreadEvent = dispatched.find(
    (e) => e.kind === 'UnreadFinishedSessionsChanged',
  );
  assert.equal(unreadEvent, undefined, 'service.setPrefs must not clear unread sessions (reducer owns it now)');

  const persisted = context.globalState.get('chatPrefs');
  assert.equal(persisted?.suppressCompletionNotifications, true);
});

test('setPrefs notifies the backend of toggle changes', async () => {
  const { service, backend, getArchState } = makeHarness();
  getArchState().settings.backendReady = true;

  const requests: { method: string; params: unknown }[] = [];
  backend.request = async <TResult = unknown>(method: string, params?: unknown): Promise<TResult> => {
    requests.push({ method, params });
    return {} as TResult;
  };

  await service.setPrefs({
    providerToggles: { 'github-copilot': false },
    extensionToggles: { 'some-extension': true },
    autonomousMode: true,
  });

  const runtimePrefsSet = requests.find((r) => r.method === 'runtimePrefs.set');
  assert.ok(runtimePrefsSet, 'expected runtimePrefs.set request');
  assert.deepEqual((runtimePrefsSet.params as any).providerToggles, { 'github-copilot': false });
  assert.deepEqual((runtimePrefsSet.params as any).extensionToggles, { 'some-extension': true });
  assert.equal((runtimePrefsSet.params as any).autonomousMode, true);
  assert.deepEqual((runtimePrefsSet.params as any).historyCompaction, getArchState().settings.prefs.historyCompaction);
});

test('setPrefs mirrors providerConcurrency and subagentDropTools to the backend (no startup-restore drift)', async () => {
  // Regression: the live setPrefs path previously hand-built its own
  // runtimePrefs.set literal and was missing `subagentDropTools`, while the
  // startup restore path was missing `providerConcurrency`. Both now share
  // buildRuntimePrefsPayload, so a change to either field must reach the backend
  // on the very first setPrefs after the user edits it (no restart needed).
  const { service, backend, getArchState } = makeHarness();
  getArchState().settings.backendReady = true;

  const requests: { method: string; params: unknown }[] = [];
  backend.request = async <TResult = unknown>(method: string, params?: unknown): Promise<TResult> => {
    requests.push({ method, params });
    return {} as TResult;
  };

  const providerConcurrency = { ollama: { maxConcurrentRequests: 7, afterburnSeconds: 12 } };
  const subagentDropTools = ['ask_user', 'web_search'];
  await service.setPrefs({
    providerConcurrency,
    subagentDropTools,
    subagentRouteAroundSaturatedProviders: true,
  });

  const runtimePrefsSet = requests.find((r) => r.method === 'runtimePrefs.set');
  assert.ok(runtimePrefsSet, 'expected runtimePrefs.set request');
  assert.deepEqual((runtimePrefsSet.params as any).providerConcurrency, providerConcurrency);
  assert.deepEqual((runtimePrefsSet.params as any).subagentDropTools, subagentDropTools);
  assert.equal((runtimePrefsSet.params as any).subagentRouteAroundSaturatedProviders, true);
});

// Restore the real module loader after all tests so later tests are unaffected.
test.after(() => {
  uninstallVscodeMock?.();
});
