import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkerLiveDetailStore } from '../../../src/backend/worker-live-detail-store';
import type { WorkerToCoordinatorFrameBody } from '../../../src/backend/worker-protocol';
import { DetailSubscriptionService } from '../../../src/host/session-service/detail-subscriptions';
import { dispatchSessionBackendEvent } from '../../../src/host/core/event-dispatch';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../../../src/shared/protocol';
import {
  validateHostToWebviewDetailMessage,
  validateWebviewToHostMessage,
} from '../../../src/shared/protocol-validation';
import type {
  BackendDetailFence,
  CoordinatorToHostDetailMessage,
  LiveSubagentDetailAddress,
} from '../../../src/shared/protocol/subagent-detail';
import {
  clearDetailSubscriptionStore,
  demandDetailValue,
  getDetailStoreDebugState,
  openDetailSubscription,
  receiveDetailImperative,
  setDetailStoreContext,
  type DetailStreamMessage,
} from '../../../src/webview/panel/transcript/detail-subscription-store';

const DETAIL_KEY = 'subagent:message-1:tool-1';
const RENDERER_ID = 'renderer-seam';
const SESSION_PATH = 'C:\\workspace\\session.jsonl';
const ADDRESS: LiveSubagentDetailAddress = {
  sessionPath: SESSION_PATH,
  turnId: 'turn-1',
  rootToolCallId: 'tool-1',
  rootAttemptId: 'root-attempt-1',
  lineage: [{ childId: 'child-1', spawningToolCallId: 'tool-1', attemptId: 'child-attempt-1' }],
};
const ROOT = {
  sessionPath: ADDRESS.sessionPath,
  turnId: ADDRESS.turnId,
  rootToolCallId: ADDRESS.rootToolCallId,
  rootAttemptId: ADDRESS.rootAttemptId,
};
const FENCE: BackendDetailFence = {
  backendGeneration: 1,
  coordinatorGeneration: 1,
  workerId: 'worker-seam',
  workerGeneration: 1,
};

function childDetail(task: string, progressGeneration: number): Record<string, unknown> {
  return {
    agent: 'worker',
    task,
    exitCode: -1,
    attemptId: ADDRESS.lineage[0]!.attemptId,
    progressGeneration,
    liveAddressable: true,
    lineage: ADDRESS.lineage.map((identity) => ({ ...identity })),
    messages: [{ role: 'assistant', content: [{ type: 'text', text: task }] }],
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface Seam {
  worker: WorkerLiveDetailStore;
  detail: DetailSubscriptionService;
  workerFrames: WorkerToCoordinatorFrameBody[];
  acceptedWorkerFrames: CoordinatorToHostDetailMessage[];
  hostMessages: HostToWebviewMessage[];
  pendingSettlements: Array<() => void>;
  wireValidationFailures: string[];
  backendRequests: string[];
  observe: (details: unknown) => void;
  open: () => void;
  settleNext: () => Promise<void>;
  settleUntilReady: (detailKey?: string) => Promise<number>;
  dispose: () => void;
}

function buildSeam(maxPageBytes = 16 * 1024): Seam {
  const workerFrames: WorkerToCoordinatorFrameBody[] = [];
  const acceptedWorkerFrames: CoordinatorToHostDetailMessage[] = [];
  const hostMessages: HostToWebviewMessage[] = [];
  const pendingSettlements: Array<() => void> = [];
  const wireValidationFailures: string[] = [];
  const backendRequests: string[] = [];
  const drainListeners = new Set<() => void>();
  let workerRequest = 0;
  let hostSubscription = 0;
  const detailRef: { current?: DetailSubscriptionService } = {};

  const worker = new WorkerLiveDetailStore({
    emit: (frame, onSettled) => {
      workerFrames.push(frame);
      if (frame.kind !== 'detail.unsubscribed') {
        const payload = { ...frame, fence: FENCE } as Record<string, unknown>;
        delete payload.requestId;
        const wireMessage = payload as unknown as CoordinatorToHostDetailMessage;
        dispatchSessionBackendEvent(
          { event: 'detail.stream', payload: wireMessage } as never,
          { onDetailStream: (message: CoordinatorToHostDetailMessage) => {
            acceptedWorkerFrames.push(message);
            const service = detailRef.current;
            if (!service) throw new Error('Detail service was not initialized before worker output.');
            service.handleStream(message);
          } } as never,
        );
      }
      if (onSettled) pendingSettlements.push(() => onSettled({ status: 'sent' }));
      return true;
    },
    onDrain: (listener) => {
      drainListeners.add(listener);
      return () => drainListeners.delete(listener);
    },
  });

  const detail = new DetailSubscriptionService({
    backend: {
      async request<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
        backendRequests.push(method);
        const request = (params ?? {}) as Record<string, unknown>;
        const requestId = `worker-request-${++workerRequest}`;
        if (method === 'detail.subscribe') {
          worker.subscribe(
            requestId,
            String(request.subscriptionId),
            request.address as LiveSubagentDetailAddress,
            request.cursor as { revision: number; pageIndex?: number } | undefined,
            Number(request.maxPageBytes),
          );
        } else if (method === 'detail.unsubscribe') {
          worker.unsubscribe(requestId, String(request.subscriptionId));
        } else if (method === 'detail.fetch') {
          worker.fetch(
            requestId,
            String(request.subscriptionId),
            request.address as LiveSubagentDetailAddress,
            request.ref as { baselineRevision: number; pageIndex: number; pageCount: number },
            Number(request.maxPageBytes),
          );
        } else {
          throw new Error(`Unexpected detail seam backend method: ${method}`);
        }
        return undefined as TResult;
      },
    },
    postImperative: (message) => {
      hostMessages.push(message);
      if (!validateHostToWebviewDetailMessage(message)) {
        wireValidationFailures.push(`host→webview rejected ${message.type}`);
        return;
      }
      receiveDetailImperative(message as DetailStreamMessage);
    },
    getHostInstanceId: () => 'host-seam',
    getViewGeneration: () => 1,
    getBackendGeneration: () => FENCE.backendGeneration,
    isRendererOwnerCurrent: (rendererId, viewGeneration, rendererGeneration) =>
      rendererId === RENDERER_ID && viewGeneration === 1 && rendererGeneration === 1,
    maxPageBytes,
  });
  detailRef.current = detail;

  setDetailStoreContext({
    hostInstanceId: 'host-seam',
    viewGeneration: 1,
    rendererId: RENDERER_ID,
    rendererGeneration: 1,
    postMessage: (rawMessage: WebviewToHostMessage) => {
      const validated = validateWebviewToHostMessage(rawMessage);
      if (!validated.ok) {
        wireValidationFailures.push(`webview→host rejected ${rawMessage.type}: ${validated.reason}`);
        return;
      }
      const message = validated.value;
      if (message.type === 'detail.subscribe') {
        detail.subscribe(
          `host-subscription-${++hostSubscription}`,
          message.viewGeneration,
          message.detailKey,
          message.address,
          message.cursor,
          RENDERER_ID,
          1,
          message.detailAttempt,
        );
      } else if (message.type === 'detail.unsubscribe') {
        detail.unsubscribe(message.viewGeneration, message.detailKey, message.reason, RENDERER_ID, 1, message.detailAttempt);
      } else if (message.type === 'detail.fetchPages') {
        detail.fetchPages(message.viewGeneration, message.detailKey, message.ref, RENDERER_ID, 1, message.detailAttempt);
      }
    },
  });

  return {
    worker,
    detail,
    workerFrames,
    acceptedWorkerFrames,
    hostMessages,
    pendingSettlements,
    wireValidationFailures,
    backendRequests,
    observe: (details) => worker.observe({ ...ROOT, details }),
    open: () => openDetailSubscription({ detailKey: DETAIL_KEY, address: ADDRESS }),
    async settleNext() {
      const settle = pendingSettlements.shift();
      assert.ok(settle, 'expected a pending worker detail-frame settlement');
      settle();
      await tick();
    },
    async settleUntilReady(detailKey = DETAIL_KEY) {
      const started = performance.now();
      for (let iteration = 0; iteration < 2_000; iteration += 1) {
        const result = demandDetailValue(detailKey);
        if (result.status === 'ready') {
          // A page reaches the receiver before its transport settlement. The
          // worker only flushes a deferred live delta or terminal handoff after
          // the last page settles, so readiness alone is not end-of-baseline.
          while (pendingSettlements.length > 0) {
            pendingSettlements.shift()!();
            await tick();
          }
          const settled = demandDetailValue(detailKey);
          assert.equal(settled.status, 'ready');
          return performance.now() - started;
        }
        const settle = pendingSettlements.shift();
        if (settle) {
          settle();
          await tick();
        } else {
          await tick();
        }
      }
      assert.fail(`detail value did not become ready; worker frames=${workerFrames.length}, accepted=${acceptedWorkerFrames.length}`);
    },
    dispose() {
      clearDetailSubscriptionStore();
      detail.reset();
      worker.dispose();
      for (const listener of drainListeners) listener();
    },
  };
}

function assertWireWasValidated(seam: Seam): void {
  assert.deepEqual(seam.wireValidationFailures, []);
  const streamFrames = seam.workerFrames.filter((frame) => frame.kind !== 'detail.unsubscribed');
  assert.equal(seam.acceptedWorkerFrames.length, streamFrames.length,
    'every actual worker stream frame passed detail.stream validation');
  assert.ok(seam.hostMessages.length > 0, 'the detail service routed stream messages to the webview boundary');
}

test('a small live baseline is serialized by WorkerLiveDetailStore, validated, routed, and assembled by the webview store', async () => {
  const seam = buildSeam();
  try {
    seam.observe([childDetail('small baseline', 1)]);
    const started = performance.now();
    seam.open();
    await tick();
    const readyMs = await seam.settleUntilReady();
    const ready = demandDetailValue(DETAIL_KEY);
    assert.equal(ready.status, 'ready');
    if (ready.status === 'ready') {
      assert.equal((ready.value as Record<string, unknown>).task, 'small baseline');
      assert.equal((ready.value as Record<string, unknown>).exitCode, -1);
    }
    const start = seam.acceptedWorkerFrames.find((frame) => frame.kind === 'detail.start');
    assert.equal(start?.kind, 'detail.start');
    if (start?.kind === 'detail.start') {
      assert.equal(start.source, 'live');
      assert.equal(start.pageCount, 1, 'the small baseline is one actual worker-produced page');
    }
    assert.deepEqual(seam.backendRequests, ['detail.subscribe']);
    assert.ok(performance.now() - started >= readyMs);
    assertWireWasValidated(seam);
  } finally {
    seam.dispose();
  }
});

test('active updates during a multi-page worker baseline assemble the original pages then apply the ordered live delta', async () => {
  const seam = buildSeam(1_024);
  try {
    const initialTask = `baseline-${'x'.repeat(12_000)}`;
    seam.observe([childDetail(initialTask, 1)]);
    seam.open();
    await tick();
    const start = seam.acceptedWorkerFrames.find((frame) => frame.kind === 'detail.start');
    assert.equal(start?.kind, 'detail.start');
    assert.ok(start && start.pageCount > 1, 'small bounded wire pages exercise real webview assembly');
    assert.equal(demandDetailValue(DETAIL_KEY).status, 'pending');

    // Hold each writer settlement while the worker observes a continuously
    // changing producer. The baseline pages themselves still come from the
    // worker's immutable serialized snapshot; the final live state must arrive
    // as a delta against those exact pages, not as repeated manual fixtures.
    seam.observe([childDetail(`update-one-${'y'.repeat(12_000)}`, 2)]);
    await seam.settleNext(); // settle detail.start; page 0 is now in flight
    seam.observe([childDetail(`latest-${'z'.repeat(12_000)}`, 3)]);

    const readyMs = await seam.settleUntilReady();
    const ready = demandDetailValue(DETAIL_KEY);
    assert.equal(ready.status, 'ready');
    if (ready.status === 'ready') {
      const value = ready.value as Record<string, unknown>;
      assert.equal(value.task, `latest-${'z'.repeat(12_000)}`);
      assert.equal(value.progressGeneration, 3);
    }
    const pages = seam.acceptedWorkerFrames.filter((frame) => frame.kind === 'detail.page');
    const deltas = seam.acceptedWorkerFrames.filter((frame) => frame.kind === 'detail.delta');
    assert.equal(pages.length, start!.pageCount, 'all original baseline pages passed actual wire validation');
    assert.equal(deltas.length, 1, 'updates coalesce into one delivered structural delta');
    assert.equal(seam.acceptedWorkerFrames.some((frame) => frame.kind === 'detail.rebase'), false,
      'continued streaming does not starve the webview with an unbounded rebase cycle');
    if (deltas[0]?.kind === 'detail.delta') {
      assert.equal(deltas[0].baseRevision, start!.baselineRevision);
      assert.equal(deltas[0].revision, 3);
    }
    assert.ok(readyMs < 45_000, `the assembled baseline and update should beat the webview load deadline (${readyMs.toFixed(1)}ms)`);
    assertWireWasValidated(seam);
  } finally {
    seam.dispose();
  }
});

test('a completed worker detail hands its assembled value to the durable terminal reference through the same seam', async () => {
  const seam = buildSeam();
  try {
    seam.observe([childDetail('completed child', 1)]);
    seam.open();
    await tick();
    await seam.settleUntilReady();
    const ready = demandDetailValue(DETAIL_KEY);
    assert.equal(ready.status, 'ready');

    seam.worker.terminal(ROOT, 'completed-message-1');
    const terminal = seam.hostMessages.find((message) => message.type === 'detail.terminal');
    assert.equal(terminal?.type, 'detail.terminal');
    if (terminal?.type === 'detail.terminal') {
      assert.equal(terminal.durableRef.source, 'durable');
      assert.equal(terminal.durableRef.messageId, 'completed-message-1');
      assert.equal(terminal.durableRef.toolCallId, ADDRESS.rootToolCallId);
    }
    assert.equal(seam.worker.debugState().subscriptions, 0, 'completion releases the worker live owner');
    assert.equal(seam.detail.getDebugState().terminalRecords, 1, 'the host keeps only its bounded durable handoff');
    assert.equal(getDetailStoreDebugState().valueBytes > 0, true, 'the completed webview value remains assembled');
    assertWireWasValidated(seam);
  } finally {
    seam.dispose();
  }
});
