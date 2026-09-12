import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SessionFilesystemMutationBarrier, SessionLifecycleCleaner } from '../../src/backend/session-filesystem-lifecycle.js';
import { SessionLifecycleStore } from '../../src/backend/session-lifecycle-store.js';
import {
  STORAGE_CUTOFF_RECEIPT_FILENAME,
  performStorageCutoff,
  storageCutoffReceiptSha256,
} from '../../src/backend/storage-cutoff.js';

function tempCutoff() {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-storage-cutoff-'));
  const stateDir = path.join(root, 'state');
  const store = new SessionLifecycleStore(path.join(stateDir, 'session-lifecycle.sqlite'));
  const barrier = new SessionFilesystemMutationBarrier({
    store,
    lockRoot: path.join(stateDir, 'session-mutation-locks'),
  });
  const cleaner = new SessionLifecycleCleaner({
    store,
    barrier,
    // The cutoff coordinates closure and deadlines; it never deletes inside this
    // test, so the root only needs to be a real directory.
    roots: { sessions: path.join(root, 'sessions') },
  });
  return { root, stateDir, store, cleaner };
}

const CUTOFF_MS = 1_800_000_000_000;

test('the cutoff closes inventoried sessions and records their deadlines', async () => {
  const { root, stateDir, store, cleaner } = tempCutoff();
  try {
    store.registerTranscript('session-a', 'sessions/a.jsonl', CUTOFF_MS - 1_000);
    store.registerTranscript('session-b', 'sessions/b.jsonl', CUTOFF_MS - 1_000);

    const receipt = await performStorageCutoff({
      store,
      cleaner,
      stateDir,
      inventory: ['session-a', 'session-b'],
      operationId: 'cutoff-op-1',
      now: () => CUTOFF_MS,
    });

    assert.deepEqual([...receipt.closedSessionIds].sort(), ['session-a', 'session-b'], JSON.stringify(receipt.failures));
    assert.deepEqual(receipt.failures, []);
    assert.deepEqual(receipt.deletedSessionIds, [], 'an ordinary close must not delete yet');

    // The deadline is recorded and the data is left in place, which is the
    // expire-in-place contract: nothing is removed at cutoff time.
    const closed = store.get('session-a');
    assert.equal(closed?.disposition, 'retain');
    assert.ok(closed?.closedAtMs);
    assert.equal(
      closed?.expiresAtMs,
      String(BigInt(closed!.closedAtMs!) + 86_400_000n),
      'expiry must be exactly 24 hours after close',
    );

    // The receipt is durable and hashes to a stable value the manifest can name.
    const receiptPath = path.join(stateDir, STORAGE_CUTOFF_RECEIPT_FILENAME);
    assert.equal(existsSync(receiptPath), true);
    assert.equal(readFileSync(receiptPath, 'utf8'), `${JSON.stringify(receipt, null, 2)}\n`);
    assert.equal(storageCutoffReceiptSha256(receipt), storageCutoffReceiptSha256(receipt));
    assert.match(storageCutoffReceiptSha256(receipt), /^[0-9a-f]{64}$/u);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the cutoff can be re-run and does not reclose already closed sessions', async () => {
  const { root, stateDir, store, cleaner } = tempCutoff();
  try {
    store.registerTranscript('session-a', 'sessions/a.jsonl', CUTOFF_MS - 1_000);
    const first = await performStorageCutoff({
      store, cleaner, stateDir, inventory: ['session-a'], operationId: 'cutoff-op-1', now: () => CUTOFF_MS,
    });
    assert.deepEqual(first.closedSessionIds, ['session-a']);

    const second = await performStorageCutoff({
      store, cleaner, stateDir, inventory: ['session-a'], operationId: 'cutoff-op-2', now: () => CUTOFF_MS + 5_000,
    });
    assert.deepEqual(second.closedSessionIds, [], 'a closed session must not be closed again');
    assert.deepEqual(second.alreadyClosedSessionIds, ['session-a']);
    // The original deadline must survive the repeat, or an interrupted cutoff
    // would extend retention every time it was retried.
    const closed = store.get('session-a');
    assert.equal(second.completedAt, new Date(CUTOFF_MS + 5_000).toISOString());
    assert.ok(closed?.expiresAtMs);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unknown inventoried session is reported rather than silently skipped', async () => {
  const { root, stateDir, store, cleaner } = tempCutoff();
  try {
    const receipt = await performStorageCutoff({
      store,
      cleaner,
      stateDir,
      inventory: ['never-seen'],
      operationId: 'cutoff-op-1',
      now: () => CUTOFF_MS,
    });
    assert.deepEqual(receipt.closedSessionIds, []);
    assert.equal(receipt.failures.length, 1);
    assert.equal(receipt.failures[0]?.sessionId, 'never-seen');
    // Ambiguous ownership stays visible: the plan forbids inventing identity.
    assert.match(receipt.failures[0]?.error ?? '', /does not know/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('one failing session does not stop the rest of the cutoff', async () => {
  const { root, stateDir, store, cleaner } = tempCutoff();
  try {
    store.registerTranscript('session-a', 'sessions/a.jsonl', CUTOFF_MS - 1_000);
    store.registerTranscript('session-c', 'sessions/c.jsonl', CUTOFF_MS - 1_000);
    const receipt = await performStorageCutoff({
      store,
      cleaner,
      stateDir,
      inventory: ['session-a', 'missing-session', 'session-c'],
      operationId: 'cutoff-op-1',
      now: () => CUTOFF_MS,
    });
    assert.deepEqual([...receipt.closedSessionIds].sort(), ['session-a', 'session-c']);
    assert.equal(receipt.failures.length, 1);
    assert.equal(receipt.failures[0]?.sessionId, 'missing-session');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
