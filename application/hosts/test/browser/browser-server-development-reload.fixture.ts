import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { BrowserServer } from '../../browser/http/browser-server';
import type { BrowserServerOptions } from '../../browser/types';
import type { ViewState } from '../../../lib/protocol/index.js';

const EMPTY_VIEW_STATE: ViewState = {
  activeSession: null,
  busy: false,
  prepassPhase: 'idle',
  retryStatus: null,
  transcript: [],
  backendReady: true,
} as unknown as ViewState;

interface ReloadProbe {
  isAttached(): boolean;
  closeSocket(reason: string): void;
  dispose(): void;
}

async function makeAssets(assetDir: string, suffix: string, buildId: string): Promise<void> {
  await fs.mkdir(path.join(assetDir, '.vite'), { recursive: true });
  await fs.mkdir(path.join(assetDir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(assetDir, 'assets', `panel-${suffix}.js`), `console.log("${suffix}");\n`);
  await fs.writeFile(
    path.join(assetDir, '.vite', 'manifest.json'),
    JSON.stringify({ panel: { file: `assets/panel-${suffix}.js`, isEntry: true } }),
  );
  await fs.writeFile(path.join(assetDir, 'pie-build-id.txt'), `${buildId}\n`);
}

async function makeServer(assetDir: string): Promise<BrowserServer> {
  const options: BrowserServerOptions = {
    getSettings: () => ({ enabled: true, port: 0, requirePreferredPort: false, allowLan: false }),
    getViewState: () => EMPTY_VIEW_STATE,
    getRunningSessionCount: () => 0,
    routeMessage: async () => undefined,
    assetDir,
  };
  const server = new BrowserServer(options);
  const outcome = await server.start();
  assert.equal(outcome.kind, 'started');
  return server;
}

function installReloadProbe(server: BrowserServer, onReload: (reason: string) => void): void {
  const transports = (server as unknown as { transports: Record<string, ReloadProbe> }).transports;
  transports['development-test-renderer'] = {
    isAttached: () => true,
    closeSocket: onReload,
    dispose: () => undefined,
  };
}

function waitForReload(reload: Promise<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for browser renderer reload signal')), 4_000);
    void reload.then((reason) => {
      clearTimeout(timeout);
      resolve(reason);
    }, (error: unknown) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function replaceFile(absolutePath: string, contents: string): Promise<void> {
  const temporaryPath = `${absolutePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, contents);
  await fs.rename(temporaryPath, absolutePath);
}

async function updateAssets(assetDir: string, suffix: string, buildId: string): Promise<void> {
  await fs.writeFile(path.join(assetDir, 'assets', `panel-${suffix}.js`), `console.log("${suffix}");\n`);
  await replaceFile(
    path.join(assetDir, '.vite', 'manifest.json'),
    JSON.stringify({ panel: { file: `assets/panel-${suffix}.js`, isEntry: true } }),
  );
  await replaceFile(path.join(assetDir, 'pie-build-id.txt'), `${buildId}\n`);
}

async function main(): Promise<void> {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-browser-development-reload-'));
  let server: BrowserServer | undefined;
  try {
    await makeAssets(assetDir, 'old123', '11111111111111111111');
    server = await makeServer(assetDir);
    let resolveReload!: (reason: string) => void;
    let reload = new Promise<string>((resolve) => { resolveReload = resolve; });
    installReloadProbe(server, (reason) => resolveReload(reason));

    // Complete the renderer generation with both its hashed entry manifest
    // and the build marker that Vite emits for this output.
    await updateAssets(assetDir, 'new456', '22222222222222222222');
    assert.equal(await waitForReload(reload), 'development-renderer-rebuilt');

    // Watching remains active when the manifest and marker are atomically
    // replaced again for a later build.
    reload = new Promise<string>((resolve) => { resolveReload = resolve; });
    await updateAssets(assetDir, 'new789', '55555555555555555555');
    assert.equal(await waitForReload(reload), 'development-renderer-rebuilt');
    await server.stop();
    server = undefined;

    // A workspace selection by itself is not enough to enable filesystem
    // watching; the isolated profile must be explicit as well.
    delete process.env.PIE_DEVELOPMENT_PROFILE_DIR;
    const partialDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-browser-no-profile-reload-'));
    try {
      await makeAssets(partialDir, 'old789', '33333333333333333333');
      server = await makeServer(partialDir);
      const calls: string[] = [];
      installReloadProbe(server, (reason) => calls.push(reason));
      await updateAssets(partialDir, 'partial', '44444444444444444444');
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.deepEqual(calls, [], 'a partial profile selection leaves connected renderers alone');
      await server.stop();
      server = undefined;
    } finally {
      if (server) await server.stop();
      await fs.rm(partialDir, { recursive: true, force: true });
    }
  } finally {
    if (server) await server.stop();
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
