import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionLifecycleStore } from '../../harness/session-storage/lifecycle/session-lifecycle-store.js';
import { SessionFilesystemMutationBarrier, SessionLifecycleCleaner } from '../../harness/session-storage/lifecycle/session-filesystem-lifecycle.js';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-cleanup-claim-'));
  const sessions = path.join(root, 'sessions');
  mkdirSync(sessions);
  const store = new SessionLifecycleStore(path.join(root, 'lifecycle.sqlite'));
  const barrier = new SessionFilesystemMutationBarrier({ store, lockRoot: path.join(root, 'locks') });
  const transcript = path.join(sessions, 'session.jsonl');
  writeFileSync(transcript, 'fixture');
  store.registerTranscript('session', 'session.jsonl', 1);
  store.registerArtifact({ sessionId: 'session', artifactId: 'transcript', kind: 'transcript', locationKind: 'root_relative', rootName: 'sessions', location: 'session.jsonl' }, 1);
  store.resolveClose('session', 'close', 2);
  return { root, sessions, store, barrier, transcript, dispose() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('registered transcript lookup survives unlink and deletion, normalizes aliases and rejects collisions', async () => {
  const f = fixture();
  try {
    rmSync(f.transcript);
    const roots = { sessions: f.sessions };
    const alias = path.join(f.sessions, 'nested', '..', 'session.jsonl');
    assert.equal(f.store.findByRegisteredTranscriptPath(alias, roots)?.sessionId, 'session');
    if (process.platform === 'win32') assert.equal(f.store.findByRegisteredTranscriptPath(alias.toUpperCase(), roots)?.sessionId, 'session');
    assert.equal(f.store.findByRegisteredTranscriptPath(path.join(f.sessions + '-sibling', 'session.jsonl'), roots), undefined);
    await new SessionLifecycleCleaner({ store: f.store, barrier: f.barrier, roots }).cleanupSession('session', 'cleanup');
    assert.equal(f.store.findByRegisteredTranscriptPath(alias, roots)?.cleanupState, 'deleted');
    f.store.registerTranscript('other', 'session.jsonl', 3);
    f.store.registerArtifact({ sessionId: 'other', artifactId: 'transcript', kind: 'transcript', locationKind: 'root_relative', rootName: 'sessions', location: 'session.jsonl' }, 3);
    assert.throws(() => f.store.findByRegisteredTranscriptPath(alias, roots), /Ambiguous/);
    assert.throws(() => f.store.registerArtifact({ sessionId: 'other', artifactId: 'escape', kind: 'transcript', locationKind: 'root_relative', rootName: 'sessions', location: '../escape' }, 3), /parent/);
  } finally { f.dispose(); }
});

test('cleanup hook runs after claim and before cleanup; hook failure blocks cleanup and failed claim never calls hook', async () => {
  const f = fixture();
  let calls = 0;
  try {
    const cleaner = new SessionLifecycleCleaner({
      store: f.store, barrier: f.barrier, roots: { sessions: f.sessions },
      onCleanupClaimed: (claim) => {
        calls++;
        assert.equal(claim.cleanupState, 'deleting');
        assert.equal(f.store.get('session')?.cleanupOperationId, 'cleanup');
        assert.equal(existsSync(f.transcript), true);
        throw new Error('invalidation failed');
      },
    });
    await assert.rejects(cleaner.cleanupSession('session', 'cleanup'), /invalidation failed/);
    assert.equal(f.store.get('session')?.cleanupState, 'blocked');
    assert.equal(existsSync(f.transcript), true);
    await assert.rejects(cleaner.cleanupSession('unregistered', 'failed'));
    assert.equal(calls, 1);
  } finally { f.dispose(); }
});
