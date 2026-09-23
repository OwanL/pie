/**
 * Detail subscription integration seam (host→renderer routing).
 *
 * Composes the production chain exactly as `host-runtime.ts` wires it:
 *
 *   RendererTransport (fake) → RendererHub/RendererSession → MessageRouter
 *   → reducer (`DetailSubscribe` command) → EffectRunner (`DetailSubscribeRpc`)
 *   → real `DetailSubscriptionService` → backend (`detail.subscribe`)
 *
 * and drives the coordinator→host stream (`DetailSubscriptionService
 * .handleStream`) back through the production imperative routing (host-runtime
 * routes every `detail.*` imperative carrying a `rendererId` to
 * `postImperativeToRenderer`, so a stream answers ITS OWN renderer).
 *
 * The realistic seam has two transcript shapes:
 * - a small COMPLETED subagent turn (durable authority: start → page →
 *   terminal), subscribed by a browser renderer;
 * - an ACTIVE streamed turn (live worker: start → page → delta), subscribed
 *   by the VS Code sidebar.
 *
 * The reported production failure is all-cases silence: the renderer times out
 * after 45s (`DETAIL_SUBSCRIPTION_LOAD_TIMEOUT_MS`) while no `detail.subscribe`
 * ever reaches the backend and no stream frame ever returns. This seam test
 * fails on any layer that drops the subscribe or the return route, and on any
 * cross-renderer stream leak.
 *
 * The coordinator→host leg crosses the real stdio boundary too: every emitted
 * frame travels as a `detail.stream` `EventEnvelope` through the production
 * `dispatchSessionBackendEvent` validator (`isCoordinatorToHostDetailMessage`),
 * so a validator that rejects coordinator-shaped frames also fails here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createInitialArchState } from '../../../src/host/core/arch-state';
import type { ArchState } from '../../../src/host/core/arch-state';
import { reducer } from '../../../src/host/core/reducer';
import type { Event } from '../../../src/host/core/events';
import { EffectRunner } from '../../../src/host/core/effect-runner';
import { dispatchSessionBackendEvent } from '../../../src/host/core/event-dispatch';
import { makeEffectRunnerDeps } from '../../helpers/effect-runner-deps';
import { MessageRouter } from '../../../src/host/core/message-router';
import type {
  HostToWebviewMessage,
  LazyDetailRef,
  WebviewToHostMessage,
} from '../../../src/shared/protocol';
import { RendererHub } from '../../../src/host/renderers/renderer-hub';
import type { RendererRegistration, RendererTransport } from '../../../src/host/renderers/types';
import {
  DetailSubscriptionService,
} from '../../../src/host/session-service/detail-subscriptions';
import type {
  BackendDetailFence,
  CoordinatorToHostDetailMessage,
  DetailJsonSegmentPayload,
  DetailPageRef,
  LiveSubagentDetailAddress,
} from '../../../src/shared/protocol/subagent-detail';
import { utf8ByteLength } from '../../../src/shared/utf8';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SESSION_PATH = 'C:\\w\\session.jsonl';
const BACKEND_GENERATION = 1;
const FENCE: BackendDetailFence = {
  backendGeneration: BACKEND_GENERATION,
  coordinatorGeneration: BACKEND_GENERATION,
  workerId: 'worker-1',
  workerGeneration: 1,
};

function makeAddress(seed: string): LiveSubagentDetailAddress {
  return {
    sessionPath: SESSION_PATH,
    turnId: `turn-${seed}`,
    rootToolCallId: `tool-${seed}`,
    rootAttemptId: `attempt-${seed}`,
    lineage: [{ childId: `child-${seed}`, spawningToolCallId: `tool-${seed}`, attemptId: `attempt-${seed}` }],
  };
}

interface FakeTransport {
  transport: RendererTransport;
  posted: HostToWebviewMessage[];
  inbound: (message: WebviewToHostMessage) => void;
}

function makeFakeTransport(kind: 'vscode' | 'browser'): FakeTransport {
  let handler: ((message: unknown) => void) | undefined;
  const posted: HostToWebviewMessage[] = [];
  const transport: RendererTransport = {
    kind,
    post: (message) => {
      posted.push(message);
      return true;
    },
    onMessage: (onMessage) => {
      handler = onMessage as (message: unknown) => void;
      return { dispose: () => { if (handler === onMessage) handler = undefined; } };
    },
    onVisibilityChanged: () => ({ dispose: () => undefined }),
    isAttached: () => true,
    isReloading: () => false,
    clearReloading: () => undefined,
    recover: () => undefined,
    dispose: () => undefined,
  };
  return {
    transport,
    posted,
    inbound: (message) => handler?.(message),
  };
}

// ─── Seam composition (mirrors host-runtime wiring) ─────────────────────────

interface Seam {
  sidebar: FakeTransport;
  browser: FakeTransport;
  sidebarSession: RendererRegistration;
  browserSession: RendererRegistration;
  sidebarRendererId: string;
  browserRendererId: string;
  backendRequests: Array<{ method: string; params: Record<string, unknown> }>;
  detail: DetailSubscriptionService;
  sendToHost: (session: FakeTransport, message: WebviewToHostMessage) => void;
  emitStream: (message: CoordinatorToHostDetailMessage) => void;
  markReady: (session: FakeTransport, viewGeneration: number) => void;
  dispose(): void;
}

function buildSeam(): Seam {
  const archState: { current: ReturnType<typeof createInitialArchState> } = { current: createInitialArchState() };
  const backendRequests: Seam['backendRequests'] = [];

  const sidebar = makeFakeTransport('vscode');
  const browser = makeFakeTransport('browser');

  const hub = new RendererHub({
    getViewState: () => ({ sessions: [], transcript: [] }) as never,
    onMessage: (msg, context) => {
      void router.handle(msg, context);
    },
    getRunningSessionCount: () => 0,
  });
  const sidebarSession = hub.registerRenderer(sidebar.transport);
  const browserSession = hub.registerRenderer(browser.transport);

  // Production routing wrapper (host-runtime.ts): detail imperatives carry the
  // owner rendererId and are delivered to THAT renderer only.
  const postImperative = (message: HostToWebviewMessage): void => {
    if (message.type.startsWith('detail.') && 'rendererId' in message) {
      hub.postImperative(message, (message as { rendererId: string }).rendererId);
      return;
    }
    hub.postImperative(message);
  };

  const detail = new DetailSubscriptionService({
    backend: {
      request<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
        backendRequests.push({ method, params: (params ?? {}) as Record<string, unknown> });
        return Promise.resolve(undefined as TResult);
      },
    },
    postImperative,
    getHostInstanceId: () => 'seam-host',
    getViewGeneration: () => sidebarSession.getViewGeneration(),
    getBackendGeneration: () => BACKEND_GENERATION,
    isRendererOwnerCurrent: (rendererId, viewGeneration, rendererGeneration) =>
      hub.isRendererOwnerCurrent(rendererId, viewGeneration, rendererGeneration),
  });

  const { deps } = makeEffectRunnerDeps({
    serviceOverrides: {
      subscribeDetail: (options) => detail.subscribe(
        options.subscriptionId,
        options.viewGeneration,
        options.detailKey,
        options.address,
        options.cursor,
        options.rendererId,
        options.rendererGeneration,
        options.detailAttempt,
      ),
      unsubscribeDetail: (options) => detail.unsubscribe(
        options.viewGeneration,
        options.detailKey,
        options.reason,
        options.rendererId,
        options.rendererGeneration,
        options.detailAttempt,
      ),
      fetchDetailPages: (options) => detail.fetchPages(
        options.viewGeneration,
        options.detailKey,
        options.ref,
        options.rendererId,
        options.rendererGeneration,
        options.detailAttempt,
      ),
    },
  });
  const effectRunner = new EffectRunner(deps);

  const dispatchArchEvent = (event: Event): void => {
    const result = reducer(archState.current, event);
    archState.current = result.state;
    for (const effect of result.effects) effectRunner.run(effect);
  };

  const router = new MessageRouter(
    (event) => dispatchArchEvent(event),
    () => archState.current,
    {
      bumpSessionDataEpoch: () => undefined,
      addFilesystemPaths: async () => undefined,
      createNewSession: () => '/s',
      openSession: () => undefined,
      duplicateSession: () => undefined,
      retryCreateOperation: () => false,
      loadOlderTranscript: async () => undefined,
      loadNewerTranscript: async () => undefined,
      jumpToLatestTranscript: async () => undefined,
      setPrefs: () => undefined,
      setPruningSettings: async () => undefined,
      setToolResultPruningSettings: async () => undefined,
    } as never,
    {
      reveal: () => undefined,
      postState: () => undefined,
      postImperative: () => undefined,
    },
    () => undefined,
    (text: string) => ({ name: text, isPlaceholder: false }),
    () => false,
  );

  return {
    sidebar,
    browser,
    sidebarSession,
    browserSession,
    sidebarRendererId: sidebarSession.rendererId,
    browserRendererId: browserSession.rendererId,
    backendRequests,
    detail,
    sendToHost: (session, message) => session.inbound(message),
    emitStream: (message) => dispatchSessionBackendEvent(
      { event: 'detail.stream', payload: message },
      { onDetailStream: (m: CoordinatorToHostDetailMessage) => detail.handleStream(m) } as never,
    ),
    markReady: (session, viewGeneration) => session.inbound({ type: 'ready', viewGeneration } as unknown as WebviewToHostMessage),
    dispose: () => hub.dispose(),
  };
}

// ─── Stream builders (exact coordinator shapes) ──────────────────────────────

const PAGE_TEXT = '{}';

function makePage(seed: string, ref: DetailPageRef): { payload: DetailJsonSegmentPayload; payloadBytes: number; checksum: string } {
  const payload: DetailJsonSegmentPayload = {
    kind: 'json-segment',
    encoding: 'utf8-json',
    segmentId: `segment-${seed}`,
    semanticPath: [],
    startByte: 0,
    endByte: utf8ByteLength(PAGE_TEXT),
    totalBytes: utf8ByteLength(PAGE_TEXT),
    startCodePoint: 0,
    endCodePoint: [...PAGE_TEXT].length,
    totalCodePoints: [...PAGE_TEXT].length,
    text: PAGE_TEXT,
  };
  const serialized = JSON.stringify(payload);
  return {
    payload,
    payloadBytes: utf8ByteLength(serialized),
    checksum: createHash('sha256').update(serialized).digest('hex'),
  };
}

function detailStart(
  subscriptionId: string,
  address: LiveSubagentDetailAddress,
  source: 'live' | 'durable',
): CoordinatorToHostDetailMessage {
  return {
    kind: 'detail.start',
    subscriptionId,
    address,
    source,
    baselineRevision: 0,
    pageCount: 1,
    totalBytes: utf8ByteLength(PAGE_TEXT),
    totalCodePoints: [...PAGE_TEXT].length,
    fence: FENCE,
  };
}

function detailPage(subscriptionId: string, seed: string): CoordinatorToHostDetailMessage {
  const ref: DetailPageRef = { baselineRevision: 0, pageIndex: 0, pageCount: 1 };
  const page = makePage(seed, ref);
  return {
    kind: 'detail.page',
    subscriptionId,
    ref,
    payload: page.payload,
    payloadBytes: page.payloadBytes,
    checksum: page.checksum,
    fence: FENCE,
  };
}

function makeDurableRef(seed: string): LazyDetailRef {
  return {
    key: `detail:${seed}`,
    kind: 'tool-result',
    source: 'durable',
    sessionPath: SESSION_PATH,
    messageId: `message-${seed}`,
    toolCallId: `tool-${seed}`,
    sizeBytes: utf8ByteLength(PAGE_TEXT),
    summary: 'completed child transcript',
    available: true,
  };
}

function ofKind(posted: HostToWebviewMessage[], type: string): HostToWebviewMessage[] {
  return posted.filter((message) => message.type === type);
}

/** Let the subscribe's async backend forward (and its catch paths) settle. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('active streamed transcript: sidebar detail.subscribe crosses the effect/service seam to the backend and the live stream returns to the initiating renderer only', async () => {
  const seam = buildSeam();
  try {
    seam.markReady(seam.sidebar, 1);

    const address = makeAddress('live');
    seam.sendToHost(seam.sidebar, {
      type: 'detail.subscribe',
      viewGeneration: 1,
      detailKey: 'subagent:msg-live:tool-live',
      detailAttempt: 1,
      address,
    } as WebviewToHostMessage);
    // The service forwards the backend request asynchronously (the subscribe
    // owner is registered synchronously, the RPC crosses on a microtask).
    await settle();

    // The subscribe must cross renderer → router → reducer → effect → service
    // → backend without being dropped.
    const subscribe = seam.backendRequests.find((entry) => entry.method === 'detail.subscribe');
    assert.ok(subscribe, 'detail.subscribe never reached the backend (all-cases silence)');
    const subscriptionId = subscribe.params.subscriptionId as string;
    assert.equal(typeof subscriptionId, 'string');
    assert.equal((subscribe.params.address as LiveSubagentDetailAddress).rootToolCallId, 'tool-live');

    // Coordinator stream: live worker source.
    seam.emitStream(detailStart(subscriptionId, address, 'live'));
    seam.emitStream(detailPage(subscriptionId, 'live'));
    seam.emitStream({
      kind: 'detail.delta',
      subscriptionId,
      baseRevision: 0,
      revision: 1,
      operations: [{ op: 'set', path: ['agent'], value: 'child-a-live' }],
      fence: FENCE,
    });

    const start = ofKind(seam.sidebar.posted, 'detail.start')[0] as
      | Extract<HostToWebviewMessage, { type: 'detail.start' }>
      | undefined;
    assert.ok(start, 'detail.start never reached the initiating sidebar renderer');
    assert.equal(start.rendererId, seam.sidebarRendererId);
    assert.equal(start.rendererGeneration, 1);
    assert.equal(start.detailKey, 'subagent:msg-live:tool-live');
    assert.equal(start.subscriptionId, subscriptionId);
    assert.equal(start.source, 'live');
    assert.ok(ofKind(seam.sidebar.posted, 'detail.page').length > 0, 'detail.page never reached the sidebar renderer');
    const delta = ofKind(seam.sidebar.posted, 'detail.delta')[0] as
      | Extract<HostToWebviewMessage, { type: 'detail.delta' }>
      | undefined;
    assert.ok(delta, 'detail.delta never reached the sidebar renderer');

    // The browser renderer must not observe the sidebar's stream.
    assert.equal(seam.browser.posted.length, 0);
  } finally {
    seam.dispose();
  }
});

test('small completed transcript: browser renderer detail.subscribe is answered by the durable authority and routed back to the browser renderer only', async () => {
  const seam = buildSeam();
  try {
    seam.markReady(seam.browser, 1);

    const address = makeAddress('done');
    seam.sendToHost(seam.browser, {
      type: 'detail.subscribe',
      viewGeneration: 1,
      detailKey: 'subagent:msg-done:tool-done',
      detailAttempt: 1,
      address,
    } as WebviewToHostMessage);
    await settle();

    const subscribe = seam.backendRequests.find((entry) => entry.method === 'detail.subscribe');
    assert.ok(subscribe, 'browser detail.subscribe never reached the backend');
    const subscriptionId = subscribe.params.subscriptionId as string;

    // The durable authority answers with source 'durable' and a terminal handoff.
    seam.emitStream(detailStart(subscriptionId, address, 'durable'));
    seam.emitStream(detailPage(subscriptionId, 'done'));
    seam.emitStream({
      kind: 'detail.terminal',
      subscriptionId,
      revision: 1,
      durableRef: makeDurableRef('done'),
      fence: FENCE,
    });

    const start = ofKind(seam.browser.posted, 'detail.start')[0] as
      | Extract<HostToWebviewMessage, { type: 'detail.start' }>
      | undefined;
    assert.ok(start, 'durable detail.start never reached the browser renderer');
    assert.equal(start.rendererId, seam.browserRendererId);
    assert.equal(start.source, 'durable');
    const terminal = ofKind(seam.browser.posted, 'detail.terminal')[0] as
      | Extract<HostToWebviewMessage, { type: 'detail.terminal' }>
      | undefined;
    assert.ok(terminal, 'detail.terminal never reached the browser renderer');

    // The sidebar renderer must not observe the browser renderer's stream.
    assert.equal(seam.sidebar.posted.length, 0);
  } finally {
    seam.dispose();
  }
});

test('backend restart (host service reset) does not poison the next subscribe: a re-expansion re-reaches the backend', async () => {
  const seam = buildSeam();
  try {
    seam.markReady(seam.sidebar, 1);

    const address = makeAddress('restart');
    seam.sendToHost(seam.sidebar, {
      type: 'detail.subscribe',
      viewGeneration: 1,
      detailKey: 'subagent:msg-restart:tool-restart',
      detailAttempt: 1,
      address,
    } as WebviewToHostMessage);
    await settle();
    const first = seam.backendRequests.find((entry) => entry.method === 'detail.subscribe');
    assert.ok(first, 'first detail.subscribe never reached the backend');

    // Backend restart: the session service resets the registry (host-runtime
    // wires this through `SessionServiceState.resetRuntimeState` / dispose).
    seam.detail.reset();
    seam.backendRequests.length = 0;

    // The renderer re-expands after the restart with a fresh attempt (its
    // own attempt ledger also reset by the hostChanged store clear).
    seam.sendToHost(seam.sidebar, {
      type: 'detail.subscribe',
      viewGeneration: 1,
      detailKey: 'subagent:msg-restart:tool-restart',
      detailAttempt: 1,
      address,
    } as WebviewToHostMessage);
    await settle();

    const second = seam.backendRequests.find((entry) => entry.method === 'detail.subscribe');
    assert.ok(second, 'post-restart detail.subscribe never reached the backend (all-cases silence)');
    assert.notEqual(second.params.subscriptionId, first.params.subscriptionId);
  } finally {
    seam.dispose();
  }
});

test('coordinator envelope whose fence generation is stale is dropped silently: the exact all-cases-silence signature', async () => {
  const seam = buildSeam();
  try {
    seam.markReady(seam.sidebar, 1);
    const address = makeAddress('fence');
    seam.sendToHost(seam.sidebar, {
      type: 'detail.subscribe',
      viewGeneration: 1,
      detailKey: 'subagent:msg-fence:tool-fence',
      detailAttempt: 1,
      address,
    } as WebviewToHostMessage);
    await settle();
    const subscribe = seam.backendRequests.find((entry) => entry.method === 'detail.subscribe');
    assert.ok(subscribe, 'detail.subscribe never reached the backend');
    const subscriptionId = subscribe.params.subscriptionId as string;

    // The backend was restarted while the host's adopted generation moved on:
    // every stream frame carries a stale fence and is dropped without error.
    seam.emitStream({ ...detailStart(subscriptionId, address, 'live'), fence: { ...FENCE, backendGeneration: 999, coordinatorGeneration: 999 } });
    seam.emitStream({ ...detailPage(subscriptionId, 'fence'), fence: { ...FENCE, backendGeneration: 999, coordinatorGeneration: 999 } });
    assert.equal(ofKind(seam.sidebar.posted, 'detail.start').length, 0, 'stale-fence start must be dropped');
    assert.equal(ofKind(seam.sidebar.posted, 'detail.page').length, 0, 'stale-fence page must be dropped');

    // A stale-fence frame kills the owner silently (no tombstone, no error,
    // no backend unsubscribe): recovery requires the renderer to re-subscribe
    // with a fresh attempt.
    seam.sendToHost(seam.sidebar, {
      type: 'detail.subscribe',
      viewGeneration: 1,
      detailKey: 'subagent:msg-fence:tool-fence',
      detailAttempt: 2,
      address,
    } as WebviewToHostMessage);
    await settle();
    const resubscribe = seam.backendRequests.filter((entry) => entry.method === 'detail.subscribe');
    assert.equal(resubscribe.length, 2, 'the re-subscribe must reach the backend');
    const freshId = resubscribe[1].params.subscriptionId as string;
    assert.notEqual(freshId, subscriptionId);
    seam.emitStream(detailStart(freshId, address, 'live'));
    seam.emitStream(detailPage(freshId, 'fence'));
    assert.ok(ofKind(seam.sidebar.posted, 'detail.start').length > 0, 'the fresh subscription recovers');
    assert.ok(ofKind(seam.sidebar.posted, 'detail.page').length > 0);
  } finally {
    seam.dispose();
  }
});

test('a renderer posting detail.subscribe under a stale viewGeneration is silently dropped by the renderer-session gate', async () => {
  const seam = buildSeam();
  try {
    seam.markReady(seam.sidebar, 1);
    const address = makeAddress('stale');
    seam.sendToHost(seam.sidebar, {
      type: 'detail.subscribe',
      viewGeneration: 1,
      detailKey: 'subagent:msg-stale:tool-stale',
      detailAttempt: 1,
      address,
    } as WebviewToHostMessage);
    await settle();
    assert.ok(
      seam.backendRequests.some((entry) => entry.method === 'detail.subscribe'),
      'the current-generation subscribe must reach the backend',
    );
    seam.backendRequests.length = 0;

    // View replacement bumps the host-owned generation (hot reload/recovery).
    // A renderer document that kept its old generation stamp (its detail store
    // context was captured from a stale envelope) then has every command
    // dropped silently — no backend request, no error, and the webview record
    // times out. This is the exact production all-cases-silence signature.
    seam.sidebarSession.handleViewResolved(false);
    seam.sendToHost(seam.sidebar, {
      type: 'detail.subscribe',
      viewGeneration: 1,
      detailKey: 'subagent:msg-stale2:tool-stale2',
      detailAttempt: 1,
      address,
    } as WebviewToHostMessage);
    await settle();

    assert.equal(
      seam.backendRequests.find((entry) => entry.method === 'detail.subscribe'),
      undefined,
      'a stale-generation subscribe must not reach the backend (and must produce no stream)',
    );
    assert.equal(seam.sidebar.posted.length, 0);
    assert.equal(seam.browser.posted.length, 0);

    // The current-generation stamp works — the drop is scoped, not poisoned.
    seam.markReady(seam.sidebar, 2);
    seam.sendToHost(seam.sidebar, {
      type: 'detail.subscribe',
      viewGeneration: 2,
      detailKey: 'subagent:msg-stale2:tool-stale2',
      detailAttempt: 1,
      address,
    } as WebviewToHostMessage);
    await settle();
    assert.ok(
      seam.backendRequests.some((entry) => entry.method === 'detail.subscribe'),
      'the current-generation subscribe must reach the backend',
    );
  } finally {
    seam.dispose();
  }
});