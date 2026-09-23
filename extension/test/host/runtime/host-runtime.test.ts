/**
 * HostRuntime extraction tests: the shared platform-neutral host composition
 * (`host/runtime/host-runtime.ts`) must be constructible and usable from
 * plain-object platform adapters (no `vscode`), must keep the CQRS spine,
 * analytics authority, and lifecycle ordering in exactly one authority, and
 * the VS Code extension class (`extension-host.ts`) must be a thin adapter
 * that owns only the status bar, commands, and sidebar provider.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { readFile } from 'node:fs/promises';

import { BackendClient } from '../../../src/host/backend/client';
import { HostRuntime } from '../../../src/host/runtime/host-runtime';
import type {
  HostRuntimePlatform,
  HostRendererSurface,
} from '../../../src/host/runtime/platform';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../../../src/shared/protocol';
import { selectRuntimeSetting } from '../../../src/host/session-service/platform';
import type { FileDiffCoreLike } from '../../../src/host/core/file-diff-service';

// ─── Stubs ───────────────────────────────────────────────────────────────────

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

interface StubRecorder {
  rendererPostState: number;
  rendererScheduleState: number;
  notifications: string[];
  editorCalls: string[];
  attentionRequests: number;
  statuses: string[];
  browserLanSetting: boolean;
  browserLanPersistenceError: boolean;
  browserEnabledSetting: boolean;
  browserEnabledPersistenceError: boolean;
}

function createPlatformFixture(options: {
  extensionPath?: string;
  browserServerEnabled?: boolean;
  browserServerPort?: number;
} = {}): { platform: HostRuntimePlatform; recorder: StubRecorder } {
  const recorder: StubRecorder = {
    rendererPostState: 0,
    rendererScheduleState: 0,
    notifications: [],
    editorCalls: [],
    attentionRequests: 0,
    statuses: [],
    browserLanSetting: false,
    browserLanPersistenceError: false,
    browserEnabledSetting: options.browserServerEnabled ?? false,
    browserEnabledPersistenceError: false,
  };
  const renderer: HostRendererSurface = {
    postState: () => { recorder.rendererPostState++; },
    postImperative: (_message: HostToWebviewMessage) => undefined,
    postImperativeToRenderer: (_rendererId: string, _message: HostToWebviewMessage) => undefined,
    scheduleState: () => { recorder.rendererScheduleState++; },
    reveal: () => undefined,
    getHostInstanceId: () => 'test-host-instance',
    getViewGeneration: () => 0,
    isRendererOwnerCurrent: () => false,
  };
  const platform: HostRuntimePlatform = {
    storage: makeStore(),
    extensionPath: options.extensionPath ?? '/test-extension',
    getRuntimeOutputDirectory: () => '/test-out',
    getWorkspaceCwd: () => '/test-workspace',
    getWorkspaceFolderPath: () => '/test-workspace',
    getSetting: <T>(name: string, fallbackName?: string): T | undefined => {
      void name;
      void fallbackName;
      return undefined;
    },
    requestWindowAttention: () => { recorder.attentionRequests++; },
    renderer,
    notifications: {
      showWarningMessage: (message) => { recorder.notifications.push(`warn:${message}`); },
      showInformationMessage: (message) => { recorder.notifications.push(`info:${message}`); },
      showErrorMessage: (message) => { recorder.notifications.push(`error:${message}`); },
      showModalConfirm: () => Promise.resolve(undefined),
      isWindowFocused: () => false,
    },
    editor: {
      openFilePicker: async () => undefined,
      openSettings: async () => { recorder.editorCalls.push('openSettings'); },
      openFileInEditor: async (filePath) => { recorder.editorCalls.push(`open:${filePath}`); },
    },
    getWorkspaceAnalyticsId: () => 'test-workspace',
    getLegacyWorkspaceAnalyticsIds: () => ['test-workspace'],
    getRuntimeIdentity: () => undefined,
    legacyUsageDataRootPath: '/test-global-storage',
    getBrowserServerSettings: () => ({
      enabled: recorder.browserEnabledSetting,
      port: options.browserServerPort ?? 1997,
      requirePreferredPort: false,
      allowLan: recorder.browserLanSetting,
    }),
    setBrowserServerLanEnabled: async (enabled) => {
      if (recorder.browserLanPersistenceError) throw new Error('fixture persistence failure');
      recorder.browserLanSetting = enabled;
    },
    setBrowserServerEnabled: async (enabled) => {
      if (recorder.browserEnabledPersistenceError) throw new Error('fixture persistence failure');
      recorder.browserEnabledSetting = enabled;
    },
    supportsBrowserServerToggle: true,
    getRendererSelection: () => ({
      fallbackDir: path.join(options.extensionPath ?? '/test-extension', 'out', 'webview', 'panel'),
      notBefore: 0,
    }),
    getWorkspaceName: () => 'test-workspace-name',
    getExperimentAssignment: () => null,
    reloadWindow: () => undefined,
    createFileDiffViewer: (service: FileDiffCoreLike) => ({
      openFileDiff: async (sessionPath: string, filePath: string) => {
        void service;
        void sessionPath;
        void filePath;
      },
      openFileInEditor: async (sessionPath: string, filePath: string) => {
        void sessionPath;
        void filePath;
      },
    }),
  };
  return { platform, recorder };
}

/** Isolate the runtime's durable state under a fresh OS temp data root so the
 *  activation manifest reads legacy authority without touching real data. */
function useTempDataRoot(): string {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-host-runtime-'));
  process.env.PIE_DATA_DIR = dataRoot;
  return dataRoot;
}

// ─── Composition + lifecycle behavior against plain-object adapters ─────────

test('HostRuntime composes and projects ViewState from plain platform adapters (no vscode)', async () => {
  const dataRoot = useTempDataRoot();
  try {
    const { platform, recorder } = createPlatformFixture();
    const runtime = new HostRuntime(platform, new BackendClient());

    // Composition exposes the runtime API a Node adapter needs.
    assert.equal(typeof runtime.buildViewState(), 'object');
    assert.equal(runtime.getRunningSessionCount(), 0);

    // The renderer seam is wired: a renderer snapshot request routes through
    // the message router and posts state on the adapter surface.
    await runtime.handleWebviewMessage({ type: 'requestSnapshot' } as WebviewToHostMessage);
    assert.ok(recorder.rendererPostState >= 1, 'renderer postState must be called for requestSnapshot');

    // Lifecycle is awaitable and idempotent without a started backend.
    await runtime.shutdown();
    await runtime.shutdown();

    void dataRoot;
  } finally {
    delete process.env.PIE_DATA_DIR;
  }
});

test('HostRuntime persists LAN intent and projects it separately from actual server state', async () => {
  const dataRoot = useTempDataRoot();
  try {
    const { platform, recorder } = createPlatformFixture();
    const runtime = new HostRuntime(platform, new BackendClient());
    await runtime.handleWebviewMessage({ type: 'setBrowserServerLanEnabled', enabled: true } as WebviewToHostMessage);

    const state = runtime.buildViewState().browserServer;
    assert.equal(recorder.browserLanSetting, true, 'the host persistence seam receives the requested preference');
    assert.equal(state?.configuredLanEnabled, true, 'the persisted intent appears in renderer state');
    assert.equal(state?.lanEnabled, false, 'the stopped server is not reported as exposing LAN access');
    assert.equal(state?.running, false);
    assert.equal(state?.changePending, false);
    assert.equal(state?.changeError, null);
    await runtime.shutdown();
  } finally {
    delete process.env.PIE_DATA_DIR;
  }
});

test('HostRuntime rebinds the shared server when LAN exposure changes', async () => {
  const dataRoot = useTempDataRoot();
  const extensionPath = path.join(dataRoot, 'extension');
  const panelDir = path.join(extensionPath, 'out', 'webview', 'panel');
  fs.mkdirSync(path.join(panelDir, '.vite'), { recursive: true });
  fs.mkdirSync(path.join(panelDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(panelDir, 'assets', 'panel-abc123.js'), 'console.log("pie");');
  fs.writeFileSync(path.join(panelDir, '.vite', 'manifest.json'), JSON.stringify({
    'index.html': { file: 'assets/panel-abc123.js', isEntry: true },
  }));
  let runtime: HostRuntime | undefined;
  try {
    const { platform } = createPlatformFixture({
      extensionPath,
      browserServerEnabled: true,
      browserServerPort: 0,
    });
    runtime = new HostRuntime(platform, new BackendClient());
    assert.equal((await runtime.browserServer.start()).kind, 'started');
    assert.equal(runtime.browserServer.getState().bindAddress, '127.0.0.1');

    await runtime.handleWebviewMessage({ type: 'setBrowserServerLanEnabled', enabled: true } as WebviewToHostMessage);
    let state = runtime.buildViewState().browserServer;
    assert.equal(state?.running, true);
    assert.equal(state?.configuredLanEnabled, true);
    assert.equal(state?.lanEnabled, true, 'the actual listener is rebound with LAN enabled');
    assert.equal(runtime.browserServer.getState().bindAddress, '0.0.0.0');
    assert.equal(state?.changeError, null);

    await runtime.handleWebviewMessage({ type: 'setBrowserServerLanEnabled', enabled: false } as WebviewToHostMessage);
    state = runtime.buildViewState().browserServer;
    assert.equal(state?.running, true);
    assert.equal(state?.configuredLanEnabled, false);
    assert.equal(state?.lanEnabled, false);
    assert.deepEqual(state?.lanUrls, []);
    assert.equal(runtime.browserServer.getState().bindAddress, '127.0.0.1');
  } finally {
    await runtime?.shutdown();
    delete process.env.PIE_DATA_DIR;
  }
});

test('HostRuntime reports LAN preference persistence failures without claiming an apply', async () => {
  const dataRoot = useTempDataRoot();
  try {
    const { platform, recorder } = createPlatformFixture();
    recorder.browserLanPersistenceError = true;
    const runtime = new HostRuntime(platform, new BackendClient());
    await runtime.handleWebviewMessage({ type: 'setBrowserServerLanEnabled', enabled: true } as WebviewToHostMessage);

    const state = runtime.buildViewState().browserServer;
    assert.equal(recorder.browserLanSetting, false);
    assert.equal(state?.configuredLanEnabled, false);
    assert.equal(state?.lanEnabled, false);
    assert.equal(state?.changePending, false);
    assert.match(state?.changeError ?? '', /Could not apply the network setting/);
    await runtime.shutdown();
  } finally {
    delete process.env.PIE_DATA_DIR;
  }
});

test('HostRuntime persists the enabled preference and starts/stops the shared listener', async () => {
  const dataRoot = useTempDataRoot();
  const extensionPath = path.join(dataRoot, 'extension');
  const panelDir = path.join(extensionPath, 'out', 'webview', 'panel');
  fs.mkdirSync(path.join(panelDir, '.vite'), { recursive: true });
  fs.mkdirSync(path.join(panelDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(panelDir, 'assets', 'panel-abc123.js'), 'console.log("pie");');
  fs.writeFileSync(path.join(panelDir, '.vite', 'manifest.json'), JSON.stringify({
    'index.html': { file: 'assets/panel-abc123.js', isEntry: true },
  }));
  let runtime: HostRuntime | undefined;
  try {
    const { platform, recorder } = createPlatformFixture({
      extensionPath,
      browserServerEnabled: false,
      browserServerPort: 0,
    });
    runtime = new HostRuntime(platform, new BackendClient());

    await runtime.handleWebviewMessage({ type: 'setBrowserServerEnabled', enabled: true } as WebviewToHostMessage);
    assert.equal(recorder.browserEnabledSetting, true, 'the global preference is persisted');
    let state = runtime.buildViewState().browserServer;
    assert.equal(state?.configuredEnabled, true);
    assert.equal(state?.serverToggleAvailable, true, 'the VS Code fixture exposes the listener switch');
    assert.equal(state?.running, true, 'the listener starts when enabled');
    assert.ok(state?.localUrl, 'the actual localhost URL is projected');
    assert.equal(state?.pendingEnabled, null);
    assert.equal(state?.changeError, null);

    await runtime.handleWebviewMessage({ type: 'setBrowserServerEnabled', enabled: false } as WebviewToHostMessage);
    assert.equal(recorder.browserEnabledSetting, false);
    state = runtime.buildViewState().browserServer;
    assert.equal(state?.configuredEnabled, false);
    assert.equal(state?.running, false, 'the listener stops when disabled');
    assert.equal(state?.localUrl, null);
    assert.equal(state?.changeError, null);
  } finally {
    await runtime?.shutdown();
    delete process.env.PIE_DATA_DIR;
  }
});

test('HostRuntime reports enabled persistence failures without claiming a start', async () => {
  const dataRoot = useTempDataRoot();
  try {
    const { platform, recorder } = createPlatformFixture({ browserServerEnabled: false });
    recorder.browserEnabledPersistenceError = true;
    const runtime = new HostRuntime(platform, new BackendClient());
    await runtime.handleWebviewMessage({ type: 'setBrowserServerEnabled', enabled: true } as WebviewToHostMessage);

    const state = runtime.buildViewState().browserServer;
    assert.equal(recorder.browserEnabledSetting, false);
    assert.equal(state?.configuredEnabled, false);
    assert.equal(state?.running, false);
    assert.equal(state?.pendingEnabled, null);
    assert.equal(state?.changePending, false);
    assert.match(state?.changeError ?? '', /Could not apply the browser server setting/);
    await runtime.shutdown();
  } finally {
    delete process.env.PIE_DATA_DIR;
  }
});

test('HostRuntime reports a failed listener bind as an error while the preference stays enabled', async () => {
  const dataRoot = useTempDataRoot();
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const occupiedPort = (blocker.address() as net.AddressInfo).port;
  try {
    const { platform } = createPlatformFixture({ browserServerEnabled: false });
    let persistedEnabled = false;
    platform.getBrowserServerSettings = () => ({
      enabled: persistedEnabled,
      port: occupiedPort,
      requirePreferredPort: true,
      allowLan: false,
    });
    platform.setBrowserServerEnabled = async (enabled) => { persistedEnabled = enabled; };
    const runtime = new HostRuntime(platform, new BackendClient());
    await runtime.handleWebviewMessage({ type: 'setBrowserServerEnabled', enabled: true } as WebviewToHostMessage);

    const state = runtime.buildViewState().browserServer;
    assert.equal(state?.running, false, 'a failed bind never claims a running listener');
    assert.equal(state?.changePending, false);
    assert.match(state?.changeError ?? '', /Could not apply the browser server setting/);
    await runtime.shutdown();
  } finally {
    blocker.close();
    delete process.env.PIE_DATA_DIR;
  }
});

test('HostRuntime keeps the LAN toggle preference-only while the listener is disabled', async () => {
  const dataRoot = useTempDataRoot();
  try {
    const { platform, recorder } = createPlatformFixture({ browserServerEnabled: false });
    const runtime = new HostRuntime(platform, new BackendClient());
    await runtime.handleWebviewMessage({ type: 'setBrowserServerLanEnabled', enabled: true } as WebviewToHostMessage);

    const state = runtime.buildViewState().browserServer;
    assert.equal(recorder.browserLanSetting, true, 'the LAN preference is saved');
    assert.equal(state?.configuredLanEnabled, true);
    assert.equal(state?.running, false, 'a disabled listener must not be started implicitly by the LAN toggle');
    assert.equal(state?.lanEnabled, false);
    assert.equal(state?.changeError, null);
    await runtime.shutdown();
  } finally {
    delete process.env.PIE_DATA_DIR;
  }
});

test('HostRuntime omits the listener switch for compositions without an independent renderer surface', async () => {
  const dataRoot = useTempDataRoot();
  try {
    const { platform } = createPlatformFixture({ browserServerEnabled: true });
    // Standalone-like composition: no independent sidebar surface, no
    // start/stop seam. The capability must be absent and the command must
    // fail closed instead of stopping the sole UI.
    delete (platform as { supportsBrowserServerToggle?: boolean }).supportsBrowserServerToggle;
    delete (platform as Partial<HostRuntimePlatform>).setBrowserServerEnabled;
    const runtime = new HostRuntime(platform, new BackendClient());

    const state = runtime.buildViewState().browserServer;
    assert.equal(state?.serverToggleAvailable, false, 'standalone never offers stopping the sole UI');

    await runtime.handleWebviewMessage({ type: 'setBrowserServerEnabled', enabled: false } as WebviewToHostMessage);
    const after = runtime.buildViewState().browserServer;
    assert.equal(after?.running, false);
    assert.match(after?.changeError ?? '', /Could not apply the browser server setting/);
    await runtime.shutdown();
  } finally {
    delete process.env.PIE_DATA_DIR;
  }
});

test('HostRuntime keeps legacy analytics authority with a fresh data root: canonical activity is omitted', async () => {
  const dataRoot = useTempDataRoot();
  try {
    // No activation manifest exists under the fresh temp root, so the
    // validated-manifest authority switch selects legacy: no canonical
    // helper started and the optional canonical projections are omitted.
    assert.equal(fs.existsSync(path.join(dataRoot, 'analytics', 'analytics.sqlite')), false,
      'legacy authority must not start the canonical store');
    const { platform } = createPlatformFixture();
    const runtime = new HostRuntime(platform, new BackendClient());
    const viewState = runtime.buildViewState() as unknown as Record<string, unknown>;
    assert.equal('canonicalActivityGlobal' in viewState, false,
      'canonical activity/facet exposure must be omitted under legacy authority');
    await runtime.shutdown();
  } finally {
    delete process.env.PIE_DATA_DIR;
  }
});

// ─── Boundary guards (one composition, one host implementation) ──────────────

test('host runtime modules must not import vscode or VS Code-only adapters', async () => {
  const runtimeSource = await readFile(new URL('../../../src/host/runtime/host-runtime.ts', import.meta.url), 'utf8');
  const platformSource = await readFile(new URL('../../../src/host/runtime/platform.ts', import.meta.url), 'utf8');
  for (const [name, source] of [['host-runtime.ts', runtimeSource], ['platform.ts', platformSource]] as const) {
    const imports = Array.from(source.matchAll(/from\s+['"]([^'"]+)['"]/g)).map((m) => m[1]);
    for (const imp of imports) {
      assert.ok(imp !== 'vscode' && !imp.includes('vscode'),
        `${name}: shared host runtime must not import vscode (found "${imp}")`);
      assert.ok(!imp.includes('sidebar/provider') && !imp.includes('vscode/') && !imp.includes('extension-host'),
        `${name}: shared host runtime must not import VS Code-only adapters (found "${imp}")`);
    }
  }
});

test('composition stays in HostRuntime; PieExtension stays a thin VS Code adapter', async () => {
  const adapterSource = await readFile(new URL('../../../src/host/extension-host.ts', import.meta.url), 'utf8');
  const runtimeSource = await readFile(new URL('../../../src/host/runtime/host-runtime.ts', import.meta.url), 'utf8');

  // One composition authority: these constructions belong to the shared
  // runtime, not to the VS Code adapter.
  for (const symbol of ['new AnalyticsRuntime', 'new BrowserServer', 'new EffectRunner', 'new SessionService', 'new MessageRouter', 'new StatsService', 'new CanonicalAnalyticsReadModel']) {
    assert.ok(!adapterSource.includes(symbol), `PieExtension must not compose ${symbol}`);
    assert.ok(runtimeSource.includes(symbol), `HostRuntime must compose ${symbol}`);
  }
  assert.ok(!adapterSource.includes('dispatch(this.archState'),
    'the reducer dispatch point must live in the shared runtime, not the adapter');
  assert.ok(runtimeSource.includes('dispatch(this.archState, event)'),
    'HostRuntime must own the single reducer dispatch point');

  // The adapter still owns the VS Code shell surfaces.
  for (const expected of ["'pie.openChat'", "'pie.newSession'", "'pie.restartBackend'", "'pie.dumpDebugState'", 'createStatusBarItem', 'registerWebviewViewProvider']) {
    assert.ok(adapterSource.includes(expected), `PieExtension must keep the VS Code shell surface: ${expected}`);
  }
});

test('selectRuntimeSetting fallback contract is shared by adapters (single authority)', () => {
  assert.equal(selectRuntimeSetting('pie-value', 'legacy-value'), 'pie-value');
  assert.equal(selectRuntimeSetting('   ', 'legacy-value'), 'legacy-value');
  assert.equal(selectRuntimeSetting(undefined, 'legacy-value'), 'legacy-value');
  assert.equal(selectRuntimeSetting(undefined, undefined), undefined);
});