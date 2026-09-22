import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CanonicalAnalyticsCapture } from '../../../src/analytics/canonical-capture.js';
import { SqliteAnalyticsRecorder } from '../../../src/analytics/sqlite-recorder.js';
import type { CanonicalAnalyticsReadModel } from '../../../src/analytics/query-entry.js';
import { createInitialArchState, type ArchState } from '../../../src/host/core/arch-state.js';
import { StatsService } from '../../../src/host/stats-service/service.js';

const SESSION_PATH = '/workspace/live-handoff.jsonl';

function makeState(messageId: string, status: 'streaming' | 'completed'): ArchState {
  const state = createInitialArchState();
  state.sessions.activeSessionPath = SESSION_PATH;
  state.sessions.openTabPaths = [SESSION_PATH];
  state.sessions.sessions = [{
    path: SESSION_PATH,
    sessionId: 'root-live-handoff',
    name: 'handoff',
    cwd: '/workspace',
    modifiedAt: '2026-09-22T00:00:00.000Z',
    messageCount: 1,
  }];
  state.transcript.bySession[SESSION_PATH] = [{
    id: messageId,
    role: 'assistant',
    createdAt: '2026-09-22T00:00:01.000Z',
    markdown: status === 'streaming' ? 'streaming' : 'settled',
    status,
    ...(status === 'completed'
      ? { usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 30 } }
      : {}),
  } as never];
  return state;
}

function auxiliary(sourceId: string, provisionalMessageId: string) {
  return {
    kind: 'assistant_message' as const,
    sourceId,
    provisionalMessageId,
    occurredAt: '2026-09-22T00:00:02.000Z',
    modelId: 'fixture-model',
    provider: 'fixture-provider',
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    providerTotalTokens: 30,
    reportedCostUsd: 0.25,
    outcome: 'succeeded' as const,
  };
}

function makeStats(
  state: ArchState,
  capture: CanonicalAnalyticsCapture,
  recorder: SqliteAnalyticsRecorder,
  root: string,
): StatsService {
  const readModel = {
    getMaxConcurrentQueries: () => 1,
    readRevision: async () => String(recorder.getProjectionRevision()),
    readScopedProviderSettlements: async (...args: Parameters<SqliteAnalyticsRecorder['readScopedProviderSettlements']>) => (
      recorder.readScopedProviderSettlements(...args)
    ),
  } as unknown as CanonicalAnalyticsReadModel;
  return new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace',
    getArchState: () => state,
    analyticsCapture: capture,
    analyticsReadModel: readModel,
    now: () => new Date('2026-09-22T00:00:03.000Z'),
  });
}

test('canonical live settlement hands off by actual invocation identity in both orders', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-live-handoff-'));
  const recorder = new SqliteAnalyticsRecorder(path.join(root, 'analytics.sqlite'));
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation',
    workspaceId: 'workspace',
    buildId: 'build',
    processGeneration: 'process',
    sink: { submit: (observation) => recorder.submit(observation) },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const firstState = makeState('stream-a', 'streaming');
  const firstStats = makeStats(firstState, capture, recorder, root);
  let secondStats: StatsService | undefined;

  try {
    await firstStats.start();

    // The streaming observation arrives before a canonical read can see it.
    const first = auxiliary('assistant:durable-a', 'stream-a');
    firstStats.onAuxiliaryLlmUsage(SESSION_PATH, first);
    const provisional = firstStats.getSessionUsage(SESSION_PATH).pendingSamples;
    assert.equal(provisional?.length, 1);
    const actualInvocationId = provisional?.[0]?.canonicalInvocationId;
    assert.ok(actualInvocationId);
    assert.notEqual(actualInvocationId, first.sourceId, 'canonical identity is not assumed to be sourceId');

    // A fresh host reads the canonical settlement before the matching observed
    // event is delivered. The duplicate observation must retain one pending
    // row while the runtime message is still streaming, then hand off cleanly.
    const secondState = makeState('stream-a', 'streaming');
    secondStats = makeStats(secondState, capture, recorder, root);
    await secondStats.start();
    secondStats.onAuxiliaryLlmUsage(SESSION_PATH, auxiliary(first.sourceId, 'stream-a'));
    const whileStreaming = secondStats.getSessionUsage(SESSION_PATH);
    assert.equal(whileStreaming.samples.length, 1);
    assert.equal(whileStreaming.pendingSamples?.length, 1);
    assert.equal(whileStreaming.pendingSamples?.[0]?.canonicalInvocationId, actualInvocationId);

    secondState.transcript.bySession[SESSION_PATH] = [{
      ...secondState.transcript.bySession[SESSION_PATH]![0],
      status: 'completed',
    } as never];
    const settled = secondStats.getSessionUsage(SESSION_PATH);
    assert.equal(settled.pendingSamples, undefined);
    assert.equal(settled.samples.filter((sample) => sample.canonicalInvocationId === actualInvocationId).length, 1);

    // Successive tool-loop calls remain identity-keyed rather than replacing a
    // session-wide scalar. Both are visible until their matching canonical rows
    // are read and their runtime streams settle.
    secondState.transcript.bySession[SESSION_PATH] = [{
      id: 'stream-b', role: 'assistant', createdAt: '2026-09-22T00:00:03.000Z',
      markdown: 'next tool-loop call', status: 'streaming',
    } as never];
    secondStats.onAuxiliaryLlmUsage(SESSION_PATH, auxiliary('assistant:durable-b', 'stream-b'));
    secondStats.onAuxiliaryLlmUsage(SESSION_PATH, auxiliary('assistant:durable-c', 'stream-b'));
    const successive = secondStats.getSessionUsage(SESSION_PATH);
    assert.equal(successive.pendingSamples?.length, 2);
    assert.notEqual(
      successive.pendingSamples?.[0]?.canonicalInvocationId,
      successive.pendingSamples?.[1]?.canonicalInvocationId,
    );
    secondStats.onBusyChanged(SESSION_PATH, false);
    assert.equal(secondStats.getSessionUsage(SESSION_PATH).pendingSamples?.length, 2);

    secondStats.onSessionClosed(SESSION_PATH);
    assert.equal(secondStats.getSessionUsage(SESSION_PATH).pendingSamples, undefined);
  } finally {
    await secondStats?.shutdown();
    await firstStats.shutdown();
    recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});
