import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { mergeOutcomesStore } from '../install/lib/outcomes.mjs';

function writeJsonl(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${values.map((value) => JSON.stringify(value)).join('\n')}\n`, 'utf8');
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function run(runId, updatedAt) {
  return {
    schemaVersion: 2,
    kind: 'run_snapshot',
    recordedAt: updatedAt,
    run: { runId, updatedAt, startedAt: updatedAt },
  };
}

test('mergeOutcomesStore migrates sessions and completed runs while leaving retired reviews untouched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-outcomes-migration-'));
  const source = path.join(root, 'source', 'data', 'outcomes');
  const destination = path.join(root, 'destination', 'data', 'outcomes');
  try {
    writeJsonl(path.join(source, 'sessions', 'source.jsonl'), [
      { type: 'session', id: 'session-two', cwd: '/workspace/two', timestamp: '2026-08-02T00:00:00.000Z' },
    ]);
    writeJsonl(path.join(source, 'session-reviews', 'reviews.jsonl'), [
      { schemaVersion: 2, kind: 'production', sessionId: 'session-two', reviewId: 'retired-review' },
    ]);
    writeJsonl(path.join(source, 'session-reviews', 'closure-actions.jsonl'), [
      { actionId: 'close-two', status: 'succeeded' },
    ]);
    const workspace = 'aaaaaaaaaaaaaaaa';
    writeJsonl(path.join(destination, workspace, 'run-snapshots.jsonl'), [run('existing-newer', '2026-08-03T00:00:00.000Z')]);
    writeJsonl(path.join(source, workspace, 'run-snapshots.jsonl'), [
      run('existing-newer', '2026-08-01T00:00:00.000Z'),
      run('source-run', '2026-08-02T00:00:00.000Z'),
    ]);

    const first = mergeOutcomesStore({ sourceOutcomesRoot: source, destinationOutcomesRoot: destination });
    assert.equal(first.skipped, false);
    assert.equal(first.sessions.copied, 1);
    assert.equal(first.runStores[0].appended, 1);
    assert.equal(first.runStores[0].older, 1);

    assert.equal(fs.existsSync(path.join(destination, 'session-reviews')), false);
    assert.equal(readJsonl(path.join(source, 'session-reviews', 'reviews.jsonl'))[0].reviewId, 'retired-review');
    assert.equal(readJsonl(path.join(destination, workspace, 'run-snapshots.jsonl')).length, 2);

    const second = mergeOutcomesStore({ sourceOutcomesRoot: source, destinationOutcomesRoot: destination });
    assert.equal(second.runStores[0].appended, 0);
    assert.equal(fs.existsSync(path.join(destination, 'session-reviews')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
