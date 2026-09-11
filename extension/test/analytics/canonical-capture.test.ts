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
  const observations: AnalyticsObservation<object>[] = [];
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
  const exactFields = observations[0]!.fields;
  assert.ok('reportedCostUsd' in exactFields);
  assert.equal(exactFields.reportedCostUsd, 0, 'reported zero is retained as exact evidence');
  assert.equal('reportedModel' in exactFields ? exactFields.reportedModel : undefined, undefined,
    'an unobserved reported model is not invented');
  assert.deepEqual({
    inputIncludesCache: 'inputIncludesCache' in exactFields ? exactFields.inputIncludesCache : undefined,
    outputIncludesReasoning: 'outputIncludesReasoning' in exactFields ? exactFields.outputIncludesReasoning : undefined,
    cacheChannelsOmittedAsZero: 'cacheChannelsOmittedAsZero' in exactFields
      ? exactFields.cacheChannelsOmittedAsZero
      : undefined,
    pricing: 'pricing' in exactFields ? exactFields.pricing : undefined,
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
  assert.equal('inputTokens' in observations[1]!.fields ? observations[1]!.fields.inputTokens : undefined,
    undefined, 'unknown channels are absent rather than invented zeroes');
  assert.equal(JSON.stringify(observations).includes('/must/not/be/persisted'), false);
  assert.deepEqual(observations[2], observations[0], 'same source redetection is exact replay');
});

test('canonical producer replay tracking remains bounded and evicted redetections get a new sequence', () => {
  const observations: AnalyticsObservation<object>[] = [];
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

test('branch and copy adapters scope SDK entry IDs and never persist session paths or copied settlements', () => {
  const observations: AnalyticsObservation<object>[] = [];
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-branch-copy',
    workspaceId: 'workspace-branch-copy',
    buildId: 'build-branch-copy',
    processGeneration: 'process-branch-copy',
    sink: { submit: (observation) => { observations.push(observation); } },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const source = { sessionId: 'source-root', sessionPath: '/private/source.jsonl' };
  const copy = { sessionId: 'copy-root', sessionPath: '/private/copy.jsonl' };
  const sourceA = capture.scopedBranchId(source, 'entry-A');
  const copyA = capture.scopedBranchId(copy, 'entry-A');
  assert.notEqual(sourceA, copyA, 'copied raw SDK entry IDs are scoped to their owning root');

  capture.captureBranchEdge(source, 'entry-A', null, 100);
  capture.captureBranchEdge(source, 'entry-B', 'entry-A', 110);
  capture.captureBranchSelection(source, 'entry-B', 'selection-B', 120);
  capture.captureCopy(copy, source, 'entry-B', 'copy-operation', 130);
  assert.deepEqual(observations.map((entry) => [entry.entityKind, entry.observationKind]), [
    ['branch', 'observation'],
    ['branch', 'observation'],
    ['branch', 'phase'],
    ['copy', 'observation'],
  ]);
  assert.equal(observations[1]?.scope.branchId, capture.scopedBranchId(source, 'entry-B'));
  assert.equal((observations[1]?.fields as { parentBranchId?: string }).parentBranchId, sourceA);
  assert.equal((observations[3]?.fields as { sourceBranchId?: string }).sourceBranchId,
    capture.scopedBranchId(source, 'entry-B'));
  assert.equal(observations.some((entry) => entry.entityKind === 'providerCall'), false);
  assert.equal(JSON.stringify(observations).includes('/private/'), false);
});

test('canonical accounting seam is exclusive and never falls through to the legacy ledger', () => {
  const root = tempRoot();
  const observations: AnalyticsObservation<object>[] = [];
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

    accounting.observeBranchEntry('/session-exclusive.jsonl', 'entry-A', null, 'entry-A');
    accounting.observeAuxiliaryLlmUsage('/session-exclusive.jsonl', {
      sourceId: 'provider-response-a',
      kind: 'assistant_message',
      occurredAt: '2026-09-10T00:00:01.000Z',
      startedAt: '2026-09-10T00:00:00.000Z',
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reportedCostUsd: 0.01,
      outcome: 'succeeded',
    });

    assert.equal(observations.length, 1);
    assert.equal(observations[0]!.observationKind, 'providerSettlement');
    assert.equal('sourceId' in observations[0]!.fields ? observations[0]!.fields.sourceId : undefined,
      'provider-response-a');
    assert.equal(observations[0]!.scope.branchId, capture.scopedBranchId({
      sessionId: 'session-exclusive', sessionPath: '/session-exclusive.jsonl',
      runId: 'run-exclusive', operationId: 'operation-exclusive',
    }, 'entry-A'));
    accounting.observeBranchEntry('/session-exclusive.jsonl', 'entry-B', 'entry-A', 'entry-B');
    accounting.observeAuxiliaryLlmUsage('/session-exclusive.jsonl', {
      sourceId: 'provider-response-b', kind: 'assistant_message',
      occurredAt: '2026-09-10T00:00:02.000Z', inputTokens: 20, outputTokens: 2,
      cacheReadTokens: 0, cacheWriteTokens: 0, reportedCostUsd: 0.02, outcome: 'succeeded',
    });
    accounting.observeBranchEntry('/session-exclusive.jsonl', 'entry-C', 'entry-A', 'entry-C');
    accounting.observeAuxiliaryLlmUsage('/session-exclusive.jsonl', {
      sourceId: 'provider-response-c', kind: 'assistant_message',
      occurredAt: '2026-09-10T00:00:03.000Z', inputTokens: 30, outputTokens: 3,
      cacheReadTokens: 0, cacheWriteTokens: 0, reportedCostUsd: 0.03, outcome: 'succeeded',
    });
    const selected = accounting.projectSessionUsage('/session-exclusive.jsonl');
    assert.deepEqual(selected.samples.map((sample) => sample.sourceId), [
      'provider-response-a', 'provider-response-c',
    ]);
    assert.equal(selected.samples.reduce((total, sample) => total + (sample.reportedCostUsd ?? 0), 0), 0.04);
    assert.equal(observations.length, 3, 'A, B, and C remain globally captured exactly once');
    assert.equal(observations.reduce((total, observation) => (
      total + ('reportedCostUsd' in observation.fields
        && typeof observation.fields.reportedCostUsd === 'number' ? observation.fields.reportedCostUsd : 0)
    ), 0), 0.06);
    assert.deepEqual(accounting.exportRecords(), [], 'legacy JSONL remains empty in canonical mode');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pending bind and private close derive the same subject from the actual create origin', async () => {
  const observations: AnalyticsObservation<object>[] = [];
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
