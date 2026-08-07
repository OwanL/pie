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

function review(sessionId, reviewId) {
  return { schemaVersion: 2, kind: 'production', sessionId, reviewId };
}

function run(runId, updatedAt) {
  return {
    schemaVersion: 2,
    kind: 'run_snapshot',
    recordedAt: updatedAt,
    run: { runId, updatedAt, startedAt: updatedAt },
  };
}

test('mergeOutcomesStore keeps a conflicting fallback behind a malformed first review and remains idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-outcomes-migration-'));
  const source = path.join(root, 'source', 'data', 'outcomes');
  const destination = path.join(root, 'destination', 'data', 'outcomes');
  try {
    writeJsonl(path.join(source, 'sessions', 'source.jsonl'), [
      { type: 'session', id: 'session-two', cwd: '/workspace/two', timestamp: '2026-08-02T00:00:00.000Z' },
    ]);
    // Deliberately malformed V2 envelope: it has a canonical key but omits the
    // required ledger/provenance fields. The incoming candidate must still be
    // appended after it so first-*valid* readers can recover.
    writeJsonl(path.join(destination, 'session-reviews', 'reviews.jsonl'), [review('session-one', 'dest-review')]);
    writeJsonl(path.join(source, 'session-reviews', 'reviews.jsonl'), [
      review('session-one', 'conflicting-review'),
      review('session-two', 'source-review'),
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
    assert.equal(first.reviews.appended, 2, 'new review plus conflicting fallback candidate');
    assert.equal(first.reviews.conflicts, 1);
    assert.equal(first.reviews.quarantined, 1);
    assert.equal(first.closureActions.appended, 1);
    assert.equal(first.runStores[0].appended, 1);
    assert.equal(first.runStores[0].older, 1);

    const reviews = readJsonl(path.join(destination, 'session-reviews', 'reviews.jsonl'));
    assert.deepEqual(
      reviews.map((entry) => entry.reviewId),
      ['dest-review', 'conflicting-review', 'source-review'],
      'the destination remains first-write canonical while the incoming conflict can rescue an invalid envelope',
    );
    assert.equal(readJsonl(path.join(destination, 'migration-conflicts', 'reviews.jsonl')).length, 1);
    assert.equal(readJsonl(path.join(destination, workspace, 'run-snapshots.jsonl')).length, 2);

    const second = mergeOutcomesStore({ sourceOutcomesRoot: source, destinationOutcomesRoot: destination });
    assert.equal(second.reviews.appended, 0);
    assert.equal(second.reviews.quarantined, 0);
    assert.equal(second.closureActions.appended, 0);
    assert.equal(second.runStores[0].appended, 0);
    assert.equal(readJsonl(path.join(destination, 'migration-conflicts', 'reviews.jsonl')).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
