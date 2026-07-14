import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RunAnalyticsStorage } from '../../../src/host/stats-service/storage';

const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');

function createStorage(outcomesRoot: string): RunAnalyticsStorage {
  return new RunAnalyticsStorage({
    dataOutcomesRootPath: outcomesRoot,
    workspaceId: 'persist-error-test-workspace',
    now: () => FIXED_DATE,
    serializeSessions: () => ({}),
  });
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-persist-error-test-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('getPersistError returns null after a successful persist', async () => {
  await withTempDir(async (tempDir) => {
    const outcomesRoot = path.join(tempDir, 'data', 'outcomes');
    const storage = createStorage(outcomesRoot);

    assert.equal(storage.getPersistError(), null);

    // A persist with no append payload still runs mkdir + checkpoint + auto-export.
    storage.schedulePersist();
    await storage.flush();

    assert.equal(storage.getPersistError(), null);
  });
});

test('getPersistError records a persist failure and clears it after a subsequent successful persist', async () => {
  await withTempDir(async (tempDir) => {
    const outcomesRoot = path.join(tempDir, 'outcomes-file');

    // Make outcomesRoot a *file* so the recursive mkdir of the hashed storageDir
    // fails with ENOTDIR. This injects a persistence failure without mocking.
    await fs.writeFile(outcomesRoot, '', 'utf8');

    const storage = createStorage(outcomesRoot);

    // First persist: its .then rejects (mkdir fails). The rejection is stored on
    // persistenceQueue but not yet observed.
    storage.schedulePersist();
    // Second persist: its leading .catch observes + records the first rejection.
    storage.schedulePersist();
    await storage.flush();

    const recorded = storage.getPersistError();
    assert.ok(recorded, 'expected a persist failure to be recorded');
    assert.equal(
      typeof recorded!.message,
      'string',
      'expected the recorded failure to expose a message string',
    );
    assert.ok(recorded!.message.length > 0, 'expected a non-empty failure message');
    assert.equal(
      recorded!.at,
      FIXED_DATE.toISOString(),
      'expected the recorded failure timestamp to be the storage clock iso time',
    );

    // Recover: remove the blocking file so the recursive mkdir can succeed.
    await fs.rm(outcomesRoot, { force: true });

    // The next persist's leading .catch records the prior (second) rejection,
    // then its .then runs to completion and clears the error state.
    storage.schedulePersist();
    await storage.flush();

    assert.equal(
      storage.getPersistError(),
      null,
      'expected a successful persist to clear the recorded failure',
    );
  });
});