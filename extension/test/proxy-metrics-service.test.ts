/**
 * Behavior test for ProxyMetricsService — the host service that polls the
 * Python proxy's /health/proxy_metrics endpoint and surfaces per-provider
 * active/queued/max concurrency to the user-facing proxy status strip.
 *
 * The existing `proxy-metrics-field-contract.test.ts` is a STATIC drift guard
 * (reads source as text, no imports). This file exercises the live class:
 *
 *   - signature() dedup: onChanged fires only on REAL metric changes, not on
 *     referentially-different but value-equal payloads (the strip must not
 *     flicker/thrash the UI every poll).
 *   - inFlight guard: overlapping ticks must not fire two HTTP fetches.
 *   - dispose(): the polling timer actually stops (no more onChanged after).
 *   - getMetrics(): returns the last known list.
 *   - Parsing/normalization of the Python JSON into ProxyProviderMetrics,
 *     including graceful handling of missing/zero fields, empty providers,
 *     and HTTP errors so the strip never shows stale/garbage.
 *
 * The service hardcodes http.get against 127.0.0.1:4000 and reads
 * vscode.workspace.getConfiguration. Both are stubbed at the CJS loader
 * (Module._load) before the module is imported, so no network / vscode runtime
 * is required. The fetch is inline + private, so we test the observable contract
 * (onChanged + getMetrics) and the pure mapping (private fetchMetrics invoked
 * directly) rather than editing source.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import Module from 'node:module';

// ─── CJS loader stubs for `vscode` and `node:http` ────────────────────────────
//
// Installed BEFORE the lazy import of ProxyMetricsService. Node runs each test
// file in its own process, so this global patch is file-scoped.

const configStore: Record<string, unknown> = {
  useProxy: true,
  proxyPort: 4000,
};

const vscodeStub = {
  workspace: {
    getConfiguration: (section: string) => ({
      get: <T>(key: string, fallback?: T): T => {
        if (section === 'pie' && configStore[key] !== undefined) {
          return configStore[key] as T;
        }
        return (fallback as T);
      },
    }),
  },
};

/** Controllable fake for node:http's `get`. Each call consumes one enqueued
 *  response (FIFO). Supports: normal JSON body, non-200 (resolve null), a
 *  connection error (req emits 'error'), and a "hang" that parks the response
 *  until releaseHang() emits data+end (used by the inFlight test). */
class HttpFake {
  calls = 0;
  lastUrl = '';
  lastHeaders: Record<string, string> = {};
  private queue: Array<{
    statusCode: number;
    body?: string;
    error?: string;
    hang?: boolean;
  }> = [];
  private hungRes?: EventEmitter;

  enqueue(statusCode: number, body = ''): this {
    this.queue.push({ statusCode, body });
    return this;
  }
  enqueueError(msg = 'ECONNREFUSED'): this {
    this.queue.push({ statusCode: 0, error: msg });
    return this;
  }
  enqueueHang(): this {
    this.queue.push({ statusCode: 200, hang: true });
    return this;
  }

  get = (url: string, opts: { headers?: Record<string, string> } | undefined, cb: (res: EventEmitter) => void): EventEmitter => {
    this.calls += 1;
    this.lastUrl = url;
    this.lastHeaders = opts?.headers ?? {};
    const res = new EventEmitter();
    (res as { resume?: () => void }).resume = () => {};
    const req = new EventEmitter();
    (req as { destroy?: () => void }).destroy = () => {};
    const next = this.queue.shift();
    setImmediate(() => {
      if (next?.error) {
        req.emit('error', new Error(next.error));
        return;
      }
      (res as unknown as { statusCode: number }).statusCode = next?.statusCode ?? 200;
      cb(res);
      if (next?.hang) {
        this.hungRes = res;
        return;
      }
      res.emit('data', Buffer.from(next?.body ?? ''));
      res.emit('end');
    });
    return req;
  };

  releaseHang(body = ''): void {
    if (!this.hungRes) throw new Error('no hung response to release');
    const res = this.hungRes;
    this.hungRes = undefined;
    res.emit('data', Buffer.from(body));
    res.emit('end');
  }

  hungResExists(): boolean {
    return this.hungRes !== undefined;
  }

  reset(): void {
    this.calls = 0;
    this.lastUrl = '';
    this.lastHeaders = {};
    this.queue = [];
    this.hungRes = undefined;
  }
}

const httpFake = new HttpFake();

type ModuleLoad = (request: string, parent: unknown, isMain: boolean) => unknown;
const ModuleInternals = Module as unknown as { _load: ModuleLoad };
const originalLoad: ModuleLoad = ModuleInternals._load.bind(ModuleInternals);

// Lazily resolved in test.before, AFTER the vscode + node:http stubs are in
// place (the module resolves both at load time). Kept at module scope so all
// tests can construct the service.
let ProxyMetricsService!: typeof import('../src/host/proxy-metrics-service').ProxyMetricsService;

type ProxyProviderMetrics = {
  provider: string;
  modelInfoId: string;
  activeRequests: number;
  queuedRequests: number;
  maxConcurrentRequests: number;
};

const MASTER_KEY = 'PIE_PROXY_MASTER_KEY';
let originalMasterKey: string | undefined;

test.before(async () => {
  originalMasterKey = process.env[MASTER_KEY];
  process.env[MASTER_KEY] = 'test-master-key';

  // Install the CJS-loader stubs, import the service (which captures the
  // stub namespaces), then restore the loader — the captured `http`/`vscode`
  // bindings keep pointing at our fakes for the rest of the file.
  ModuleInternals._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === 'vscode') return vscodeStub;
    if (request === 'node:http') return { get: httpFake.get };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    ({ ProxyMetricsService } = await import('../src/host/proxy-metrics-service'));
  } finally {
    ModuleInternals._load = originalLoad;
  }
});

test.after(() => {
  if (originalMasterKey === undefined) delete process.env[MASTER_KEY];
  else process.env[MASTER_KEY] = originalMasterKey;
});

test.beforeEach(() => {
  httpFake.reset();
  configStore.useProxy = true;
  configStore.proxyPort = 4000;
});

function metricsPayload(providers: unknown): string {
  return JSON.stringify({
    generatedAt: '2026-07-07T00:00:00+00:00',
    providers,
  });
}

const UMANS: ProxyProviderMetrics = {
  provider: 'umans',
  modelInfoId: 'umans-shared',
  activeRequests: 1,
  queuedRequests: 0,
  maxConcurrentRequests: 4,
};

// ─── signature() dedup ──────────────────────────────────────────────────────

test('onChanged fires only on real metric changes, not on value-equal payloads', async () => {
  let changed = 0;
  const service = new ProxyMetricsService({ onChanged: () => { changed += 1; } });

  // First tick: empty -> A. onChanged must fire once.
  httpFake.enqueue(200, metricsPayload([{ ...UMANS }]));
  await (service as unknown as { tick: () => Promise<void> }).tick();
  assert.equal(changed, 1, 'first tick must fire onChanged');
  assert.deepEqual(service.getMetrics(), [{ ...UMANS }]);

  // Second tick: a REFERENTIALLY-DIFFERENT but value-equal payload. signature()
  // must treat them as equal so onChanged does NOT fire and the UI does not
  // thrash on every poll.
  httpFake.enqueue(200, metricsPayload([{ ...UMANS }]));
  await (service as unknown as { tick: () => Promise<void> }).tick();
  assert.equal(changed, 1, 'value-equal payload must not fire onChanged');
  assert.deepEqual(service.getMetrics(), [{ ...UMANS }]);

  // Third tick: an actual value change (activeRequests 1 -> 2). onChanged fires.
  httpFake.enqueue(200, metricsPayload([{ ...UMANS, activeRequests: 2 }]));
  await (service as unknown as { tick: () => Promise<void> }).tick();
  assert.equal(changed, 2, 'a real change must fire onChanged');
  assert.deepEqual(service.getMetrics(), [{ ...UMANS, activeRequests: 2 }]);
});

test('signature dedup is order-sensitive to the sorted list (reorder is a change)', async () => {
  let changed = 0;
  const service = new ProxyMetricsService({ onChanged: () => { changed += 1; } });

  const a: ProxyProviderMetrics = { provider: 'alpha', modelInfoId: 'a-shared', activeRequests: 0, queuedRequests: 1, maxConcurrentRequests: 4 };
  const b: ProxyProviderMetrics = { provider: 'beta', modelInfoId: 'b-shared', activeRequests: 0, queuedRequests: 1, maxConcurrentRequests: 4 };

  // Both queued=1 -> provider-ascending sort: [alpha, beta].
  httpFake.enqueue(200, metricsPayload([b, a]));
  await (service as unknown as { tick: () => Promise<void> }).tick();
  assert.equal(changed, 1);
  assert.deepEqual(
    service.getMetrics().map((m) => m.provider),
    ['alpha', 'beta'],
    'fetchMetrics must sort by provider ascending when queued/active tie',
  );

  // Same values, same sorted order -> no change.
  httpFake.enqueue(200, metricsPayload([a, b]));
  await (service as unknown as { tick: () => Promise<void> }).tick();
  assert.equal(changed, 1, 'same sorted list must not fire onChanged');
});

// ─── inFlight guard ─────────────────────────────────────────────────────────

test('inFlight guard prevents overlapping ticks from issuing two HTTP fetches', async () => {
  let changed = 0;
  const service = new ProxyMetricsService({ onChanged: () => { changed += 1; } });

  // A hung response parks fetchMetrics so the first tick stays in flight.
  httpFake.enqueueHang();
  const tick1 = (service as unknown as { tick: () => Promise<void> }).tick();
  // Drain the immediate queue so the fake's `get` callback runs, attaches the
  // data/end listeners, and parks the hung response.
  await new Promise<void>((r) => setImmediate(() => r()));
  assert.ok(httpFake.hungResExists(), 'the hung response must be parked');

  // Second tick while the first is still in flight must short-circuit and NOT
  // issue another HTTP request.
  const tick2 = (service as unknown as { tick: () => Promise<void> }).tick();
  await tick2;
  assert.equal(httpFake.calls, 1, 'overlapping tick must not issue a second fetch');

  // Release the hung response -> first tick completes and fires onChanged once.
  httpFake.releaseHang(metricsPayload([{ ...UMANS }]));
  await tick1;
  assert.equal(changed, 1, 'first tick fires onChanged once it completes');
  assert.deepEqual(service.getMetrics(), [{ ...UMANS }]);

  // After the first completes, inFlight is cleared and a new tick proceeds.
  httpFake.enqueue(200, metricsPayload([{ ...UMANS, activeRequests: 3 }]));
  await (service as unknown as { tick: () => Promise<void> }).tick();
  assert.equal(httpFake.calls, 2, 'a tick after inFlight clears proceeds normally');
  assert.equal(changed, 2);
});

// ─── getMetrics() ────────────────────────────────────────────────────────────

test('getMetrics returns the last known list and [] before the first fetch', () => {
  const service = new ProxyMetricsService({ onChanged: () => {} });
  assert.deepEqual(service.getMetrics(), [], 'no metrics before the first successful tick');
});

test('a failed fetch replaces the strip with [] (never stale/garbage), firing onChanged once', async () => {
  let changed = 0;
  const service = new ProxyMetricsService({ onChanged: () => { changed += 1; } });

  httpFake.enqueue(200, metricsPayload([{ ...UMANS }]));
  await (service as unknown as { tick: () => Promise<void> }).tick();
  assert.equal(changed, 1);
  assert.deepEqual(service.getMetrics(), [{ ...UMANS }]);

  // A failing fetch (HTTP 500) resolves to [] in fetchMetrics. The service
  // treats this as a real change ([UMANS] -> []) and fires onChanged so the
  // user-facing strip VANISHES rather than showing stale numbers from before
  // the outage — the graceful behavior the source implements.
  httpFake.enqueue(500, '');
  await (service as unknown as { tick: () => Promise<void> }).tick();
  assert.equal(changed, 2, 'a failed fetch transitions to [] and fires onChanged');
  assert.deepEqual(service.getMetrics(), [], 'the strip is cleared on fetch failure');
});

test('a transient error then recovery restores the strip via dedup', async () => {
  let changed = 0;
  const service = new ProxyMetricsService({ onChanged: () => { changed += 1; } });

  httpFake.enqueue(200, metricsPayload([{ ...UMANS }]));
  await (service as unknown as { tick: () => Promise<void> }).tick();
  assert.equal(changed, 1);

  // Transient outage -> strip vanishes.
  httpFake.enqueue(500, '');
  await (service as unknown as { tick: () => Promise<void> }).tick();
  assert.equal(changed, 2);
  assert.deepEqual(service.getMetrics(), []);

  // Recovery: same values as before the outage. signature([]) != signature([UMANS])
  // so onChanged fires once to restore the strip.
  httpFake.enqueue(200, metricsPayload([{ ...UMANS }]));
  await (service as unknown as { tick: () => Promise<void> }).tick();
  assert.equal(changed, 3);
  assert.deepEqual(service.getMetrics(), [{ ...UMANS }]);

  // A subsequent identical poll must NOT re-fire (dedup).
  httpFake.enqueue(200, metricsPayload([{ ...UMANS }]));
  await (service as unknown as { tick: () => Promise<void> }).tick();
  assert.equal(changed, 3, 'value-equal recovery poll must not fire onChanged');
});

// ─── dispose() ──────────────────────────────────────────────────────────────

test('dispose stops the polling timer (no further onChanged after dispose)', async () => {
  let changed = 0;
  const service = new ProxyMetricsService({ onChanged: () => { changed += 1; } });

  // Immediate tick fetches A; interval ticks would fetch B (a different
  // value) at POLL_MS (1000ms). If dispose() fails to stop the timer, the
  // interval tick fetches B and fires onChanged a second time.
  httpFake.enqueue(200, metricsPayload([{ ...UMANS }]));
  // Enqueue B several times for any interval ticks that (wrongly) fire.
  const bPayload = metricsPayload([{ ...UMANS, activeRequests: 9 }]);
  httpFake.enqueue(200, bPayload);
  httpFake.enqueue(200, bPayload);
  httpFake.enqueue(200, bPayload);

  service.start();

  // Wait for the immediate tick to land (poll, since the fetch is async).
  for (let i = 0; i < 50 && changed === 0; i += 1) {
    await delay(10);
  }
  assert.equal(changed, 1, 'the immediate start() tick must fire onChanged once');

  service.dispose();
  // Timer field must be cleared so start() can be called again later.
  assert.equal(
    (service as unknown as { timer: unknown }).timer,
    undefined,
    'dispose must clear the interval handle',
  );

  // Wait well past POLL_MS (1000ms). If the timer were not stopped, an
  // interval tick would fetch B and fire onChanged again.
  await delay(1300);
  assert.equal(changed, 1, 'dispose must stop the timer — no further onChanged');
  // The last known list remains A (the interval never fetched B).
  assert.deepEqual(service.getMetrics(), [{ ...UMANS }]);
});

test('dispose is a no-op when no timer is running', () => {
  const service = new ProxyMetricsService({ onChanged: () => {} });
  // No start() called — dispose must not throw and must leave timer undefined.
  service.dispose();
  assert.equal((service as unknown as { timer: unknown }).timer, undefined);
});

test('start() is idempotent (a second start does not spawn a second timer)', () => {
  let changed = 0;
  const service = new ProxyMetricsService({ onChanged: () => { changed += 1; } });

  httpFake.enqueue(200, metricsPayload([{ ...UMANS }]));
  httpFake.enqueue(200, metricsPayload([{ ...UMANS }]));
  service.start();
  const firstTimer = (service as unknown as { timer: unknown }).timer;
  assert.notEqual(firstTimer, undefined, 'start() must install a timer');

  service.start();
  assert.equal(
    (service as unknown as { timer: unknown }).timer,
    firstTimer,
    'a second start() must not replace the timer',
  );

  service.dispose();
});

// ─── fetchMetrics parsing / normalization ─────────────────────────────────────
//
// fetchMetrics is the pure mapping from the Python /health/proxy_metrics JSON
// into ProxyProviderMetrics. Invoked directly (private) with the stubs in place
// so the exact user-facing values can be asserted against the source JSON.

test('fetchMetrics normalizes a full providers payload and sorts by queued desc, active desc, provider asc', async () => {
  const service = new ProxyMetricsService({ onChanged: () => {} });
  httpFake.enqueue(200, metricsPayload([
    // Unsorted on purpose: fetchMetrics must sort.
    { provider: 'zeta', modelInfoId: 'z-shared', activeRequests: 0, queuedRequests: 0, maxConcurrentRequests: 2 },
    { provider: 'alpha', modelInfoId: 'a-shared', activeRequests: 2, queuedRequests: 3, maxConcurrentRequests: 4 },
    { provider: 'beta', modelInfoId: 'b-shared', activeRequests: 5, queuedRequests: 3, maxConcurrentRequests: 4 },
    { provider: 'gamma', modelInfoId: 'g-shared', activeRequests: 0, queuedRequests: 1, maxConcurrentRequests: 4 },
  ]));
  const out = await (service as unknown as { fetchMetrics: () => Promise<ProxyProviderMetrics[]> }).fetchMetrics();
  assert.deepEqual(
    out,
    [
      { provider: 'beta', modelInfoId: 'b-shared', activeRequests: 5, queuedRequests: 3, maxConcurrentRequests: 4 },
      { provider: 'alpha', modelInfoId: 'a-shared', activeRequests: 2, queuedRequests: 3, maxConcurrentRequests: 4 },
      { provider: 'gamma', modelInfoId: 'g-shared', activeRequests: 0, queuedRequests: 1, maxConcurrentRequests: 4 },
      { provider: 'zeta', modelInfoId: 'z-shared', activeRequests: 0, queuedRequests: 0, maxConcurrentRequests: 2 },
    ],
    'sort: queued desc (beta/alpha=3, gamma=1, zeta=0); tie -> active desc (beta=5 > alpha=2); tie -> provider asc',
  );
});

test('fetchMetrics keeps idle providers (active=0, queued=0) so the strip does not flicker', async () => {
  const service = new ProxyMetricsService({ onChanged: () => {} });
  httpFake.enqueue(200, metricsPayload([
    { provider: 'umans', modelInfoId: 'umans-shared', activeRequests: 0, queuedRequests: 0, maxConcurrentRequests: 4 },
  ]));
  const out = await (service as unknown as { fetchMetrics: () => Promise<ProxyProviderMetrics[]> }).fetchMetrics();
  assert.deepEqual(out, [
    { provider: 'umans', modelInfoId: 'umans-shared', activeRequests: 0, queuedRequests: 0, maxConcurrentRequests: 4 },
  ]);
});

test('fetchMetrics returns [] for an empty providers array', async () => {
  const service = new ProxyMetricsService({ onChanged: () => {} });
  httpFake.enqueue(200, metricsPayload([]));
  const out = await (service as unknown as { fetchMetrics: () => Promise<ProxyProviderMetrics[]> }).fetchMetrics();
  assert.deepEqual(out, []);
});

test('fetchMetrics returns [] when the providers key is missing', async () => {
  const service = new ProxyMetricsService({ onChanged: () => {} });
  httpFake.enqueue(200, JSON.stringify({ generatedAt: '2026-07-07T00:00:00+00:00' }));
  const out = await (service as unknown as { fetchMetrics: () => Promise<ProxyProviderMetrics[]> }).fetchMetrics();
  assert.deepEqual(out, []);
});

test('fetchMetrics filters out malformed provider entries (missing/wrong-typed fields)', async () => {
  const service = new ProxyMetricsService({ onChanged: () => {} });
  httpFake.enqueue(200, metricsPayload([
    // Valid.
    { provider: 'good', modelInfoId: 'good-shared', activeRequests: 1, queuedRequests: 0, maxConcurrentRequests: 4 },
    // Missing provider.
    { modelInfoId: 'x-shared', activeRequests: 0, queuedRequests: 0, maxConcurrentRequests: 4 },
    // Missing modelInfoId.
    { provider: 'y', activeRequests: 0, queuedRequests: 0, maxConcurrentRequests: 4 },
    // activeRequests wrong type (string).
    { provider: 'z', modelInfoId: 'z-shared', activeRequests: '0', queuedRequests: 0, maxConcurrentRequests: 4 },
    // queuedRequests wrong type.
    { provider: 'w', modelInfoId: 'w-shared', activeRequests: 0, queuedRequests: '0', maxConcurrentRequests: 4 },
    // maxConcurrentRequests wrong type.
    { provider: 'v', modelInfoId: 'v-shared', activeRequests: 0, queuedRequests: 0, maxConcurrentRequests: '4' },
    // null entry.
    null,
  ]));
  const out = await (service as unknown as { fetchMetrics: () => Promise<ProxyProviderMetrics[]> }).fetchMetrics();
  assert.deepEqual(out.map((m) => m.provider), ['good']);
});

test('fetchMetrics surfaces exact numeric values including zero fields', async () => {
  const service = new ProxyMetricsService({ onChanged: () => {} });
  httpFake.enqueue(200, metricsPayload([
    { provider: 'umans', modelInfoId: 'umans-shared', activeRequests: 0, queuedRequests: 0, maxConcurrentRequests: 4 },
    { provider: 'openrouter', modelInfoId: 'or-shared', activeRequests: 7, queuedRequests: 12, maxConcurrentRequests: 16 },
  ]));
  const out = await (service as unknown as { fetchMetrics: () => Promise<ProxyProviderMetrics[]> }).fetchMetrics();
  // sorted by queued desc: openrouter(12) then umans(0).
  assert.deepEqual(out, [
    { provider: 'openrouter', modelInfoId: 'or-shared', activeRequests: 7, queuedRequests: 12, maxConcurrentRequests: 16 },
    { provider: 'umans', modelInfoId: 'umans-shared', activeRequests: 0, queuedRequests: 0, maxConcurrentRequests: 4 },
  ]);
});

test('fetchMetrics sends the master key as a Bearer Authorization header', async () => {
  const service = new ProxyMetricsService({ onChanged: () => {} });
  httpFake.enqueue(200, metricsPayload([]));
  await (service as unknown as { fetchMetrics: () => Promise<ProxyProviderMetrics[]> }).fetchMetrics();
  assert.equal(httpFake.lastHeaders.Authorization, 'Bearer test-master-key');
  assert.match(httpFake.lastUrl, /127\.0\.0\.1:4000\/health\/proxy_metrics/);
});

test('fetchMetrics honors a custom proxyPort from configuration', async () => {
  configStore.proxyPort = 54321;
  const service = new ProxyMetricsService({ onChanged: () => {} });
  httpFake.enqueue(200, metricsPayload([]));
  await (service as unknown as { fetchMetrics: () => Promise<ProxyProviderMetrics[]> }).fetchMetrics();
  assert.match(httpFake.lastUrl, /127\.0\.0\.1:54321\/health\/proxy_metrics/);
});

test('fetchMetrics returns [] when useProxy is disabled', async () => {
  configStore.useProxy = false;
  const service = new ProxyMetricsService({ onChanged: () => {} });
  httpFake.enqueue(200, metricsPayload([{ ...UMANS }]));
  const out = await (service as unknown as { fetchMetrics: () => Promise<ProxyProviderMetrics[]> }).fetchMetrics();
  assert.deepEqual(out, []);
  assert.equal(httpFake.calls, 0, 'no HTTP fetch must occur when useProxy is false');
});

test('fetchMetrics returns [] when the master key env var is unset', async () => {
  const saved = process.env[MASTER_KEY];
  delete process.env[MASTER_KEY];
  try {
    const service = new ProxyMetricsService({ onChanged: () => {} });
    httpFake.enqueue(200, metricsPayload([{ ...UMANS }]));
    const out = await (service as unknown as { fetchMetrics: () => Promise<ProxyProviderMetrics[]> }).fetchMetrics();
    assert.deepEqual(out, []);
    assert.equal(httpFake.calls, 0, 'no HTTP fetch must occur without a master key');
  } finally {
    process.env[MASTER_KEY] = saved;
  }
});

test('fetchMetrics returns [] on a non-200 HTTP status (no stale/garbage)', async () => {
  const service = new ProxyMetricsService({ onChanged: () => {} });
  httpFake.enqueue(401, '{"error":"unauthorized"}');
  const out = await (service as unknown as { fetchMetrics: () => Promise<ProxyProviderMetrics[]> }).fetchMetrics();
  assert.deepEqual(out, []);
});

test('fetchMetrics returns [] on a 5xx HTTP status', async () => {
  const service = new ProxyMetricsService({ onChanged: () => {} });
  httpFake.enqueue(500, 'internal error');
  const out = await (service as unknown as { fetchMetrics: () => Promise<ProxyProviderMetrics[]> }).fetchMetrics();
  assert.deepEqual(out, []);
});

test('fetchMetrics returns [] on invalid JSON body', async () => {
  const service = new ProxyMetricsService({ onChanged: () => {} });
  httpFake.enqueue(200, 'not-json{');
  const out = await (service as unknown as { fetchMetrics: () => Promise<ProxyProviderMetrics[]> }).fetchMetrics();
  assert.deepEqual(out, []);
});

test('fetchMetrics returns [] on a connection error (req emits error)', async () => {
  const service = new ProxyMetricsService({ onChanged: () => {} });
  httpFake.enqueueError('connect ECONNREFUSED 127.0.0.1:4000');
  const out = await (service as unknown as { fetchMetrics: () => Promise<ProxyProviderMetrics[]> }).fetchMetrics();
  assert.deepEqual(out, []);
});