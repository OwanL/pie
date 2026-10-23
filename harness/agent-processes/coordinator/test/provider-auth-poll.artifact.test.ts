import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendServer } from '../server';

for (const disposedDuringReload of [false, true]) {
  test(`coordinator auth polling awaits native reload and fences overlap/disposal (${disposedDuringReload})`, { timeout: 15_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pie-coordinator-auth-poll-'));
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reloading = new Promise<void>(resolve => { entered = resolve; });
    let reloads = 0;
    let broadcasts = 0;
    let reloaded = false;
    const authPath = join(dir, 'auth.json');
    await writeFile(authPath, '{}');
    // No server startup, workers, timers, live authority or native SDK loading.
    const server = Object.assign(Object.create(BackendServer.prototype), {
      disposed: false, sessionCatalogPollingActive: true, sessionCatalogPollInFlight: false,
      agentDir: dir, authPath, modelsJsonFingerprint: 'missing',
      sessionCatalog: { invalidateIfInventoryChanged: async () => false },
      getSessionDir: () => dir,
      authStorage: {
        reload: () => { throw new Error('synchronous reload forbidden'); },
        reloadAsync: async () => { reloads++; entered(); await gate; reloaded = true; },
        drainErrors: () => [],
      },
      workerRuntimeRouter: { refreshAuth: async () => {
        assert.equal(reloaded, true);
        broadcasts++;
      } },
    }) as { pollSessionCatalog(): Promise<void>; disposed: boolean; sessionCatalogPollInFlight: boolean; authFingerprint?: string };
    try {
      const polling = server.pollSessionCatalog();
      await reloading;
      await server.pollSessionCatalog();
      assert.equal(reloads, 1, 'overlapping polls cannot begin a second native reload');
      assert.equal(broadcasts, 0);
      assert.equal(server.authFingerprint, undefined);
      server.disposed = disposedDuringReload;
      release();
      await polling;
      assert.equal(server.sessionCatalogPollInFlight, false);
      assert.equal(broadcasts, disposedDuringReload ? 0 : 1);
      assert.equal(typeof server.authFingerprint, disposedDuringReload ? 'undefined' : 'string');
      if (!disposedDuringReload) {
        await server.pollSessionCatalog();
        assert.equal(reloads, 1, 'unchanged fingerprint does not reload native storage');
      }
    } finally {
      release();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
