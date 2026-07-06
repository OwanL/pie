/**
 * Phase 1 red-test battery — proxy restart mid-stream (Bug 5, pie).
 *
 * Bug 5 — Proxy restart mid-stream: `ProxyService.restart()` does
 *         `await this.stop()` (kills the litellm tree) then `start()` with NO
 *         check for in-flight streaming sessions routed through the proxy. A
 *         `settings.set` carrying a proxy field triggers
 *         `regenerateProxyConfigAndRestart` (service.ts) → kills the proxy
 *         mid-stream → an in-flight proxied turn gets a random connection
 *         error (ECONNRESET / socket hang up) with NO structured notice and NO
 *         drain. The proxy's access log only shows 200 for the HTTP start, so
 *         an early SSE close is invisible — the user can't tell "proxy
 *         restarted under me" vs "provider cut" vs "proxy throttled".
 *
 *         This test pins the bug at the `ProxyService` level: when a streaming
 *         request is in flight through a tracked proxy child, `stop()` (the
 *         first half of `restart()`) silently kills the in-flight stream
 *         with no observability hook fired.
 *
 * Approach: spawns a REAL HTTP server as a tracked `ProxyService` child (a tiny
 * node subprocess that streams SSE forever), opens a streaming request to it,
 * then calls `ProxyService.stop()`. Asserts the in-flight stream is killed
 * silently today (no drain, no structured notice emitted) — the bug to be
 * fixed by Phase 2 (drain-or-notice). `ProxyService` imports cleanly under
 * tsx (`import type * as vscode from 'vscode'` is type-only, erased at runtime).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as http from 'node:http';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';

import { ProxyService } from '../src/host/backend/proxy-service';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Find a free TCP port by binding to :0 and reading the assigned port. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error('could not get port'));
      }
    });
  });
}

/** Spin up a real streaming HTTP server as a tracked ProxyService child. The
 *  child streams SSE `data:` lines forever until killed. Routes:
 *  - GET /health/liveness → 200 (so a future start() fast-path probe succeeds)
 *  - POST /v1/chat/completions → 200 + SSE stream (never ends)
 *  Returns the bound port and the ProxyService instance with `proc` set. */
async function spawnStreamingProxyChild(): Promise<{ service: ProxyService; port: number; child: cp.ChildProcess }> {
  const port = await freePort();

  // Inline node script: an HTTP server that streams forever on /v1/chat/completions.
  // Written as a single-quoted PowerShell-safe string via a Buffer write to a
  // temp file (avoids quoting hell), then spawned.
  const script = `
    const http = require('http');
    const server = http.createServer((req, res) => {
      if (req.url === '/health/liveness') { res.writeHead(200); res.end('ok'); return; }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        let n = 0;
        // Stream a delta every 20ms forever; only ends when the socket is killed.
        const iv = setInterval(() => {
          n++;
          try { res.write(\`data: {"choices":[{"delta":{"content":"chunk-\${n}"}}]}\n\n\`); } catch (e) { clearInterval(iv); }
        }, 20);
        req.on('close', () => clearInterval(iv));
        return;
      }
      res.writeHead(404); res.end('not found');
    });
    server.listen(${port}, '127.0.0.1', () => {
      // Signal ready on stdout so the parent knows it's listening.
      process.stdout.write('READY\\n');
    });
    process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
    process.on('SIGINT', () => { server.close(() => process.exit(0)); });
    // Keep stdout alive so the parent's 'exit' is the kill signal.
  `;

  const child = cp.spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: false,
  });

  // Wait for READY.
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('streaming proxy child did not signal READY')), 3000);
    child.stdout!.once('data', (chunk: Buffer) => {
      if (chunk.toString().includes('READY')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`streaming proxy child exited early (code ${code})`));
    });
  });

  // Inject it as the tracked child of a fresh ProxyService. `restart()` and
  // `stop()` operate on `this.proc`, so this is enough to exercise the kill
  // path without the real `uv run litellm` spawn.
  const service = new ProxyService();
  (service as unknown as { proc: cp.ChildProcess }).proc = child;

  return { service, port, child };
}

// ===========================================================================
// Bug 5 — restart()/stop() silently kills an in-flight streaming request
// ===========================================================================

test('Bug 5: stop() [first half of restart()] emits a structured PROXY_RESTART_IN_FLIGHT notice before killing the in-flight stream (Phase 2 fix: drain-or-notice)', async () => {
  const { service, port, child } = await spawnStreamingProxyChild();
  try {
    // Wire the Bug 5 observability hook BEFORE opening the stream.
    type Notice = { code?: string; message?: string; pid?: number };
    // Use a mutable container so TS control-flow analysis does not narrow to
    // `never` after the null literal init (the assignment happens in an async
    // callback the checker cannot track).
    const noticeBox: { value: Notice | null } = { value: null };
    let noticeCount = 0;
    service.onInFlightInterrupted = (payload) => {
      noticeCount++;
      noticeBox.value = payload as Notice;
    };

    // Open a streaming chat-completions request and let a few chunks arrive.
    const streamChunks: string[] = [];
    // Use a mutable container so TS control-flow analysis does not narrow to
    // `never` after the null literal init (the assignment happens in an async
    // callback the checker cannot track).
    const errorBox: { value: Error | null } = { value: null };
    let streamEnded = false;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { streamChunks.push(chunk); });
        res.on('end', () => { streamEnded = true; });
        res.on('error', (e: Error) => { errorBox.value = e; });
      },
    );
    req.on('error', (e: Error) => { errorBox.value = e; });
    req.write(JSON.stringify({ model: 'umans-coder', stream: true, messages: [{ role: 'user', content: 'hi' }] }));
    req.end();

    // Wait until the stream is genuinely in flight (a couple of deltas arrived).
    const startWait = Date.now();
    while (streamChunks.length < 2 && Date.now() - startWait < 1000) {
      await sleep(10);
    }
    assert.ok(streamChunks.length >= 2, 'stream must be in flight (≥2 chunks) before stop()');

    // Now call stop() — the EXACT operation restart() performs first.
    await service.stop();
    // Give the killed socket time to surface the error to the in-flight request.
    await sleep(100);

    // Phase 2 FIX: a structured PROXY_RESTART_IN_FLIGHT notice is emitted
    // BEFORE the kill, so an in-flight stream that dies with an opaque
    // transport error is attributable to "proxy restarted" instead of looking
    // like a provider cut.
    assert.equal(noticeCount, 1, 'Phase 2 FIX: stop() emits exactly one PROXY_RESTART_IN_FLIGHT notice when a tracked child is killed');
    const notice = noticeBox.value;
    assert.equal(notice?.code, 'PROXY_RESTART_IN_FLIGHT', 'notice code is PROXY_RESTART_IN_FLIGHT');
    assert.ok(
      typeof notice?.pid === 'number' && notice!.pid! > 0,
      'notice carries the pid of the dying proxy child',
    );
    assert.match(
      notice?.message ?? '',
      /proxy.+restart|restart.+in-flight|interrupted/i,
      'notice message explains the in-flight stream was interrupted by a proxy restart',
    );

    // The in-flight stream is still killed (we did NOT add a drain — out of
    // scope for minimal-diff hardening; the structured notice is the fix).
    // The shape is still an opaque transport error — but now it has a
    // matching structured notice so the user can tell what happened.
    assert.ok(
      streamEnded || errorBox.value !== null,
      'in-flight stream is still killed by stop() (no drain added) — but the structured notice makes it attributable',
    );
    const streamError = errorBox.value;
    const failureShape = streamError
      ? `${streamError.name}: ${streamError.message}`
      : streamEnded
        ? 'stream-ended-without-error'
        : 'stream-still-hanging';
    assert.match(
      failureShape,
      /ECONNRESET|ECONNABORTED|EPIPE|aborted|socket hang up|stream-ended-without-error|read ECONN|ERR_/i,
      `in-flight stream killed by proxy stop() still surfaces a transport error (${failureShape}) — the structured notice is the attributable overlay`,
    );
  } finally {
    if (!child.killed && child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
});

test('Bug 5 (control): stop() on a proxy with NO in-flight streams is a clean no-op-shaped teardown (the happy restart path must NOT be blocked by Phase 2)', async () => {
  // Control: the same stop() with no in-flight stream must remain fast and
  // silent. Phase 2's "drain or notice" must NOT introduce a wait when no
  // stream is in flight — only the in-flight case needs the structured error.
  const { service, child } = await spawnStreamingProxyChild();
  try {
    const t0 = Date.now();
    await service.stop();
    const elapsed = Date.now() - t0;
    // stop() should be near-instant when no stream is in flight.
    assert.ok(elapsed < 1000, `stop() with no in-flight stream should be fast (took ${elapsed}ms)`);
    // Child is gone.
    await new Promise<void>((resolve) => {
      const onExit = () => resolve();
      child.once('exit', onExit);
      // Already exited?
      if (child.exitCode !== null || child.killed) resolve();
      setTimeout(resolve, 500);
    });
  } finally {
    if (!child.killed && child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
});
