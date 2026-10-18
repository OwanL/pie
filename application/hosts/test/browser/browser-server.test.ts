/**
 * Browser server integration tests: loopback
 * bind, HTTP surface, upgrade validation, rendererHello handshake, snapshot
 * delivery, fail-closed ingress, client cap, lifecycle events, and port
 * release. Uses real loopback sockets on ephemeral ports with a deterministic
 * clock for the handshake bound.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createBrowserAssetDir } from './browser-assets.fixture';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { BrowserServer } from '../../browser/http/browser-server';
import { createLocalFileOpenService } from '../../lib/local-file-open.js';
import { isLanIPv4Address } from '../../browser/network-access/policy.js';
import type { BrowserServerLifecycleEvent, BrowserServerOptions } from '../../browser/types';
import type { RendererCommandContext, ViewState, WebviewToHostMessage } from '../../../lib/protocol/index.js';
import { WEBVIEW_PROTOCOL_VERSION } from '../../../lib/protocol/envelopes.js';

const EMPTY_VIEW_STATE: ViewState = {
  activeSession: null,
  busy: false,
  prepassPhase: 'idle',
  retryStatus: null,
  transcript: [],
  backendReady: true,
} as unknown as ViewState;

interface Harness {
  server: BrowserServer;
  events: BrowserServerLifecycleEvent[];
  routed: Array<{ msg: WebviewToHostMessage; context: RendererCommandContext }>;
  assetDir: string;
  stop: () => Promise<void>;
}

async function createHarness(t: TestContext, overrides: Partial<BrowserServerOptions> = {}): Promise<Harness> {
  let server: BrowserServer;
  const assetDir = await createBrowserAssetDir(t, async () => { await server?.stop(); });
  const events: BrowserServerLifecycleEvent[] = [];
  const routed: Array<{ msg: WebviewToHostMessage; context: RendererCommandContext }> = [];
  server = new BrowserServer({
    hostInstanceId: 'shared-host-test',
    getSettings: () => ({ enabled: true, port: 0, requirePreferredPort: false, allowLan: false }),
    getViewState: () => EMPTY_VIEW_STATE,
    getRunningSessionCount: () => 0,
    routeMessage: async (msg, context) => {
      routed.push({ msg, context });
      // Mirrors the real wiring (MessageRouter.onReady → postStateFor →
      // renderer-scoped requestState): handshake messages answer THEIR
      // renderer with an immediate snapshot.
      if (msg.type === 'ready' || msg.type === 'refreshState' || msg.type === 'requestSnapshot') {
        server.requestState(context.rendererId);
      }
    },
    assetDir,
    onLifecycle: (event) => events.push(event),
    ...overrides,
  });
  return {
    server,
    events,
    routed,
    assetDir,
    stop: async () => {
      await server.stop();
    },
  };
}

function getPort(server: BrowserServer): number {
  const state = server.getState();
  assert.ok(state.port !== null, 'server must be running');
  return state.port;
}

function httpGet(port: number, pathname: string, method = 'GET', hostHeader = `127.0.0.1:${port}`): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { Host: hostHeader } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk as Buffer));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

interface TestSocket {
  ws: WebSocket;
  /** Next inbound message (buffered from connect time — no listener race). */
  next: (timeoutMs?: number) => Promise<Record<string, unknown>>;
  waitForClose: (timeoutMs?: number) => Promise<{ code: number; reason: string }>;
  close: () => void;
}

function connectWs(port: number, options: { host?: string; origin?: string; path?: string } = {}): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${options.path ?? '/ws'}`, {
      headers: {
        Host: options.host ?? `127.0.0.1:${port}`,
        ...(options.origin !== undefined ? { Origin: options.origin } : {}),
      },
    });
    const queue: Array<Record<string, unknown>> = [];
    const waiters: Array<{ resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        queue.push(message);
      }
    });
    const next = (timeoutMs = 2_000): Promise<Record<string, unknown>> => {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolveMessage, rejectMessage) => {
        const timer = setTimeout(() => rejectMessage(new Error('timed out waiting for a message')), timeoutMs);
        waiters.push({ resolve: resolveMessage, reject: rejectMessage, timer });
      });
    };
    const waitForClose = (timeoutMs = 2_000): Promise<{ code: number; reason: string }> =>
      new Promise((resolveClose, rejectClose) => {
        const timer = setTimeout(() => rejectClose(new Error('timed out waiting for close')), timeoutMs);
        ws.once('close', (code, reason) => {
          clearTimeout(timer);
          resolveClose({ code, reason: reason.toString() });
        });
      });
    ws.once('open', () => resolve({ ws, next, waitForClose, close: () => ws.close() }));
    ws.once('error', reject);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('start binds loopback and serves the HTML shell, health, and allowlisted assets', async (t) => {
  const { server, stop } = await createHarness(t);
  const outcome = await server.start();
  assert.equal(outcome.kind, 'started');
  if (outcome.kind !== 'started') return;
  const port = getPort(server);
  assert.ok(outcome.url.startsWith('http://127.0.0.1:'), 'the primary URL remains loopback-only');
  assert.equal(server.getState().bindAddress, '127.0.0.1');
  assert.equal(server.getState().lanEnabled, false);
  assert.deepEqual(server.getState().lanUrls, []);

  const page = await httpGet(port, '/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'] ?? '', /text\/html/);  assert.match(page.body, /pie-transport" content="browser"/);
  assert.match(page.body, /pie-ws-route" content="\/ws"/);
  assert.match(page.body, /pie-asset-version/);
  assert.match(page.body, /panel-abc123\.js/);
  assert.match(String(page.headers['content-security-policy'] ?? ''), /frame-ancestors 'none'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['x-frame-options'], 'DENY');

  const health = await httpGet(port, '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { ok: true });

  const asset = await httpGet(port, '/assets/panel-abc123.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers['content-type'] ?? '', /javascript/);
  assert.match(asset.headers['cache-control'] ?? '', /immutable/);

  // Lazy-loaded chunks (dynamic entries) are served too: the browser's
  // relative dynamic import must resolve (regression: transcript-host 404).
  const dynamicChunk = await httpGet(port, '/assets/transcript-host-xyz789.js');
  assert.equal(dynamicChunk.status, 200);
  assert.match(dynamicChunk.headers['content-type'] ?? '', /javascript/);

  const rejectedHost = await httpGet(port, '/', 'GET', `192.168.1.50:${port}`);
  assert.equal(rejectedHost.status, 403, 'HTTP Host checks reject non-loopback addresses by default');
  const missing = await httpGet(port, '/assets/not-in-manifest.js');
  assert.equal(missing.status, 404);
  const traversal = await httpGet(port, '/assets/..%2f..%2fpackage.json');
  assert.equal(traversal.status, 404);
  const unknown = await httpGet(port, '/nope');
  assert.equal(unknown.status, 404);
  const post = await httpGet(port, '/', 'POST');
  assert.equal(post.status, 405);

  await stop();
});

test('LAN opt-in binds IPv4 all interfaces and reports/accepts only advertised private IPv4 URLs', async (t) => {
  const lanAddress = '192.168.1.44';
  const { server, events, stop } = await createHarness(t, {
    getSettings: () => ({ enabled: true, port: 0, requirePreferredPort: false, allowLan: true }),
    getLanIPv4Addresses: () => [lanAddress, '10.2.3.4', '203.0.113.5', '127.0.0.1'],
  });
  try {
    const outcome = await server.start();
    assert.equal(outcome.kind, 'started');
    if (outcome.kind !== 'started') return;
    const port = getPort(server);
    const state = server.getState();
    assert.equal(state.bindAddress, '0.0.0.0');
    assert.equal(state.lanEnabled, true);
    assert.deepEqual(state.lanUrls, [
      `http://10.2.3.4:${port}/`,
      `http://${lanAddress}:${port}/`,
    ]);
    assert.deepEqual(events.find((event) => event.kind === 'started'), {
      kind: 'started',
      url: state.url,
      preferred: true,
      lanEnabled: true,
      lanUrls: state.lanUrls,
    });

    const page = await httpGet(port, '/', 'GET', `${lanAddress}:${port}`);
    assert.equal(page.status, 200);
    assert.match(String(page.headers['content-security-policy'] ?? ''), new RegExp(`ws://${lanAddress}:${port}`));
    assert.equal((await httpGet(port, '/health', 'GET', `192.168.1.45:${port}`)).status, 403);
    assert.equal((await httpGet(port, '/', 'GET', `203.0.113.5:${port}`)).status, 403);

    await assert.rejects(connectWs(port, {
      host: `192.168.1.45:${port}`,
      origin: `http://192.168.1.45:${port}`,
    }), /Unexpected server response: 403/);
    await assert.rejects(connectWs(port, {
      host: `${lanAddress}:${port}`,
      origin: `http://192.168.1.45:${port}`,
    }), /Unexpected server response: 403/);
    const lanSocket = await connectWs(port, {
      host: `${lanAddress}:${port}`,
      origin: `http://${lanAddress}:${port}`,
    });
    assert.equal((await lanSocket.next()).type, 'rendererHello');
    lanSocket.close();
  } finally {
    await stop();
  }
});

test('LAN report click command returns a real nonloopback origin with relative script and image', async (t) => {
  const address = Object.values(os.networkInterfaces()).flat().find((entry) =>
    entry?.family === 'IPv4' && !entry.internal && isLanIPv4Address(entry.address))?.address;
  if (!address) return t.skip('No private IPv4 interface available for genuine LAN socket test');
  const reports = createLocalFileOpenService();
  let harness: Harness;
  harness = await createHarness(t, {
    getSettings: () => ({ enabled: true, port: 0, requirePreferredPort: false, allowLan: true }),
    getLanIPv4Addresses: () => [address],
    routeMessage: async (msg, context) => {
      if (msg.type === 'ready') harness.server.requestState(context.rendererId);
      if (msg.type !== 'prepareLocalFileOpen') return;
      assert.deepEqual(context.hostBrowserNetwork, { hostname: address, allowLan: true });
      const report = await reports.open({ path: msg.path, openIn: 'popup', browserNetwork: context.hostBrowserNetwork }, {
        exists: async () => true, findFiles: async () => [],
      });
      harness.server.postImperative({ type: 'localFileOpenResult', requestId: msg.requestId, status: 'ready', openIn: 'popup', url: report.url }, context.rendererId);
    },
  });
  let ws: WebSocket | undefined;
  try {
    await fs.writeFile(path.join(harness.assetDir, 'report.html'), '<script src="report.js"></script><img src="pixel.svg">');
    await fs.writeFile(path.join(harness.assetDir, 'report.js'), 'document.body.dataset.report = "loaded";');
    await fs.writeFile(path.join(harness.assetDir, 'pixel.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    await harness.server.start();
    const port = getPort(harness.server);
    ws = new WebSocket(`ws://${address}:${port}/ws`, { origin: `http://${address}:${port}` });
    const messages: Record<string, unknown>[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(String(data))));
    const wait = async (type: string) => {
      for (let i = 0; i < 200; i++) {
        const result = messages.find((message) => message.type === type);
        if (result) return result;
        await sleep(10);
      }
      throw new Error('Timed out waiting for ' + type);
    };
    const hello = await wait('rendererHello');
    ws.send(JSON.stringify({ type: 'ready', buildId: hello.buildId, viewGeneration: hello.viewGeneration }));
    await wait('state');
    ws.send(JSON.stringify({ type: 'prepareLocalFileOpen', path: path.join(harness.assetDir, 'report.html'), requestId: 'lan-click',
      clientCommandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', viewGeneration: hello.viewGeneration }));
    const result = await wait('localFileOpenResult');
    const url = new URL(String(result.url));
    assert.equal(url.hostname, address);
    assert.notEqual(url.port, String(port), 'report is isolated from Pie HTTP/WS');
    assert.match(await (await fetch(url)).text(), /report\.js/);
    const script = await fetch(new URL('report.js', url));
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') ?? '', /javascript/);
    assert.match(await script.text(), /loaded/);
    const image = await fetch(new URL('pixel.svg', url));
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/svg+xml');
    await assert.rejects(new Promise((resolve, reject) => {
      const foreign = new WebSocket(`ws://${address}:${port}/ws`, { origin: url.origin });
      foreign.once('open', () => { foreign.close(); resolve(undefined); });
      foreign.once('error', reject);
    }), /403/, 'report origin cannot connect to Pie WebSocket');
  } finally {
    ws?.terminate();
    await reports.dispose();
    await harness.stop();
  }
});

test('HTML requests refresh a replaced asset manifest and retain prior assets', async (t) => {
  const { server, assetDir, stop } = await createHarness(t);
  const outcome = await server.start();
  assert.equal(outcome.kind, 'started');
  if (outcome.kind !== 'started') return;
  const port = getPort(server);

  const before = await httpGet(port, '/');
  assert.match(before.body, /panel-abc123\.js/);

  await fs.writeFile(path.join(assetDir, 'assets', 'panel-new456.js'), 'console.log("new pie");\n');
  await fs.writeFile(path.join(assetDir, 'assets', 'panel-new456.css'), 'body { color: red; }\n');
  await fs.writeFile(
    path.join(assetDir, '.vite', 'manifest.json'),
    JSON.stringify({
      'index.html': {
        file: 'assets/panel-new456.js',
        isEntry: true,
        css: ['assets/panel-new456.css'],
      },
    }),
  );

  const after = await httpGet(port, '/');
  assert.equal(after.status, 200);
  assert.match(after.body, /panel-new456\.js/);
  assert.match(after.body, /panel-new456\.css/);
  assert.doesNotMatch(after.body, /panel-abc123\.js/);
  assert.equal((await httpGet(port, '/assets/panel-new456.js')).status, 200);
  assert.equal((await httpGet(port, '/assets/panel-abc123.js')).status, 200);

  await stop();
});

test('only an explicit development profile reloads connected browser renderers after a completed renderer build', async (t) => {
  const child = spawnSync(process.execPath, [
    '--import', 'tsx',
    fileURLToPath(new URL('./browser-server-development-reload.fixture.ts', import.meta.url)),
  ], {
    cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      PIE_DEVELOPMENT_PI_WORKSPACE: path.resolve(os.tmpdir(), 'pi-development-workspace'),
      PIE_DEVELOPMENT_PROFILE_DIR: path.resolve(os.tmpdir(), 'pie-development-profile'),
    },
  });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
});

test('an occupied preferred port falls back to an OS-assigned port (info-only)', async (t) => {
  const blocker = http.createServer();
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const blockedPort = (blocker.address() as { port: number }).port;

  const { server, events, stop } = await createHarness(t, {
    getSettings: () => ({ enabled: true, port: blockedPort, requirePreferredPort: false, allowLan: false }),
  });
  const outcome = await server.start();
  assert.equal(outcome.kind, 'started');
  if (outcome.kind !== 'started') return;
  assert.equal(outcome.preferred, false);
  assert.notEqual(getPort(server), blockedPort);
  assert.ok(events.some((event) => event.kind === 'fallback'), 'fallback is a lifecycle event');
  assert.ok(!events.some((event) => event.kind === 'bind-failed'), 'fallback is NOT a bind failure');

  await stop();
  await new Promise<void>((resolve) => blocker.close(() => resolve()));
});

test('requirePreferredPort: an occupied preferred port is a terminal bind failure', async (t) => {
  const blocker = http.createServer();
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const blockedPort = (blocker.address() as { port: number }).port;

  const { server, events, stop } = await createHarness(t, {
    getSettings: () => ({ enabled: true, port: blockedPort, requirePreferredPort: true, allowLan: false }),
  });
  const outcome = await server.start();
  assert.equal(outcome.kind, 'failed');
  assert.equal(server.isRunning(), false);
  assert.ok(events.some((event) => event.kind === 'bind-failed'));

  await stop();
  await new Promise<void>((resolve) => blocker.close(() => resolve()));
});

test('disabled settings produce a disabled outcome without binding', async (t) => {
  const { server, stop } = await createHarness(t, {
    getSettings: () => ({ enabled: false, port: 0, requirePreferredPort: false, allowLan: false }),
  });
  const outcome = await server.start();
  assert.equal(outcome.kind, 'disabled');
  assert.equal(server.isRunning(), false);
  await stop();
});

test('upgrade validation: foreign Host/Origin are rejected, the exact origin is accepted', async (t) => {
  const { server, stop } = await createHarness(t);
  await server.start();
  const port = getPort(server);

  await assert.rejects(connectWs(port, { host: 'evil.example:1997' }), /Unexpected server response: 403/);
  await assert.rejects(connectWs(port, { host: `127.0.0.1:${port}`, origin: 'http://evil.example' }), /Unexpected server response: 403/);
  await assert.rejects(connectWs(port, { host: `127.0.0.1:${port}`, origin: `http://localhost:${port}` }), /Unexpected server response: 403/);
  await assert.rejects(connectWs(port, { path: '/not-ws' }), /Unexpected server response: 404/);

  const { ws, next, waitForClose, close } = await connectWs(port, { origin: `http://127.0.0.1:${port}` });
  close();
  await stop();
});

test('a browser socket receives rendererHello and a full snapshot after ready', async (t) => {
  const { server, stop } = await createHarness(t);
  await server.start();
  const port = getPort(server);

  const { ws, next, waitForClose, close } = await connectWs(port, { origin: `http://127.0.0.1:${port}` });
  const hello = await next();
  assert.equal(hello.type, 'rendererHello');
  assert.equal(hello.protocolVersion, WEBVIEW_PROTOCOL_VERSION);
  assert.equal(hello.hostInstanceId, 'shared-host-test');
  assert.equal(typeof hello.rendererId, 'string');
  assert.equal(typeof hello.rendererGeneration, 'number');
  assert.equal(typeof hello.viewGeneration, 'number');
  assert.equal(typeof hello.assetVersion, 'string');

  ws.send(JSON.stringify({ type: 'ready', buildId: hello.buildId, viewGeneration: hello.viewGeneration }));
  const snapshot = await next();
  assert.equal(snapshot.type, 'state');
  assert.equal(snapshot.hostInstanceId, hello.hostInstanceId);
  assert.equal(snapshot.rendererId, hello.rendererId);
  assert.equal(snapshot.rendererGeneration, hello.rendererGeneration);
  assert.equal(snapshot.viewGeneration, hello.viewGeneration);
  assert.equal((snapshot.state as { backendReady?: boolean }).backendReady, true);

  close();
  await stop();
});

test('a validated browser command routes with the trusted renderer context and gets exactly one ack', async (t) => {
  const { server, routed, stop } = await createHarness(t);
  await server.start();
  const port = getPort(server);

  const { ws, next, waitForClose, close } = await connectWs(port, { origin: `http://127.0.0.1:${port}` });
  const hello = await next();
  ws.send(JSON.stringify({ type: 'ready', buildId: hello.buildId, viewGeneration: hello.viewGeneration }));
  await next(); // snapshot

  const clientCommandId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  ws.send(JSON.stringify({
    type: 'newSession',
    clientCommandId,
    viewGeneration: hello.viewGeneration,
  }));
  const ack = await next();
  assert.equal(ack.type, 'commandAck');
  assert.equal(ack.clientCommandId, clientCommandId);
  assert.equal(ack.decision, 'accepted');

  assert.equal(routed.filter((entry) => entry.msg.type === 'newSession').length, 1);
  const routedCommand = routed.find((entry) => entry.msg.type === 'newSession');
  assert.equal(routedCommand?.msg.type, 'newSession');
  assert.equal(routedCommand?.context.rendererId, hello.rendererId);
  assert.equal(routedCommand?.context.kind, 'browser');

  // A duplicate of the same command is never routed again and gets no ack.
  ws.send(JSON.stringify({ type: 'newSession', clientCommandId, viewGeneration: hello.viewGeneration }));
  await sleep(150);
  assert.equal(routed.filter((entry) => entry.msg.type === 'newSession').length, 1, 'duplicate is never re-routed');

  close();
  await stop();
});

test('fail-closed ingress: malformed frames are never routed; the rate bound closes the socket', async (t) => {
  const { server, routed, stop } = await createHarness(t);
  await server.start();
  const port = getPort(server);

  const { ws, next, waitForClose, close } = await connectWs(port, { origin: `http://127.0.0.1:${port}` });
  const hello = await next();
  ws.send(JSON.stringify({ type: 'ready', buildId: hello.buildId, viewGeneration: hello.viewGeneration }));
  await next();

  // Unknown fields are rejected (fail-closed, not ignored).
  ws.send(JSON.stringify({ type: 'newSession', clientCommandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', evil: true }));
  await sleep(100);
  assert.equal(routed.filter((entry) => entry.msg.type === 'newSession').length, 0, 'schema-invalid commands are never routed');

  // Binary frames are rejected outright.
  ws.send(Buffer.from('binary'));
  // Unparseable JSON.
  ws.send('{not json');

  // 5 violations within the window close the socket with a typed reason.
  const closePromise = waitForClose();
  for (let index = 0; index < 4; index += 1) {
    ws.send('{not json');
  }
  const closed = await closePromise;
  assert.equal(closed.code, 1008);
  assert.match(closed.reason, /malformed/);

  await stop();
});

test('the client cap closes the 5th concurrent browser socket', async (t) => {
  const { server, stop } = await createHarness(t);
  await server.start();
  const port = getPort(server);

  const sockets: TestSocket[] = [];
  for (let index = 0; index < 4; index += 1) {
    sockets.push(await connectWs(port, { origin: `http://127.0.0.1:${port}` }));
  }
  const fifth = await connectWs(port, { origin: `http://127.0.0.1:${port}` });
  const close = await fifth.waitForClose();
  assert.equal(close.code, 1013);
  assert.match(close.reason, /client-limit/);

  for (const socket of sockets) socket.close();
  await stop();
});

test('handshake bound: a socket that never sends ready is closed by the deterministic clock', async (t) => {
  const timers: Array<() => void> = [];
  const { server, stop } = await createHarness(t, {
    clock: {
      now: () => 0,
      setTimeout: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout: () => undefined,
    },
  });
  await server.start();
  const port = getPort(server);

  const { ws, next, waitForClose, close } = await connectWs(port, { origin: `http://127.0.0.1:${port}` });
  const hello = await next();
  assert.equal(hello.type, 'rendererHello');

  const closePromise = waitForClose();
  for (const timer of timers.splice(0)) timer();
  const closed = await closePromise;
  assert.equal(closed.code, 1008);
  assert.match(closed.reason, /handshake-timeout/);

  await stop();
});

test('stop releases the port; restart rebinds atomically', async (t) => {
  const { server, stop } = await createHarness(t);
  await server.start();
  const port = getPort(server);
  await server.stop();
  assert.equal(server.isRunning(), false);

  // The port is free again: a fresh server binds the same preferred port.
  const { server: second } = await createHarness(t, {
    getSettings: () => ({ enabled: true, port, requirePreferredPort: false, allowLan: false }),
  });
  const outcome = await second.start();
  assert.equal(outcome.kind, 'started');
  if (outcome.kind === 'started') {
    assert.equal(outcome.preferred, true, 'the released port is reusable');
    assert.equal(getPort(second), port);
  }
  await second.stop();

  // Restart on the SAME server instance re-reads settings and rebinds
  // (this harness configures port 0 = OS-assigned, so the restart lands on
  // a fresh loopback port and is fully running again).
  const outcome2 = await server.start();
  assert.equal(outcome2.kind, 'started');
  if (outcome2.kind === 'started') {
    assert.equal(server.isRunning(), true);
    assert.ok(outcome2.port > 0 && outcome2.port < 65536, 'restart binds a valid loopback port');
  }
  await stop();
});

test('a browser disconnect deregisters the renderer and cancels pending confirmations', async (t) => {
  const { server, stop } = await createHarness(t);
  await server.start();
  const port = getPort(server);

  const { ws, next, waitForClose, close } = await connectWs(port, { origin: `http://127.0.0.1:${port}` });
  const hello = await next();
  ws.send(JSON.stringify({ type: 'ready', buildId: hello.buildId, viewGeneration: hello.viewGeneration }));
  await next();

  const confirmPromise = server.requestInlineConfirm(hello.rendererId as string, {
    kind: 'model-switch',
    message: 'Switch?',
    confirmChoice: 'Switch',
  });
  assert.equal(server.getState().clientCount, 1);

  close();
  assert.equal(await confirmPromise, false, 'disconnect cancels the pending confirmation');
  await sleep(100);
  assert.equal(server.getState().clientCount, 0, 'the renderer is deregistered');
  await stop();
});
