import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { ColdSessionStore, StaleColdSessionLeaseError } from '../cold-session-store';

async function withStore(run: (store: ColdSessionStore, sessionPath: string, root: string, setManager: (manager: unknown) => void) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-cold-metadata-'));
  let manager: unknown;
  const store = new ColdSessionStore({
    sdk: { SessionManager: { open: () => manager } } as any,
    coordinatorGeneration: 1,
    startupCwd: root,
    agentDir: root,
  });
  const sessionPath = path.join(root, 'session.jsonl');
  try {
    await fs.writeFile(sessionPath, `${JSON.stringify({ type: 'session', version: 3, id: 'metadata', cwd: root })}\n`, 'utf8');
    await run(store, sessionPath, root, (value) => { manager = value; });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('hot durable metadata honors explicit thinking changes and otherwise uses settings defaults', async () => {
  await withStore(async (store, sessionPath, root, setManager) => {
    store.leases.reserveCanonicalPaths([sessionPath], 'hot:test', { hideFromCatalog: false });
    setManager({
      getBranch: () => [{ type: 'thinking_level_change' }],
      buildSessionContext: () => ({ thinkingLevel: 'high', model: { modelId: 'durable-model', provider: 'mock' } }),
      getCwd: () => '/durable-cwd',
    });
    assert.deepEqual(await store.readDurableSessionMetadata(sessionPath, { defaultThinkingLevel: 'medium' }), {
      cwd: '/durable-cwd', modelId: 'durable-model', provider: 'mock', thinkingLevel: 'high',
    });
    setManager({ getBranch: () => [], getCwd: () => '' });
    assert.deepEqual(await store.readDurableSessionMetadata(sessionPath, { defaultThinkingLevel: 'medium' }), {
      cwd: root, thinkingLevel: 'medium',
    });
    assert.deepEqual(await store.readDurableSessionMetadata(sessionPath, {}), { cwd: root });
    setManager({
      getBranch: () => [{ type: 'thinking_level_change' }],
      buildSessionContext: () => ({ thinkingLevel: 'unknown', model: null }),
      getCwd: () => root,
    });
    assert.deepEqual(await store.readDurableSessionMetadata(sessionPath, { defaultThinkingLevel: 'low' }), {
      cwd: root, thinkingLevel: 'low',
    });
  });
});

test('hot durable metadata rejects migration and ownership changes without cold fallback', async () => {
  await withStore(async (store, sessionPath, root, setManager) => {
    const [token] = store.leases.reserveCanonicalPaths([sessionPath], 'hot:test', { hideFromCatalog: false });
    let opens = 0;
    setManager({
      getBranch: () => { opens += 1; return []; },
      buildSessionContext: () => { store.leases.releaseCanonicalPaths([token]); return {}; },
      getCwd: () => root,
    });
    await assert.rejects(store.readDurableSessionMetadata(sessionPath, {}),
      (error) => error instanceof StaleColdSessionLeaseError && error.reason === 'ownership-revision');
    assert.equal(opens, 1);
    store.leases.reserveCanonicalPaths([sessionPath], 'hot:replacement', { hideFromCatalog: false });
    await fs.writeFile(sessionPath, '{"type":"session","version":2}\n', 'utf8');
    await assert.rejects(store.readDurableSessionMetadata(sessionPath, {}),
      (error: { code?: string }) => error.code === 'SESSION_SETTINGS_UNAVAILABLE');
    assert.equal(opens, 1, 'legacy hot metadata must not reach SDK migration');
    assert.equal(await fs.readFile(sessionPath, 'utf8'), '{"type":"session","version":2}\n');
  });
});

test('cold durable metadata delegates a transcript-free open and omits absent optional settings', async () => {
  await withStore(async (store, sessionPath, root) => {
    let session: any = { cwd: '', modelId: '', provider: '', thinkingLevel: '' };
    const calls: unknown[] = [];
    store.openSnapshot = async (openedPath, options) => {
      calls.push({ openedPath, options });
      return { session } as any;
    };
    const settings = { defaultThinkingLevel: 'medium' as const };
    assert.deepEqual(await store.readDurableSessionMetadata(sessionPath, settings), { cwd: root });
    session = { cwd: '/cold-cwd', modelId: 'model', provider: 'mock', thinkingLevel: 'low' };
    assert.deepEqual(await store.readDurableSessionMetadata(sessionPath, settings), session);
    assert.deepEqual(calls, Array(2).fill({ openedPath: sessionPath, options: { modelSettings: settings, transcript: 'skip' } }));
  });
});
