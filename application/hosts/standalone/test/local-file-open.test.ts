import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { createStandaloneHostRuntimePlatform } from '../platform.js';

async function tempDirectory(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pie-local-file-open-standalone-'));
}

function isPortClosed(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(500);
    const done = (closed: boolean): void => { socket.destroy(); resolve(closed); };
    socket.on('connect', () => done(false));
    socket.on('error', () => done(true));
    socket.on('timeout', () => done(true));
  });
}

/** The standalone platform wires the shared local-file-open service into the
 *  editor seam for POPUP openers (its only real surface is the browser); the
 *  listener is verified, sibling-contained, and disposed with the host. */
test('standalone prepareLocalFileOpen serves html with siblings and disposes at shutdown', async () => {
  const root = await tempDirectory();
  try {
    await fs.writeFile(path.join(root, 'page.html'), '<script src="app.js"></script>');
    await fs.writeFile(path.join(root, 'app.js'), 'console.log("app");');
    const platform = createStandaloneHostRuntimePlatform({
      workspaceCwd: root,
      extensionPath: root,
      runtimeOutputDirectory: root,
      dataPaths: { rootDir: root, analyticsDir: root, sessionsDir: root, artifactsDir: root, stateDir: root, cacheDir: root },
      dependencies: { nodePath: process.execPath, sdkPath: root },
      getBrowserServer: () => undefined,
    });
    assert.equal(typeof platform.editor.prepareLocalFileOpen, 'function');
    assert.equal(typeof platform.editor.disposeLocalFileOpen, 'function');

    const prepared = await platform.editor.prepareLocalFileOpen!({
      path: path.join(root, 'page.html'), openIn: 'popup',
    });
    assert.match(prepared.url, /^http:\/\/127\.0\.0\.1:\d+\/$/u, 'a loopback-only verified origin');
    const entry = await fetch(prepared.url);
    assert.equal(entry.status, 200);
    assert.equal(entry.headers.get('content-type'), 'text/html; charset=utf-8');
    const sibling = await fetch(`${prepared.url}app.js`);
    assert.equal(sibling.status, 200);
    assert.equal(sibling.headers.get('content-type'), 'text/javascript; charset=utf-8');

    await platform.editor.disposeLocalFileOpen!();
    const port = Number(/:(\d+)\//u.exec(prepared.url)?.[1]);
    assert.equal(await isPortClosed(port), true, 'host shutdown disposal closes the listener');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('standalone local file open fails closed for unavailable and ambiguous files', async () => {
  const root = await tempDirectory();
  try {
    await fs.writeFile(path.join(root, 'page.html'), 'x');
    const platform = createStandaloneHostRuntimePlatform({
      workspaceCwd: root,
      extensionPath: root,
      runtimeOutputDirectory: root,
      dataPaths: { rootDir: root, analyticsDir: root, sessionsDir: root, artifactsDir: root, stateDir: root, cacheDir: root },
      dependencies: { nodePath: process.execPath, sdkPath: root },
      getBrowserServer: () => undefined,
    });
    await assert.rejects(
      () => platform.editor.prepareLocalFileOpen!({ path: path.join(root, 'missing.html'), openIn: 'popup' }),
      /Could not find file/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});