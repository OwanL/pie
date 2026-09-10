import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  SessionLifecycleStore,
  sessionRetentionDeadline,
} from '../../src/backend/session-lifecycle-store.js';

function tempDatabase(): { root: string; databasePath: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-session-lifecycle-'));
  return { root, databasePath: path.join(root, 'lifecycle.sqlite') };
}

test('privacy setting is reversible while open and the first close decision is frozen across hosts', () => {
  const temp = tempDatabase();
  const first = new SessionLifecycleStore(temp.databasePath);
  const second = new SessionLifecycleStore(temp.databasePath);
  try {
    first.setPrivacyMode('session-private', 'on', 100);
    first.setPrivacyMode('session-private', 'off', 101);
    second.setPrivacyMode('session-private', 'on', 102);

    const close = first.resolveClose('session-private', 'close-operation-1', 200);
    assert.equal(close.privacyMode, 'on');
    assert.equal(close.disposition, 'delete');
    assert.equal(close.cleanupState, 'deleting');
    assert.equal(close.expiresAtMs, undefined);
    assert.equal(close.writeEpoch, 1);
    assert.equal(close.duplicate, false);

    const duplicate = second.resolveClose('session-private', 'competing-close-operation', 999);
    assert.deepEqual(duplicate, { ...close, duplicate: true });
    assert.throws(() => second.setPrivacyMode('session-private', 'off', 1_000), /frozen after close/);

    const deleted = second.markDeleted('session-private', 250);
    assert.equal(deleted.cleanupState, 'deleted');
    assert.equal(first.get('session-private')?.cleanupState, 'deleted');
  } finally {
    first.close();
    second.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('privacy setting survives application shutdown without becoming an implicit close', () => {
  const temp = tempDatabase();
  let store = new SessionLifecycleStore(temp.databasePath);
  try {
    store.setPrivacyMode('session-restart', 'on', 100);
    store.close();
    store = new SessionLifecycleStore(temp.databasePath);
    const open = store.get('session-restart');
    assert.equal(open?.privacyMode, 'on');
    assert.equal(open?.closedAtMs, undefined);
    assert.equal(store.resolveClose('session-restart', 'close-after-restart', 200).disposition, 'delete');
  } finally {
    store.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('non-private close retains for exactly 24 hours using signed-64-bit timestamps', () => {
  const temp = tempDatabase();
  let store = new SessionLifecycleStore(temp.databasePath);
  try {
    const closedAt = '9007199254740993';
    const close = store.resolveClose('session-retained', 'close-operation-retained', closedAt);
    assert.equal(close.disposition, 'retain');
    assert.equal(close.expiresAtMs, sessionRetentionDeadline(closedAt));
    assert.deepEqual(store.listDue(BigInt(close.expiresAtMs) - 1n), []);
    assert.equal(store.listDue(close.expiresAtMs)[0]?.sessionId, 'session-retained');

    store.close();
    store = new SessionLifecycleStore(temp.databasePath);
    assert.deepEqual(store.resolveClose('session-retained', 'restart-retry', 1), {
      ...close,
      duplicate: true,
    });
  } finally {
    store.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});
