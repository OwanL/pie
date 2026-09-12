import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SessionFilesystemMutationBarrier, SessionLifecycleCleaner } from '../../src/backend/session-filesystem-lifecycle.js';
import { SessionLifecycleStore } from '../../src/backend/session-lifecycle-store.js';
import {
  STORAGE_CUTOFF_AUTHORIZATION_ENV,
  STORAGE_CUTOFF_AUTHORIZATION_VALUE,
  STORAGE_CUTOFF_JOURNAL_FILENAME,
  STORAGE_CUTOFF_RECEIPT_FILENAME,
  performStorageCutoff,
  storageCutoffReceiptSha256,
} from '../../src/backend/storage-cutoff.js';

function authorizeCutoff() {
  const previous = process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV];
  process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] = STORAGE_CUTOFF_AUTHORIZATION_VALUE;
  return () => {
    if (previous === undefined) delete process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV];
    else process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] = previous;
  };
}

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
  return { root, stateDir, store, barrier, cleaner };
}

const CUTOFF_MS = 1_800_000_000_000;

test('the cutoff closes inventoried sessions and records their deadlines', async () => {
  const { root, stateDir, store, cleaner } = tempCutoff();
  const restoreAuthorization = authorizeCutoff();
  try {
    store.registerTranscript('session-a', 'sessions/a.jsonl', CUTOFF_MS - 1_000);
    store.registerTranscript('session-b', 'sessions/b.jsonl', CUTOFF_MS - 1_000);

    const receipt = await performStorageCutoff({
      store,
      cleaner,
      stateDir,
      inventory: ['session-a', 'session-b'],
      inventoryValidated: true,
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
    assert.equal(existsSync(path.join(stateDir, STORAGE_CUTOFF_JOURNAL_FILENAME)), true);
  } finally {
    restoreAuthorization();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the cutoff can be re-run and does not reclose already closed sessions', async () => {
  const { root, stateDir, store, cleaner } = tempCutoff();
  const restoreAuthorization = authorizeCutoff();
  try {
    store.registerTranscript('session-a', 'sessions/a.jsonl', CUTOFF_MS - 1_000);
    const first = await performStorageCutoff({
      store, cleaner, stateDir, inventory: ['session-a'], inventoryValidated: true, operationId: 'cutoff-op-1', now: () => CUTOFF_MS,
    });
    assert.deepEqual(first.closedSessionIds, ['session-a']);

    const second = await performStorageCutoff({
      store, cleaner, stateDir, inventory: ['session-a'], inventoryValidated: true, operationId: 'cutoff-op-1', now: () => CUTOFF_MS + 5_000,
    });
    assert.deepEqual(second, first, 'an exact retry must return the durable receipt without changing its timestamp');
    // The original deadline must survive the repeat, or an interrupted cutoff
    // would extend retention every time it was retried.
    const closed = store.get('session-a');
    assert.ok(closed?.expiresAtMs);
  } finally {
    restoreAuthorization();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unknown inventoried session is reported rather than silently skipped', async () => {
  const { root, stateDir, store, cleaner } = tempCutoff();
  const restoreAuthorization = authorizeCutoff();
  try {
    const receipt = await performStorageCutoff({
      store,
      cleaner,
      stateDir,
      inventory: ['never-seen'],
      inventoryValidated: true,
      operationId: 'cutoff-op-1',
      now: () => CUTOFF_MS,
    });
    assert.deepEqual(receipt.closedSessionIds, []);
    assert.equal(receipt.failures.length, 1);
    assert.equal(receipt.failures[0]?.sessionId, 'never-seen');
    // Ambiguous ownership stays visible: the plan forbids inventing identity.
    assert.match(receipt.failures[0]?.error ?? '', /does not know/);
  } finally {
    restoreAuthorization();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('one failing session does not stop the rest of the cutoff', async () => {
  const { root, stateDir, store, cleaner } = tempCutoff();
  const restoreAuthorization = authorizeCutoff();
  try {
    store.registerTranscript('session-a', 'sessions/a.jsonl', CUTOFF_MS - 1_000);
    store.registerTranscript('session-c', 'sessions/c.jsonl', CUTOFF_MS - 1_000);
    const receipt = await performStorageCutoff({
      store,
      cleaner,
      stateDir,
      inventory: ['session-a', 'missing-session', 'session-c'],
      inventoryValidated: true,
      operationId: 'cutoff-op-1',
      now: () => CUTOFF_MS,
    });
    assert.deepEqual([...receipt.closedSessionIds].sort(), ['session-a', 'session-c']);
    assert.equal(receipt.failures.length, 1);
    assert.equal(receipt.failures[0]?.sessionId, 'missing-session');
  } finally {
    restoreAuthorization();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('authorization and explicit inventory validation fail closed before journaling', async () => {
  const { root, stateDir, store, cleaner } = tempCutoff();
  try {
    store.registerTranscript('session-a', 'sessions/a.jsonl', CUTOFF_MS - 1_000);
    await assert.rejects(
      performStorageCutoff({
        store,
        cleaner,
        stateDir,
        inventory: ['session-a'],
        inventoryValidated: true,
        operationId: 'cutoff-op-auth',
        now: () => CUTOFF_MS,
      }),
      /requires PIE_STORAGE_CUTOFF_AUTHORIZATION/,
    );
    assert.equal(store.get('session-a')?.closedAtMs ?? null, null);
    assert.equal(existsSync(path.join(stateDir, STORAGE_CUTOFF_JOURNAL_FILENAME)), false);

    const restoreAuthorization = authorizeCutoff();
    try {
      await assert.rejects(
        performStorageCutoff({
          store,
          cleaner,
          stateDir,
          inventory: ['session-a'],
          inventoryValidated: false,
          operationId: 'cutoff-op-auth',
          now: () => CUTOFF_MS,
        }),
        /missing explicit validation evidence/,
      );
      assert.equal(store.get('session-a')?.closedAtMs ?? null, null);
      assert.equal(existsSync(path.join(stateDir, STORAGE_CUTOFF_JOURNAL_FILENAME)), false);
    } finally {
      restoreAuthorization();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an empty validated inventory is a durable successful no-session cutoff', async () => {
  const { root, stateDir, store, cleaner } = tempCutoff();
  const restoreAuthorization = authorizeCutoff();
  try {
    const receipt = await performStorageCutoff({
      store,
      cleaner,
      stateDir,
      inventory: [],
      inventoryValidated: true,
      operationId: 'cutoff-op-empty',
      now: () => CUTOFF_MS,
    });
    assert.deepEqual(receipt.closedSessionIds, []);
    assert.deepEqual(receipt.alreadyClosedSessionIds, []);
    assert.deepEqual(receipt.deletedSessionIds, []);
    assert.deepEqual(receipt.failures, []);
    assert.equal(JSON.parse(readFileSync(path.join(stateDir, STORAGE_CUTOFF_JOURNAL_FILENAME), 'utf8')).status, 'complete');
    assert.deepEqual(await performStorageCutoff({
      store,
      cleaner,
      stateDir,
      inventory: [],
      inventoryValidated: true,
      operationId: 'cutoff-op-empty',
      now: () => CUTOFF_MS + 1_000,
    }), receipt, 'an empty cutoff receipt is idempotent too');
  } finally {
    restoreAuthorization();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an interrupted operation resumes its frozen inventory and rejects changes', async () => {
  const { root, stateDir, store, cleaner } = tempCutoff();
  const restoreAuthorization = authorizeCutoff();
  try {
    store.registerTranscript('session-a', 'sessions/a.jsonl', CUTOFF_MS - 1_000);
    store.registerTranscript('session-b', 'sessions/b.jsonl', CUTOFF_MS - 1_000);
    let interrupted = false;
    await assert.rejects(
      performStorageCutoff({
        store,
        cleaner,
        stateDir,
        inventory: ['session-a', 'session-b'],
        inventoryValidated: true,
        operationId: 'cutoff-op-resume',
        now: () => CUTOFF_MS,
        afterSession: (sessionId) => {
          if (sessionId === 'session-a' && !interrupted) {
            interrupted = true;
            throw new Error('simulated interruption');
          }
        },
      }),
      /simulated interruption/,
    );
    assert.ok(store.get('session-a')?.closedAtMs);
    assert.equal(store.get('session-b')?.closedAtMs ?? null, null);

    await assert.rejects(
      performStorageCutoff({
        store,
        cleaner,
        stateDir,
        inventory: ['session-a'],
        inventoryValidated: true,
        operationId: 'cutoff-op-resume',
        now: () => CUTOFF_MS,
      }),
      /does not match the frozen write-ahead journal/,
    );
    assert.equal(store.get('session-b')?.closedAtMs ?? null, null);

    const resumed = await performStorageCutoff({
      store,
      cleaner,
      stateDir,
      inventory: ['session-a', 'session-b'],
      inventoryValidated: true,
      operationId: 'cutoff-op-resume',
      now: () => CUTOFF_MS + 1_000,
    });
    assert.deepEqual(resumed.closedSessionIds, ['session-a', 'session-b']);
    assert.deepEqual(resumed.failures, []);
    assert.deepEqual(await performStorageCutoff({
      store,
      cleaner,
      stateDir,
      inventory: ['session-b', 'session-a'],
      inventoryValidated: true,
      operationId: 'cutoff-op-resume',
      now: () => CUTOFF_MS + 2_000,
    }), resumed, 'an exact retry returns the same receipt');
  } finally {
    restoreAuthorization();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('partial failures remain visible and can be retried without re-closing successes', async () => {
  const { root, stateDir, store, cleaner } = tempCutoff();
  const restoreAuthorization = authorizeCutoff();
  try {
    store.registerTranscript('session-a', 'sessions/a.jsonl', CUTOFF_MS - 1_000);
    const partial = await performStorageCutoff({
      store,
      cleaner,
      stateDir,
      inventory: ['session-a', 'missing-session'],
      inventoryValidated: true,
      operationId: 'cutoff-op-partial',
      now: () => CUTOFF_MS,
    });
    assert.deepEqual(partial.closedSessionIds, ['session-a']);
    assert.equal(partial.failures.length, 1);
    assert.equal(JSON.parse(readFileSync(path.join(stateDir, STORAGE_CUTOFF_JOURNAL_FILENAME), 'utf8')).status, 'partial');

    const repeatedPartial = await performStorageCutoff({
      store,
      cleaner,
      stateDir,
      inventory: ['session-a', 'missing-session'],
      inventoryValidated: true,
      operationId: 'cutoff-op-partial',
      now: () => CUTOFF_MS + 500,
    });
    assert.deepEqual(repeatedPartial, partial, 'an unchanged partial receipt remains idempotent while it awaits repair');

    store.registerTranscript('missing-session', 'sessions/missing.jsonl', CUTOFF_MS - 1_000);
    const recovered = await performStorageCutoff({
      store,
      cleaner,
      stateDir,
      inventory: ['session-a', 'missing-session'],
      inventoryValidated: true,
      operationId: 'cutoff-op-partial',
      now: () => CUTOFF_MS + 1_000,
    });
    assert.deepEqual([...recovered.closedSessionIds].sort(), ['session-a', 'missing-session'].sort());
    assert.deepEqual(recovered.failures, []);
  } finally {
    restoreAuthorization();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('private sessions fail before any close without the canonical deletion adapter', async () => {
  const { root, stateDir, store, barrier, cleaner } = tempCutoff();
  const restoreAuthorization = authorizeCutoff();
  try {
    store.registerTranscript('private-session', 'sessions/private.jsonl', CUTOFF_MS - 1_000);
    store.setPrivacyMode('private-session', 'on', CUTOFF_MS);
    await assert.rejects(
      performStorageCutoff({
        store,
        cleaner,
        stateDir,
        inventory: ['private-session'],
        inventoryValidated: true,
        operationId: 'cutoff-op-private',
        now: () => CUTOFF_MS,
      }),
      /refusing partial cutoff/,
    );
    assert.equal(store.get('private-session')?.closedAtMs ?? null, null);

    let deleted = 0;
    const analytics = { deleteSession: () => { deleted += 1; } };
    const privateCleaner = new SessionLifecycleCleaner({
      store,
      barrier,
      roots: { sessions: path.join(root, 'sessions') },
      analytics,
    });
    const receipt = await performStorageCutoff({
      store,
      cleaner: privateCleaner,
      analytics,
      stateDir,
      inventory: ['private-session'],
      inventoryValidated: true,
      operationId: 'cutoff-op-private',
      now: () => CUTOFF_MS + 1_000,
    });
    assert.deepEqual(receipt.deletedSessionIds, ['private-session']);
    assert.deepEqual(receipt.failures, []);
    assert.equal(deleted, 1);
  } finally {
    restoreAuthorization();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a previously closed private session retries blocked cleanup under its original close identity', async () => {
  const { root, stateDir, store, barrier } = tempCutoff();
  const restoreAuthorization = authorizeCutoff();
  try {
    store.registerTranscript('private-session', 'sessions/private.jsonl', CUTOFF_MS - 1_000);
    store.setPrivacyMode('private-session', 'on', CUTOFF_MS);
    const failingCleaner = new SessionLifecycleCleaner({
      store,
      barrier,
      roots: { sessions: path.join(root, 'sessions') },
      analytics: { deleteSession: () => { throw new Error('analytics temporarily unavailable'); } },
      now: () => CUTOFF_MS,
    });
    await assert.rejects(
      failingCleaner.closeSession('private-session', 'original-close', 'private_close'),
      /analytics temporarily unavailable/,
    );
    const blocked = store.get('private-session');
    assert.equal(blocked?.closeOperationId, 'original-close');
    assert.equal(blocked?.cleanupState, 'blocked');
    assert.equal(blocked?.closedAtMs, String(CUTOFF_MS));

    const deletionCalls: string[] = [];
    const recoveringCleaner = new SessionLifecycleCleaner({
      store,
      barrier,
      roots: { sessions: path.join(root, 'sessions') },
      analytics: {
        deleteSession: (sessionId: string, sourceKey: string) => {
          deletionCalls.push(`${sessionId}:${sourceKey}`);
        },
      },
      now: () => CUTOFF_MS + 1_000,
    });
    const receipt = await performStorageCutoff({
      store,
      cleaner: recoveringCleaner,
      stateDir,
      inventory: ['private-session'],
      inventoryValidated: true,
      operationId: 'new-cutoff-operation',
      now: () => CUTOFF_MS + 1_000,
    });
    assert.deepEqual(receipt.closedSessionIds, ['private-session']);
    assert.deepEqual(receipt.deletedSessionIds, ['private-session']);
    assert.deepEqual(receipt.failures, []);
    assert.deepEqual(deletionCalls, ['private-session:session-lifecycle:original-close']);
    const recovered = store.get('private-session');
    assert.equal(recovered?.closeOperationId, 'original-close');
    assert.equal(recovered?.closedAtMs, String(CUTOFF_MS));
    assert.equal(recovered?.cleanupState, 'deleted');
  } finally {
    restoreAuthorization();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent retries serialize on one cutoff operation and replay one receipt', async () => {
  const { root, stateDir, store, cleaner } = tempCutoff();
  const restoreAuthorization = authorizeCutoff();
  try {
    store.registerTranscript('session-a', 'sessions/a.jsonl', CUTOFF_MS - 1_000);
    const options = {
      store,
      cleaner,
      stateDir,
      inventory: ['session-a'],
      inventoryValidated: true,
      operationId: 'cutoff-op-concurrent',
      now: () => CUTOFF_MS,
      afterSession: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 75));
      },
    };
    const [first, second] = await Promise.all([
      performStorageCutoff(options),
      performStorageCutoff({ ...options, afterSession: undefined }),
    ]);
    assert.deepEqual(second, first, 'a concurrent retry must replay the first durable receipt');
    assert.equal(JSON.parse(readFileSync(path.join(stateDir, STORAGE_CUTOFF_JOURNAL_FILENAME), 'utf8')).status, 'complete');
  } finally {
    restoreAuthorization();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a successful receipt survives a crash before the final journal status write', async () => {
  const { root, stateDir, store, cleaner } = tempCutoff();
  const restoreAuthorization = authorizeCutoff();
  try {
    store.registerTranscript('session-a', 'sessions/a.jsonl', CUTOFF_MS - 1_000);
    const first = await performStorageCutoff({
      store, cleaner, stateDir, inventory: ['session-a'], inventoryValidated: true, operationId: 'cutoff-op-crash', now: () => CUTOFF_MS,
    });
    const receiptPath = path.join(stateDir, STORAGE_CUTOFF_RECEIPT_FILENAME);
    const receiptBytes = readFileSync(receiptPath, 'utf8');
    const journalPath = path.join(stateDir, STORAGE_CUTOFF_JOURNAL_FILENAME);
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Record<string, unknown>;
    journal.status = 'in-progress';
    delete journal.receiptSha256;
    writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

    const resumed = await performStorageCutoff({
      store, cleaner, stateDir, inventory: ['session-a'], inventoryValidated: true, operationId: 'cutoff-op-crash', now: () => CUTOFF_MS + 1_000,
    });
    assert.deepEqual(resumed, first);
    assert.equal(readFileSync(receiptPath, 'utf8'), receiptBytes, 'the existing terminal receipt bytes must be replayed');
    assert.equal(JSON.parse(readFileSync(journalPath, 'utf8')).status, 'complete');
  } finally {
    restoreAuthorization();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a complete journal must agree with its receipt outcomes', async () => {
  const { root, stateDir, store, cleaner } = tempCutoff();
  const restoreAuthorization = authorizeCutoff();
  try {
    store.registerTranscript('session-a', 'sessions/a.jsonl', CUTOFF_MS - 1_000);
    const receipt = await performStorageCutoff({
      store, cleaner, stateDir, inventory: ['session-a'], inventoryValidated: true, operationId: 'cutoff-op-corrupt', now: () => CUTOFF_MS,
    });
    const journalPath = path.join(stateDir, STORAGE_CUTOFF_JOURNAL_FILENAME);
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Record<string, unknown>;
    journal.outcomes = {};
    journal.receiptSha256 = storageCutoffReceiptSha256(receipt);
    writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    await assert.rejects(
      performStorageCutoff({
        store, cleaner, stateDir, inventory: ['session-a'], inventoryValidated: true, operationId: 'cutoff-op-corrupt', now: () => CUTOFF_MS + 1_000,
      }),
      /no outcome|outcomes do not match/u,
    );
  } finally {
    restoreAuthorization();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the private capability is checked inside the close barrier after inventory preflight', async () => {
  const { root, stateDir, store, cleaner } = tempCutoff();
  const restoreAuthorization = authorizeCutoff();
  try {
    store.registerTranscript('private-session', 'sessions/private.jsonl', CUTOFF_MS - 1_000);
    const racedStore = Object.create(store) as SessionLifecycleStore & { get: SessionLifecycleStore['get'] };
    let firstRead = true;
    racedStore.get = (sessionId: string) => {
      const record = store.get(sessionId);
      if (firstRead) {
        firstRead = false;
        store.setPrivacyMode(sessionId, 'on', CUTOFF_MS + 1);
      }
      return record;
    };
    const receipt = await performStorageCutoff({
      store: racedStore,
      cleaner,
      stateDir,
      inventory: ['private-session'],
      inventoryValidated: true,
      operationId: 'cutoff-op-capability-race',
      now: () => CUTOFF_MS + 2,
    });
    assert.equal(receipt.failures.length, 1);
    assert.equal(store.get('private-session')?.closedAtMs ?? null, null, 'the race must fail before lifecycle closure');
  } finally {
    restoreAuthorization();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a dead cutoff operation owner is reclaimed, while ownership remains transient', async () => {
  const { root, stateDir, store, cleaner } = tempCutoff();
  const restoreAuthorization = authorizeCutoff();
  try {
    const lockPath = path.join(stateDir, '.storage-cutoff-operation-v1.lock');
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify({
      schemaVersion: 1,
      pid: 999_999,
      token: 'dead-owner',
      operationId: 'old-operation',
      acquiredAtMs: CUTOFF_MS,
    })}\n`);
    const receipt = await performStorageCutoff({
      store, cleaner, stateDir, inventory: [], inventoryValidated: true, operationId: 'cutoff-op-reclaim', now: () => CUTOFF_MS,
    });
    assert.deepEqual(receipt.failures, []);
    assert.equal(existsSync(lockPath), false);
  } finally {
    restoreAuthorization();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('mutation barrier rejects malformed, cross-session, and invalid-PID owner evidence', () => {
  const { root, stateDir, store, barrier } = tempCutoff();
  const cases = [
    {
      sessionId: 'malformed-owner',
      owner: { schema: 1, pid: 999_999, token: 'owner-token', sessionId: 'malformed-owner' },
    },
    {
      sessionId: 'unrelated-owner',
      owner: { schema: 1, pid: 999_999, token: 'owner-token', sessionId: 'another-session', acquiredAtMs: 0 },
    },
    {
      sessionId: 'invalid-pid-owner',
      owner: { schema: 1, pid: 0, token: 'owner-token', sessionId: 'invalid-pid-owner', acquiredAtMs: 0 },
    },
  ] as const;
  try {
    for (const { sessionId, owner } of cases) {
      const key = createHash('sha256').update(sessionId).digest('hex');
      const lockPath = path.join(stateDir, 'session-mutation-locks', `${key}.lock`);
      mkdirSync(lockPath, { recursive: true });
      writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify(owner)}\n`);
      assert.throws(
        () => barrier.runAdministrative(sessionId, 'owner-evidence-test', () => undefined),
        /owner evidence/,
      );
      assert.equal(existsSync(lockPath), true, `unsafe owner lock was reclaimed for ${sessionId}`);
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
