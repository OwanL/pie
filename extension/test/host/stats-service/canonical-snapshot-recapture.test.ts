import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AnalyticsObservation } from '../../../../shared/analytics/contracts.js';
import { CanonicalAnalyticsCapture } from '../../../src/analytics/canonical-capture.js';
import { createInitialArchState, type ArchState } from '../../../src/host/core/arch-state';
import { StatsService } from '../../../src/host/stats-service/service';
import type { SessionUsageSnapshot } from '../../../src/shared/protocol';

const BASE_MS = Date.parse('2026-09-10T00:00:00.000Z');

function sessionState(sessionPath: string, sessionId: string): ArchState {
  const state = createInitialArchState();
  state.sessions.activeSessionPath = sessionPath;
  state.sessions.openTabPaths = [sessionPath];
  state.sessions.sessions = [{
    path: sessionPath, sessionId, name: 'fixture',
    cwd: path.dirname(sessionPath), modifiedAt: '2026-09-10T00:00:00.000Z', messageCount: 1,
  }];
  return state;
}

function snapshotFor(branchEntryIds: string[]): SessionUsageSnapshot {
  return {
    branchId: branchEntryIds.at(-1),
    branchEntryIds,
    samples: [{
      sourceId: 'assistant:turn-1',
      kind: 'assistant',
      modelId: 'model-a',
      provider: 'provider-a',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      totalTokens: 125,
      reportedCostUsd: 0.25,
    }],
  };
}

test('canonical authority never re-settles transcript-derived snapshot history across opens or copies', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-snapshot-recapture-'));
  const sessionPath = '/sessions/canonical-open.jsonl';
  const copyPath = '/sessions/canonical-copy.jsonl';
  const state = sessionState(sessionPath, 'root-a');
  const observations: AnalyticsObservation<object>[] = [];
  let nowMs = BASE_MS;
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical', generationId: 'generation-recapture', workspaceId: 'workspace-recapture',
    buildId: 'build', processGeneration: 'process',
    sink: { submit: (observation) => { observations.push(observation); } },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-recapture',
    getArchState: () => state,
    now: () => new Date(nowMs),
    analyticsCapture: capture,
  });
  try {
    const branchEntryIds = ['entry-1', 'entry-2', 'entry-3'];
    // Real seam: every `session.opened` payload carries the whole
    // transcript-derived usage snapshot, including repeated re-opens.
    stats.onSessionUsageSnapshot(sessionPath, 'root-a', snapshotFor(branchEntryIds), 'snapshot:open-1', nowMs);
    nowMs += 1_000;
    stats.onSessionUsageSnapshot(sessionPath, 'root-a', snapshotFor(branchEntryIds), 'snapshot:open-2', nowMs);
    assert.equal(
      observations.filter((observation) => observation.entityKind === 'providerCall').length,
      0,
      'a canonical re-open must not re-derive transcript history into provider settlements',
    );

    // A copied session inherits the transcript-derived snapshot under its own
    // root; root-scoped invocation identities must not mint settlements for
    // the inherited work.
    const copyState = sessionState(copyPath, 'root-b');
    copyState.sessions.sessions = [...state.sessions.sessions, ...copyState.sessions.sessions];
    state.sessions.sessions = copyState.sessions.sessions;
    nowMs += 1_000;
    stats.onSessionUsageSnapshot(copyPath, 'root-b', snapshotFor(branchEntryIds), 'snapshot:open-copy', nowMs);
    assert.equal(
      observations.filter((observation) => observation.entityKind === 'providerCall').length,
      0,
      'a copy open must not settle inherited transcript-derived work again',
    );

    // Branch edges stay captured for both scopes even though settlement
    // migration is suppressed.
    const branchEdges = observations.filter((observation) => (
      observation.entityKind === 'branch' && observation.observationKind === 'observation'
    ));
    assert.equal(branchEdges.length, branchEntryIds.length * 2, 'both opened scopes keep their ancestry edges');

    // The copy relation is still observed through its own seam.
    nowMs += 1_000;
    stats.onSessionDuplicated({
      destinationPath: copyPath,
      destinationSessionId: 'root-b',
      sourcePath: sessionPath,
      sourceSessionId: 'root-a',
      sourceBranchId: 'entry-3',
      operationId: 'operation-copy',
      observedAt: nowMs,
    });
    assert.equal(
      observations.filter((observation) => observation.entityKind === 'copy').length,
      1,
      'the copy relation keeps its dedicated capture',
    );

    // Live capture is untouched: an auxiliary settlement is captured exactly
    // once, and repeated snapshots around it never duplicate it.
    nowMs += 1_000;
    stats.prepareForSend(sessionPath, []);
    stats.onAuxiliaryLlmUsage(sessionPath, {
      kind: 'assistant_message',
      sourceId: 'assistant:live-turn',
      occurredAt: new Date(nowMs).toISOString(),
      modelId: 'model-a',
      provider: 'provider-a',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs: 500,
    });
    const liveSettlements = observations.filter((observation) => observation.entityKind === 'providerCall');
    assert.equal(liveSettlements.length, 1, 'live settlements keep their canonical capture seam');
    nowMs += 1_000;
    stats.onSessionUsageSnapshot(sessionPath, 'root-a', snapshotFor(branchEntryIds), 'snapshot:open-3', nowMs);
    assert.equal(
      observations.filter((observation) => observation.entityKind === 'providerCall').length,
      1,
      'a later snapshot must not re-settle the live invocation',
    );
  } finally {
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy authority keeps migrating transcript-derived snapshots and dedups repeated opens', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-snapshot-legacy-'));
  const sessionPath = '/sessions/legacy-open.jsonl';
  const state = sessionState(sessionPath, 'root-a');
  let nowMs = BASE_MS;
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-legacy',
    getArchState: () => state,
    now: () => new Date(nowMs),
    createId: () => 'run-legacy',
  });
  try {
    await stats.start();
    const branchEntryIds = ['entry-1', 'entry-2', 'entry-3'];
    stats.onSessionUsageSnapshot(sessionPath, 'root-a', snapshotFor(branchEntryIds), 'snapshot:open-1', nowMs);
    nowMs += 1_000;
    // A repeated open replays the same transcript-derived sample; legacy
    // migration must stay idempotent on source identity.
    stats.onSessionUsageSnapshot(sessionPath, 'root-a', snapshotFor(branchEntryIds), 'snapshot:open-2', nowMs);
    const rows = stats.getBillableInvocationRecords();
    assert.equal(rows.length, 1, 'legacy migration still runs and dedups repeated opens');
    assert.equal(rows[0]?.sourceId, 'assistant:turn-1');
    assert.equal(rows[0]?.evidenceOrigin, 'migration');
  } finally {
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});