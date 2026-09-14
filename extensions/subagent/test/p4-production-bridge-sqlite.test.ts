import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as waitImmediate } from 'node:timers/promises';
import test from 'node:test';
import { deserialize, serialize } from 'node:v8';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import type {
  AnalyticsTransportAcknowledgement,
  AnalyticsTransportPacket,
} from '../../../shared/analytics/transport.js';
import { canonicalAnalyticsToolEntityId } from '../../../shared/analytics/transport.js';
import type { AgentConfig } from '../agents.js';
import { executeSingleTask } from '../src/single.js';
import type { SelectionContext } from '../src/selection.js';
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
import type { RetryClock } from '../src/retry.js';
import type { RuntimeTraceEvent } from '../src/runtime-trace.js';
import type { SingleResult, SubagentDetails, SubagentProviderInvocationRecord } from '../types.js';

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
    maxQueueRecords: 256,
    maxQueueBytes: 32 * 1024 * 1024,
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

// ---------------------------------------------------------------------------
// executeSingleTask → installed production bridge seam (real runner path)
// ---------------------------------------------------------------------------

const PARENT_TASK = 'exercise executeSingleTask through the installed production bridge';
const NESTED_TASK = 'nested child produced the shared rich body';
const nestedChildId = 'p4-production-nested-child';
const nestedToolCallId = 'p4-production-nested-tool';
const credentialSentinel = 'sk-ant-p4-sentinel-0123456789abcd';
const nestedBody = `p4-nested-unique:${credentialSentinel}:${'w'.repeat(1024 * 1024 + 111)}`;
const nestedBodyRedacted = `p4-nested-unique:[credential redacted]:${'w'.repeat(1024 * 1024 + 111)}`;

function nestedResultOf(value: SingleResult): SingleResult {
  const message = value.messages[0] as { details?: SubagentDetails } | undefined;
  const nested = message?.details?.results?.[0];
  assert.ok(nested, 'the rich result must embed a nested child in its toolResult details');
  return nested;
}

function textOfMessage(value: SingleResult): string {
  const content = value.messages[0]?.content[0] as { text?: string } | undefined;
  assert.ok(typeof content?.text === 'string');
  return content.text;
}

function runnerAgent(): AgentConfig {
  return {
    name: 'fixture-agent',
    description: 'test',
    systemPrompt: '',
    source: 'project',
    filePath: 'fixture-agent.md',
    bucket: 'medium',
  };
}

function runnerSelection(): SelectionContext {
  const models = [{ provider: 'fixture-provider', id: 'fixture-model', input: ['text'] }];
  return {
    modelConfig: [],
    disabledProviders: new Set(),
    allowedModelIds: undefined,
    bucketAssignments: {
      small: [],
      medium: models.map((model) => ({ model: model.id, thinkingLevel: 'high' as const })),
      frontier: [],
    },
    alwaysParentModel: false,
    nestedAllowedBuckets: { small: true, medium: true, frontier: true },
    registryModels: models,
    fallbackOnProviderFailure: true,
  };
}

function runnerToolContext() {
  const models = [{ provider: 'fixture-provider', id: 'fixture-model', input: ['text'] }];
  return {
    cwd: process.cwd(),
    model: { provider: 'parent', id: 'parent-model' },
    modelRegistry: {
      getAvailable: () => models,
      getAll: () => models,
      find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
    },
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => undefined },
  };
}

/** Rich terminal result with a nested toolResult wrapper: `details.results[0]`
 * carries a >1MiB child body plus child metadata distinct from the parent's. */
function richResult(attemptId: string, completedAtMs: number): SingleResult {
  return {
    agent: 'fixture-agent',
    agentSource: 'project',
    task: PARENT_TASK,
    exitCode: 0,
    messages: [{
      role: 'toolResult',
      toolCallId: 'p4-nested-tool-call',
      toolName: 'subagent',
      content: [{ type: 'text', text: 'nested delegation wrapper' }],
      isError: false,
      timestamp: completedAtMs,
      details: {
        mode: 'single',
        agentScope: 'project',
        projectAgentsDir: null,
        results: [{
          childId: nestedChildId,
          agent: 'fixture-nested-agent',
          agentSource: 'project',
          task: NESTED_TASK,
          exitCode: 0,
          messages: [{
            role: 'assistant',
            content: [{ type: 'text', text: nestedBody }],
            timestamp: completedAtMs,
          }],
          stderr: '',
          usage: { input: 7, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.4, contextTokens: 0, turns: 1 },
          provider: 'fixture-nested-provider',
          model: 'fixture-nested-model',
          startedAt: completedAtMs - 10,
          completedAt: completedAtMs,
          stopReason: 'completed',
        } as SingleResult],
      },
    }],
    stderr: '',
    usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.04, contextTokens: 0, turns: 1 },
    provider: 'fixture-provider',
    model: 'fixture-model',
    startedAt: completedAtMs - 10,
    completedAt: completedAtMs,
    stopReason: 'completed',
    providerInvocations: [{
      invocationId: `${attemptId}:provider:1`,
      attemptId,
      provider: 'fixture-provider',
      model: 'fixture-model',
      usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.04 },
      startedAt: completedAtMs - 10,
      completedAt: completedAtMs,
      outcome: 'success',
    }],
  };
}

test('executeSingleTask hands a rich nested payload to the installed bridge and completes before held ACKs', async () => {
  const proofRoot = mkdtempSync(path.join(tmpdir(), 'pie-p4-runner-nested-'));
  const databasePath = path.join(proofRoot, 'analytics.sqlite');
  const nestedRoute = {
    ...route,
    rootSessionPath: 'C:/disposable/p4-production-nested-root.jsonl',
    leasePath: 'C:/disposable/p4-production-nested-root.jsonl',
  };
  const rootSessionId = 'p4-production-nested-root';
  const lifecycle: AnalyticsWorkerLifecycleEvent[] = [];
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript,
    execArgv: workerExecArgv,
    databasePath,
    maxBatchSize: 32,
    maxQueueRecords: 256,
    maxQueueBytes: 32 * 1024 * 1024,
    onWorkerLifecycle: (event) => lifecycle.push(event),
  });
  let producerTransport: AnalyticsWorkerTransport | undefined;
  let hostTransport: HostAnalyticsTransport | undefined;
  let readModel: SqliteAnalyticsRecorder | undefined;
  const heldAcknowledgements: AnalyticsTransportAcknowledgement[] = [];
  const factDeliveryIds: string[] = [];
  const detailStarts: Array<{ byteLength: number; sha256: string; detail: { payloadId?: string; metadata?: Record<string, unknown> } }> = [];
  const detailPackets: AnalyticsTransportPacket[] = [];
  const hostErrors: Error[] = [];
  let deliveredAcknowledgements = 0;
  let releaseAcknowledgements!: () => void;
  const acknowledgementGate = new Promise<void>((resolve) => { releaseAcknowledgements = resolve; });
  let fixtureResult: SingleResult | undefined;
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
        assert.deepEqual(Reflect.get(params, 'route'), nestedRoute);
        const acknowledgement = Reflect.get(params, 'acknowledgement') as AnalyticsTransportAcknowledgement;
        heldAcknowledgements.push(acknowledgement);
        // Hold the ACK delivery: the producer learns nothing until released.
        await acknowledgementGate;
        producerTransport?.acknowledge(acknowledgement);
        deliveredAcknowledgements += 1;
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
          detailStarts.push({ byteLength: packet.byteLength, sha256: packet.sha256, detail: packet.detail });
        }
        queueMicrotask(() => {
          hostTransport?.receive({ route: nestedRoute, packet: JSON.parse(JSON.stringify(packet)) });
          onSettled?.({ status: 'sent' });
        });
        return true;
      },
      requestAnalyticsSubjectRebind: async (captureSubject) => captureSubject,
    }, {
      generationId,
      captureSubject: { kind: 'session', rootSessionId },
      workspaceId: 'p4-production-nested-workspace',
      buildId: 'p4-production-build',
    }, 'p4-production-nested-process');
    producerTransport.install();
    const capture = resolveInstalledSubagentAnalyticsCapture();
    assert.ok(capture, 'the installed production bridge must own capture for the real runner seam');

    const envelope = await executeSingleTask({
      params: { agent: 'fixture-agent', task: PARENT_TASK, bucket: 'medium' },
      ctx: runnerToolContext() as never,
      agents: [runnerAgent()],
      runtimeCtx: { depth: 0, trail: [], budget: { sessions: 0 }, analyticsCapture: capture },
      makeDetails: (results) => ({ mode: 'single', agentScope: 'project', projectAgentsDir: null, results }),
      onUpdate: () => undefined,
      signal: new AbortController().signal,
      selectionCtx: runnerSelection(),
      toolCallId: nestedToolCallId,
      parentUiBridge: undefined,
      parentSessionId: 'p4-production-nested-parent',
      allToolNames: undefined,
      _internal: {
        runAttempt: async (_resolved, attemptId, _onUpdate, onProviderDispatch) => {
          assert.ok(onProviderDispatch);
          onProviderDispatch({
            provider: 'fixture-provider',
            model: 'fixture-model',
            thinkingLevel: 'high',
            observedAtMs: 1_800_000_000_050,
          });
          const built = richResult(attemptId, 1_800_000_000_100);
          fixtureResult = built;
          return built;
        },
      },
    });
    assert.equal(envelope.isError, undefined);
    assert.ok(envelope.details.results[0]);
    assert.ok(fixtureResult);
    await waitImmediate();
    await waitImmediate();

    // The real runner sealed the capture receipt itself; the test never calls
    // the capture functions, so the installed context is the sole owner.
    const receipt = fixtureResult.analyticsCaptureReceipt;
    assert.ok(receipt);
    assert.equal(fixtureResult.analyticsCaptureStatus, 'submitted');
    assert.equal(receipt.attemptId, fixtureResult.attemptId);
    assert.ok(fixtureResult.providerInvocations?.[0]?.invocationId === `${receipt.attemptId}:provider:1`);
    assert.deepEqual(receipt.predispatch, {
      factStatus: 'submitted',
      providerRequestCount: 1,
      providerRequestIds: [`${receipt.attemptId}:provider:1`],
      lastSubmittedSequence: 2,
      internalRetryCoverage: 'unknown',
    });
    assert.equal(receipt.lastSubmittedSequence, 4, 'begin, dispatch, settlement, and end facts were submitted');
    assert.equal('lastAcknowledgedSequence' in receipt, false, 'the sealed receipt must not wait for storage');
    assert.equal(receipt.terminalDetailComplete, false, 'detail completeness is sampled before any held ACK');
    assert.equal(factDeliveryIds.length, 4);
    assert.ok((detailStarts[0]?.byteLength ?? 0) > 1024 * 1024, 'the rich nested body must stream beyond 1 MiB');
    assert.equal(deliveredAcknowledgements, 0, 'executeSingleTask completed while every ACK was still held');
    const sealedReceipt = structuredClone(receipt);

    // Mutate the returned/source object after the handoff: the persisted copy
    // must already be independently owned bytes.
    fixtureResult.usage.cost = 9.99;
    fixtureResult.task = 'mutated-after-handoff';
    (nestedResultOf(fixtureResult).messages[0]!.content[0] as unknown as { text: string }).text
      = `${nestedBody}:MUTATED-AFTER-HANDOFF`;

    releaseAcknowledgements();
    for (let index = 0; index < 10; index += 1) await waitImmediate();
    await supervisor.flush();
    for (let index = 0; index < 25; index += 1) await waitImmediate();

    assert.equal(heldAcknowledgements.length, 5, 'four facts and one detail receive independent dispositions');
    assert.equal(deliveredAcknowledgements, 5, 'every held ACK reached the producer only after release');
    assert.ok(heldAcknowledgements.every((acknowledgement) => acknowledgement.status === 'durable'));
    assert.equal(heldAcknowledgements.filter((acknowledgement) => acknowledgement.completeDetailPayloadId).length, 1);
    assert.deepEqual(hostErrors, []);
    assert.deepEqual(
      fixtureResult.analyticsCaptureReceipt,
      sealedReceipt,
      'a late ACK must not mutate the sealed terminal receipt',
    );

    readModel = new SqliteAnalyticsRecorder(databasePath, { readOnly: true });
    assert.equal(readModel.countTypedEntityObservations('execution', rootSessionId), 2);
    assert.equal(readModel.countProviderSettlements(rootSessionId), 1);
    assert.equal(readModel.countDetails(rootSessionId), 1);
    const settlements = readModel.readScopedProviderSettlements({ kind: 'rootSession', rootSessionId });
    assert.equal(settlements.settlementCoverage, 'complete');
    assert.equal(settlements.settlements.length, 1);
    assert.equal(settlements.settlements[0]?.reportedCostUsd, 0.04, 'the mutated source cost must not reach durable facts');
    assert.equal(settlements.settlements[0]?.usage.inputTokens, 3);
    assert.equal(settlements.settlements[0]?.usage.outputTokens, 2);

    const start = detailStarts[0]!;
    assert.equal(start.detail.payloadId, receipt.terminalDetailPayloadId);
    assert.equal(start.detail.metadata?.childId, fixtureResult.childId);
    assert.equal(start.detail.metadata?.attemptId, fixtureResult.attemptId);
    assert.equal(start.detail.metadata?.outcome, 'completed');
    assert.equal(
      start.detail.metadata?.parentToolCallId,
      canonicalAnalyticsToolEntityId(rootSessionId, nestedToolCallId),
      'the installed bridge maps the parent tool identity',
    );
    const wirePackets = detailPackets.splice(0);
    const wireBytes = detailWireBytes(wirePackets);
    assert.equal(wireBytes.byteLength, start.byteLength);
    assert.equal(createHash('sha256').update(wireBytes).digest('hex'), start.sha256);
    assert.deepEqual(
      serialize(sanitizeAnalyticsDetail(deserialize(wireBytes))),
      wireBytes,
      'the redacted detail must remain a canonical fixed point',
    );
    const persistedBytes = readCompleteDetailBytes(readModel, receipt.terminalDetailPayloadId);
    assert.equal(persistedBytes.byteLength, wireBytes.byteLength);
    assert.equal(createHash('sha256').update(persistedBytes).digest('hex'), start.sha256);

    const decodedParent = deserialize(persistedBytes) as SingleResult;
    const decodedNested = nestedResultOf(decodedParent);
    assert.equal(decodedParent.task, PARENT_TASK, 'the mutated source task must not reach the persisted copy');
    assert.equal(decodedParent.usage.cost, 0.04, 'the mutated source cost must not reach the persisted copy');
    assert.equal(decodedParent.provider, 'fixture-provider');
    assert.equal(decodedParent.model, 'fixture-model');
    assert.equal(decodedNested.childId, nestedChildId);
    assert.equal(decodedNested.agent, 'fixture-nested-agent');
    assert.equal(decodedNested.task, NESTED_TASK);
    assert.equal(decodedNested.provider, 'fixture-nested-provider');
    assert.equal(decodedNested.model, 'fixture-nested-model');
    assert.equal(decodedNested.usage.cost, 0.4);
    const decodedNestedText = textOfMessage(decodedNested);
    assert.equal(decodedNestedText, nestedBodyRedacted, 'the credential sentinel must be redacted per the shared policy');
    assert.equal(decodedNestedText.includes(credentialSentinel), false);
    assert.equal(decodedNestedText.includes(':MUTATED-AFTER-HANDOFF'), false);
    assert.ok(Buffer.byteLength(decodedNestedText, 'utf8') > 1024 * 1024);
    readModel.close();
    readModel = undefined;
    await supervisor.shutdown();
    assert.deepEqual(lifecycle.map((event) => event.state), ['spawned', 'ready', 'terminal']);
  } catch (error) {
    primaryFailure = error;
  } finally {
    readModel?.close();
    hostTransport?.dispose();
    producerTransport?.dispose();
    releaseAcknowledgements();
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

test('executeSingleTask hands a cancelled rich nested payload to the installed bridge before held ACKs', async () => {
  const proofRoot = mkdtempSync(path.join(tmpdir(), 'pie-p4-runner-cancelled-'));
  const databasePath = path.join(proofRoot, 'analytics.sqlite');
  const cancelledRoute = {
    ...route,
    rootSessionPath: 'C:/disposable/p4-production-cancelled-root.jsonl',
    leasePath: 'C:/disposable/p4-production-cancelled-root.jsonl',
  };
  const cancelledRootSessionId = 'p4-production-cancelled-root';
  const lifecycle: AnalyticsWorkerLifecycleEvent[] = [];
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript,
    execArgv: workerExecArgv,
    databasePath,
    maxBatchSize: 32,
    maxQueueRecords: 256,
    maxQueueBytes: 32 * 1024 * 1024,
    onWorkerLifecycle: (event) => lifecycle.push(event),
  });
  let producerTransport: AnalyticsWorkerTransport | undefined;
  let hostTransport: HostAnalyticsTransport | undefined;
  let readModel: SqliteAnalyticsRecorder | undefined;
  const heldAcknowledgements: AnalyticsTransportAcknowledgement[] = [];
  const factDeliveryIds: string[] = [];
  const detailStarts: Array<{ byteLength: number; sha256: string; detail: { payloadId?: string; metadata?: Record<string, unknown> } }> = [];
  const detailPackets: AnalyticsTransportPacket[] = [];
  const hostErrors: Error[] = [];
  let deliveredAcknowledgements = 0;
  let releaseAcknowledgements!: () => void;
  const acknowledgementGate = new Promise<void>((resolve) => { releaseAcknowledgements = resolve; });
  const cancellationController = new AbortController();
  let attemptEntered!: () => void;
  const attemptStarted = new Promise<void>((resolve) => { attemptEntered = resolve; });
  let attemptReturned = false;
  let fixtureResult: SingleResult | undefined;
  let primaryFailure: unknown;
  try {
    await supervisor.start();
    const backend = {
      getGeneration: () => cancelledRoute.coordinatorGeneration,
      onEvent: () => ({ dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
      request: async <Result = unknown>(method: string, params?: unknown): Promise<Result> => {
        assert.equal(method, 'analytics.ack');
        assert.ok(params && typeof params === 'object' && !Array.isArray(params));
        assert.deepEqual(Reflect.get(params, 'route'), cancelledRoute);
        const acknowledgement = Reflect.get(params, 'acknowledgement') as AnalyticsTransportAcknowledgement;
        heldAcknowledgements.push(acknowledgement);
        await acknowledgementGate;
        producerTransport?.acknowledge(acknowledgement);
        deliveredAcknowledgements += 1;
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
          detailStarts.push({ byteLength: packet.byteLength, sha256: packet.sha256, detail: packet.detail });
        }
        queueMicrotask(() => {
          hostTransport?.receive({ route: cancelledRoute, packet: JSON.parse(JSON.stringify(packet)) });
          onSettled?.({ status: 'sent' });
        });
        return true;
      },
      requestAnalyticsSubjectRebind: async (captureSubject) => captureSubject,
    }, {
      generationId,
      captureSubject: { kind: 'session', rootSessionId: cancelledRootSessionId },
      workspaceId: 'p4-production-cancelled-workspace',
      buildId: 'p4-production-build',
    }, 'p4-production-cancelled-process');
    producerTransport.install();
    const capture = resolveInstalledSubagentAnalyticsCapture();
    assert.ok(capture, 'the installed production bridge must own capture for cancellation');

    const responsePromise = executeSingleTask({
      params: { agent: 'fixture-agent', task: PARENT_TASK, bucket: 'medium' },
      ctx: runnerToolContext() as never,
      agents: [runnerAgent()],
      runtimeCtx: { depth: 0, trail: [], budget: { sessions: 0 }, analyticsCapture: capture },
      makeDetails: (results) => ({ mode: 'single', agentScope: 'project', projectAgentsDir: null, results }),
      onUpdate: () => undefined,
      signal: cancellationController.signal,
      selectionCtx: runnerSelection(),
      toolCallId: 'p4-cancelled-nested-tool',
      parentUiBridge: undefined,
      parentSessionId: 'p4-production-cancelled-parent',
      allToolNames: undefined,
      _internal: {
        runAttempt: async (_resolved, attemptId, _onAttemptUpdate, onProviderDispatch) => {
          assert.ok(onProviderDispatch);
          onProviderDispatch({
            provider: 'fixture-provider',
            model: 'fixture-model',
            thinkingLevel: 'high',
            observedAtMs: 1_800_000_000_050,
          });
          attemptEntered();
          await new Promise<void>((resolve) => {
            const onAbort = () => {
              cancellationController.signal.removeEventListener('abort', onAbort);
              resolve();
            };
            if (cancellationController.signal.aborted) onAbort();
            else cancellationController.signal.addEventListener('abort', onAbort, { once: true });
          });
          const built = richResult(attemptId, 1_800_000_000_100);
          built.exitCode = 1;
          built.stopReason = 'aborted';
          built.errorMessage = 'cancelled by test controller';
          built.failureClass = 'abort';
          built.retryable = false;
          built.replaySafety = 'terminal';
          built.providerInvocations![0]!.outcome = 'aborted';
          fixtureResult = built;
          attemptReturned = true;
          return built;
        },
      },
    });
    await attemptStarted;
    assert.equal(cancellationController.signal.aborted, false);
    cancellationController.abort();
    const envelope = await responsePromise;
    assert.equal(attemptReturned, true, 'the injected provider returned after cancellation was observed');
    assert.equal(envelope.isError, true, 'the cancelled terminal result must settle the task as an error');
    assert.equal(envelope.details.results[0]?.stopReason, 'aborted');
    assert.ok(fixtureResult);
    const receipt = fixtureResult.analyticsCaptureReceipt;
    assert.ok(receipt);
    assert.equal(fixtureResult.stopReason, 'aborted');
    assert.equal(fixtureResult.analyticsCaptureStatus, 'submitted');
    assert.deepEqual(receipt.predispatch, {
      factStatus: 'submitted',
      providerRequestCount: 1,
      providerRequestIds: [`${receipt.attemptId}:provider:1`],
      lastSubmittedSequence: 2,
      internalRetryCoverage: 'unknown',
    });
    assert.equal(receipt.lastSubmittedSequence, 4, 'cancelled terminal facts include the aborted provider settlement');
    assert.equal('lastAcknowledgedSequence' in receipt, false, 'the task response must not await recorder ACKs');
    assert.equal(receipt.terminalDetailComplete, false, 'detail completeness is sampled before the held ACK');
    assert.equal(factDeliveryIds.length, 4);
    assert.ok((detailStarts[0]?.byteLength ?? 0) > 1024 * 1024, 'the cancelled rich body must stream beyond 1 MiB');
    assert.equal(deliveredAcknowledgements, 0, 'executeSingleTask returned while every analytics ACK was held');
    const sealedReceipt = structuredClone(receipt);

    fixtureResult.usage.cost = 9.99;
    fixtureResult.task = 'mutated-after-cancel-handoff';
    (nestedResultOf(fixtureResult).messages[0]!.content[0] as unknown as { text: string }).text
      = `${nestedBody}:MUTATED-AFTER-HANDOFF`;

    releaseAcknowledgements();
    for (let index = 0; index < 10; index += 1) await waitImmediate();
    await supervisor.flush();
    for (let index = 0; index < 25; index += 1) await waitImmediate();

    assert.equal(heldAcknowledgements.length, 5, 'four facts and one detail receive independent dispositions');
    assert.equal(deliveredAcknowledgements, 5, 'every held ACK reached the producer only after release');
    assert.ok(heldAcknowledgements.every((acknowledgement) => acknowledgement.status === 'durable'));
    assert.equal(heldAcknowledgements.filter((acknowledgement) => acknowledgement.completeDetailPayloadId).length, 1);
    assert.deepEqual(hostErrors, []);
    assert.deepEqual(fixtureResult.analyticsCaptureReceipt, sealedReceipt, 'late ACKs must not mutate the cancelled receipt');

    readModel = new SqliteAnalyticsRecorder(databasePath, { readOnly: true });
    assert.equal(readModel.countTypedEntityObservations('execution', cancelledRootSessionId), 2);
    assert.equal(readModel.countProviderSettlements(cancelledRootSessionId), 1);
    assert.equal(readModel.countDetails(cancelledRootSessionId), 1);
    const settlements = readModel.readScopedProviderSettlements({ kind: 'rootSession', rootSessionId: cancelledRootSessionId });
    assert.equal(settlements.settlementCoverage, 'complete');
    assert.equal(settlements.settlements.length, 1);
    assert.equal(settlements.settlements[0]?.outcome, 'aborted');
    assert.equal(settlements.settlements[0]?.reportedCostUsd, 0.04, 'the mutated source cost must not reach durable facts');

    const start = detailStarts[0]!;
    assert.equal(start.detail.payloadId, receipt.terminalDetailPayloadId);
    assert.equal(start.detail.metadata?.childId, fixtureResult.childId);
    assert.equal(start.detail.metadata?.attemptId, fixtureResult.attemptId);
    assert.equal(start.detail.metadata?.outcome, 'aborted', 'SQLite detail metadata must retain cancellation');
    assert.equal(
      start.detail.metadata?.parentToolCallId,
      canonicalAnalyticsToolEntityId(cancelledRootSessionId, 'p4-cancelled-nested-tool'),
    );
    const wirePackets = detailPackets.splice(0);
    const wireBytes = detailWireBytes(wirePackets);
    assert.equal(wireBytes.byteLength, start.byteLength);
    assert.equal(createHash('sha256').update(wireBytes).digest('hex'), start.sha256);
    assert.deepEqual(
      serialize(sanitizeAnalyticsDetail(deserialize(wireBytes))),
      wireBytes,
      'the redacted cancelled detail must remain a canonical fixed point',
    );
    const persistedBytes = readCompleteDetailBytes(readModel, receipt.terminalDetailPayloadId);
    assert.equal(persistedBytes.byteLength, wireBytes.byteLength);
    assert.equal(createHash('sha256').update(persistedBytes).digest('hex'), start.sha256);

    const decodedParent = deserialize(persistedBytes) as SingleResult;
    const decodedNested = nestedResultOf(decodedParent);
    assert.equal(decodedParent.task, PARENT_TASK);
    assert.equal(decodedParent.exitCode, 1);
    assert.equal(decodedParent.stopReason, 'aborted');
    assert.equal(decodedParent.errorMessage, 'cancelled by test controller');
    assert.equal(decodedParent.provider, 'fixture-provider');
    assert.equal(decodedParent.model, 'fixture-model');
    assert.equal(decodedNested.childId, nestedChildId);
    assert.equal(decodedNested.task, NESTED_TASK);
    assert.equal(decodedNested.provider, 'fixture-nested-provider');
    assert.equal(decodedNested.model, 'fixture-nested-model');
    const decodedNestedText = textOfMessage(decodedNested);
    assert.equal(decodedNestedText, nestedBodyRedacted);
    assert.equal(decodedNestedText.includes(credentialSentinel), false);
    assert.equal(decodedNestedText.includes(':MUTATED-AFTER-HANDOFF'), false);
    assert.ok(Buffer.byteLength(decodedNestedText, 'utf8') > 1024 * 1024);
    readModel.close();
    readModel = undefined;
    await supervisor.shutdown();
    assert.deepEqual(lifecycle.map((event) => event.state), ['spawned', 'ready', 'terminal']);
  } catch (error) {
    primaryFailure = error;
  } finally {
    readModel?.close();
    releaseAcknowledgements();
    hostTransport?.dispose();
    try {
      await producerTransport?.dispose();
    } catch (error) {
      if (primaryFailure === undefined) primaryFailure = error;
    }
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

// ---------------------------------------------------------------------------
// executeSingleTask two-attempt provider failover → installed bridge → SQLite
// ---------------------------------------------------------------------------

const FAILOVER_ROOT_SESSION_ID = 'p4-production-failover-root';
const FAILOVER_TOOL_CALL_ID = 'p4-failover-nested-tool';
const FAILOVER_PARENT_TASK = 'exercise two-attempt provider failover through the installed production bridge';
const failoverModels = [
  { provider: 'fixture-provider', id: 'fixture-model', input: ['text'] },
  { provider: 'fixture-provider-b', id: 'fixture-model-b', input: ['text'] },
];
const failoverFixedNowMs = 1_800_000_000_000;
const immediateRetryClock: RetryClock = {
  now: () => failoverFixedNowMs,
  setTimer: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
};

function failoverSelection(): SelectionContext {
  return {
    modelConfig: [],
    disabledProviders: new Set(),
    allowedModelIds: undefined,
    bucketAssignments: {
      small: [],
      medium: failoverModels.map((model) => ({ model: model.id, thinkingLevel: 'high' as const })),
      frontier: [],
    },
    alwaysParentModel: false,
    nestedAllowedBuckets: { small: true, medium: true, frontier: true },
    registryModels: failoverModels,
    fallbackOnProviderFailure: true,
  };
}

/** Rich terminal result for one failover attempt: a >1MiB nested body behind a
 * toolResult wrapper plus distinct per-attempt provider metadata. The failed
 * attempt is a retryable timeout with an immediate (0 ms) Retry-After. */
function failoverResult(options: {
  attemptId: string;
  provider: string;
  model: string;
  completedAtMs: number;
  failed: boolean;
  nestedChildId: string;
  bodyPrefix: string;
}): SingleResult {
  const usage = options.failed
    ? { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 1 }
    : { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.04, contextTokens: 0, turns: 1 };
  const nestedBody = `${options.bodyPrefix}:${credentialSentinel}:${'w'.repeat(1024 * 1024 + 111)}`;
  return {
    agent: 'fixture-agent',
    agentSource: 'project',
    task: FAILOVER_PARENT_TASK,
    exitCode: options.failed ? 1 : 0,
    messages: [{
      role: 'toolResult',
      toolCallId: 'p4-failover-nested-call',
      toolName: 'subagent',
      content: [{ type: 'text', text: 'nested delegation wrapper' }],
      isError: false,
      timestamp: options.completedAtMs,
      details: {
        mode: 'single',
        agentScope: 'project',
        projectAgentsDir: null,
        results: [{
          childId: options.nestedChildId,
          agent: 'fixture-nested-agent',
          agentSource: 'project',
          task: NESTED_TASK,
          exitCode: 0,
          messages: [{
            role: 'assistant',
            content: [{ type: 'text', text: nestedBody }],
            timestamp: options.completedAtMs,
          }],
          stderr: '',
          usage: { input: 7, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.4, contextTokens: 0, turns: 1 },
          provider: 'fixture-nested-provider',
          model: 'fixture-nested-model',
          startedAt: options.completedAtMs - 10,
          completedAt: options.completedAtMs,
          stopReason: 'completed',
        } as SingleResult],
      },
    }],
    stderr: '',
    usage,
    provider: options.provider,
    model: options.model,
    startedAt: options.completedAtMs - 50,
    completedAt: options.completedAtMs,
    stopReason: options.failed ? 'error' : 'completed',
    ...(options.failed ? {
      errorMessage: 'fixture provider timeout',
      failureClass: 'timeout' as const,
      retryable: true,
      replaySafety: 'safe' as const,
      retryAfterMs: 0,
    } : {}),
    providerInvocations: [{
      invocationId: `${options.attemptId}:provider:1`,
      attemptId: options.attemptId,
      provider: options.provider,
      model: options.model,
      usage: {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        cost: usage.cost,
      },
      startedAt: options.completedAtMs - 50,
      completedAt: options.completedAtMs,
      outcome: options.failed ? ('failure' as const) : ('success' as const),
    }],
  };
}

/** Reassemble every streamed detail payload from the wire packets, grouped by
 * delivery id, so two interleaved attempt payloads stay independent. */
function streamedDetailPayloads(packets: AnalyticsTransportPacket[]): Array<{
  deliveryId: string;
  payloadId: string;
  byteLength: number;
  sha256: string;
  metadata: Record<string, unknown> | undefined;
  bytes: Buffer;
}> {
  return packets
    .filter((packet) => packet.kind === 'detail.start')
    .map((start) => {
      assert.equal(start.kind, 'detail.start');
      const chunks = packets
        .filter((packet) => packet.kind === 'detail.chunk' && packet.deliveryId === start.deliveryId)
        .sort((left, right) => {
          assert.equal(left.kind, 'detail.chunk');
          assert.equal(right.kind, 'detail.chunk');
          return left.index - right.index;
        });
      assert.equal(chunks.length, start.chunkCount);
      return {
        deliveryId: start.deliveryId,
        payloadId: start.detail.payloadId,
        byteLength: start.byteLength,
        sha256: start.sha256,
        metadata: start.detail.metadata as Record<string, unknown> | undefined,
        bytes: Buffer.concat(chunks.map((packet) => {
          assert.equal(packet.kind, 'detail.chunk');
          return Buffer.from(packet.data, 'base64');
        })),
      };
    });
}

test('executeSingleTask failover reaches SQLite through distinct provider attempts under held ACKs', async () => {
  const proofRoot = mkdtempSync(path.join(tmpdir(), 'pie-p4-runner-failover-'));
  const databasePath = path.join(proofRoot, 'analytics.sqlite');
  const failoverRoute = {
    ...route,
    rootSessionPath: 'C:/disposable/p4-production-failover-root.jsonl',
    leasePath: 'C:/disposable/p4-production-failover-root.jsonl',
  };
  const lifecycle: AnalyticsWorkerLifecycleEvent[] = [];
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript,
    execArgv: workerExecArgv,
    databasePath,
    maxBatchSize: 32,
    maxQueueRecords: 256,
    maxQueueBytes: 32 * 1024 * 1024,
    onWorkerLifecycle: (event) => lifecycle.push(event),
  });
  let producerTransport: AnalyticsWorkerTransport | undefined;
  let hostTransport: HostAnalyticsTransport | undefined;
  let readModel: SqliteAnalyticsRecorder | undefined;
  const heldAcknowledgements: AnalyticsTransportAcknowledgement[] = [];
  const factDeliveryIds: string[] = [];
  const detailStarts: Array<{ byteLength: number; sha256: string; detail: { payloadId?: string; metadata?: Record<string, unknown> } }> = [];
  const detailPackets: AnalyticsTransportPacket[] = [];
  const hostErrors: Error[] = [];
  let deliveredAcknowledgements = 0;
  let releaseAcknowledgements!: () => void;
  const acknowledgementGate = new Promise<void>((resolve) => { releaseAcknowledgements = resolve; });
  const traceSinkKey = Symbol.for('pie.runtime-trace-sink.v1');
  const traceTarget = globalThis as Record<PropertyKey, unknown>;
  const previousTraceSink = traceTarget[traceSinkKey];
  const traceEvents: RuntimeTraceEvent[] = [];
  traceTarget[traceSinkKey] = (event: RuntimeTraceEvent) => traceEvents.push(event);
  const attemptIds: string[] = [];
  const attemptProviders: string[] = [];
  const attemptModels: string[] = [];
  let ordinal = 0;
  let failedResult: SingleResult | undefined;
  let succeededResult: SingleResult | undefined;
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
        assert.deepEqual(Reflect.get(params, 'route'), failoverRoute);
        const acknowledgement = Reflect.get(params, 'acknowledgement') as AnalyticsTransportAcknowledgement;
        heldAcknowledgements.push(acknowledgement);
        // Hold the ACK delivery: the producer learns nothing until released.
        await acknowledgementGate;
        producerTransport?.acknowledge(acknowledgement);
        deliveredAcknowledgements += 1;
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
          detailStarts.push({ byteLength: packet.byteLength, sha256: packet.sha256, detail: packet.detail });
        }
        queueMicrotask(() => {
          hostTransport?.receive({ route: failoverRoute, packet: JSON.parse(JSON.stringify(packet)) });
          onSettled?.({ status: 'sent' });
        });
        return true;
      },
      requestAnalyticsSubjectRebind: async (captureSubject) => captureSubject,
    }, {
      generationId,
      captureSubject: { kind: 'session', rootSessionId: FAILOVER_ROOT_SESSION_ID },
      workspaceId: 'p4-production-failover-workspace',
      buildId: 'p4-production-build',
    }, 'p4-production-failover-process');
    producerTransport.install();
    const capture = resolveInstalledSubagentAnalyticsCapture();
    assert.ok(capture, 'the installed production bridge must own capture for the failover seam');

    const envelope = await executeSingleTask({
      params: { agent: 'fixture-agent', task: FAILOVER_PARENT_TASK, bucket: 'medium' },
      ctx: runnerToolContext() as never,
      agents: [runnerAgent()],
      runtimeCtx: { depth: 0, trail: [], budget: { sessions: 0 }, analyticsCapture: capture },
      makeDetails: (results) => ({ mode: 'single', agentScope: 'project', projectAgentsDir: null, results }),
      onUpdate: () => undefined,
      signal: new AbortController().signal,
      selectionCtx: failoverSelection(),
      toolCallId: FAILOVER_TOOL_CALL_ID,
      parentUiBridge: undefined,
      parentSessionId: 'p4-production-failover-parent',
      allToolNames: undefined,
      _internal: {
        clock: immediateRetryClock,
        runAttempt: async (resolved, attemptId, _onAttemptUpdate, onProviderDispatch) => {
          ordinal += 1;
          const model = resolved.modelOverride!;
          const provider = failoverModels.find((candidate) => candidate.id === model)!.provider;
          assert.ok(onProviderDispatch);
          assert.equal(resolved.selection?.fallback, false, 'failover must select from configured bucket assignments, not the parent fallback');
          onProviderDispatch({
            provider,
            model,
            thinkingLevel: 'high',
            observedAtMs: failoverFixedNowMs + 50 * ordinal,
          });
          const built = failoverResult({
            attemptId,
            provider,
            model,
            completedAtMs: failoverFixedNowMs + 100 * ordinal,
            failed: ordinal === 1,
            nestedChildId: ordinal === 1 ? 'p4-failover-failed-nested-child' : 'p4-failover-success-nested-child',
            bodyPrefix: ordinal === 1 ? 'p4-failover-failed-unique' : 'p4-failover-success-unique',
          });
          attemptIds.push(attemptId);
          attemptProviders.push(provider);
          attemptModels.push(model);
          if (ordinal === 1) failedResult = built;
          else succeededResult = built;
          return built;
        },
      },
    });
    assert.equal(ordinal, 2, 'the retry loop must dispatch exactly two provider attempts');
    assert.equal(envelope.isError, undefined, 'the successful second attempt must settle without an error envelope');
    assert.ok(envelope.details.results[0]);
    assert.equal(deliveredAcknowledgements, 0, 'executeSingleTask completed while every analytics ACK was still held');
    // Detail frames cross the producer transport on microtasks; drain them
    // (without releasing any held ACK) before asserting the wire contents.
    for (let index = 0; index < 100 && (detailStarts.length < 2 || factDeliveryIds.length < 8); index += 1) await waitImmediate();

    // Two distinct attempt identities; the real resolver excluded the failed
    // provider, so the second dispatch must run on the surviving provider.
    assert.equal(attemptIds.length, 2);
    assert.notEqual(attemptIds[0], attemptIds[1], 'each dispatch must carry a distinct attempt identity');
    assert.notEqual(attemptProviders[0], attemptProviders[1], 'the real resolver must exclude the failed provider');
    assert.equal(attemptModels[0], failoverModels.find((model) => model.provider === attemptProviders[0])!.id);
    assert.equal(attemptModels[1], failoverModels.find((model) => model.provider === attemptProviders[1])!.id);

    const terminal = envelope.details.results[0] as SingleResult;
    assert.deepEqual(terminal.attemptRecords?.map((record) => record.attemptId), attemptIds);
    assert.deepEqual(
      terminal.providerInvocations?.map((invocation) => invocation.invocationId),
      attemptIds.map((attemptId) => `${attemptId}:provider:1`),
    );
    assert.equal(terminal.usage.cost, 0.05, 'the terminal envelope must carry the cumulative 0.01 + 0.04 cost');
    assert.equal(terminal.usage.input, 4);
    assert.equal(terminal.usage.output, 3);
    assert.equal(terminal.usage.turns, 2);
    assert.deepEqual(terminal.selectionPool, [attemptModels[1]], 'the retry pool must contain only the surviving provider model');
    assert.equal(terminal.analyticsCaptureStatus, 'submitted');
    assert.equal(factDeliveryIds.length, 8, 'each attempt submitted begin, dispatch, settlement, and end facts');
    assert.equal(detailStarts.length, 2, 'each attempt must stream its own terminal detail payload');
    assert.ok((detailStarts[0]?.byteLength ?? 0) > 1024 * 1024, 'the failed attempt body must stream beyond 1 MiB');
    assert.ok((detailStarts[1]?.byteLength ?? 0) > 1024 * 1024, 'the successful attempt body must stream beyond 1 MiB');
    assert.notEqual(detailStarts[0]?.detail.payloadId, detailStarts[1]?.detail.payloadId);

    // The failed attempt is partially captured under its own identity.
    const failedReceipt = failedResult!.analyticsCaptureReceipt;
    assert.ok(failedReceipt, 'the failed attempt must seal its own partial capture receipt');
    assert.equal(failedResult!.analyticsCaptureStatus, 'submitted', 'the failed attempt must be captured, not skipped');
    assert.equal(failedReceipt.attemptId, attemptIds[0]);
    assert.deepEqual(failedReceipt.predispatch, {
      factStatus: 'submitted',
      providerRequestCount: 1,
      providerRequestIds: [`${attemptIds[0]}:provider:1`],
      lastSubmittedSequence: 2,
      internalRetryCoverage: 'unknown',
    });
    assert.equal(failedReceipt.lastSubmittedSequence, 4, 'failed attempts still seal settlement and end facts');
    assert.equal('lastAcknowledgedSequence' in failedReceipt, false);
    assert.equal(failedReceipt.terminalDetailComplete, false);
    const succeededReceipt = succeededResult!.analyticsCaptureReceipt;
    assert.ok(succeededReceipt);
    assert.equal(succeededResult!.analyticsCaptureStatus, 'submitted');
    assert.equal(succeededReceipt.attemptId, attemptIds[1]);
    assert.deepEqual(succeededReceipt.predispatch, {
      factStatus: 'submitted',
      providerRequestCount: 1,
      providerRequestIds: [`${attemptIds[1]}:provider:1`],
      lastSubmittedSequence: 2,
      internalRetryCoverage: 'unknown',
    });
    assert.equal(succeededReceipt.lastSubmittedSequence, 4);
    assert.equal('lastAcknowledgedSequence' in succeededReceipt, false);
    assert.equal(succeededReceipt.terminalDetailComplete, false);
    assert.notEqual(failedReceipt.terminalDetailPayloadId, succeededReceipt.terminalDetailPayloadId, 'each attempt owns an independent detail payload');
    const sealedFailedReceipt = structuredClone(failedReceipt);
    const sealedSucceededReceipt = structuredClone(succeededReceipt);

    // Mutate the surviving attempt after the handoff: the persisted copy must
    // already be independently owned bytes.
    succeededResult!.usage.cost = 9.99;
    succeededResult!.task = 'mutated-after-failover-handoff';
    (nestedResultOf(succeededResult!).messages[0]!.content[0] as unknown as { text: string }).text
      = `p4-failover-success-unique:${credentialSentinel}:${'w'.repeat(1024 * 1024 + 111)}:MUTATED-AFTER-HANDOFF`;
    assert.equal(terminal.usage.cost, 0.05, 'the envelope cumulative usage is independent of the mutated source');

    releaseAcknowledgements();
    for (let index = 0; index < 400 && deliveredAcknowledgements < 10; index += 1) await waitImmediate();
    await supervisor.flush();
    for (let index = 0; index < 25; index += 1) await waitImmediate();

    assert.equal(heldAcknowledgements.length, 10, 'four facts and one detail per attempt receive independent dispositions');
    assert.equal(deliveredAcknowledgements, 10, 'every held ACK reached the producer only after release');
    assert.ok(heldAcknowledgements.every((acknowledgement) => acknowledgement.status === 'durable'));
    assert.equal(heldAcknowledgements.filter((acknowledgement) => acknowledgement.completeDetailPayloadId).length, 2);
    assert.deepEqual(hostErrors, []);
    assert.deepEqual(failedResult!.analyticsCaptureReceipt, sealedFailedReceipt, 'late ACKs must not mutate the failed attempt receipt');
    assert.deepEqual(succeededResult!.analyticsCaptureReceipt, sealedSucceededReceipt, 'late ACKs must not mutate the sealed terminal receipt');

    readModel = new SqliteAnalyticsRecorder(databasePath, { readOnly: true });
    assert.equal(readModel.countTypedEntityObservations('execution', FAILOVER_ROOT_SESSION_ID), 4, 'each attempt records its own execution begin and end');
    assert.equal(readModel.countProviderSettlements(FAILOVER_ROOT_SESSION_ID), 2);
    assert.equal(readModel.countDetails(FAILOVER_ROOT_SESSION_ID), 2);
    const settlements = readModel.readScopedProviderSettlements({ kind: 'rootSession', rootSessionId: FAILOVER_ROOT_SESSION_ID });
    assert.equal(settlements.settlementCoverage, 'complete');
    assert.equal(settlements.settlements.length, 2);
    const failedSettlement = settlements.settlements.find((settlement) => settlement.reportedCostUsd === 0.01);
    const succeededSettlement = settlements.settlements.find((settlement) => settlement.reportedCostUsd === 0.04);
    assert.ok(failedSettlement, 'the failed attempt settlement must be durable exactly once');
    assert.ok(succeededSettlement, 'the successful attempt settlement must be durable exactly once');
    assert.equal(settlements.settlements.filter((settlement) => settlement.reportedCostUsd === 0.01).length, 1, 'no double charge for the failed attempt');
    assert.equal(settlements.settlements.filter((settlement) => settlement.reportedCostUsd === 0.04).length, 1, 'no double charge for the successful attempt');
    assert.notEqual(failedSettlement.invocationId, succeededSettlement.invocationId);
    assert.equal(failedSettlement.provider, attemptProviders[0]);
    assert.equal(failedSettlement.outcome, 'failure');
    assert.equal(failedSettlement.usage.inputTokens, 1);
    assert.equal(failedSettlement.usage.outputTokens, 1);
    assert.equal(succeededSettlement.provider, attemptProviders[1]);
    assert.equal(succeededSettlement.outcome, 'success');
    assert.equal(succeededSettlement.usage.inputTokens, 3);
    assert.equal(succeededSettlement.usage.outputTokens, 2);

    // Persisted execution-observation outcomes: the 4-row execution count does
    // not itself carry the terminal failed/succeeded disposition, so bound the
    // terminal end observations to each known attempt id through a separate
    // read-only node:sqlite handle on the exact scratch database.
    const executionDatabase = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const likeFirstAttempt = `%"attemptId":"${attemptIds[0]}"%`;
      const likeSecondAttempt = `%"attemptId":"${attemptIds[1]}"%`;
      const beginRows = executionDatabase.prepare(`
        SELECT outcome
        FROM analytics_execution_observations
        WHERE root_session_id = ? AND observation_kind = 'begin'
          AND operation_kind = 'subagent-attempt'
          AND (payload_json LIKE ? OR payload_json LIKE ?)
      `).all(FAILOVER_ROOT_SESSION_ID, likeFirstAttempt, likeSecondAttempt) as Array<{ outcome: string | null }>;
      assert.equal(beginRows.length, 2, 'each known attempt persists exactly one execution begin');
      assert.ok(beginRows.every((row) => row.outcome === null), 'begin observations carry no outcome; the outcome domain is terminal-only');
      const endRows = executionDatabase.prepare(`
        SELECT outcome, payload_json
        FROM analytics_execution_observations
        WHERE root_session_id = ? AND observation_kind = 'end'
          AND operation_kind = 'subagent-attempt'
          AND (payload_json LIKE ? OR payload_json LIKE ?)
      `).all(FAILOVER_ROOT_SESSION_ID, likeFirstAttempt, likeSecondAttempt) as Array<{ outcome: string | null; payload_json: string }>;
      assert.equal(endRows.length, 2, 'each known attempt persists exactly one execution end');
      const endOutcomeByAttemptId = new Map(endRows.map((row) => {
        // payload_json stores the full observation envelope; the recorder
        // projects columns from observation.fields.
        const payload = JSON.parse(row.payload_json) as { fields?: { attemptId?: string } };
        const payloadAttemptId = payload.fields?.attemptId;
        assert.ok(typeof payloadAttemptId === 'string', 'each end observation must carry its attempt identity in fields');
        return [payloadAttemptId, row.outcome];
      }));
      assert.deepEqual([...endOutcomeByAttemptId.keys()].sort(), [...attemptIds].sort());
      assert.equal(
        endOutcomeByAttemptId.get(attemptIds[0]),
        'failed',
        'the first attempt must persist its execution end outcome as failed, consistent with its failure settlement and error terminal payload kind',
      );
      assert.equal(
        endOutcomeByAttemptId.get(attemptIds[1]),
        'succeeded',
        'the second attempt must persist its execution end outcome as succeeded, consistent with its success settlement and completed terminal payload kind',
      );
    } finally {
      executionDatabase.close();
    }

    const streamed = streamedDetailPayloads(detailPackets.splice(0));
    assert.equal(streamed.length, 2);
    const streamByAttemptId = new Map(streamed.map((stream) => [(stream.metadata?.attemptId as string | undefined) ?? 'unknown', stream]));
    assert.deepEqual([...streamByAttemptId.keys()].sort(), [...attemptIds].sort());
    for (const [index, receipt] of [failedReceipt, succeededReceipt].entries()) {
      const stream = streamByAttemptId.get(attemptIds[index]);
      assert.ok(stream, `the detail payload for ${attemptIds[index]} must stream on the wire`);
      assert.equal(stream.payloadId, receipt.terminalDetailPayloadId);
      assert.equal(stream.byteLength, stream.bytes.byteLength);
      assert.equal(createHash('sha256').update(stream.bytes).digest('hex'), stream.sha256);
      assert.deepEqual(
        serialize(sanitizeAnalyticsDetail(deserialize(stream.bytes))),
        stream.bytes,
        'the redacted detail must remain a canonical fixed point',
      );
      assert.equal(stream.metadata?.childId, terminal.childId);
      assert.equal(stream.metadata?.attemptId, attemptIds[index]);
      assert.equal(
        stream.metadata?.parentToolCallId,
        canonicalAnalyticsToolEntityId(FAILOVER_ROOT_SESSION_ID, FAILOVER_TOOL_CALL_ID),
      );
      const persistedBytes = readCompleteDetailBytes(readModel, receipt.terminalDetailPayloadId);
      assert.equal(persistedBytes.byteLength, stream.byteLength);
      assert.equal(createHash('sha256').update(persistedBytes).digest('hex'), stream.sha256);
    }
    assert.equal(streamByAttemptId.get(attemptIds[0])?.metadata?.outcome, 'error', 'the failed attempt detail must retain its terminal outcome');
    assert.equal(streamByAttemptId.get(attemptIds[1])?.metadata?.outcome, 'completed');

    const decodedFailed = deserialize(readCompleteDetailBytes(readModel, failedReceipt.terminalDetailPayloadId)) as SingleResult;
    assert.equal(decodedFailed.attemptId, attemptIds[0]);
    assert.equal(decodedFailed.exitCode, 1);
    assert.equal(decodedFailed.stopReason, 'error');
    assert.equal(decodedFailed.failureClass, 'timeout');
    assert.equal(decodedFailed.retryable, true);
    assert.equal(decodedFailed.replaySafety, 'safe');
    assert.equal(decodedFailed.errorMessage, 'fixture provider timeout');
    assert.equal(decodedFailed.usage.cost, 0.01);
    assert.equal(decodedFailed.provider, attemptProviders[0]);
    assert.equal(decodedFailed.model, attemptModels[0]);
    assert.equal(decodedFailed.task, FAILOVER_PARENT_TASK);
    const decodedFailedNested = nestedResultOf(decodedFailed);
    assert.equal(decodedFailedNested.childId, 'p4-failover-failed-nested-child');
    assert.equal(decodedFailedNested.task, NESTED_TASK);
    assert.equal(decodedFailedNested.usage.cost, 0.4);
    const decodedFailedText = textOfMessage(decodedFailedNested);
    assert.equal(decodedFailedText, `p4-failover-failed-unique:[credential redacted]:${'w'.repeat(1024 * 1024 + 111)}`);
    assert.equal(decodedFailedText.includes(credentialSentinel), false);
    assert.ok(Buffer.byteLength(decodedFailedText, 'utf8') > 1024 * 1024);

    const decodedSucceeded = deserialize(readCompleteDetailBytes(readModel, succeededReceipt.terminalDetailPayloadId)) as SingleResult;
    assert.equal(decodedSucceeded.attemptId, attemptIds[1]);
    assert.equal(decodedSucceeded.exitCode, 0);
    assert.equal(decodedSucceeded.stopReason, 'completed');
    assert.equal(decodedSucceeded.usage.cost, 0.04, 'the mutated source cost must not reach the persisted copy');
    assert.equal(decodedSucceeded.task, FAILOVER_PARENT_TASK, 'the mutated source task must not reach the persisted copy');
    assert.equal(decodedSucceeded.provider, attemptProviders[1]);
    assert.equal(decodedSucceeded.model, attemptModels[1]);
    const decodedSucceededNested = nestedResultOf(decodedSucceeded);
    assert.equal(decodedSucceededNested.childId, 'p4-failover-success-nested-child');
    assert.equal(decodedSucceededNested.task, NESTED_TASK);
    const decodedSucceededText = textOfMessage(decodedSucceededNested);
    assert.equal(decodedSucceededText, `p4-failover-success-unique:[credential redacted]:${'w'.repeat(1024 * 1024 + 111)}`);
    assert.equal(decodedSucceededText.includes(credentialSentinel), false);
    assert.equal(decodedSucceededText.includes(':MUTATED-AFTER-HANDOFF'), false);
    assert.ok(Buffer.byteLength(decodedSucceededText, 'utf8') > 1024 * 1024);
    readModel.close();
    readModel = undefined;
    await supervisor.shutdown();
    assert.deepEqual(lifecycle.map((event) => event.state), ['spawned', 'ready', 'terminal']);
    assert.equal(lifecycle.filter((event) => event.state === 'terminal').length, 1);

    // Producer-thread terminal clone cost samples: two samples, one per
    // attempt. Raw measurements are logged for reporting; two samples support
    // no percentile or p99 gate claim.
    const cloneEvents = traceEvents.filter((event) => event.phase === 'clone' && event.payloadClass === 'detail_terminal');
    assert.equal(cloneEvents.length, 2, 'exactly one terminal clone per attempt');
    assert.deepEqual(cloneEvents.map((event) => event.identifiers?.attempt).sort(), [...attemptIds].sort());
    const cloneSamples = cloneEvents.map((event) => {
      assert.ok((event.sourcePayloadBytes ?? 0) > 1024 * 1024, 'each clone sample must cover the >1MiB retained payload');
      assert.equal(event.producedPayloadBytes, event.sourcePayloadBytes);
      assert.equal(typeof event.durationMs, 'number');
      return {
        attemptId: event.identifiers?.attempt,
        durationMs: Number((event.durationMs ?? 0).toFixed(3)),
        sourcePayloadBytes: event.sourcePayloadBytes,
      };
    });
    console.log('[p4-failover-terminal-clone-samples]', JSON.stringify(cloneSamples));
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (previousTraceSink === undefined) delete traceTarget[traceSinkKey];
    else traceTarget[traceSinkKey] = previousTraceSink;
    readModel?.close();
    releaseAcknowledgements();
    hostTransport?.dispose();
    try {
      await producerTransport?.dispose();
    } catch (error) {
      if (primaryFailure === undefined) primaryFailure = error;
    }
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
