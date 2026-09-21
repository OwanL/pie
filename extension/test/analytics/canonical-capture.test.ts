import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deserialize } from 'node:v8';

import type { AnalyticsObservation } from '../../../shared/analytics/contracts.js';
import {
  CanonicalAnalyticsCapture,
  analyticsRootSessionId,
} from '../../src/analytics/canonical-capture.js';
import { BillableAccounting } from '../../src/host/billable-accounting/service.js';

function tempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'pie-canonical-capture-'));
}

test('tool detail capacity is checked before traversing and encoding rich input', () => {
  let inputReads = 0;
  let submitted = 0;
  let preflights = 0;
  let rejected = true;
  const errors: string[] = [];
  const input = { get text(): string { inputReads += 1; return 'retained tool input'; } };
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical', generationId: 'generation-a', workspaceId: 'workspace-a',
    buildId: 'build-a', processGeneration: 'process-a',
    sink: { submit: () => undefined },
    detailSink: {
      preflightDetail: (detail) => {
        preflights += 1;
        assert.equal((detail as { input: unknown }).input, input);
        if (rejected) throw new Error('test capacity exhausted');
      },
      submitDetail: (detail) => {
        submitted += 1;
        assert.equal(deserialize(Buffer.from(detail.bytes)).input.text, 'retained tool input');
      },
    },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
    onDetailCaptureError: (error) => { errors.push(error.message); },
  });
  const context = { sessionId: 'session-a', sessionPath: '/session-a', operationId: 'operation-a' };
  const tool = { id: 'tool-a', name: 'bash', input, status: 'running' as const, startedAt: 100 };
  assert.equal(capture.captureTool(context, tool, 'begin', 'tool-a:begin', 100), 'rejected');
  assert.equal(inputReads, 0, 'rejected detail is not sanitized or serialized');
  assert.equal(submitted, 0);
  assert.deepEqual(errors, ['test capacity exhausted']);
  rejected = false;
  assert.equal(capture.captureTool(context, tool, 'begin', 'tool-a:begin', 100), 'submitted');
  assert.equal(preflights, 2);
  assert.equal(submitted, 1);
});

test('synchronously rejected canonical facts do not consume producer sequence numbers', () => {
  const observations: AnalyticsObservation<object>[] = [];
  let reject = true;
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical', generationId: 'generation-sequence', workspaceId: 'workspace-a',
    buildId: 'build-a', processGeneration: 'process-a',
    sink: { submit: (observation) => {
      if (reject) throw new Error('capture capacity exhausted');
      observations.push(observation);
    } },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const base = {
    schemaVersion: 1 as const,
    sessionId: 'session-a', sessionPath: '/session-a', branchId: null,
    parentOperationId: null, parentRunId: null, parentToolId: null,
    kind: 'conversation' as const, provider: 'provider-a', model: 'model-a',
    provenance: 'exact' as const, startedAt: '2026-09-10T00:00:00.000Z',
    endedAt: '2026-09-10T00:00:01.000Z', outcome: 'succeeded' as const,
    instrumentationGap: false as const,
  };
  assert.equal(capture.captureProviderSettlement({ ...base, invocationId: 'rejected', sourceId: 'rejected' }), 'rejected');
  reject = false;
  assert.equal(capture.captureProviderSettlement({ ...base, invocationId: 'accepted', sourceId: 'accepted' }), 'submitted');
  reject = true;
  assert.equal(capture.captureProviderSettlement({ ...base, invocationId: 'accepted', sourceId: 'accepted' }), 'rejected');
  reject = false;
  assert.equal(capture.captureProviderSettlement({ ...base, invocationId: 'later', sourceId: 'later' }), 'submitted');
  assert.deepEqual(observations.map((entry) => entry.sourceSequence), ['1', '2']);
});

test('tracked recorder rejection remains explicit and releases an unconsumed sequence', () => {
  const observations: AnalyticsObservation<object>[] = [];
  const dispositions: Array<(value: { status: 'durable' } | { status: 'rejected'; code: string; message: string }) => void> = [];
  const errors: string[] = [];
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical', generationId: 'generation-tracked', workspaceId: 'workspace-a',
    buildId: 'build-a', processGeneration: 'process-a',
    sink: {
      submit: () => undefined,
      submitTracked: (observation, onDisposition) => {
        observations.push(observation);
        dispositions.push(onDisposition);
      },
    },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
    onCaptureError: (error) => { errors.push(error.message); },
  });
  const base = {
    schemaVersion: 1 as const,
    sessionId: 'session-tracked', sessionPath: '/session-tracked', branchId: null,
    parentOperationId: null, parentRunId: null, parentToolId: null,
    kind: 'conversation' as const, provider: 'provider-a', model: 'model-a',
    provenance: 'exact' as const, startedAt: '2026-09-10T00:00:00.000Z',
    endedAt: '2026-09-10T00:00:01.000Z', outcome: 'succeeded' as const,
    instrumentationGap: false as const,
  };
  assert.equal(capture.captureProviderSettlement({ ...base, invocationId: 'first', sourceId: 'first' }), 'submitted');
  dispositions[0]!({ status: 'rejected', code: 'source_conflict', message: 'conflicting source' });
  assert.equal(capture.captureProviderSettlement({ ...base, invocationId: 'second', sourceId: 'second' }), 'submitted');
  assert.deepEqual(observations.map((entry) => entry.sourceSequence), ['1', '1']);
  assert.deepEqual(errors, ['conflicting source']);
});

test('async non-tail rejection rotates the producer epoch while a retry of the holed source keeps its old stream', () => {
  const observations: AnalyticsObservation<object>[] = [];
  const dispositions: Array<(value: { status: 'durable' } | { status: 'rejected'; code: string; message: string }) => void> = [];
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical', generationId: 'generation-rotate', workspaceId: 'workspace-a',
    buildId: 'build-a', processGeneration: 'process-a',
    sink: {
      submit: () => undefined,
      submitTracked: (observation, onDisposition) => {
        observations.push(observation);
        dispositions.push(onDisposition);
      },
    },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const base = {
    schemaVersion: 1 as const,
    sessionId: 'session-rotate', sessionPath: '/session-rotate', branchId: null,
    parentOperationId: null, parentRunId: null, parentToolId: null,
    kind: 'conversation' as const, provider: 'provider-a', model: 'model-a',
    provenance: 'exact' as const, startedAt: '2026-09-10T00:00:00.000Z',
    endedAt: '2026-09-10T00:00:01.000Z', outcome: 'succeeded' as const,
    instrumentationGap: false as const,
  };
  capture.captureProviderSettlement({ ...base, invocationId: 'hole', sourceId: 'hole' });
  capture.captureProviderSettlement({ ...base, invocationId: 'later', sourceId: 'later' });
  assert.deepEqual(observations.map((entry) => entry.sourceSequence), ['1', '2']);
  // The later source settles first; the earlier rejection is definitive and
  // arrives when it can no longer be released as the tail.
  dispositions[1]!({ status: 'durable' });
  dispositions[0]!({ status: 'rejected', code: 'invalid_record', message: 'invalid record' });

  capture.captureProviderSettlement({ ...base, invocationId: 'fresh', sourceId: 'fresh' });
  assert.match(observations[2]!.stableOriginId!, /^host-origin:[0-9a-f]{64}:epoch:1$/);
  assert.equal(observations[2]!.sourceSequence, '1',
    'the rotated epoch starts a fresh sequence stream with no fabricated receipt');
  assert.equal(observations[2]!.idempotencyKey, JSON.stringify([
    'generation-rotate', 'providerSettlement', 'provider-settlement:fresh',
  ]), 'rotation must not change the source-key idempotency identity');

  // A genuine retry of the holed source key reuses its retained assignment,
  // so the retry still lands on the original holed stream and can fill it.
  capture.captureProviderSettlement({ ...base, invocationId: 'hole', sourceId: 'hole' });
  assert.equal(observations[3]!.stableOriginId, observations[0]!.stableOriginId);
  assert.equal(observations[3]!.sourceSequence, '1');
  assert.equal(observations[3]!.idempotencyKey, observations[0]!.idempotencyKey);
  dispositions[2]!({ status: 'durable' });
  dispositions[3]!({ status: 'durable' });
  capture.captureProviderSettlement({ ...base, invocationId: 'after-retry', sourceId: 'after-retry' });
  assert.equal(observations[4]!.stableOriginId, observations[2]!.stableOriginId,
    'filled old holes do not resurrect the retired epoch for new facts');
  assert.equal(observations[4]!.sourceSequence, '2');
});

test('evicted and reassigned source still rotates after its original non-tail rejection', () => {
  const observations: AnalyticsObservation<object>[] = [];
  const dispositions: Array<(value: { status: 'durable' } | { status: 'rejected'; code: string; message: string }) => void> = [];
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical', generationId: 'generation-evicted', workspaceId: 'workspace-a',
    buildId: 'build-a', processGeneration: 'process-a', maxTrackedSourceKeys: 2,
    sink: {
      submit: () => undefined,
      submitTracked: (observation, onDisposition) => {
        observations.push(observation);
        dispositions.push(onDisposition);
      },
    },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const context = { sessionId: 'session-a', sessionPath: '/session-a', runId: 'run-a', operationId: 'op-a' };
  const submit = (key: string) => capture.captureExecution(context, key, 'begin', key, 100, { source: 'host' });
  submit('hole');
  submit('later-a');
  submit('later-b'); // Evicts the in-flight hole.
  submit('hole'); // Replacement cache entry must not suppress recovery.
  dispositions[0]!({ status: 'rejected', code: 'invalid_record', message: 'invalid record' });
  submit('fresh');
  assert.notEqual(observations[4]!.stableOriginId, observations[0]!.stableOriginId);
  assert.equal(observations[4]!.sourceSequence, '1');
  // A later acknowledgement for the replacement belongs to the retired epoch.
  dispositions[3]!({ status: 'durable' });
  submit('next');
  assert.equal(observations[5]!.stableOriginId, observations[4]!.stableOriginId);
  assert.equal(observations[5]!.sourceSequence, '2');
});

test('ambiguous transport failure retains the producer sequence without release or rotation', async () => {
  const observations: AnalyticsObservation<object>[] = [];
  const errors: string[] = [];
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical', generationId: 'generation-ambiguity', workspaceId: 'workspace-a',
    buildId: 'build-a', processGeneration: 'process-a',
    sink: { submit: (observation) => {
      observations.push(observation);
      return Promise.reject(new Error('transport failed'));
    } },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
    onCaptureError: (error) => { errors.push(error.message); },
  });
  const base = {
    schemaVersion: 1 as const,
    sessionId: 'session-ambiguity', sessionPath: '/session-ambiguity', branchId: null,
    parentOperationId: null, parentRunId: null, parentToolId: null,
    kind: 'conversation' as const, provider: 'provider-a', model: 'model-a',
    provenance: 'exact' as const, startedAt: '2026-09-10T00:00:00.000Z',
    endedAt: '2026-09-10T00:00:01.000Z', outcome: 'succeeded' as const,
    instrumentationGap: false as const,
  };
  capture.captureProviderSettlement({ ...base, invocationId: 'first', sourceId: 'first' });
  capture.captureProviderSettlement({ ...base, invocationId: 'second', sourceId: 'second' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  capture.captureProviderSettlement({ ...base, invocationId: 'third', sourceId: 'third' });
  // Ambiguous failure is replayable: the recorder may have committed, so the
  // sequence stays owned by its source key and the origin never rotates.
  assert.deepEqual(observations.map((entry) => entry.sourceSequence), ['1', '2', '3']);
  assert.deepEqual(observations.map((entry) => entry.stableOriginId), [
    observations[0]!.stableOriginId, observations[0]!.stableOriginId, observations[0]!.stableOriginId,
  ]);
  assert.deepEqual(errors, ['transport failed', 'transport failed']);
  capture.captureProviderSettlement({ ...base, invocationId: 'first', sourceId: 'first' });
  assert.equal(observations[3]!.sourceSequence, '1', 'the retained entry still owns its sequence');
});

test('deleted-subject dispositions consume the sequence without rotating the producer origin', () => {
  const observations: AnalyticsObservation<object>[] = [];
  const dispositions: Array<(value: { status: 'durable' } | { status: 'rejected'; code: string; message: string }) => void> = [];
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical', generationId: 'generation-deleted', workspaceId: 'workspace-a',
    buildId: 'build-a', processGeneration: 'process-a',
    sink: {
      submit: () => undefined,
      submitTracked: (observation, onDisposition) => {
        observations.push(observation);
        dispositions.push(onDisposition);
      },
    },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const base = {
    schemaVersion: 1 as const,
    sessionId: 'session-deleted', sessionPath: '/session-deleted', branchId: null,
    parentOperationId: null, parentRunId: null, parentToolId: null,
    kind: 'conversation' as const, provider: 'provider-a', model: 'model-a',
    provenance: 'exact' as const, startedAt: '2026-09-10T00:00:00.000Z',
    endedAt: '2026-09-10T00:00:01.000Z', outcome: 'succeeded' as const,
    instrumentationGap: false as const,
  };
  capture.captureProviderSettlement({ ...base, invocationId: 'deleted-subject', sourceId: 'deleted-subject' });
  dispositions[0]!({ status: 'rejected', code: 'subject_deleted', message: 'subject deleted' });
  capture.captureProviderSettlement({ ...base, invocationId: 'after-delete', sourceId: 'after-delete' });
  assert.equal(observations[1]!.stableOriginId, observations[0]!.stableOriginId,
    'a sink-consumed deleted-subject sequence must not rotate the origin');
  assert.equal(observations[1]!.sourceSequence, '2');
});

test('reentrant canonical rejection does not release a sequence admitted by the nested capture', () => {
  const observations: AnalyticsObservation<object>[] = [];
  let reentered = false;
  const base = {
    schemaVersion: 1 as const,
    sessionId: 'session-reentrant', sessionPath: '/session-reentrant', branchId: null,
    parentOperationId: null, parentRunId: null, parentToolId: null,
    kind: 'conversation' as const, provider: 'provider-a', model: 'model-a',
    provenance: 'exact' as const, startedAt: '2026-09-10T00:00:00.000Z',
    endedAt: '2026-09-10T00:00:01.000Z', outcome: 'succeeded' as const,
    instrumentationGap: false as const,
  };
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical', generationId: 'generation-reentrant', workspaceId: 'workspace-a',
    buildId: 'build-a', processGeneration: 'process-a',
    sink: { submit: (observation) => {
      if (!reentered) {
        reentered = true;
        assert.equal(capture.captureProviderSettlement({ ...base, invocationId: 'same-invocation', sourceId: 'same-source' }), 'submitted');
        throw new Error('outer capture rejected');
      }
      observations.push(observation);
    } },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  assert.equal(capture.captureProviderSettlement({ ...base, invocationId: 'same-invocation', sourceId: 'same-source' }), 'rejected');
  assert.equal(capture.captureProviderSettlement({ ...base, invocationId: 'different', sourceId: 'different-source' }), 'submitted');
  assert.deepEqual(observations.map((entry) => entry.sourceSequence), ['1', '2']);
});

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
    assert.deepEqual(accounting.projectSessionUsage('/session-exclusive.jsonl'), {
      samples: [], authority: 'unknown',
    }, 'selected-branch reads belong to the durable read model');
    assert.deepEqual(observations.map((observation) => observation.scope.branchId),
      ['entry-A', 'entry-B', 'entry-C'].map((entry) => capture.scopedBranchId({
        sessionId: 'session-exclusive', sessionPath: '/session-exclusive.jsonl',
        runId: 'run-exclusive', operationId: 'operation-exclusive',
      }, entry)));
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
