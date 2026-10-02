/**
 * HostRuntime extraction tests: the shared platform-neutral host composition
 * (`application/backend/composition/host-runtime.ts`) must be constructible and usable from
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

import { BackendClient } from '../../agent-connection/client';
import { BrowserServer } from '../../../hosts/browser/http/browser-server';
import { HostRuntime } from '../../composition/host-runtime.js';
import type {
  HostRuntimePlatform,
  HostRendererSurface,
} from '../../../hosts/lib/platform-contracts/platform.js';
import type { HostToWebviewMessage, RendererCommandContext, WebviewToHostMessage } from '../../../lib/protocol/index.js';
import { selectRuntimeSetting } from '../../../hosts/lib/platform-contracts/session-platform';
import type { FileDiffCoreLike } from '../../file-changes/file-diff-service';

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
  browserServerFactoryCalls: number;
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
    browserServerFactoryCalls: 0,
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
    createBrowserServer: (serverOptions) => {
      recorder.browserServerFactoryCalls += 1;
      const extensionPath = options.extensionPath ?? '/test-extension';
      return new BrowserServer({
        ...serverOptions,
        assetDir: path.join(extensionPath, 'out', 'webview', 'panel'),
        rendererSelection: {
          fallbackDir: path.join(extensionPath, 'out', 'webview', 'panel'),
          notBefore: 0,
        },
        iconPath: path.join(extensionPath, 'media', 'icon.svg'),
        titleSuffix: 'test-workspace-name',
      });
    },
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

test('HostRuntime preserves the trusted renderer context when routing webview commands', async () => {
  const dataRoot = useTempDataRoot();
  try {
    const { platform } = createPlatformFixture();
    const runtime = new HostRuntime(platform, new BackendClient());
    try {
      let receivedContext: RendererCommandContext | undefined;
      (runtime as unknown as {
        messageRouter: { handle(message: WebviewToHostMessage, context?: RendererCommandContext): Promise<void> };
      }).messageRouter = {
        handle: async (_message, context) => { receivedContext = context; },
      };

      const context: RendererCommandContext = {
        rendererId: 'sidebar-renderer',
        kind: 'vscode',
        rendererGeneration: 7,
      };
      await runtime.handleWebviewMessage({ type: 'detail.subscribe' } as WebviewToHostMessage, context);

      assert.deepEqual(receivedContext, context, 'detail routing needs the owning sidebar identity');
      void dataRoot;
    } finally {
      await runtime.shutdown();
    }
  } finally {
    delete process.env.PIE_DATA_DIR;
  }
});

test('HostRuntime composes and projects ViewState from plain platform adapters (no vscode)', async () => {
  const dataRoot = useTempDataRoot();
  try {
    const { platform, recorder } = createPlatformFixture();
    const runtime = new HostRuntime(platform, new BackendClient());

    // Composition exposes the runtime API a Node adapter needs, while the
    // injected host factory constructs the shared browser service once.
    assert.equal(recorder.browserServerFactoryCalls, 1);
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

for (const pausedPhase of ['handoff', 'analytics', 'stats', 'sessions', 'browser'] as const) {
  test(`HostRuntime shutdown drains startup paused at ${pausedPhase} before closing storage`, async () => {
    const dataRoot = useTempDataRoot();
    const { platform, recorder } = createPlatformFixture();
    const runtime = new HostRuntime(platform, new BackendClient());
    const internals = runtime as unknown as {
      analyticsHandoffControl: { start: () => Promise<void> };
      analyticsRuntime: { start: () => Promise<unknown> };
      analyticsHandoffRegistry: { close: () => void };
    };
    const calls: string[] = [];
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    const phase = async (name: string): Promise<void> => {
      calls.push(name);
      if (name === pausedPhase) {
        reached();
        await gate;
      }
    };
    internals.analyticsHandoffControl.start = () => phase('handoff');
    internals.analyticsRuntime.start = () => phase('analytics');
    runtime.statsService.start = () => phase('stats');
    runtime.service.start = () => phase('sessions');
    runtime.browserServer.start = async () => {
      await phase('browser');
      return { kind: 'disabled' };
    };
    const close = internals.analyticsHandoffRegistry.close.bind(internals.analyticsHandoffRegistry);
    let storageClosed = false;
    internals.analyticsHandoffRegistry.close = () => {
      storageClosed = true;
      close();
    };
    let startup: Promise<void> | undefined;
    let shutdown: Promise<void> | undefined;
    try {
      startup = runtime.start();
      await paused;
      shutdown = runtime.shutdown();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(storageClosed, false, 'startup may still release a writer admission');
      release();
      await Promise.all([startup, shutdown]);
      assert.equal(storageClosed, true);
      const phases = ['handoff', 'analytics', 'stats', 'sessions', 'browser'];
      assert.deepEqual(calls, phases.slice(0, phases.indexOf(pausedPhase) + 1),
        'shutdown must fence every subsequent startup phase');
      assert.deepEqual(recorder.notifications, [], 'normal shutdown is not an analytics outage');
      await assert.rejects(() => runtime.start(), /shut.*down/iu);
    } finally {
      release();
      await Promise.allSettled([startup, shutdown].filter((pending): pending is Promise<void> => !!pending));
      await runtime.shutdown();
      delete process.env.PIE_DATA_DIR;
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });
}

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
  const runtimeSource = await readFile(new URL('../../composition/host-runtime.ts', import.meta.url), 'utf8');
  const platformSource = await readFile(new URL('../../../hosts/lib/platform-contracts/platform.ts', import.meta.url), 'utf8');
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

test('browser-server seam is owned by the host-neutral runtime; no concrete implementation imports (including type-only)', async () => {
  const runtimeSource = await readFile(new URL('../../composition/host-runtime.ts', import.meta.url), 'utf8');
  const platformSource = await readFile(new URL('../../../hosts/lib/platform-contracts/platform.ts', import.meta.url), 'utf8');
  const seamSource = await readFile(new URL('../../../hosts/lib/platform-contracts/browser-server-seam.ts', import.meta.url), 'utf8');
  const browserServerSource = await readFile(new URL('../../../hosts/browser/http/browser-server.ts', import.meta.url), 'utf8');
  const typesSource = await readFile(new URL('../../../hosts/browser/types.ts', import.meta.url), 'utf8');

  // Every import specifier must avoid the concrete browser-server domain —
  // the regex matches the `from` clause of both value and `import type`
  // imports, so type-only dependencies respect ownership too. The seam module
  // itself lives in `application/hosts/lib/platform-contracts/`, so its own
  // platform-contract specifier is not a concrete-domain import.
  for (const [name, source] of [
    ['host-runtime.ts', runtimeSource],
    ['platform.ts', platformSource],
    ['browser-server-seam.ts', seamSource],
  ] as const) {
    const imports = Array.from(source.matchAll(/from\s+['"]([^'"]+)['"]/g)).map((m) => m[1]);
    for (const imp of imports) {
      assert.ok(!imp.includes('browser-server/'),
        `${name}: shared host runtime must not import the concrete browser-server implementation, even type-only (found "${imp}")`);
    }
    assert.ok(!/(^|[^A-Za-z])BrowserServerOptions/.test(source),
      `${name}: must not reference the concrete browser-server construction options`);
    assert.ok(!source.includes('new BrowserServer'),
      `${name}: the concrete hosts construct the browser service, not the shared runtime`);
  }

  // The seam is the single host-neutral contract owner: the runtime consumes
  // the lifecycle/service port, and the canonical settings/lifecycle shapes
  // are defined once (not mirrored).
  assert.ok(seamSource.includes('export interface BrowserServerService'),
    'the host-neutral seam must own the browser service lifecycle port');
  assert.ok(seamSource.includes('export interface HostRuntimeBrowserServerOptions'),
    'the host-neutral seam must own the factory options interface (not a Pick of the concrete options)');
  assert.ok(platformSource.includes('createBrowserServer(options: HostRuntimeBrowserServerOptions): BrowserServerService'),
    'the platform factory must return the host-neutral service seam');
  assert.ok(runtimeSource.includes('readonly browserServer: BrowserServerService'),
    'HostRuntime must hold the browser server through the host-neutral service seam');

  // The concrete implementation satisfies the seam; the canonical shapes are
  // re-exported from the seam, never redeclared in the browser-server module.
  assert.ok(browserServerSource.includes('export class BrowserServer implements BrowserServerService'),
    'the BrowserServer implementation must declare the host-neutral service contract');
  assert.ok(typesSource.includes("from '../lib/platform-contracts/browser-server-seam.js'"),
    'browser-server types must re-export the canonical shapes from the host-neutral seam');
  assert.ok(!typesSource.includes('export interface BrowserServerSettings')
    && !typesSource.includes('export type BrowserServerLifecycleEvent'),
    'canonical settings/lifecycle shapes must be defined once in the seam, not mirrored');
});

test('BrowserServer construction stays in concrete hosts; PieExtension stays a thin adapter', async () => {
  const adapterSource = await readFile(new URL('../../../hosts/vscode/activation/extension-host.ts', import.meta.url), 'utf8');
  const runtimeSource = await readFile(new URL('../../composition/host-runtime.ts', import.meta.url), 'utf8');
  const vscodePlatformSource = await readFile(new URL('../../../hosts/vscode/runtime/host-runtime-platform.ts', import.meta.url), 'utf8');
  const standalonePlatformSource = await readFile(new URL('../../../hosts/standalone/platform.ts', import.meta.url), 'utf8');
  const browserFactorySource = await readFile(new URL('../../../hosts/browser/http/browser-server-factory.ts', import.meta.url), 'utf8');

  // One application composition authority; only concrete hosts construct the
  // host-specific server adapter and its asset paths.
  for (const symbol of ['new AnalyticsRuntime', 'new EffectRunner', 'new SessionService', 'new MessageRouter', 'new StatsService', 'new CanonicalAnalyticsReadModel']) {
    assert.ok(!adapterSource.includes(symbol), `PieExtension must not compose ${symbol}`);
    assert.ok(runtimeSource.includes(symbol), `HostRuntime must compose ${symbol}`);
  }
  assert.ok(!runtimeSource.includes('new BrowserServer'),
    'HostRuntime must request the browser service through HostRuntimePlatform');
  assert.ok(vscodePlatformSource.includes('createBrowserServer('),
    'the VS Code platform adapter selects the browser service factory');
  assert.ok(standalonePlatformSource.includes('createBrowserServer('),
    'the standalone platform adapter selects the browser service factory');
  assert.ok(browserFactorySource.includes('new BrowserServer'),
    'the browser host factory constructs the concrete server');
  assert.ok(vscodePlatformSource.includes("assetDir: path.join(context.extensionPath, 'out', 'webview', 'panel')"),
    'VS Code asset paths stay in its concrete adapter');
  assert.ok(standalonePlatformSource.includes("assetDir: path.join(options.runtimeOutputDirectory, 'webview', 'panel')"),
    'standalone asset paths stay in its concrete adapter (runtime output directory)');
  assert.ok(standalonePlatformSource.includes("fallbackDir: path.join(options.runtimeOutputDirectory, 'webview', 'panel')"),
    'standalone renderer asset selection stays in its concrete adapter (runtime output directory)');
  assert.ok(standalonePlatformSource.includes("iconPath: path.join(options.extensionPath, 'media', 'icon.svg')"),
    'the standalone adapter keeps its host-owned icon path on the extension path');
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