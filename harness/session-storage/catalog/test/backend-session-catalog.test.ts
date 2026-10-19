import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { SessionCatalog } from '../session-catalog';
import { readBackendSessionInventory, readBackendSessionInventorySignature } from '../session-directory';
import { SessionIndexStore } from '../session-index-store';
import { readIndexedSessionMetadata } from '../../metadata/session-metadata';
import { withCatalogDirectory, writeSession } from './catalog-fixtures';

test('non-lock memory context promotes to durable truth without resurrecting tombstones', async () => {
  await withCatalogDirectory(async (_root, agentDir, sessionDir) => {
    const file = path.join(sessionDir, 'canonical.jsonl');
    await writeSession(file, 'Canonical');
    let now = 0;
    let opens = 0;
    const catalog = new SessionCatalog({ nowMs: () => now, createIndexStore: (...args) => {
      if (++opens === 1) throw Object.assign(new Error('read-only'), { code: 'EACCES' });
      return new SessionIndexStore(...args);
    } });
    assert.equal((await catalog.list(agentDir, sessionDir)).length, 1);
    now = 249;
    assert.equal((await catalog.list(agentDir, sessionDir)).length, 1);
    assert.equal(opens, 1);
    catalog.remove(file);
    now = 250;
    assert.deepEqual(await catalog.list(agentDir, sessionDir), []);
    assert.equal(opens, 2);
    await writeSession(path.join(sessionDir, 'external.jsonl'), 'External');
    assert.deepEqual((await catalog.list(agentDir, sessionDir)).map(s => s.name), ['External']);
  });
});

test('promotion fences metadata still in flight in the old memory context', async () => {
  await withCatalogDirectory(async (_root, agentDir, sessionDir) => {
    await writeSession(path.join(sessionDir, 'canonical.jsonl'), 'Canonical');
    let now = 0;
    let opens = 0;
    let reads = 0;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const catalog = new SessionCatalog({ nowMs: () => now,
      createIndexStore: (...args) => {
        if (++opens === 1) throw new Error('index unavailable');
        return new SessionIndexStore(...args);
      },
      readIndexedMetadata: async (...args) => {
        const result = await readIndexedSessionMetadata(...args);
        if (++reads === 1) { entered(); await gate; }
        return result;
      },
    });
    const stale = catalog.list(agentDir, sessionDir);
    await started;
    now = 250;
    assert.equal((await catalog.list(agentDir, sessionDir)).length, 1);
    release();
    assert.deepEqual(await stale, [], 'superseded context may publish live summaries only');
    assert.equal((await catalog.list(agentDir, sessionDir)).length, 1);
  });
});

for (const usePersistentIndex of [false, true]) {
  test(`unchanged fingerprints cache metadata; appends and new files reconcile (persistent=${usePersistentIndex})`, async () => {
    await withCatalogDirectory(async (_root, agentDir, sessionDir) => {
      const file = path.join(sessionDir, 'canonical.jsonl');
      await writeSession(file, 'Canonical');
      let reads = 0;
      const catalog = new SessionCatalog({ usePersistentIndex, readIndexedMetadata: async (...args) => {
        reads++; return readIndexedSessionMetadata(...args);
      } });
      assert.equal((await catalog.list(agentDir, sessionDir)).length, 1);
      assert.equal(await catalog.invalidateIfInventoryChanged(agentDir, sessionDir), false);
      assert.equal(await catalog.invalidateIfInventoryChanged(agentDir, sessionDir), false);
      await catalog.list(agentDir, sessionDir);
      assert.equal(reads, 1);
      await fs.appendFile(file, JSON.stringify({ type: 'session_info', id: 'rename', parentId: 'name', name: 'Renamed', timestamp: '2026-01-03T00:00:00.000Z' }) + '\n');
      assert.equal(await catalog.invalidateIfInventoryChanged(agentDir, sessionDir), true);
      assert.equal((await catalog.list(agentDir, sessionDir))[0]?.name, 'Renamed');
      await writeSession(path.join(sessionDir, 'external.jsonl'), 'External');
      assert.equal((await catalog.list(agentDir, sessionDir)).length, 2);
    });
  });
  test(`forget excludes in-flight metadata and live overlays (persistent=${usePersistentIndex})`, async () => {
    await withCatalogDirectory(async (_root, agentDir, sessionDir) => {
      const file = path.join(sessionDir, 'canonical.jsonl');
      await writeSession(file, 'Canonical');
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const catalog = new SessionCatalog({ usePersistentIndex, readIndexedMetadata: async (...args) => {
        const result = await readIndexedSessionMetadata(...args); entered(); await gate; return result;
      } });
      const pending = catalog.list(agentDir, sessionDir);
      await started;
      catalog.remove(file);
      release();
      assert.deepEqual(await pending, []);
      assert.deepEqual(await catalog.list(agentDir, sessionDir, [{ path: file, name: 'Live', cwd: '/repo', messageCount: 1, modifiedAt: '2026-01-02T00:00:00.000Z' }]), []);
    });
  });
  test(`inaccessible inventory retains complete projection and recovers (persistent=${usePersistentIndex})`, async () => {
    await withCatalogDirectory(async (_root, agentDir, sessionDir) => {
      await writeSession(path.join(sessionDir, 'canonical.jsonl'), 'Canonical');
      let inaccessible = false;
      const failure = Object.assign(new Error('unavailable'), { code: 'EACCES' });
      const catalog = new SessionCatalog({ usePersistentIndex,
        readInventorySignature: async (...args) => { if (inaccessible) throw failure; return readBackendSessionInventorySignature(...args); },
        readInventory: async (...args) => { if (inaccessible) throw failure; return readBackendSessionInventory(...args); },
      });
      assert.equal((await catalog.list(agentDir, sessionDir)).length, 1);
      inaccessible = true;
      catalog.refresh();
      assert.equal((await catalog.list(agentDir, sessionDir)).length, 1);
      await assert.rejects(catalog.invalidateIfInventoryChanged(agentDir, sessionDir), { code: 'EACCES' });
      inaccessible = false;
      await writeSession(path.join(sessionDir, 'external.jsonl'), 'External');
      assert.equal((await catalog.list(agentDir, sessionDir)).length, 2);
    });
  });
}
