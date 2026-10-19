import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { SessionCatalog } from '../session-catalog';
import { withCatalogDirectory, writeSession } from './catalog-fixtures';

for (const usePersistentIndex of [false, true]) {
  test(`canonical inventory scopes, ordering and live precedence (persistent=${usePersistentIndex})`, async () => {
    await withCatalogDirectory(async (_root, agentDir, sessionDir) => {
      const flat = path.join(sessionDir, 'flat.jsonl');
      const nested = path.join(sessionDir, '--workspace--', 'nested.jsonl');
      await writeSession(flat);
      await writeSession(nested, 'Named Session', '2026-01-02T00:00:00.000Z');
      await writeSession(path.join(sessionDir, '--workspace--', 'deeper', 'ignored.jsonl'), 'Ignored');
      await writeSession(path.join(agentDir, 'sessions', '--legacy--', 'legacy.jsonl'), 'Legacy');
      const catalog = new SessionCatalog({ usePersistentIndex });
      const sessions = await catalog.list(agentDir, sessionDir);
      assert.deepEqual(sessions.map(s => s.path), [nested, flat]);
      assert.equal(sessions[0]?.name, 'Named Session');
      assert.equal(sessions[0]?.isPlaceholder, false);
      assert.equal(sessions[1]?.isPlaceholder, true);
      assert.ok(sessions[1]?.name.startsWith('Refactor the analytics'));
      const livePath = process.platform === 'win32' ? flat.toUpperCase() : flat;
      const live = { ...sessions[1]!, path: livePath, name: 'Live', modifiedAt: '2026-01-03T00:00:00.000Z', agentCreated: true };
      const overlaid = await catalog.list(agentDir, sessionDir, [live]);
      assert.deepEqual(overlaid.map(s => s.name), ['Live', 'Named Session']);
      assert.equal(overlaid[0]?.agentCreated, true);
    });
  });
  test(`default inventory includes only one nested cwd level (persistent=${usePersistentIndex})`, async () => {
    await withCatalogDirectory(async (_root, agentDir) => {
      const nested = path.join(agentDir, 'sessions', '--cwd--', 'nested.jsonl');
      await writeSession(nested, 'Nested');
      await writeSession(path.join(agentDir, 'sessions', 'ignored.jsonl'), 'Direct ignored');
      await writeSession(path.join(agentDir, 'sessions', '--cwd--', 'deep', 'ignored.jsonl'), 'Deep ignored');
      const catalog = new SessionCatalog({ usePersistentIndex });
      assert.deepEqual((await catalog.list(agentDir, undefined)).map(s => s.path), [nested]);
    });
  });
  test(`empty default never falls back to SDK (persistent=${usePersistentIndex})`, async () => {
    await withCatalogDirectory(async (_root, agentDir) => {
      const catalog = new SessionCatalog({ usePersistentIndex });
      assert.deepEqual(await catalog.list(agentDir, undefined), []);
      assert.deepEqual(await catalog.list(agentDir, undefined), []);
    });
  });
}
