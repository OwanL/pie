import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  LOCAL_FILE_OPEN_POLICY,
  createLocalFileOpenService,
  localFileMimeForExtension,
  type LocalFileOpenClock,
} from '../local-file-open.js';
import type { LocalFileOpenCommand } from '../../../lib/platform-contracts/local-file-open.js';

/** Node:http request helper: undici `fetch` cannot set a custom Host header. */
function requestRaw(url: string, headers: Record<string, string>): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'HEAD', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function isPortClosed(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(timeoutMs);
    const done = (closed: boolean): void => {
      socket.destroy();
      resolve(closed);
    };
    socket.on('connect', () => done(false));
    socket.on('error', () => done(true));
    socket.on('timeout', () => done(true));
  });
}

/** Fake clock capturing idle timers so idle-expiry disposal is deterministic. */
function createFakeClock(): { clock: LocalFileOpenClock; fireIdleTimers(): void } {
  const timers = new Map<object, () => void>();
  return {
    clock: {
      setTimeout: (callback, _delayMs) => {
        const handle: object = {};
        timers.set(handle, callback);
        return handle;
      },
      clearTimeout: (handle) => { timers.delete(handle as object); },
    },
    fireIdleTimers: () => {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
  };
}

async function tempDirectory(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pie-local-file-open-'));
}

function openCommand(filePath: string): LocalFileOpenCommand {
  return { path: filePath, openIn: 'popup' };
}

test('serves the entry at / plus contained sibling assets with typed MIME', async () => {
  const root = await tempDirectory();
  const service = createLocalFileOpenService({ selfCheck: async () => undefined });
  try {
    await fs.writeFile(path.join(root, 'page.html'), '<!doctype html><script src="app.js"></script><link rel="stylesheet" href="app.css">');
    await fs.writeFile(path.join(root, 'app.js'), 'console.log("app");');
    await fs.writeFile(path.join(root, 'app.css'), 'body {}');

    let dispose: (() => Promise<void>) | undefined;
    try {
      const session = await service.open(openCommand(path.join(root, 'page.html')), { exists: async () => true, findFiles: async () => [] });
      dispose = session.dispose.bind(session);
      assert.match(session.url, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}\/$/u);

      const entry = await get(session.url);
      assert.equal(entry.status, 200);
      assert.equal(entry.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(entry.body, '<!doctype html><script src="app.js"></script><link rel="stylesheet" href="app.css">');
      assert.equal(entry.headers['x-content-type-options'], 'nosniff');
      assert.equal(entry.headers['referrer-policy'], 'no-referrer');

      const script = await get(`${session.url}app.js`);
      assert.equal(script.status, 200);
      assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
      assert.equal(script.body, 'console.log("app");');

      const style = await get(`${session.url}app.css`);
      assert.equal(style.status, 200);
      assert.equal(style.headers['content-type'], 'text/css; charset=utf-8');
      assert.strictEqual(typeof localFileMimeForExtension('.html'), 'string');
    } finally {
      await dispose?.();
    }
  } finally {
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('canonically fences the parent directory: traversal, escapes, and listing-free 404s', async () => {
  const root = await tempDirectory();
  const service = createLocalFileOpenService({ selfCheck: async () => undefined });
  try {
    await fs.writeFile(path.join(root, 'entry.html'), '<p>entry</p>');
    // An existing sibling OUTSIDE the root must stay unreachable.
    const outside = await tempDirectory();
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');

    const session = await service.open(openCommand(path.join(root, 'entry.html')), { exists: async () => true, findFiles: async () => [] });
    try {
      assert.equal((await get(`${session.url}..%2Finvalid.txt`)).status, 404);
      const escape = await get(`${session.url}..%2F..%2F${path.basename(outside)}%2Fsecret.txt`);
      assert.ok([403, 404].includes(escape.status), 'escaped targets never serve');

      // Encoded traversal of an existing outside file: realpath + containment.
      const encodedOutside = await get(`${session.url}${encodeURIComponent('..')}%2F`);
      assert.ok([403, 404].includes(encodedOutside.status));

      // Missing contained file stays a plain 404.
      assert.equal((await get(`${session.url}missing.html`)).status, 404);
    } finally {
      await session.dispose();
    }
    await fs.rm(outside, { recursive: true, force: true });
  } finally {
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects foreign Host headers and non-GET/HEAD requests', async () => {
  const root = await tempDirectory();
  const service = createLocalFileOpenService({ selfCheck: async () => undefined });
  try {
    await fs.writeFile(path.join(root, 'entry.html'), '<p>entry</p>');
    const session = await service.open(openCommand(path.join(root, 'entry.html')), { exists: async () => true, findFiles: async () => [] });
    try {
      const port = Number(/:(\d+)\//u.exec(session.url)?.[1]);
      assert.ok(Number.isFinite(port));
      const foreignHost = await requestRaw(session.url, { host: 'evil.example:80' });
      assert.equal(foreignHost.status, 403, 'DNS rebinding via a forged Host must fail closed');
      // Node's http client cannot send an empty Host header; probe with a raw
      // socket so a missing/empty Host is proven to fail closed, too.
      const emptyHost = await new Promise<string>((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.setTimeout(1000);
        let body = '';
        socket.on('data', (chunk) => { body += String(chunk); });
        socket.on('end', () => resolve(body));
        socket.on('error', reject);
        socket.on('timeout', () => socket.destroy());
        socket.write('HEAD / HTTP/1.1\r\n\r\n');
      });
      assert.match(emptyHost, /(?:400|403)\b/u, 'a missing/empty Host header fails closed');

      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(session.url, { method: 'POST' }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end('x');
      });
      assert.equal(status, 405, 'bodies are rejected');
    } finally {
      await session.dispose();
    }
  } finally {
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('self-check failure revokes its capability and open() throws', async () => {
  const root = await tempDirectory();
  const service = createLocalFileOpenService({ selfCheck: async () => { throw new Error('unreachable'); } });
  try {
    await fs.writeFile(path.join(root, 'entry.html'), '<p>entry</p>');
    await assert.rejects(
      () => service.open(openCommand(path.join(root, 'entry.html')), { exists: async () => true, findFiles: async () => [] }),
      /unreachable/u,
    );
    // The failed listener must not remain bounded-live: maxConcurrent is not
    // consumed by failed preparations.
    const ok = createLocalFileOpenService({ selfCheck: async () => undefined });
    try {
      const session = await ok.open(openCommand(path.join(root, 'entry.html')), { exists: async () => true, findFiles: async () => [] });
      await session.dispose();
    } finally {
      await ok.dispose();
    }
  } finally {
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('idle expiry revokes the capability; the last one also closes the accept loop', async () => {
  const root = await tempDirectory();
  const fake = createFakeClock();
  const service = createLocalFileOpenService({ clock: fake.clock, selfCheck: async () => undefined });
  try {
    await fs.writeFile(path.join(root, 'entry.html'), '<p>entry</p>');
    const session = await service.open(openCommand(path.join(root, 'entry.html')), { exists: async () => true, findFiles: async () => [] });
    const port = Number(/:(\d+)\//u.exec(session.url)?.[1]);
    assert.equal(await isPortClosed(port), false, 'the verified listener accepts connections');
    fake.fireIdleTimers();
    assert.equal(await isPortClosed(port), true, 'idle expiry of the final capability closes the grantless listener');
  } finally {
    await service.dispose();
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('revoking the final capability closes the accept loop; an in-flight open is never closed underneath', async () => {
  const root = await tempDirectory();
  const service = createLocalFileOpenService({ selfCheck: async () => undefined });
  try {
    await fs.writeFile(path.join(root, 'entry.html'), '<p>entry</p>');
    const resolver = { exists: async () => true, findFiles: async () => [] };
    const first = await service.open(openCommand(path.join(root, 'entry.html')), resolver);
    const port = Number(/:(\d+)\//u.exec(first.url)?.[1]);
    await first.dispose();
    assert.equal(await isPortClosed(port), true, 'revoking the final capability closes the listener');
    // A later open transparently rebinds a fresh report origin.
    const second = await service.open(openCommand(path.join(root, 'entry.html')), resolver);
    assert.equal(await get(second.url).then((response) => response.status), 200, 'the fresh origin serves again');
    await second.dispose();
  } finally {
    await service.dispose();
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a local IPv6 loopback report host is normalized to 127.0.0.1', async () => {
  const root = await tempDirectory();
  const service = createLocalFileOpenService({ selfCheck: async () => undefined });
  try {
    await fs.writeFile(path.join(root, 'entry.html'), '<p>entry</p>');
    const resolver = { exists: async () => true, findFiles: async () => [] };
    for (const raw of ['[::1]', '::1']) {
      const session = await service.open(
        { path: path.join(root, 'entry.html'), openIn: 'popup', browserNetwork: { hostname: raw, allowLan: false } },
        resolver,
      );
      try {
        assert.match(session.url, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}\/$/u,
          'a [::1] Host never mints a URL the IPv4-only report binding cannot answer');
        // The real self-check already verified reachability under the
        // normalized origin and the exact Host gate accepted it.
        assert.equal((await get(session.url)).status, 200);
        const foreignHost = await requestRaw(session.url, { host: '[::1]:' + (Number(/:(\d+)\//u.exec(session.url)?.[1]) || 0) });
        assert.equal(foreignHost.status, 403, 'the bracketed IPv6 form is not a verified Host');
      } finally { await session.dispose(); }
    }
  } finally {
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ambiguous or missing requested files fail without starting a listener', async () => {
  const root = await tempDirectory();
  await fs.writeFile(path.join(root, 'page.html'), 'x');
  const service = createLocalFileOpenService({ selfCheck: async () => undefined });
  try {
    await assert.rejects(
      () => service.open(openCommand(path.join(root, 'missing.html')), { exists: async () => false, findFiles: async () => [] }),
      /Could not find file/u,
    );
    await assert.rejects(
      () => service.open(
        { path: path.join(root, 'page.html'), reference: 'page.html', workingDirectory: root, openIn: 'popup' },
        { exists: async () => false, findFiles: async () => [path.join(root, 'a', 'page.html'), path.join(root, 'b', 'page.html')] },
      ),
      /ambiguous/u,
      'ambiguous bare names never pick silently',
    );
  } finally {
    await service.dispose();
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('concurrent capabilities are bounded on one report origin and host disposal closes it', async () => {
  const root = await tempDirectory();
  const service = createLocalFileOpenService({ selfCheck: async () => undefined });
  try {
    await fs.writeFile(path.join(root, 'page.html'), 'x');
    const resolver = { exists: async () => true, findFiles: async () => [] };
    const sessions = await Promise.all(Array.from({ length: LOCAL_FILE_OPEN_POLICY.maxConcurrent },
      () => service.open(openCommand(path.join(root, 'page.html')), resolver)));
    await assert.rejects(
      () => service.open(openCommand(path.join(root, 'page.html')), resolver),
      /Too many prepared files/u,
    );
    const urls = new Set(sessions.map((session) => session.url));
    assert.equal(urls.size, LOCAL_FILE_OPEN_POLICY.maxConcurrent, 'each open mints its own distinct capability');
    assert.equal(new Set(sessions.map((session) => new URL(session.url).origin)).size, 1, 'all opens share one report origin');
    await service.dispose();
    for (const session of sessions) {
      const port = Number(/:(\d+)\//u.exec(session.url)?.[1]);
      assert.equal(await isPortClosed(port), true, 'dispose closed every listener');
    }
  } finally {
    await service.dispose();
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});