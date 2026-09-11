import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CanonicalAnalyticsCapture } from '../../src/analytics/canonical-capture.js';
import { SessionLifecycleStore } from '../../src/backend/session-lifecycle-store.js';
import { SqliteAnalyticsRecorder } from '../../src/analytics/sqlite-recorder.js';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-pending-create-races-'));
  const recorder = new SqliteAnalyticsRecorder(path.join(root, 'analytics.sqlite'));
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-pending-races',
    workspaceId: 'workspace-pending-races',
    buildId: 'build-pending-races',
    processGeneration: 'process-pending-races',
    sink: recorder,
    detailSink: recorder,
    lifecycleSink: {
      bindPendingCreate: async (...args) => recorder.bindPendingCreate(...args),
      deleteSession: async (...args) => recorder.deleteSession(...args),
    },
  });
  return { root, recorder, capture };
}

function capturePending(
  capture: CanonicalAnalyticsCapture,
  pendingPath: string,
  createOperationId: string,
  sourceKey: string,
  observedAtMs: number,
): void {
  assert.equal(capture.captureExecution(
    {
      sessionId: null,
      sessionPath: pendingPath,
      runId: null,
      operationId: createOperationId,
    },
    `execution:${sourceKey}`,
    'begin',
    sourceKey,
    observedAtMs,
    { source: 'host' },
  ), 'submitted');
}

test('close before bind fences the exact pending subject and a stale bind cannot resurrect it', async () => {
  const { root, recorder, capture } = fixture();
  try {
    capturePending(capture, 'pending:shared-alias', 'create-close-first', 'close-first', 100);
    await capture.closeSession('root-close-first', 'on', 101, 'create-close-first');
    await capture.bindPendingCreate('pending:shared-alias', 'root-close-first', 102, 'create-close-first');

    assert.equal(recorder.countObservations(), 0);
    assert.equal(
      capture.captureExecution(
        {
          sessionId: null,
          sessionPath: 'pending:shared-alias',
          runId: null,
          operationId: 'create-close-first',
        },
        'execution:late',
        'phase',
        'late-after-private-close',
        103,
        { source: 'host' },
      ),
      'rejected',
    );
    assert.equal(recorder.countObservations(), 0);
  } finally {
    recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('bind before close deletes only that create while a shared path alias remains isolated', async () => {
  const { root, recorder, capture } = fixture();
  try {
    capturePending(capture, 'pending:shared-alias', 'create-a', 'shared-alias-a', 200);
    capturePending(capture, 'pending:shared-alias', 'create-b', 'shared-alias-b', 201);
    await capture.bindPendingCreate('pending:shared-alias', 'root-a', 202, 'create-a');
    await capture.bindPendingCreate('pending:shared-alias', 'root-b', 203, 'create-b');
    await capture.closeSession('root-a', 'on', 204, 'create-a');

    assert.equal(recorder.countObservations(), 1, 'the unrelated create/root must remain');
    await capture.closeSession('root-b', 'on', 205, 'create-b');
    assert.equal(recorder.countObservations(), 0, 'the unrelated create remains independently deletable');
  } finally {
    recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('restart between origin persistence and deletion reuses the persisted create identity', async () => {
  const { root, recorder, capture } = fixture();
  const lifecyclePath = path.join(root, 'session-lifecycle.sqlite');
  let lifecycle = new SessionLifecycleStore(lifecyclePath);
  try {
    capturePending(capture, 'pending:restart-alias', 'create-before-restart', 'restart-pending', 300);
    lifecycle.registerPendingCreateOperation('root-after-restart', 'create-before-restart', 301);
    lifecycle.setPrivacyMode('root-after-restart', 'on', 302);
    lifecycle.resolveClose('root-after-restart', 'cleanup-after-restart', 303, 'private_close');

    lifecycle.close();
    lifecycle = new SessionLifecycleStore(lifecyclePath);
    const persisted = lifecycle.get('root-after-restart');
    assert.equal(persisted?.pendingCreateOperationId, 'create-before-restart');
    assert.notEqual(persisted?.pendingCreateOperationId, persisted?.cleanupOperationId);

    await capture.closeSession(
      'root-after-restart',
      'on',
      304,
      persisted?.pendingCreateOperationId,
    );
    await capture.bindPendingCreate(
      'pending:restart-alias',
      'root-after-restart',
      305,
      'create-before-restart',
    );

    assert.equal(recorder.countObservations(), 0);
    assert.equal(lifecycle.get('root-after-restart')?.cleanupState, 'deleting');
  } finally {
    lifecycle.close();
    recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});
