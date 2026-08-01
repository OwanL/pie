import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RunAnalyticsStorage } from '../../../src/host/stats-service/storage';
import { RUN_ANALYTICS_SCHEMA_VERSION, type RunSnapshot } from '../../../src/host/run-analytics';
import { serializeJsonLine } from '../../../src/shared/jsonl';

const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function noTimer(): ReturnType<typeof setTimeout> {
  return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
}

/** Minimal run shape that passes coerceRunSnapshot (rollups default in the coercer). */
function bareRun(runId: string): Record<string, unknown> {
  return {
    sessionPath: `/session/${runId}`,
    runId,
    taskGroupId: `task-${runId}`,
    status: 'closed',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:10:00.000Z',
    mixedModelConfig: false,
    sendCount: 1,
    assistantTurnCount: 1,
    assistantTurnDurationMs: 1000,
    interruptedCount: 0,
    messageEditCount: 0,
    truncatedAfterCount: 0,
    filesystemPathRefCount: 1,
    imageInputCount: 0,
    imageInputBytes: 0,
    unsupportedInputCount: 0,
    backendErrorCodes: [],
    inputKindsUsed: [],
  };
}

function snapshotEnvelope(runId: string): string {
  return serializeJsonLine({
    schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
    kind: 'run_snapshot',
    recordedAt: '2026-01-01T00:00:00.000Z',
    run: bareRun(runId),
  });
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-storage-retry-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('appendHistoryChunk retries a transient EBUSY then appends the snapshot', async () => {
  await withTempDir(async (tempDir) => {
    const outcomesRoot = path.join(tempDir, 'data', 'outcomes');
    let appendAttempts = 0;
    const appendedChunks: string[] = [];
    const appendFile = (async (_file: unknown, data: unknown) => {
      appendAttempts += 1;
      if (appendAttempts === 1) throw errno('EBUSY');
      appendedChunks.push(String(data));
    }) as typeof fs.appendFile;

    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: outcomesRoot,
      workspaceId: 'append-retry-workspace',
      now: () => FIXED_DATE,
      serializeSessions: () => ({}),
      appendFile,
      retryDelay: async () => undefined,
      autoExportSetTimeout: () => noTimer(),
    });

    await storage.start();
    const snapshot = { runId: 'run-append-retry' } as RunSnapshot;
    storage.schedulePersist(snapshot);
    await storage.flush();

    assert.equal(appendAttempts, 2, 'append retried once after the transient EBUSY');
    assert.equal(appendedChunks.length, 1, 'exactly one chunk reached the (fake) file');
    assert.ok(appendedChunks[0]!.includes('run-append-retry'), 'the appended chunk carries the snapshot runId');
    assert.equal(storage.getPersistError(), null, 'a recovered append records no persist error');
  });
});

test('appendHistoryChunk surfaces a persistent transient error after exhausting retries', async () => {
  await withTempDir(async (tempDir) => {
    const outcomesRoot = path.join(tempDir, 'data', 'outcomes');
    let appendAttempts = 0;
    const appendFile = (async () => {
      appendAttempts += 1;
      throw errno('EACCES');
    }) as typeof fs.appendFile;

    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: outcomesRoot,
      workspaceId: 'append-exhaust-workspace',
      now: () => FIXED_DATE,
      serializeSessions: () => ({}),
      appendFile,
      retryDelay: async () => undefined,
      autoExportSetTimeout: () => noTimer(),
    });

    await storage.start();
    const snapshot = { runId: 'run-append-exhaust' } as RunSnapshot;
    storage.schedulePersist(snapshot);
    await storage.flush();

    // default schedule is 5 delays → 6 total attempts before the error surfaces
    assert.equal(appendAttempts, 6, 'the bounded retry budget is exhausted before surfacing');
    const recorded = storage.getPersistError();
    assert.ok(recorded, 'the exhausted transient error is recorded as a persist failure');
    assert.ok(recorded!.message.includes('EACCES'), 'the surfaced error carries the errno code');
  });
});

test('pruneJsonlFile retries a transient EBUSY on the retention read then prunes', async () => {
  await withTempDir(async (tempDir) => {
    const outcomesRoot = path.join(tempDir, 'data', 'outcomes');
    const seededRaw = snapshotEnvelope('r1') + snapshotEnvelope('r2');
    let readAttempts = 0;
    const readFile = (async () => {
      readAttempts += 1;
      if (readAttempts === 1) throw errno('EBUSY');
      return seededRaw;
    }) as unknown as typeof fs.readFile;

    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: outcomesRoot,
      workspaceId: 'prune-read-retry-workspace',
      now: () => FIXED_DATE,
      serializeSessions: () => ({}),
      maxRunHistoryEntries: 1, // two seeded records exceed the limit → prune reads
      maxRunHistoryBytes: 5_000_000,
      readFile,
      retryDelay: async () => undefined,
      autoExportSetTimeout: () => noTimer(),
    });

    await storage.start();
    const filePath = path.join(storage.getStorageDir(), 'run-snapshots.jsonl');
    await fs.writeFile(filePath, seededRaw, 'utf8');

    // schedulePersist() with no snapshot runs the checkpoint + retention pass
    // (and no append), so the only read of the JSONL is the prune read.
    storage.schedulePersist();
    await storage.flush();

    assert.equal(readAttempts, 2, 'prune read retried once after the transient EBUSY');
    assert.equal(storage.getPersistError(), null, 'a recovered prune read records no persist error');

    const raw = await fs.readFile(filePath, 'utf8');
    const kept = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    assert.equal(kept.length, 1, 'prune kept only the newest record after the retried read');
    assert.equal(JSON.parse(kept[0]!).run.runId, 'r2');
  });
});
