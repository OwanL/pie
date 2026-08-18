/**
 * Browser server integration tests (browser server plan §6/§7): loopback
 * bind, HTTP surface, upgrade validation, rendererHello handshake, snapshot
 * delivery, fail-closed ingress, client cap, lifecycle events, and port
 * release. Uses real loopback sockets on ephemeral ports with a deterministic
 * clock for the handshake bound.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';

import { BrowserServer } from '../../../src/host/browser-server/browser-server';
import type { BrowserServerLifecycleEvent, BrowserServerOptions } from '../../../src/host/browser-server/types';
import type { RendererCommandContext, ViewState, WebviewToHostMessage } from '../../../src/shared/protocol';
import { WEBVIEW_PROTOCOL_VERSION } from '../../../src/shared/protocol';

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

async function createHarness(overrides: Partial<BrowserServerOptions> = {}): Promise<Harness> {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-browser-server-'));
  await fs.mkdir(path.join(assetDir, '.vite'), { recursive: true });
  await fs.mkdir(path.join(assetDir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(assetDir, 'assets', 'panel-abc123.js'), 'console.log("pie");\n');
  await fs.writeFile(path.join(assetDir, 'assets', 'panel-abc123.css'), 'body {}\n');
  await fs.writeFile(
    path.join(assetDir, '.vite', 'manifest.json'),
    JSON.stringify({
      'index.html': {
        file: 'assets/panel-abc123.js',
        isEntry: true,
        css: ['assets/panel-abc123.css'],
      },
    }),
  );

  const events: BrowserServerLifecycleEvent[] = [];
  const routed: Array<{ msg: WebviewToHostMessage; context: RendererCommandContext }> = [];
  const server = new BrowserServer({
    getSettings: () => ({ enabled: true, port: 0, requirePreferredPort: false }),
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
      await fs.rm(assetDir, { recursive: true, force: true });
    },
  };
}

function getPort(server: BrowserServer): number {
  const state = server.getState();
  assert.ok(state.port !== null, 'server must be running');
  return state.port;
}

function httpGet(port: number, pathname: string, method = 'GET'): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method }, (res) => {
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

test('start binds loopback and serves the HTML shell, health, and allowlisted assets', async () => {
  const { server, stop } = await createHarness();
  const outcome = await server.start();
  assert.equal(outcome.kind, 'started');
  if (outcome.kind !== 'started') return;
  const port = getPort(server);
  assert.ok(outcome.url.startsWith('http://127.0.0.1:'), 'the URL is loopback-only');

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

  const asset = await httpGet(port, '/assets/assets/panel-abc123.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers['content-type'] ?? '', /javascript/);
  assert.match(asset.headers['cache-control'] ?? '', /immutable/);

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

test('an occupied preferred port falls back to an OS-assigned port (info-only)', async () => {
  const blocker = http.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const blockedPort = (blocker.address() as { port: number }).port;

  const { server, events, stop } = await createHarness({
    getSettings: () => ({ enabled: true, port: blockedPort, requirePreferredPort: false }),
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

test('requirePreferredPort: an occupied preferred port is a terminal bind failure', async () => {
  const blocker = http.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const blockedPort = (blocker.address() as { port: number }).port;

  const { server, events, stop } = await createHarness({
    getSettings: () => ({ enabled: true, port: blockedPort, requirePreferredPort: true }),
  });
  const outcome = await server.start();
  assert.equal(outcome.kind, 'failed');
  assert.equal(server.isRunning(), false);
  assert.ok(events.some((event) => event.kind === 'bind-failed'));

  await stop();
  await new Promise<void>((resolve) => blocker.close(() => resolve()));
});

test('disabled settings produce a disabled outcome without binding', async () => {
  const { server, stop } = await createHarness({
    getSettings: () => ({ enabled: false, port: 0, requirePreferredPort: false }),
  });
  const outcome = await server.start();
  assert.equal(outcome.kind, 'disabled');
  assert.equal(server.isRunning(), false);
  await stop();
});

test('upgrade validation: foreign Host/Origin are rejected, the exact origin is accepted', async () => {
  const { server, stop } = await createHarness();
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

test('a browser socket receives rendererHello and a full snapshot after ready', async () => {
  const { server, stop } = await createHarness();
  await server.start();
  const port = getPort(server);

  const { ws, next, waitForClose, close } = await connectWs(port, { origin: `http://127.0.0.1:${port}` });
  const hello = await next();
  assert.equal(hello.type, 'rendererHello');
  assert.equal(hello.protocolVersion, WEBVIEW_PROTOCOL_VERSION);
  assert.equal(typeof hello.hostInstanceId, 'string');
  assert.equal(typeof hello.rendererId, 'string');
  assert.equal(typeof hello.rendererGeneration, 'number');
  assert.equal(typeof hello.viewGeneration, 'number');
  assert.equal(typeof hello.assetVersion, 'string');

  ws.send(JSON.stringify({ type: 'ready', viewGeneration: hello.viewGeneration }));
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

test('a validated browser command routes with the trusted renderer context and gets exactly one ack', async () => {
  const { server, routed, stop } = await createHarness();
  await server.start();
  const port = getPort(server);

  const { ws, next, waitForClose, close } = await connectWs(port, { origin: `http://127.0.0.1:${port}` });
  const hello = await next();
  ws.send(JSON.stringify({ type: 'ready', viewGeneration: hello.viewGeneration }));
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

test('fail-closed ingress: malformed frames are never routed; the rate bound closes the socket', async () => {
  const { server, routed, stop } = await createHarness();
  await server.start();
  const port = getPort(server);

  const { ws, next, waitForClose, close } = await connectWs(port, { origin: `http://127.0.0.1:${port}` });
  const hello = await next();
  ws.send(JSON.stringify({ type: 'ready', viewGeneration: hello.viewGeneration }));
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

test('the client cap closes the 5th concurrent browser socket', async () => {
  const { server, stop } = await createHarness();
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

test('handshake bound: a socket that never sends ready is closed by the deterministic clock', async () => {
  const timers: Array<() => void> = [];
  const { server, stop } = await createHarness({
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

test('stop releases the port; restart rebinds atomically', async () => {
  const { server, stop } = await createHarness();
  await server.start();
  const port = getPort(server);
  await server.stop();
  assert.equal(server.isRunning(), false);

  // The port is free again: a fresh server binds the same preferred port.
  const second = new BrowserServer({
    getSettings: () => ({ enabled: true, port, requirePreferredPort: false }),
    getViewState: () => EMPTY_VIEW_STATE,
    getRunningSessionCount: () => 0,
    routeMessage: async () => undefined,
    assetDir: (await createHarness()).assetDir,
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

test('a browser disconnect deregisters the renderer and cancels pending confirmations', async () => {
  const { server, stop } = await createHarness();
  await server.start();
  const port = getPort(server);

  const { ws, next, waitForClose, close } = await connectWs(port, { origin: `http://127.0.0.1:${port}` });
  const hello = await next();
  ws.send(JSON.stringify({ type: 'ready', viewGeneration: hello.viewGeneration }));
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
