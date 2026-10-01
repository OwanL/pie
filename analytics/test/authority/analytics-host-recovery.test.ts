import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  recoverStaleAnalyticsHosts,
  type AnalyticsHostRecoveryOptions,
} from '../../authority/analytics-host-recovery.js';
import type { AnalyticsHostRecord, AnalyticsWriterIdentity } from '../../authority/session-lifecycle-writer-store.js';
import type { ProcessOwnerReadResult } from '../../authority/process-census.js';
import { SessionLifecycleStore } from '../../../harness/session-storage/lifecycle/session-lifecycle-store.js';

const WORKSPACE_ID = 'workspace-host-recovery';
const NOW = 50_000;

type TemporaryStore = { root: string; store: SessionLifecycleStore };

function temporaryStore(): TemporaryStore {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-host-recovery-'));
  return { root, store: new SessionLifecycleStore(path.join(root, 'state', 'session-lifecycle.sqlite')) };
}

function registerHost(
  store: SessionLifecycleStore,
  hostInstanceId: string,
  processId: number,
  registeredAtMs = 1_000,
): AnalyticsHostRecord {
  return store.registerAnalyticsHost({
    hostInstanceId,
    workspaceId: WORKSPACE_ID,
    generationId: `generation-${hostInstanceId}`,
    buildId: `build-${hostInstanceId}`,
    processId,
    capabilities: ['host-discovery'],
    registeredAtMs: String(registeredAtMs),
  });
}

function writerIdentity(host: AnalyticsHostRecord): AnalyticsWriterIdentity {
  return {
    hostInstanceId: host.hostInstanceId,
    workspaceId: host.workspaceId,
    generationId: host.generationId,
    buildId: host.buildId,
    processId: host.processId,
  };
}

function stopHost(store: SessionLifecycleStore, host: AnalyticsHostRecord): void {
  store.markAnalyticsHostState(host.hostInstanceId, host.processId, host.generationId, 'stopped', NOW - 1);
}

function census(
  details: Partial<ProcessOwnerReadResult> = {},
): ProcessOwnerReadResult {
  return {
    processes: [],
    backendOwners: [],
    complete: true,
    reasons: [],
    ...details,
  };
}

function options(
  store: SessionLifecycleStore,
  processCensus: ProcessOwnerReadResult,
  extra: Partial<AnalyticsHostRecoveryOptions> = {},
): AnalyticsHostRecoveryOptions {
  return {
    registry: store,
    workspaceId: WORKSPACE_ID,
    readProcessCensus: async () => processCensus,
    now: () => NOW,
    ...extra,
  };
}

function closeTemporary(temporary: TemporaryStore): void {
  temporary.store.close();
  rmSync(temporary.root, { recursive: true, force: true });
}

test('recovers a stopped host only when its exact identity has an orphaned writer lease', async () => {
  const temporary = temporaryStore();
  const host = registerHost(temporary.store, 'stopped-orphan', 701);
  const lease = temporary.store.acquireAnalyticsWriterLease(writerIdentity(host), 0, NOW - 2);
  stopHost(temporary.store, host);
  const logs: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];

  try {
    const result = await recoverStaleAnalyticsHosts(options(temporary.store, census(), {
      log: (level, message, data) => logs.push({ level, message, data }),
    }));

    assert.deepEqual(result, { retiredHosts: 0, reclaimedLeases: 1 });
    assert.equal(temporary.store.getAnalyticsHost(host.hostInstanceId)?.state, 'stopped');
    assert.deepEqual(temporary.store.listAnalyticsWriterLeases(WORKSPACE_ID), []);
    assert.ok(logs.some(({ level, message, data }) => level === 'info'
      && message === 'reclaimed orphaned writer leases from stopped hosts'
      && data?.count === 1));
    assert.equal(lease.hostInstanceId, host.hostInstanceId);
  } finally {
    closeTemporary(temporary);
  }
});

test('does not recover a host registered after process census collection begins', async () => {
  const temporary = temporaryStore();
  let lateHost: AnalyticsHostRecord | undefined;
  try {
    const result = await recoverStaleAnalyticsHosts({
      ...options(temporary.store, census()),
      readProcessCensus: async () => {
        // This writer was not present in the OS snapshot being returned, but
        // registered while collection was in flight. Its absence proves nothing.
        lateHost = registerHost(temporary.store, 'registered-during-census', 710);
        temporary.store.acquireAnalyticsWriterLease(writerIdentity(lateHost), 0, NOW - 1);
        return census();
      },
    });
    assert.deepEqual(result, { retiredHosts: 0, reclaimedLeases: 0 });
    assert.equal(temporary.store.getAnalyticsHost(lateHost!.hostInstanceId)?.state, 'registered');
    assert.equal(temporary.store.listAnalyticsWriterLeases(WORKSPACE_ID).length, 1);
  } finally {
    closeTemporary(temporary);
  }
});

test('keeps active and unknown-birth host PIDs and their leases', async () => {
  const temporary = temporaryStore();
  const active = registerHost(temporary.store, 'active-pid', 702, 1_000);
  const unknownBirth = registerHost(temporary.store, 'unknown-pid-birth', 703, 1_000);
  temporary.store.acquireAnalyticsWriterLease(writerIdentity(active), 0, NOW - 2);
  temporary.store.acquireAnalyticsWriterLease(writerIdentity(unknownBirth), 0, NOW - 1);

  try {
    const result = await recoverStaleAnalyticsHosts(options(temporary.store, census({
      processes: [
        { processId: active.processId, processCreatedAtMs: 1_000 },
        { processId: unknownBirth.processId, processCreatedAtMs: null },
      ],
    })));

    assert.deepEqual(result, { retiredHosts: 0, reclaimedLeases: 0 });
    assert.equal(temporary.store.getAnalyticsHost(active.hostInstanceId)?.state, 'registered');
    assert.equal(temporary.store.getAnalyticsHost(unknownBirth.hostInstanceId)?.state, 'registered');
    assert.equal(temporary.store.listAnalyticsWriterLeases(WORKSPACE_ID).length, 2);
  } finally {
    closeTemporary(temporary);
  }
});

test('a stopped marker never permits cleanup while host or child writer evidence remains', async (t) => {
  const evidence: Record<string, ProcessOwnerReadResult> = {
    'live host': census({ processes: [{ processId: 711, processCreatedAtMs: 1_000 }] }),
    'unknown host birth': census({ processes: [{ processId: 711, processCreatedAtMs: null }] }),
    'backend without descriptor': census({ backendOwners: [{
      backendProcessId: 8_711, hostProcessId: 711, backendCreatedAtMs: 2_000,
      hostCreatedAtMs: null, backendGeneration: 1,
    }] }),
    'orphan recorder': census({ processes: [{
      processId: 8_711, processCreatedAtMs: 2_000, analyticsRecorderWorkerParentProcessId: 711,
    }] }),
    'older recorder despite reused host PID': census({ processes: [
      { processId: 711, processCreatedAtMs: 10_000 },
      { processId: 8_711, processCreatedAtMs: 2_000, analyticsRecorderWorkerParentProcessId: 711 },
    ] }),
    'unknown recorder birth despite reused host PID': census({ processes: [
      { processId: 711, processCreatedAtMs: 10_000 },
      { processId: 8_711, processCreatedAtMs: null, analyticsRecorderWorkerParentProcessId: 711 },
    ] }),
  };
  for (const [name, processCensus] of Object.entries(evidence)) {
    await t.test(name, async () => {
      const temporary = temporaryStore();
      try {
        const host = registerHost(temporary.store, 'stopped-but-not-proven-dead', 711);
        const lease = temporary.store.acquireAnalyticsWriterLease(writerIdentity(host), 0, NOW - 2);
        stopHost(temporary.store, host);
        const stopped = temporary.store.getAnalyticsHost(host.hostInstanceId);
        assert.deepEqual(await recoverStaleAnalyticsHosts(options(temporary.store, processCensus)),
          { retiredHosts: 0, reclaimedLeases: 0 });
        assert.deepEqual(temporary.store.getAnalyticsHost(host.hostInstanceId), stopped);
        assert.deepEqual(temporary.store.listAnalyticsWriterLeases(WORKSPACE_ID), [lease]);
      } finally {
        closeTemporary(temporary);
      }
    });
  }
});

test('allows evidenced PID reuse only when no older recorder child remains', async () => {
  const temporary = temporaryStore();
  const reusedPid = registerHost(temporary.store, 'reused-pid', 704, 1_000);
  const reusedPidWithOldRecorder = registerHost(temporary.store, 'reused-pid-old-recorder', 705, 1_000);

  try {
    const result = await recoverStaleAnalyticsHosts(options(temporary.store, census({
      processes: [
        { processId: reusedPid.processId, processCreatedAtMs: 10_000 },
        { processId: reusedPidWithOldRecorder.processId, processCreatedAtMs: 10_000 },
        {
          processId: 8_705,
          processCreatedAtMs: 9_000,
          analyticsRecorderWorkerParentProcessId: reusedPidWithOldRecorder.processId,
        },
      ],
    })));

    assert.deepEqual(result, { retiredHosts: 1, reclaimedLeases: 0 });
    assert.equal(temporary.store.getAnalyticsHost(reusedPid.hostInstanceId)?.state, 'stopped');
    assert.equal(temporary.store.getAnalyticsHost(reusedPidWithOldRecorder.hostInstanceId)?.state, 'registered');
  } finally {
    closeTemporary(temporary);
  }
});

test('backend owners and recorder children block retirement even when the host process is absent', async () => {
  const temporary = temporaryStore();
  const backendOwned = registerHost(temporary.store, 'backend-owned', 706);
  const recorderOwned = registerHost(temporary.store, 'recorder-owned', 707);

  try {
    const result = await recoverStaleAnalyticsHosts(options(temporary.store, census({
      processes: [{
        processId: 8_707,
        processCreatedAtMs: 5_000,
        analyticsRecorderWorkerParentProcessId: recorderOwned.processId,
      }],
      backendOwners: [{
        backendProcessId: 8_706,
        hostProcessId: backendOwned.processId,
        backendCreatedAtMs: 4_000,
        hostCreatedAtMs: null,
        backendGeneration: 1,
        analyticsHostInstanceId: backendOwned.hostInstanceId,
      }],
    })));

    assert.deepEqual(result, { retiredHosts: 0, reclaimedLeases: 0 });
    assert.equal(temporary.store.getAnalyticsHost(backendOwned.hostInstanceId)?.state, 'registered');
    assert.equal(temporary.store.getAnalyticsHost(recorderOwned.hostInstanceId)?.state, 'registered');
  } finally {
    closeTemporary(temporary);
  }
});

test('an incomplete process census blocks all recovery', async () => {
  const temporary = temporaryStore();
  const host = registerHost(temporary.store, 'incomplete-census', 708);
  const lease = temporary.store.acquireAnalyticsWriterLease(writerIdentity(host), 0, NOW - 1);
  const logs: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];

  try {
    const result = await recoverStaleAnalyticsHosts(options(temporary.store, census({
      complete: false,
      reasons: [{ code: 'process-census-truncated' }],
    }), {
      log: (level, message, data) => logs.push({ level, message, data }),
    }));

    assert.deepEqual(result, { retiredHosts: 0, reclaimedLeases: 0 });
    assert.equal(temporary.store.getAnalyticsHost(host.hostInstanceId)?.state, 'registered');
    assert.deepEqual(temporary.store.listAnalyticsWriterLeases(WORKSPACE_ID), [lease]);
    assert.ok(logs.some(({ level, message, data }) => level === 'warn'
      && message === 'stale-host recovery skipped; process census is incomplete'
      && (data?.reasonCodes as string[]).includes('process-census-truncated')));
  } finally {
    closeTemporary(temporary);
  }
});

test('clean stopped history is not recovered for a lease belonging to another identity with the same PID', async () => {
  const temporary = temporaryStore();
  const history = registerHost(temporary.store, 'clean-stopped-history', 709, 1_000);
  stopHost(temporary.store, history);
  const current = registerHost(temporary.store, 'current-host-same-pid', 709, 19_000);
  const currentLease = temporary.store.acquireAnalyticsWriterLease(writerIdentity(current), 0, NOW - 1);
  const recoveries: AnalyticsWriterIdentity[] = [];
  const registry: AnalyticsHostRecoveryOptions['registry'] = {
    listAnalyticsHosts: temporary.store.listAnalyticsHosts.bind(temporary.store),
    listAnalyticsWriterLeases: temporary.store.listAnalyticsWriterLeases.bind(temporary.store),
    recoverAnalyticsHostAfterProcessExit: (identity, nowMs) => {
      recoveries.push(identity);
      return temporary.store.recoverAnalyticsHostAfterProcessExit(identity, nowMs);
    },
  };

  try {
    const result = await recoverStaleAnalyticsHosts({
      ...options(temporary.store, census({
        processes: [{ processId: current.processId, processCreatedAtMs: 20_000 }],
      })),
      registry,
    });

    assert.deepEqual(result, { retiredHosts: 0, reclaimedLeases: 0 });
    assert.deepEqual(recoveries, []);
    assert.equal(temporary.store.getAnalyticsHost(history.hostInstanceId)?.state, 'stopped');
    assert.equal(temporary.store.getAnalyticsHost(current.hostInstanceId)?.state, 'registered');
    assert.deepEqual(temporary.store.listAnalyticsWriterLeases(WORKSPACE_ID), [currentLease]);
  } finally {
    closeTemporary(temporary);
  }
});
