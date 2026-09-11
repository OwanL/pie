import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AnalyticsObservation } from '../../../shared/analytics/contracts.js';
import {
  CanonicalAnalyticsCapture,
  analyticsRootSessionId,
} from '../../src/analytics/canonical-capture.js';
import { BillableAccounting } from '../../src/host/billable-accounting/service.js';

function tempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'pie-canonical-capture-'));
}

test('canonical provider adapter preserves exact accounting fields and assigns contiguous producer sequence', () => {
  const observations: AnalyticsObservation[] = [];
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-canonical',
    workspaceId: 'workspace-a',
    buildId: 'build-a',
    processGeneration: 'process-a',
    sink: { submit: (observation) => { observations.push(observation); } },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });

  const base = {
    schemaVersion: 1 as const,
    sessionId: 'session-a',
    sessionPath: '/must/not/be/persisted/session.jsonl',
    branchId: null,
    parentOperationId: 'operation-a',
    parentRunId: 'run-a',
    parentToolId: null,
    kind: 'conversation' as const,
    provider: 'provider-a',
    model: 'model-a',
    provenance: 'exact' as const,
    evidenceOrigin: 'live' as const,
    startedAt: '2026-09-10T00:00:00.000Z',
    endedAt: '2026-09-10T00:00:01.000Z',
    outcome: 'succeeded' as const,
    instrumentationGap: false as const,
    pricing: {
      catalogVersion: 'sha256:catalog-a',
      calculatedCostUsd: 0.0000155,
      rateSnapshot: {
        inputTokensUsdPerMillion: 1,
        outputTokensUsdPerMillion: 2,
        cacheReadTokensUsdPerMillion: 0.5,
        cacheWriteTokensUsdPerMillion: 1,
      },
    },
  };
  assert.equal(capture.captureProviderSettlement({
    ...base,
    invocationId: 'invocation-a',
    sourceId: 'source-a',
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 0,
    providerReportedCostUsd: 0,
  }), 'submitted');
  assert.equal(capture.captureProviderSettlement({
    ...base,
    invocationId: 'invocation-b',
    sourceId: 'source-b',
    instrumentationGap: true,
    instrumentationGapReason: 'usage unavailable',
    provenance: 'unknown',
  }), 'submitted');

  assert.equal(capture.captureProviderSettlement({
    ...base,
    invocationId: 'invocation-a',
    sourceId: 'source-a',
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 0,
    providerReportedCostUsd: 0,
  }), 'submitted');

  assert.equal(observations.length, 3);
  assert.deepEqual(observations.map((entry) => entry.sourceSequence), ['1', '2', '1']);
  assert.deepEqual(observations[0]!.scope, {
    workspaceCoverage: 'known',
    workspaceId: 'workspace-a',
    rootSessionId: 'session-a',
    sessionId: 'session-a',
    executionId: 'operation-a',
    invocationId: 'invocation-a',
    toolCallId: undefined,
  });
  assert.match(observations[0]!.stableOriginId!, /^host-origin:[0-9a-f]{64}$/);
  assert.equal(observations[0]!.fields.reportedCostUsd, 0, 'reported zero is retained as exact evidence');
  assert.equal(observations[0]!.fields.reportedModel, undefined, 'an unobserved reported model is not invented');
  assert.deepEqual({
    inputIncludesCache: observations[0]!.fields.inputIncludesCache,
    outputIncludesReasoning: observations[0]!.fields.outputIncludesReasoning,
    cacheChannelsOmittedAsZero: observations[0]!.fields.cacheChannelsOmittedAsZero,
    pricing: observations[0]!.fields.pricing,
  }, {
    inputIncludesCache: false,
    outputIncludesReasoning: true,
    cacheChannelsOmittedAsZero: false,
    pricing: {
      normalizationVersion: 'oracle-v1',
      catalogVersion: 'sha256:catalog-a',
      currency: 'USD',
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 2,
      cacheReadUsdPerMillionTokens: 0.5,
      cacheWriteUsdPerMillionTokens: 1,
    },
  });
  assert.equal(observations[1]!.fields.inputTokens, undefined, 'unknown channels are absent rather than invented zeroes');
  assert.equal(JSON.stringify(observations).includes('/must/not/be/persisted'), false);
  assert.deepEqual(observations[2], observations[0], 'same source redetection is exact replay');
});

test('canonical producer replay tracking remains bounded and evicted redetections get a new sequence', () => {
  const observations: AnalyticsObservation[] = [];
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-bounded',
    workspaceId: 'workspace-bounded',
    buildId: 'build-bounded',
    processGeneration: 'process-bounded',
    maxTrackedSourceKeys: 2,
    sink: { submit: (observation) => { observations.push(observation); } },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const settlement = (sourceId: string) => capture.captureProviderSettlement({
    schemaVersion: 1,
    sessionId: 'session-bounded',
    sessionPath: null,
    branchId: null,
    parentOperationId: 'operation-bounded',
    parentRunId: 'run-bounded',
    parentToolId: null,
    kind: 'conversation',
    provider: 'provider-bounded',
    model: 'model-bounded',
    provenance: 'exact',
    evidenceOrigin: 'live',
    startedAt: '2026-09-10T00:00:00.000Z',
    endedAt: '2026-09-10T00:00:01.000Z',
    outcome: 'succeeded',
    instrumentationGap: false,
    invocationId: `invocation-${sourceId}`,
    sourceId,
    inputTokens: 1,
  });
  settlement('a');
  settlement('b');
  settlement('c');
  settlement('a');
  assert.equal(capture.trackedSourceKeyCount, 2);
  assert.deepEqual(observations.map((observation) => observation.sourceSequence), ['1', '2', '3', '4']);
  assert.equal(observations[0]!.stableOriginId, observations[3]!.stableOriginId);
});

test('canonical accounting seam is exclusive and never falls through to the legacy ledger', () => {
  const root = tempRoot();
  const observations: AnalyticsObservation[] = [];
  try {
    const capture = new CanonicalAnalyticsCapture({
      authority: 'canonical',
      generationId: 'generation-exclusive',
      workspaceId: 'workspace-exclusive',
      buildId: 'build-exclusive',
      processGeneration: 'process-exclusive',
      sink: { submit: (observation) => { observations.push(observation); } },
      detailSink: { submitDetail: () => undefined },
      lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
    });
    const accounting = new BillableAccounting({
      getStorageDir: () => root,
      now: () => new Date('2026-09-10T00:00:01.000Z'),
      scheduleRender: () => undefined,
      dispatchArchEvent: () => undefined,
      getAgentDir: () => null,
      isPrivateSession: () => false,
      sessionIdentity: () => ({ sessionId: 'session-exclusive', provider: 'provider-a', modelId: 'model-a' }),
      currentRunId: () => 'run-exclusive',
      activeOperationId: () => 'operation-exclusive',
      markDerivedExportDirty: () => assert.fail('canonical settlement must not dirty a legacy export'),
      canonicalCapture: capture,
    });

    accounting.observeAuxiliaryLlmUsage('/session-exclusive.jsonl', {
      sourceId: 'provider-response-a',
      kind: 'assistant_message',
      occurredAt: '2026-09-10T00:00:01.000Z',
      startedAt: '2026-09-10T00:00:00.000Z',
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outcome: 'succeeded',
    });

    assert.equal(observations.length, 1);
    assert.equal(observations[0]!.observationKind, 'providerSettlement');
    assert.equal(observations[0]!.fields.sourceId, 'provider-response-a');
    assert.deepEqual(accounting.exportRecords(), [], 'legacy JSONL remains empty in canonical mode');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pending bind and private close derive the same subject from the actual create origin', async () => {
  const observations: AnalyticsObservation[] = [];
  const binds: string[] = [];
  const deletes: Array<string | undefined> = [];
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-pending-lifecycle',
    workspaceId: 'workspace-pending-lifecycle',
    buildId: 'build-pending-lifecycle',
    processGeneration: 'process-pending-lifecycle',
    sink: { submit: (observation) => { observations.push(observation); } },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: {
      bindPendingCreate: async (pendingOperationId) => { binds.push(pendingOperationId); },
      deleteSession: async (_root, _source, _timestamp, pendingOperationId) => {
        deletes.push(pendingOperationId);
      },
    },
  });

  const createOperationId = 'actual-create-origin';
  capture.captureExecution(
    {
      sessionId: null,
      sessionPath: 'pending:reusable-alias',
      runId: null,
      operationId: createOperationId,
    },
    'execution-a',
    'begin',
    'pending-observation-a',
    100,
    { source: 'host' },
  );
  assert.equal(observations[0]?.captureSubject.kind, 'pendingCreate');
  const pendingSubjectId = observations[0]?.captureSubject.kind === 'pendingCreate'
    ? observations[0].captureSubject.operationId
    : undefined;

  await capture.bindPendingCreate('pending:reusable-alias', 'root-a', 101, createOperationId);
  await capture.closeSession('root-a', 'on', 102, createOperationId);

  assert.ok(pendingSubjectId);
  assert.deepEqual(binds, [pendingSubjectId]);
  assert.deepEqual(deletes, [pendingSubjectId]);
  assert.notEqual(pendingSubjectId, createOperationId, 'the recorder key remains a derived analytics identity');
});

test('fallback root identity is stable and does not disclose the session path', () => {
  const pathA = 'C:/sensitive/workspace/session.jsonl';
  const first = analyticsRootSessionId(null, pathA);
  assert.equal(first, analyticsRootSessionId(null, pathA));
  assert.equal(first.includes('sensitive'), false);
  assert.equal(analyticsRootSessionId('stable-session', pathA), 'stable-session');
});
