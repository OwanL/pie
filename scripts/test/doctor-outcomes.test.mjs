import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { collectPostMigrationOutcomeDrift } from '../doctor-outcomes.mjs';
import { mergeOutcomesStore, readRegisteredOutcomeSources } from '../install/lib/outcomes.mjs';

function writeJsonl(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${values.map((value) => JSON.stringify(value)).join('\n')}\n`, 'utf8');
}

function waitForClockTick() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}

test('first registry write preserves a legacy receipt source alongside the new source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-doctor-outcomes-legacy-'));
  const sourceA = path.join(root, 'source-a', 'data', 'outcomes');
  const sourceB = path.join(root, 'source-b', 'data', 'outcomes');
  const destination = path.join(root, 'destination', 'data', 'outcomes');
  try {
    fs.mkdirSync(path.join(destination, 'migration-conflicts'), { recursive: true });
    fs.mkdirSync(sourceA, { recursive: true });
    fs.mkdirSync(sourceB, { recursive: true });
    fs.writeFileSync(path.join(destination, 'migration-conflicts', 'last-outcomes-migration.json'), `${JSON.stringify({
      sourceRoot: path.resolve(sourceA),
      migrationStartedAt: '2026-08-01T00:00:00.000Z',
      migratedAt: '2026-08-01T00:00:01.000Z',
    })}\n`, 'utf8');

    mergeOutcomesStore({ sourceOutcomesRoot: sourceB, destinationOutcomesRoot: destination });

    assert.deepEqual(
      readRegisteredOutcomeSources(destination).map((entry) => entry.sourceRoot).sort(),
      [path.resolve(sourceA), path.resolve(sourceB)].sort(),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('post-migration outcome writes are detected until the displaced store is reconciled again', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-doctor-outcomes-'));
  const source = path.join(root, 'source', 'data', 'outcomes');
  const destination = path.join(root, 'destination', 'data', 'outcomes');
  const runFile = path.join(source, 'aaaaaaaaaaaaaaaa', 'run-snapshots.jsonl');
  try {
    writeJsonl(runFile, [{
      schemaVersion: 2, kind: 'run_snapshot', recordedAt: '2026-08-01T00:00:00.000Z',
      run: { runId: 'run-one', startedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
    }]);
    // Keep the fixture away from the filesystem/ISO millisecond boundary; this
    // assertion tests post-migration drift, not timestamp-resolution jitter.
    waitForClockTick();
    mergeOutcomesStore({ sourceOutcomesRoot: source, destinationOutcomesRoot: destination });
    assert.deepEqual(readRegisteredOutcomeSources(destination).map((entry) => entry.sourceRoot), [path.resolve(source)]);
    assert.equal(collectPostMigrationOutcomeDrift({ canonicalOutcomesRoot: destination }).changedFileCount, 0);

    // Older canonical stores have only the last receipt; discovery must retain
    // that source until the next merge creates the registry.
    fs.rmSync(path.join(destination, 'migration-conflicts', 'outcomes-migration-sources.json'));
    assert.deepEqual(readRegisteredOutcomeSources(destination).map((entry) => entry.sourceRoot), [path.resolve(source)]);

    waitForClockTick();
    fs.appendFileSync(runFile, `${JSON.stringify({
      schemaVersion: 2, kind: 'run_snapshot', recordedAt: '2026-08-02T00:00:00.000Z',
      run: { runId: 'run-two', startedAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z' },
    })}\n`, 'utf8');
    const drift = collectPostMigrationOutcomeDrift({ canonicalOutcomesRoot: destination });
    assert.equal(drift.changedFileCount, 1);
    assert.deepEqual(drift.sources[0].changedFiles, [path.join('aaaaaaaaaaaaaaaa', 'run-snapshots.jsonl')]);

    waitForClockTick();
    mergeOutcomesStore({ sourceOutcomesRoot: source, destinationOutcomesRoot: destination });
    assert.equal(collectPostMigrationOutcomeDrift({ canonicalOutcomesRoot: destination }).changedFileCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
