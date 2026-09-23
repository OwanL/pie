import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deserialize } from 'node:v8';

import {
  AnalyticsSourceConflictError,
  type AnalyticsDetailCapture,
  type AnalyticsObservation,
} from '../../../shared/analytics/contracts.js';
import { CanonicalAnalyticsCapture } from '../../../extension/src/analytics/canonical-capture.js';
import { SqliteAnalyticsRecorder } from '../../../extension/src/analytics/sqlite-recorder.js';
import { BillableAccounting } from '../../../extension/src/host/billable-accounting/service.js';
import { getSubagentBillingEntries } from '../../../extension/src/shared/subagent-result.js';
import { captureSubagentTerminalResult } from '../src/analytics-capture.js';
import { buildAttemptRecord } from '../src/retry.js';
import type {
  SingleResult,
  SubagentProviderInvocationRecord,
} from '../types.js';

function invocation(
  invocationId: string,
  attemptId: string,
  cost: number,
  outcome: SubagentProviderInvocationRecord['outcome'],
): SubagentProviderInvocationRecord {
  return {
    invocationId,
    attemptId,
    provider: 'fixture-provider',
    model: `fixture-model-${attemptId}`,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost },
    startedAt: 1_800_000_000_000,
    completedAt: 1_800_000_000_001,
    outcome,
  };
}

function result(options: {
  childId: string;
  attemptId: string;
  invocation: SubagentProviderInvocationRecord;
  exitCode: number;
  stopReason: 'completed' | 'error' | 'aborted';
  messages?: SingleResult['messages'];
}): SingleResult {
  return {
    childId: options.childId,
    agent: 'fixture-agent',
    agentSource: 'project',
    task: 'fixture task',
    exitCode: options.exitCode,
    messages: options.messages ?? [],
    stderr: '',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: options.invocation.usage?.cost ?? 0,
      contextTokens: 0,
      turns: 1,
    },
    provider: options.invocation.provider,
    model: options.invocation.model,
    attemptId: options.attemptId,
    startedAt: options.invocation.startedAt,
    completedAt: options.invocation.completedAt,
    stopReason: options.stopReason,
    providerInvocations: [options.invocation],
  };
}

function readCompleteDetail(recorder: SqliteAnalyticsRecorder, payloadId: string): unknown {
  const chunks: Buffer[] = [];
  let offset: number | string = 0;
  for (;;) {
    const range = recorder.readDetailRange(payloadId, offset, 64 * 1024);
    assert.equal(range.available, true);
    chunks.push(Buffer.from(range.bytes));
    if (range.nextOffset === null) break;
    offset = range.nextOffset;
  }
  return deserialize(Buffer.concat(chunks));
}

test('subagent producer facts reconcile through SQLite without terminal aggregate charges', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-p4-subagent-terminal-'));
  const recorder = new SqliteAnalyticsRecorder(path.join(root, 'analytics.sqlite'));
  try {
    const generationId = 'generation-p4-terminal';
    const rootSessionId = 'root-session-p4';
    const submittedDetailBytes = new Map<string, Buffer[]>();
    const detailSink = {
      submitDetail: (capture: AnalyticsDetailCapture) => {
        const attempts = submittedDetailBytes.get(capture.payloadId) ?? [];
        attempts.push(Buffer.from(capture.bytes));
        submittedDetailBytes.set(capture.payloadId, attempts);
        return recorder.submitDetail(capture);
      },
    };
    const captureContext = {
      generationId,
      workspaceId: 'workspace-p4',
      captureSubject: { kind: 'session' as const, rootSessionId },
      sink: detailSink,
      factSink: recorder,
      readFactAcknowledgement: (_generation: string, stableOriginId: string) => {
        const identity = JSON.stringify([generationId, 'subagent', stableOriginId]);
        return recorder.readProducerReconciliation().find(
          (entry) => entry.producerIdentity === identity,
        )?.contiguousWatermark;
      },
      isDetailComplete: (payloadId: string) => recorder.detailMetadata(payloadId)?.complete === true,
      resolveParentToolEntityId: (toolCallId: string) => `canonical-tool:${toolCallId}`,
    };

    const hostCapture = new CanonicalAnalyticsCapture({
      authority: 'canonical',
      generationId,
      workspaceId: 'workspace-p4',
      buildId: 'build-p4-host',
      processGeneration: 'host-p4',
      sink: recorder,
      detailSink: recorder,
      lifecycleSink: {
        bindPendingCreate: async (...args) => recorder.bindPendingCreate(...args),
        deleteSession: async (...args) => recorder.deleteSession(...args),
      },
    });
    assert.equal(hostCapture.captureProviderSettlement({
      schemaVersion: 1,
      invocationId: 'root-provider-.01',
      sourceId: 'root-provider-response',
      sessionId: rootSessionId,
      sessionPath: '/fixture/root.jsonl',
      branchId: null,
      parentOperationId: null,
      parentRunId: 'root-run',
      parentToolId: null,
      kind: 'conversation',
      provider: 'fixture-provider',
      model: 'fixture-root-model',
      provenance: 'exact',
      evidenceOrigin: 'live',
      startedAt: '2027-01-15T08:00:00.000Z',
      endedAt: '2027-01-15T08:00:00.001Z',
      outcome: 'succeeded',
      instrumentationGap: false,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      providerTotalTokens: 2,
      providerReportedCostUsd: 0.01,
    }), 'submitted');

    const nestedBody = `nested-unique-prefix:${'z'.repeat(1024 * 1024 + 257)}`;
    const nested = result({
      childId: 'nested-child',
      attemptId: 'nested-attempt-.04',
      invocation: invocation('nested-provider-.04', 'nested-attempt-.04', 0.04, 'success'),
      exitCode: 0,
      stopReason: 'completed',
      messages: [{
        role: 'assistant',
        content: [{ type: 'text', text: nestedBody }],
        timestamp: 1_800_000_000_001,
      }],
    });
    assert.equal(captureSubagentTerminalResult(nested, captureContext, 'nested-parent-tool'), 'submitted');
    const nestedPayloadId = nested.analyticsCaptureReceipt!.terminalDetailPayloadId;
    assert.equal(captureSubagentTerminalResult(nested, captureContext, 'nested-parent-tool'), 'submitted');
    (nested.messages[0]!.content[0] as { text: string }).text = 'mutated-after-handoff';
    const reconstructedNested = readCompleteDetail(recorder, nestedPayloadId) as SingleResult;
    assert.equal(
      (reconstructedNested.messages[0]!.content[0] as { text: string }).text,
      nestedBody,
    );
    assert.equal(
      captureSubagentTerminalResult(nested, captureContext, 'nested-parent-tool'),
      'rejected',
      'same producer identity with changed terminal bytes rejects instead of overwriting',
    );
    const nestedAttempt = buildAttemptRecord(nested);
    const nestedForParent = { ...nested, attemptRecords: [nestedAttempt] };

    const failed = result({
      childId: 'child',
      attemptId: 'child-failed-attempt-.02',
      invocation: invocation('child-provider-.02', 'child-failed-attempt-.02', 0.02, 'failure'),
      exitCode: 1,
      stopReason: 'error',
    });
    assert.equal(captureSubagentTerminalResult(failed, captureContext, 'root-subagent-tool'), 'submitted');

    const succeeded = result({
      childId: 'child',
      attemptId: 'child-failover-attempt-.03',
      invocation: invocation('child-provider-.03', 'child-failover-attempt-.03', 0.03, 'success'),
      exitCode: 0,
      stopReason: 'completed',
      messages: [{
        role: 'toolResult',
        toolCallId: 'nested-parent-tool',
        toolName: 'subagent',
        content: [{ type: 'text', text: 'nested done' }],
        details: { mode: 'single', results: [nestedForParent] },
        isError: false,
        timestamp: 1_800_000_000_001,
      }],
    });
    assert.equal(captureSubagentTerminalResult(succeeded, captureContext, 'root-subagent-tool'), 'submitted');

    const failedAttempt = buildAttemptRecord(failed);
    const succeededAttempt = buildAttemptRecord(succeeded);
    assert.deepEqual(
      [failedAttempt, succeededAttempt, nestedAttempt].map(
        (entry) => entry.analyticsCaptureReceipt?.factStatus,
      ),
      ['submitted', 'submitted', 'submitted'],
      'a detail conflict after handoff must not change the sealed fact receipt',
    );
    assert.deepEqual(
      [failedAttempt, succeededAttempt, nestedAttempt].map((entry) => entry.analyticsCaptureReceipt),
      [
        failed.analyticsCaptureReceipt,
        succeeded.analyticsCaptureReceipt,
        nested.analyticsCaptureReceipt,
      ],
    );
    const terminalResult = {
      mode: 'single',
      results: [{
        ...succeeded,
        attemptRecords: [failedAttempt, succeededAttempt],
        providerInvocations: [
          ...failed.providerInvocations!,
          ...succeeded.providerInvocations!,
        ],
      }],
    };
    const terminalBilling = getSubagentBillingEntries(terminalResult);
    assert.deepEqual(terminalBilling.map((entry) => entry.path), ['0', '0.0']);
    assert.deepEqual(
      terminalBilling.flatMap((entry) => entry.invocations ?? []).map(
        (entry) => [entry.invocationId, entry.canonicalInvocationId],
      ),
      [
        ['child-provider-.02', failed.providerInvocations![0]!.canonicalInvocationId],
        ['child-provider-.03', succeeded.providerInvocations![0]!.canonicalInvocationId],
        ['nested-provider-.04', nested.providerInvocations![0]!.canonicalInvocationId],
      ],
    );
    assert.deepEqual(
      terminalBilling.map((entry) => entry.attempts?.map(
        (attempt) => attempt.analyticsCaptureReceipt,
      )),
      [
        [failed.analyticsCaptureReceipt, succeeded.analyticsCaptureReceipt],
        [nested.analyticsCaptureReceipt],
      ],
    );
    const accounting = new BillableAccounting({
      getStorageDir: () => root,
      now: () => new Date('2027-01-15T08:00:01.000Z'),
      scheduleRender: () => undefined,
      dispatchArchEvent: () => undefined,
      getAgentDir: () => null,
      isPrivateSession: () => false,
      sessionIdentity: () => ({ sessionId: rootSessionId }),
      currentRunId: () => 'root-run',
      activeOperationId: () => null,
      markDerivedExportDirty: () => assert.fail('canonical reconciliation must not dirty legacy exports'),
      canonicalCapture: hostCapture,
    });
    const terminalTool = {
      id: 'root-subagent-tool',
      name: 'subagent',
      input: {},
      status: 'completed' as const,
      result: terminalResult,
    };
    accounting.observeSubagentToolResult('/fixture/root.jsonl', terminalTool);
    accounting.observeSubagentToolResult('/fixture/root.jsonl', terminalTool);

    const summary = recorder.readProviderAccountingSummary(rootSessionId);
    assert.equal(summary.invocationCount, 4);
    assert.equal(summary.effectiveCostUsd.value, 0.10);
    assert.equal(recorder.readProviderSettlements(rootSessionId).settlements.length, 4);
    const childProviderObservation = recorder.executeReadOnlyQuery(
      `SELECT payload_json FROM analytics_observations
       WHERE entity_kind = 'providerCall' AND json_extract(payload_json, '$.fields.sourceId') = ?`,
      ['child-provider-.03'],
    ).rows[0] as { payload_json: string };
    const childProviderScope = (JSON.parse(
      childProviderObservation.payload_json,
    ) as AnalyticsObservation).scope;
    assert.equal(childProviderScope.rootSessionId, rootSessionId);
    assert.equal(childProviderScope.sessionId, 'child');
    assert.equal(childProviderScope.executionId, succeeded.analyticsCaptureReceipt?.executionId);
    assert.equal(childProviderScope.parentToolCallId, 'canonical-tool:root-subagent-tool');
    assert.deepEqual(
      recorder.readProviderSettlements(rootSessionId).settlements.map((row) => row.reportedCostUsd).sort(),
      [0.01, 0.02, 0.03, 0.04],
    );
    assert.equal(accounting.invocationLedger.projectAll().records.length, 0);

    assert.deepEqual(accounting.projectSessionUsage('/fixture/root.jsonl'), {
      samples: [], authority: 'unknown',
    }, 'the parent retains no duplicate settlement history; the durable four-invocation oracle above is authoritative');

    // Exact producer redelivery is an idempotent replay. The terminal sideband
    // and inclusive usage are never a second settlement authority.
    const failedReplayStatus = captureSubagentTerminalResult(failed, captureContext, 'root-subagent-tool');
    const failedDetailAttempts = submittedDetailBytes.get(
      failed.analyticsCaptureReceipt!.terminalDetailPayloadId,
    ) ?? [];
    assert.deepEqual(
      failedDetailAttempts.map((bytes) => deserialize(bytes)),
      [deserialize(failedDetailAttempts[0]!), deserialize(failedDetailAttempts[0]!)],
      'exact producer redelivery must retain identical terminal detail content',
    );
    assert.deepEqual(
      failedDetailAttempts[1],
      failedDetailAttempts[0],
      'exact producer redelivery must retain identical terminal detail bytes',
    );
    assert.equal(
      failedReplayStatus,
      'submitted',
      failed.analyticsCaptureError ?? 'exact producer redelivery unexpectedly rejected',
    );
    assert.equal(captureSubagentTerminalResult(succeeded, captureContext, 'root-subagent-tool'), 'submitted');
    assert.equal(recorder.readProviderAccountingSummary(rootSessionId).invocationCount, 4);
    assert.equal(recorder.readProviderAccountingSummary(rootSessionId).effectiveCostUsd.value, 0.10);
    assert.equal(failed.analyticsCaptureReceipt?.lastAcknowledgedSequence, 3);
    assert.equal(succeeded.analyticsCaptureReceipt?.lastAcknowledgedSequence, 3);
    assert.equal(nested.analyticsCaptureReceipt?.lastAcknowledgedSequence, 3);
    assert.equal(failed.analyticsCaptureReceipt?.terminalDetailComplete, true);
    assert.equal(succeeded.analyticsCaptureReceipt?.terminalDetailComplete, true);
    assert.equal(nestedAttempt.analyticsCaptureReceipt?.factStatus, 'submitted');
  } finally {
    recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('producer sequence gaps remain visible until late facts fill the contiguous watermark', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-p4-subagent-ordering-'));
  const recorder = new SqliteAnalyticsRecorder(path.join(root, 'analytics.sqlite'));
  try {
    const queued: AnalyticsObservation<object>[] = [];
    const attempt = result({
      childId: 'ordering-child',
      attemptId: 'ordering-attempt',
      invocation: invocation('ordering-provider', 'ordering-attempt', 0.02, 'success'),
      exitCode: 0,
      stopReason: 'completed',
    });
    const status = captureSubagentTerminalResult(attempt, {
      generationId: 'generation-p4-ordering',
      workspaceId: 'workspace-p4',
      captureSubject: { kind: 'session', rootSessionId: 'root-p4-ordering' },
      sink: recorder,
      factSink: { submit: (observation) => { queued.push(observation); } },
      isDetailComplete: (payloadId) => recorder.detailMetadata(payloadId)?.complete === true,
    }, 'ordering-parent-tool');
    assert.equal(status, 'submitted');
    assert.equal(attempt.analyticsCaptureReceipt?.factStatus, 'submitted');
    assert.equal(attempt.analyticsCaptureReceipt?.lastAcknowledgedSequence, undefined);
    assert.equal(attempt.analyticsCaptureReceipt?.terminalDetailComplete, true);
    assert.deepEqual(queued.map((entry) => entry.sourceSequence), [1, 2, 3]);

    recorder.submit(queued[0]!);
    recorder.submit(queued[2]!);
    let state = recorder.readProducerAcknowledgements(queued);
    assert.equal(state[0]?.contiguousWatermark, 1);
    assert.equal(state[0]?.highestObservedSequence, 3);
    assert.deepEqual(state[0]?.visibleGaps, [{ from: 2, to: 2 }]);

    recorder.submit(queued[1]!);
    state = recorder.readProducerAcknowledgements(queued);
    assert.equal(state[0]?.contiguousWatermark, 3);
    assert.deepEqual(state[0]?.visibleGaps, []);
    recorder.submit(queued[1]!);
    assert.equal(recorder.readProviderAccountingSummary('root-p4-ordering').invocationCount, 1);

    assert.throws(
      () => recorder.submit({
        ...queued[1]!,
        fields: { ...queued[1]!.fields, outcome: 'failure' },
      }),
      AnalyticsSourceConflictError,
    );
    assert.equal(recorder.readProviderAccountingSummary('root-p4-ordering').invocationCount, 1);
  } finally {
    recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('aborted attempts preserve partial settlement and expose missing provider evidence without synthetic zero rows', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-p4-subagent-abort-'));
  const recorder = new SqliteAnalyticsRecorder(path.join(root, 'analytics.sqlite'));
  try {
    const context = {
      generationId: 'generation-p4-abort',
      captureSubject: { kind: 'session' as const, rootSessionId: 'root-p4-abort' },
      sink: recorder,
      factSink: recorder,
    };
    const partialInvocation: SubagentProviderInvocationRecord = {
      invocationId: 'aborted-provider-partial',
      attemptId: 'aborted-attempt-with-response',
      provider: 'fixture-provider',
      model: 'fixture-model',
      usage: { output: 7, cost: 0.02 },
      startedAt: 1_800_000_000_000,
      completedAt: 1_800_000_000_001,
      outcome: 'aborted',
    };
    const partial = result({
      childId: 'aborted-child',
      attemptId: partialInvocation.attemptId,
      invocation: partialInvocation,
      exitCode: 1,
      stopReason: 'aborted',
    });
    assert.equal(captureSubagentTerminalResult(partial, context, 'abort-parent-tool'), 'submitted');

    const noResponse = result({
      childId: 'aborted-child-no-response',
      attemptId: 'aborted-attempt-no-response',
      invocation: invocation('unused', 'aborted-attempt-no-response', 0, 'aborted'),
      exitCode: 1,
      stopReason: 'aborted',
    });
    noResponse.providerInvocations = [];
    noResponse.usage = {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0,
    };
    assert.equal(captureSubagentTerminalResult(noResponse, context, 'abort-parent-tool'), 'submitted');

    const settlements = recorder.readProviderSettlements('root-p4-abort').settlements;
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0]?.outcome, 'aborted');
    assert.equal(settlements[0]?.usage.inputTokens, null);
    assert.equal(settlements[0]?.usage.outputTokens, 7);
    assert.equal(settlements[0]?.reportedCostUsd, 0.02);
    const executionRows = recorder.executeReadOnlyQuery(
      `SELECT payload_json FROM analytics_observations
       WHERE entity_kind = 'execution' AND observation_kind = 'end'`,
    ).rows as Array<{ payload_json: string }>;
    const noResponseEnd = executionRows
      .map((row) => JSON.parse(row.payload_json) as AnalyticsObservation)
      .find((entry) => entry.fields.attemptId === 'aborted-attempt-no-response');
    assert.equal(noResponseEnd?.fields.outcome, 'aborted');
    assert.equal(noResponseEnd?.fields.captureIncomplete, true);
    assert.match(String(noResponseEnd?.fields.reason), /without an observable provider response/);
  } finally {
    recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});
