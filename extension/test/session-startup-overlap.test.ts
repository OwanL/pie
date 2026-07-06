import test from 'node:test';
import assert from 'node:assert/strict';

// Must stub `vscode` BEFORE importing startup.ts (which imports `vscode`).
import './helpers/vscode-stub';
import { spawnProxyAndBackendConcurrently } from '../src/host/session-service/startup';
import { setBootTraceEnabled, setLogLevel, getLogLevel } from '../src/host/util/pie-logger';
import type { ProxyService } from '../src/host/backend/proxy-service';
import type { BackendClient } from '../src/host/backend/client';

/** Derive the private `StartSessionBackendOptions` type from the exported helper
 *  so the test can build a fake options bag without the interface being
 *  exported. Only the fields the helper actually touches need real fakes; the
 *  rest are no-ops. */
type StartOpts = Parameters<typeof spawnProxyAndBackendConcurrently>[0];
type ProxyStartOptions = NonNullable<Parameters<typeof spawnProxyAndBackendConcurrently>[1]>;
type BackendArgs = Parameters<typeof spawnProxyAndBackendConcurrently>[2];

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const PROXY_START: ProxyStartOptions = { proxyDir: '/p', configPath: '/c', port: 4000, host: '127.0.0.1' };
const BACKEND_ARGS: BackendArgs = { nodePath: '/n', sdkPath: '/s', backendPath: '/b', cwd: '/w', restoredStartupPath: null };

interface FakeProxy {
  start: (opts: ProxyStartOptions) => Promise<unknown>;
  stop?: () => Promise<void>;
}
interface FakeBackend {
  start: (opts: unknown) => Promise<unknown>;
  stop: () => Promise<void>;
}

function makeOptions(
  opts: { createProxyService: () => FakeProxy; backend: FakeBackend; dispatchArch?: (e: { kind: string; notice?: string }) => void },
): StartOpts {
  const notices: { kind: string; notice?: string }[] = [];
  const dispatch = opts.dispatchArch ?? ((e) => notices.push(e));
  void notices;
  return {
    context: { subscriptions: [] } as unknown as StartOpts['context'],
    backend: opts.backend as unknown as BackendClient,
    scheduleRender: () => undefined,
    events: { attach: () => undefined, detach: () => undefined } as unknown as StartOpts['events'],
    state: { preloadSessions: () => undefined } as unknown as StartOpts['state'],
    service: {
      setProxyRuntime: () => undefined,
      loadPruningSettings: async () => undefined,
      loadToolResultPruningSettings: async () => undefined,
    } as unknown as StartOpts['service'],
    openSession: () => undefined,
    getArchState: () => ({}) as unknown as ReturnType<StartOpts['getArchState']>,
    dispatchArch: dispatch as unknown as StartOpts['dispatchArch'],
    createProxyService: opts.createProxyService as unknown as StartOpts['createProxyService'],
  } as unknown as StartOpts;
}

test('startup: proxy spawn + backend spawn run concurrently (overlap, not serial)', async () => {
  // Deterministic concurrency proof (no wall-clock thresholds — those flake
  // under a loaded event loop). Each start() enters a barrier that resolves only
  // once BOTH start() calls have been entered, then awaits it. A serial flow
  // would deadlock: the first start() could not resolve before the second is
  // called, but the second is never called until the first resolves. A clean
  // return therefore proves the two spawns overlapped.
  let entered = 0;
  let bothEntered!: () => void;
  const bothEnteredPromise = new Promise<void>((resolve) => { bothEntered = resolve; });
  const enter = () => { entered += 1; if (entered === 2) bothEntered(); };
  const backend: FakeBackend = {
    start: async () => { enter(); await bothEnteredPromise; return {}; },
    stop: async () => undefined,
  };
  const proxy: FakeProxy = {
    start: async () => { enter(); await bothEnteredPromise; return {}; },
  };
  const options = makeOptions({
    createProxyService: () => proxy,
    backend,
  });

  const result = await spawnProxyAndBackendConcurrently(options, PROXY_START, BACKEND_ARGS);

  assert.equal(result.proxyReady, true);
  assert.equal(result.started, true);
  assert.equal(entered, 2, 'both proxy.start and backend.start must be invoked (concurrency, not serial)');
});

test('startup: useProxy off (no startOptions) → only the backend spawns, no proxy created', async () => {
  let proxyCreated = false;
  const backend: FakeBackend = {
    start: async () => { await delay(5); return {}; },
    stop: async () => undefined,
  };
  const options = makeOptions({
    createProxyService: () => { proxyCreated = true; return { start: async () => ({}) } as unknown as ProxyService; },
    backend,
  });

  const result = await spawnProxyAndBackendConcurrently(options, undefined, BACKEND_ARGS);

  assert.equal(result.proxyReady, true); // no proxy needed → treated as ready
  assert.equal(result.started, true);
  assert.equal(proxyCreated, false, 'proxy must not be created when useProxy is off');
});

test('startup: proxy fails after backend started → backend stopped to avoid a leaked process', async () => {
  // Partial-failure cleanup: the serial flow never started the backend when the
  // proxy failed. With overlap, the backend may already be up — it must be
  // stopped so it isn't left running against a not-ready proxy.
  let backendStopped = false;
  const backend: FakeBackend = {
    start: async () => { await delay(10); return {}; }, // succeeds
    stop: async () => { backendStopped = true; },
  };
  const proxy: FakeProxy = {
    start: async () => { await delay(20); throw new Error('uv not found'); }, // fails
  };
  const notices: string[] = [];
  const options = makeOptions({
    createProxyService: () => proxy,
    backend,
    dispatchArch: (e) => { if (e.kind === 'NoticeShown' && e.notice) notices.push(e.notice); },
  });

  const result = await spawnProxyAndBackendConcurrently(options, PROXY_START, BACKEND_ARGS);

  assert.equal(result.proxyReady, false);
  assert.equal(result.started, true);
  assert.equal(backendStopped, true, 'backend must be stopped when the proxy fails');
  assert.ok(notices.some((n) => /Failed to start the LiteLLM proxy/.test(n)), 'a proxy-failure notice must be surfaced');
});

test('startup: backend fails (proxy succeeded) → returns started:false; proxy owned by subscriptions is left for shutdown', async () => {
  // Mirror of the serial behavior: when the proxy succeeds but the backend
  // fails, the proxy (owned by context.subscriptions, killed on deactivate) is
  // NOT stopped inline — it is left for the extension shutdown. Only the
  // backend-wins/proxy-fails case stops the winner.
  let proxyStopped = false;
  const backend: FakeBackend = {
    start: async () => { await delay(20); throw new Error('node crashed'); }, // fails
    stop: async () => undefined,
  };
  const proxy: FakeProxy = {
    start: async () => { await delay(10); return {}; }, // succeeds
    stop: async () => { proxyStopped = true; },
  };
  const notices: string[] = [];
  const options = makeOptions({
    createProxyService: () => proxy,
    backend,
    dispatchArch: (e) => { if (e.kind === 'NoticeShown' && e.notice) notices.push(e.notice); },
  });

  const result = await spawnProxyAndBackendConcurrently(options, PROXY_START, BACKEND_ARGS);

  assert.equal(result.started, false);
  assert.equal(result.proxyReady, true);
  assert.equal(proxyStopped, false, 'proxy is owned by subscriptions; not stopped inline on backend failure');
  assert.ok(notices.some((n) => /Failed to start PI backend/.test(n)), 'a backend-failure notice must be surfaced');
});

test('startup: proxy.started and backend.started boot logs carry spawn durationMs (richness)', async () => {
  // Logging richness: each spawn→ready phase logs its wall-clock duration so a
  // slow startup (e.g. a 60s first `uv run`) is attributable to a phase from the
  // pie log alone. bootLog fires only when boot tracing is enabled.
  const originalLevel = getLogLevel();
  const originalInfo = console.info;
  const captured: unknown[][] = [];
  setBootTraceEnabled(true);
  setLogLevel('info');
  console.info = (...args: unknown[]) => captured.push(args);
  try {
    const backend: FakeBackend = {
      start: async () => { await delay(25); return {}; },
      stop: async () => undefined,
    };
    const proxy: FakeProxy = { start: async () => { await delay(25); return {}; } };
    const options = makeOptions({ createProxyService: () => proxy, backend });
    await spawnProxyAndBackendConcurrently(options, PROXY_START, BACKEND_ARGS);
  } finally {
    console.info = originalInfo;
    setBootTraceEnabled(false);
    setLogLevel(originalLevel);
  }

  // console.info receives ([pie:scope] event, dataObject) — find the rows for
  // the .started events and assert a numeric durationMs reflecting the ~25ms spawn.
  const findData = (event: string): Record<string, unknown> | undefined => {
    for (const args of captured) {
      const line = typeof args[0] === 'string' ? (args[0] as string) : '';
      if (line.includes(event)) return args[1] as Record<string, unknown> | undefined;
    }
    return undefined;
  };
  const proxyData = findData('proxy.started');
  const backendData = findData('backend.started');
  assert.ok(proxyData, 'proxy.started boot log should fire');
  assert.ok(backendData, 'backend.started boot log should fire');
  assert.equal(typeof proxyData!.durationMs, 'number');
  assert.ok((proxyData!.durationMs as number) >= 20, `proxy durationMs should reflect the ~25ms spawn (got ${proxyData!.durationMs})`);
  assert.equal(typeof backendData!.durationMs, 'number');
  assert.ok((backendData!.durationMs as number) >= 20, `backend durationMs should reflect the ~25ms spawn (got ${backendData!.durationMs})`);
});
