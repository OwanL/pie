import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as waitImmediate } from 'node:timers/promises';
import test from 'node:test';
import { deserialize, serialize } from 'node:v8';
import { fileURLToPath } from 'node:url';

import type {
  AnalyticsTransportAcknowledgement,
  AnalyticsTransportPacket,
} from '../../../shared/analytics/transport.js';
import { sanitizeAnalyticsDetail } from '../../../shared/sensitive-redaction.js';
import { AnalyticsRecorderSupervisor, type AnalyticsWorkerLifecycleEvent } from '../../../extension/src/analytics/recorder-supervisor.js';
import { SqliteAnalyticsRecorder } from '../../../extension/src/analytics/sqlite-recorder.js';
import { AnalyticsWorkerTransport } from '../../../extension/src/backend/analytics-worker-transport.js';
import { HostAnalyticsTransport } from '../../../extension/src/host/analytics-transport.js';
import {
  bindSubagentAnalyticsAttemptState,
  captureSubagentProviderDispatch,
  captureSubagentTerminalResult,
} from '../src/analytics-capture.js';
import { resolveInstalledSubagentAnalyticsCapture } from '../src/analytics-runtime-bridge.js';
import type { SingleResult, SubagentProviderInvocationRecord } from '../types.js';

const workerScript = fileURLToPath(new URL(
  '../../../extension/test/analytics/fixtures/production-recorder-worker.mjs',
  import.meta.url,
));
const workerExecArgv = [
  `--import=${new URL('../../../extension/node_modules/tsx/dist/loader.mjs', import.meta.url).href}`,
];

const generationId = 'p4-production-bridge-generation';
const rootSessionId = 'p4-production-bridge-root';
const route = {
  coordinatorGeneration: 1,
  workerId: 'p4-production-worker',
  workerGeneration: 1,
  workerPid: process.pid,
  rootSessionPath: 'C:/disposable/p4-production-root.jsonl',
  leasePath: 'C:/disposable/p4-production-root.jsonl',
  leaseRevision: 1,
};

function invocation(attemptId: string): SubagentProviderInvocationRecord {
  return {
    invocationId: `${attemptId}:provider:1`,
    attemptId,
    provider: 'fixture-provider',
    model: 'fixture-model',
    usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.04 },
    startedAt: 1_800_000_000_000,
    completedAt: 1_800_000_000_010,
    outcome: 'success',
  };
}

function result(largeBody: string): SingleResult {
  const attemptId = 'p4-production-attempt';
  const providerInvocation = invocation(attemptId);
  return {
    childId: 'p4-production-child',
    agent: 'fixture-agent',
    agentSource: 'project',
    task: 'exercise the production analytics bridge',
    exitCode: 0,
    messages: [{
      role: 'assistant',
      content: [{ type: 'text', text: largeBody }],
      timestamp: providerInvocation.completedAt,
    }],
    stderr: '',
    usage: {
      input: 3,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.04,
      contextTokens: 0,
      turns: 1,
    },
    provider: providerInvocation.provider,
    model: providerInvocation.model,
    attemptId,
    startedAt: providerInvocation.startedAt,
    completedAt: providerInvocation.completedAt,
    stopReason: 'completed',
    providerInvocations: [providerInvocation],
  };
}

function readCompleteDetailBytes(recorder: SqliteAnalyticsRecorder, payloadId: string): Buffer {
  const chunks: Buffer[] = [];
  let offset: number | string = 0;
  for (;;) {
    const range = recorder.readDetailRange(payloadId, offset, 64 * 1024);
    assert.equal(range.available, true);
    chunks.push(Buffer.from(range.bytes));
    if (range.nextOffset === null) break;
    offset = range.nextOffset;
  }
  return Buffer.concat(chunks);
}

function detailWireBytes(packets: AnalyticsTransportPacket[]): Buffer {
  const start = packets.find((packet) => packet.kind === 'detail.start');
  assert.ok(start && start.kind === 'detail.start');
  const chunks = packets
    .filter((packet) => packet.kind === 'detail.chunk' && packet.deliveryId === start.deliveryId)
    .sort((left, right) => {
      assert.equal(left.kind, 'detail.chunk');
      assert.equal(right.kind, 'detail.chunk');
      return left.index - right.index;
    });
  assert.equal(chunks.length, start.chunkCount);
  return Buffer.concat(chunks.map((packet) => {
    assert.equal(packet.kind, 'detail.chunk');
    return Buffer.from(packet.data, 'base64');
  }));
}

function byteDifference(left: Buffer, right: Buffer): {
  offset: number;
  leftHex: string;
  rightHex: string;
} | null {
  const limit = Math.min(left.byteLength, right.byteLength);
  let offset = 0;
  while (offset < limit && left[offset] === right[offset]) offset += 1;
  if (offset === limit && left.byteLength === right.byteLength) return null;
  const start = Math.max(0, offset - 8);
  const end = Math.min(Math.max(left.byteLength, right.byteLength), offset + 16);
  return {
    offset,
    leftHex: left.subarray(start, Math.min(end, left.byteLength)).toString('hex'),
    rightHex: right.subarray(start, Math.min(end, right.byteLength)).toString('hex'),
  };
}

function firstText(value: SingleResult): string | undefined {
  return (value.messages[0]?.content[0] as { text?: string } | undefined)?.text;
}

test('actual subagent producer reaches SQLite once and receives only recorder-durable ACKs', async () => {
  const proofRoot = mkdtempSync(path.join(tmpdir(), 'pie-p4-production-bridge-'));
  const databasePath = path.join(proofRoot, 'analytics.sqlite');
  const lifecycle: AnalyticsWorkerLifecycleEvent[] = [];
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript,
    execArgv: workerExecArgv,
    databasePath,
    maxBatchSize: 32,
    maxQueuedRecords: 256,
    maxQueuedBytes: 32 * 1024 * 1024,
    onWorkerLifecycle: (event) => lifecycle.push(event),
  });
  let producerTransport: AnalyticsWorkerTransport | undefined;
  let hostTransport: HostAnalyticsTransport | undefined;
  let readModel: SqliteAnalyticsRecorder | undefined;
  const acknowledgements: AnalyticsTransportAcknowledgement[] = [];
  const factDeliveryIds: string[] = [];
  const detailStarts: Array<{ byteLength: number; sha256: string }> = [];
  const detailPackets: AnalyticsTransportPacket[] = [];
  const hostErrors: Error[] = [];
  let primaryFailure: unknown;
  try {
    await supervisor.start();
    const backend = {
      getGeneration: () => route.coordinatorGeneration,
      onEvent: () => ({ dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
      request: async <Result = unknown>(method: string, params?: unknown): Promise<Result> => {
        assert.equal(method, 'analytics.ack');
        assert.ok(params && typeof params === 'object' && !Array.isArray(params));
        assert.deepEqual(Reflect.get(params, 'route'), route);
        const acknowledgement = Reflect.get(params, 'acknowledgement') as AnalyticsTransportAcknowledgement;
        acknowledgements.push(acknowledgement);
        producerTransport?.acknowledge(acknowledgement);
        return { accepted: true } as Result;
      },
    };
    hostTransport = new HostAnalyticsTransport({
      generationId,
      backend,
      recorder: supervisor,
      maxPendingDetails: 4,
      maxPendingDetailBytes: 8 * 1024 * 1024,
      onError: (error) => hostErrors.push(error),
    });
    producerTransport = new AnalyticsWorkerTransport({
      sendAnalyticsFrame: (packet, onSettled) => {
        if (packet.kind === 'fact') factDeliveryIds.push(packet.deliveryId);
        if (packet.kind.startsWith('detail.')) detailPackets.push(structuredClone(packet));
        if (packet.kind === 'detail.start') {
          detailStarts.push({ byteLength: packet.byteLength, sha256: packet.sha256 });
        }
        queueMicrotask(() => {
          hostTransport?.receive({ route, packet: JSON.parse(JSON.stringify(packet)) });
          onSettled?.({ status: 'sent' });
        });
        return true;
      },
      requestAnalyticsSubjectRebind: async (captureSubject) => captureSubject,
    }, {
      generationId,
      captureSubject: { kind: 'session', rootSessionId },
      workspaceId: 'p4-production-workspace',
      buildId: 'p4-production-build',
    }, 'p4-production-process');
    producerTransport.install();
    const capture = resolveInstalledSubagentAnalyticsCapture();
    assert.ok(capture);

    const runtimeContext = {};
    const attemptState = bindSubagentAnalyticsAttemptState(runtimeContext, {
      attemptId: 'p4-production-attempt',
      childId: 'p4-production-child',
      parentToolCallId: 'p4-parent-tool',
      startedAtMs: 1_800_000_000_000,
    });
    captureSubagentProviderDispatch(capture, attemptState, {
      observedAtMs: 1_800_000_000_000,
    });
    const largeBody = `p4-production-unique:${'z'.repeat(1024 * 1024 + 257)}`;
    const first = result(largeBody);
    assert.equal(captureSubagentTerminalResult(first, capture, 'p4-parent-tool', attemptState), 'submitted');
    assert.ok(first.analyticsCaptureReceipt);
    assert.equal(factDeliveryIds.length, 4, 'begin, dispatch, provider settlement, and terminal facts must all enter transport');
    const sealedReceipt = structuredClone(first.analyticsCaptureReceipt);

    await waitImmediate();
    await supervisor.flush();
    assert.deepEqual(first.analyticsCaptureReceipt, sealedReceipt, 'delayed ACK must not mutate the sealed terminal receipt');
    assert.deepEqual(hostErrors, []);
    assert.equal(acknowledgements.length, 5, 'four facts and one detail receive independent durable dispositions');
    assert.ok(acknowledgements.every((acknowledgement) => acknowledgement.status === 'durable'));
    assert.equal(acknowledgements.filter((acknowledgement) => acknowledgement.completeDetailPayloadId).length, 1);
    assert.ok((detailStarts[0]?.byteLength ?? 0) > 1024 * 1024, 'the real transport must stream more than 1 MiB');

    readModel = new SqliteAnalyticsRecorder(databasePath, { readOnly: true });
    assert.equal(readModel.countTypedEntityObservations('execution', rootSessionId), 2);
    assert.equal(readModel.countProviderSettlements(rootSessionId), 1);
    assert.equal(readModel.countDetails(rootSessionId), 1);
    const firstSettlements = readModel.readScopedProviderSettlements({ kind: 'rootSession', rootSessionId });
    assert.equal(firstSettlements.settlementCoverage, 'complete');
    assert.equal(firstSettlements.settlements.length, 1);
    assert.equal(firstSettlements.settlements[0]?.reportedCostUsd, 0.04);
    assert.equal(firstSettlements.settlements[0]?.usage.inputTokens, 3);
    assert.equal(firstSettlements.settlements[0]?.usage.outputTokens, 2);
    const payloadId = first.analyticsCaptureReceipt?.terminalDetailPayloadId;
    assert.ok(payloadId);
    const firstWirePackets = detailPackets.splice(0);
    const firstWireBytes = detailWireBytes(firstWirePackets);
    assert.equal(firstWireBytes.byteLength, detailStarts[0]?.byteLength);
    assert.equal(createHash('sha256').update(firstWireBytes).digest('hex'), detailStarts[0]?.sha256);
    const fixedPointBytes = serialize(sanitizeAnalyticsDetail(deserialize(firstWireBytes)));
    assert.deepEqual(fixedPointBytes, firstWireBytes, 'producer detail bytes must be a canonical fixed point');
    const firstDetailBytes = readCompleteDetailBytes(readModel, payloadId);
    const wireHash = createHash('sha256').update(firstWireBytes).digest('hex');
    const readHash = createHash('sha256').update(firstDetailBytes).digest('hex');
    const wireValue = deserialize(firstWireBytes) as SingleResult;
    const readValue = deserialize(firstDetailBytes) as SingleResult;
    assert.deepEqual(readValue, wireValue, 'SQLite detail reconstruction must preserve decoded wire semantics');
    const difference = byteDifference(firstWireBytes, firstDetailBytes);
    assert.equal(firstDetailBytes.byteLength, firstWireBytes.byteLength, JSON.stringify({
      wireBytes: firstWireBytes.byteLength,
      readBytes: firstDetailBytes.byteLength,
      wireHash,
      readHash,
      difference,
    }));
    assert.equal(readHash, wireHash, JSON.stringify({ wireHash, readHash, difference }));
    assert.equal(firstText(readValue), largeBody);
    readModel.close();
    readModel = undefined;

    const replay = structuredClone(first);
    delete replay.analyticsCaptureReceipt;
    delete replay.analyticsCaptureError;
    const replayAttemptState = bindSubagentAnalyticsAttemptState({}, {
      attemptId: 'p4-production-attempt',
      childId: 'p4-production-child',
      parentToolCallId: 'p4-parent-tool',
      startedAtMs: 1_800_000_000_000,
    });
    captureSubagentProviderDispatch(capture, replayAttemptState, {
      observedAtMs: 1_800_000_000_000,
    });
    assert.equal(captureSubagentTerminalResult(replay, capture, 'p4-parent-tool', replayAttemptState), 'submitted');
    await waitImmediate();
    await supervisor.flush();
    assert.equal(acknowledgements.length, 10, 'exact redelivery is acknowledged per record without another entity or charge');
    assert.deepEqual(hostErrors, []);

    const conflict = result(`${largeBody}:changed`);
    conflict.providerInvocations![0]!.usage!.cost = 0.4;
    const conflictAttemptState = bindSubagentAnalyticsAttemptState({}, {
      attemptId: 'p4-production-attempt',
      childId: 'p4-production-child',
      parentToolCallId: 'p4-parent-tool',
      startedAtMs: 1_800_000_000_000,
    });
    captureSubagentProviderDispatch(capture, conflictAttemptState, {
      observedAtMs: 1_800_000_000_000,
    });
    assert.equal(captureSubagentTerminalResult(conflict, capture, 'p4-parent-tool', conflictAttemptState), 'submitted');
    await waitImmediate();
    await supervisor.flush();
    const conflictAcknowledgements = acknowledgements.slice(10);
    assert.equal(conflictAcknowledgements.length, 5);
    assert.equal(conflictAcknowledgements.filter((acknowledgement) => acknowledgement.status === 'durable').length, 3);
    const rejectedConflicts = conflictAcknowledgements.filter((acknowledgement) => acknowledgement.status === 'rejected');
    assert.equal(rejectedConflicts.length, 2, 'changed provider settlement and detail are rejected independently');
    assert.ok(rejectedConflicts.every((acknowledgement) => acknowledgement.code === 'source_conflict'));
    assert.deepEqual(hostErrors, []);
    await supervisor.shutdown();

    readModel = new SqliteAnalyticsRecorder(databasePath, { readOnly: true });
    assert.equal(readModel.countTypedEntityObservations('execution', rootSessionId), 2);
    assert.equal(readModel.countProviderSettlements(rootSessionId), 1);
    assert.equal(readModel.countDetails(rootSessionId), 1);
    const settlementsAfterConflict = readModel.readScopedProviderSettlements({ kind: 'rootSession', rootSessionId }).settlements;
    assert.equal(settlementsAfterConflict.length, 1);
    assert.equal(settlementsAfterConflict[0]?.reportedCostUsd, 0.04);
    const replayedDetailBytes = readCompleteDetailBytes(readModel, payloadId);
    assert.equal(createHash('sha256').update(replayedDetailBytes).digest('hex'), detailStarts[0]?.sha256);
    assert.equal(firstText(deserialize(replayedDetailBytes) as SingleResult), largeBody);
    assert.deepEqual(lifecycle.map((event) => event.state), ['spawned', 'ready', 'terminal']);
    assert.equal(lifecycle.filter((event) => event.state === 'terminal').length, 1);
  } catch (error) {
    primaryFailure = error;
  } finally {
    readModel?.close();
    hostTransport?.dispose();
    producerTransport?.dispose();
    try {
      await supervisor.shutdown();
    } catch (error) {
      if (primaryFailure === undefined) primaryFailure = error;
    }
    try {
      rmSync(proofRoot, { recursive: true, force: true });
    } catch (error) {
      if (primaryFailure === undefined) primaryFailure = error;
    }
  }
  if (primaryFailure !== undefined) throw primaryFailure;
});
