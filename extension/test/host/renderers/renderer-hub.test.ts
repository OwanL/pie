/**
 * Renderer hub tests (browser server plan Milestone 1).
 *
 * Acceptance: two fake renderers receive independent snapshots; renderer A's
 * evidence cannot advance renderer B's ledger; blocking A never delays B;
 * disposing/replacing one renderer does not reset host state or the other
 * renderer; one logical render produces exactly one expensive projection.
 *
 * Timing discipline: the delivery controller's settlement/commit timers are
 * long (1000 ms) so `clock.advance(50)` fires only the hub's 50 ms schedule
 * debounce. The commit gate (one accepted-but-uncommitted revision per
 * renderer) is opened with explicit `transcriptCommitted` evidence before a
 * second schedule is expected to post.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { RendererHub } from '../../../src/host/renderers/renderer-hub';
import { FakeRendererTransport } from '../../helpers/fake-renderer-transport';
import type { StateDeliveryClock } from '../../../src/host/sidebar/state-delivery-controller';
import type { ViewState, WebviewToHostMessage } from '../../../src/shared/protocol';

class FakeClock implements StateDeliveryClock {
  private nowValue = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.nowValue; }
  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowValue + delayMs, callback });
    return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  advance(ms: number): void {
    this.nowValue += ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.nowValue);
      if (due.length === 0) return;
      for (const [id, timer] of due) {
        if (this.timers.delete(id)) timer.callback();
      }
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function state(): ViewState {
  return {
    activeSession: null,
    busy: false,
    prepassPhase: 'idle',
    retryStatus: null,
    transcript: [],
  } as unknown as ViewState;
}

type StateMessage = Extract<import('../../../src/shared/protocol').HostToWebviewMessage, { type: 'state' }>;

function createHub(clock: FakeClock, routed: WebviewToHostMessage[]) {
  let projections = 0;
  const hub = new RendererHub({
    clock,
    getViewState: () => {
      projections += 1;
      return state();
    },
    onMessage: (msg) => routed.push(msg),
    getRunningSessionCount: () => 0,
    settlementTimeoutMs: 1000,
    commitTimeoutMs: 1000,
    retryDelayMs: 5,
    maxRetryAttempts: 2,
    acceptedLedgerCapacity: 8,
  });
  return { hub, getProjections: () => projections };
}

async function ready(transport: FakeRendererTransport, registration: { getViewGeneration(): number }): Promise<void> {
  transport.send({ type: 'ready', viewGeneration: registration.getViewGeneration() });
  await settle();
}

function commit(transport: FakeRendererTransport, message: StateMessage): void {
  transport.send({
    type: 'transcriptCommitted',
    payload: {
      revision: message.revision,
      viewGeneration: message.viewGeneration,
      identity: message.expectedTranscriptIdentity,
      mountGeneration: 1,
      evidence: 'displayed',
    },
  });
}

/** Fire the hub debounce, let posts settle, and open every renderer's commit
 *  gate with evidence for its latest posted snapshot. */
async function scheduleAndSettle(hub: RendererHub, clock: FakeClock, transports: FakeRendererTransport[]): Promise<void> {
  hub.scheduleState();
  clock.advance(50);
  await settle();
  for (const transport of transports) {
    const latest = transport.stateMessages().at(-1);
    if (latest) commit(transport, latest);
  }
  await settle();
}

test('two fake renderers receive independent snapshots with per-renderer identity', async () => {
  const clock = new FakeClock();
  const routed: WebviewToHostMessage[] = [];
  const { hub } = createHub(clock, routed);
  const a = new FakeRendererTransport('browser');
  const b = new FakeRendererTransport('browser');
  const regA = hub.registerRenderer(a);
  const regB = hub.registerRenderer(b);
  await ready(a, regA);
  await ready(b, regB);

  await scheduleAndSettle(hub, clock, [a, b]);

  const statesA = a.stateMessages();
  const statesB = b.stateMessages();
  assert.equal(statesA.length, 1);
  assert.equal(statesB.length, 1);
  assert.equal(statesA[0].hostInstanceId, statesB[0].hostInstanceId, 'shared extension-host incarnation');
  assert.notEqual(regA.rendererId, regB.rendererId, 'per-renderer identity');
  assert.equal(statesA[0].revision, 1);
  assert.equal(statesB[0].revision, 1, 'revisions are scoped per renderer');
  hub.dispose();
});

test('renderer A evidence cannot advance renderer B ledger', async () => {
  const clock = new FakeClock();
  const routed: WebviewToHostMessage[] = [];
  const { hub } = createHub(clock, routed);
  const a = new FakeRendererTransport('browser');
  const b = new FakeRendererTransport('browser');
  const regA = hub.registerRenderer(a);
  const regB = hub.registerRenderer(b);
  await ready(a, regA);
  await ready(b, regB);
  hub.scheduleState();
  clock.advance(50);
  await settle();

  const stateA = a.stateMessages()[0]!;
  const stateB = b.stateMessages()[0]!;
  commit(a, stateA);
  await settle();

  assert.equal(regA.getDebugState().lastStateAppliedRevision, stateA.revision);
  assert.equal(regB.getDebugState().lastStateAppliedRevision, 0, 'A evidence never settles B');

  // A's evidence for B's revision is unknown to A's ledger and must not
  // advance anything.
  a.send({
    type: 'transcriptCommitted',
    payload: {
      revision: stateB.revision,
      viewGeneration: stateB.viewGeneration,
      identity: stateB.expectedTranscriptIdentity,
      mountGeneration: 1,
      evidence: 'displayed',
    },
  });
  await settle();
  assert.equal(regA.getDebugState().lastStateAppliedRevision, stateA.revision);
  hub.dispose();
});

test('blocking renderer A never delays renderer B', async () => {
  const clock = new FakeClock();
  const routed: WebviewToHostMessage[] = [];
  const { hub } = createHub(clock, routed);
  const a = new FakeRendererTransport('browser');
  const b = new FakeRendererTransport('browser');
  const regA = hub.registerRenderer(a);
  const regB = hub.registerRenderer(b);
  await ready(a, regA);
  await ready(b, regB);

  const blocked = deferred<boolean>();
  a.postOutcomes.push(blocked.promise);
  hub.scheduleState();
  clock.advance(50);
  await settle();

  assert.equal(a.stateMessages().length, 1, 'A posted once and is blocked on settlement');
  assert.equal(b.stateMessages().length, 1, 'B posts independently while A is blocked');
  commit(b, b.stateMessages()[0]!);
  await settle();

  // A second logical render: B advances again while A is still blocked.
  hub.scheduleState();
  clock.advance(50);
  await settle();
  assert.equal(a.stateMessages().length, 1, 'A stays blocked on its unsettled post');
  assert.equal(b.stateMessages().length, 2, 'B is never gated by A');

  blocked.resolve(true);
  await settle();
  commit(a, a.stateMessages()[0]!);
  await settle();
  assert.equal(a.stateMessages().length, 2, 'A catches up after its post settles and commits');
  hub.dispose();
});

test('disposing one renderer does not reset host state or the other renderer', async () => {
  const clock = new FakeClock();
  const routed: WebviewToHostMessage[] = [];
  const { hub } = createHub(clock, routed);
  const a = new FakeRendererTransport('browser');
  const b = new FakeRendererTransport('browser');
  const regA = hub.registerRenderer(a);
  const regB = hub.registerRenderer(b);
  await ready(a, regA);
  await ready(b, regB);
  await scheduleAndSettle(hub, clock, [a, b]);
  const stateB0 = b.stateMessages()[0]!;

  regA.dispose();
  await scheduleAndSettle(hub, clock, [b]);

  assert.equal(a.stateMessages().length, 1, 'disposed renderer receives nothing more');
  assert.equal(b.stateMessages().length, 2, 'survivor keeps receiving snapshots');
  assert.equal(
    regB.getDebugState().lastStateAppliedRevision,
    b.stateMessages().at(-1)!.revision,
    'survivor ledger advances only through its own evidence',
  );
  assert.equal(regB.getDebugState().globalRevision, b.stateMessages().at(-1)!.revision, 'survivor revisions keep advancing');
  hub.dispose();
});

test('replacing one renderer does not reset the other renderer', async () => {
  const clock = new FakeClock();
  const routed: WebviewToHostMessage[] = [];
  const { hub } = createHub(clock, routed);
  const a = new FakeRendererTransport('browser');
  const b = new FakeRendererTransport('browser');
  const regA = hub.registerRenderer(a);
  const regB = hub.registerRenderer(b);
  await ready(a, regA);
  await ready(b, regB);
  await scheduleAndSettle(hub, clock, [a, b]);
  const stateB0 = b.stateMessages()[0]!;

  // A is replaced: new transport, new registration, fresh identity.
  const a2 = new FakeRendererTransport('browser');
  const regA2 = hub.registerRenderer(a2);
  await ready(a2, regA2);
  await scheduleAndSettle(hub, clock, [a2, b]);

  assert.notEqual(regA2.rendererId, regA.rendererId, 'replacement gets fresh renderer identity');
  assert.equal(regA2.getDebugState().hostInstanceId, regA.getDebugState().hostInstanceId, 'host incarnation is shared across replacements');
  assert.equal(
    regB.getDebugState().lastStateAppliedRevision,
    b.stateMessages().at(-1)!.revision,
    'B ledger advances only through its own evidence',
  );
  assert.equal(b.stateMessages().length, 2, 'B keeps receiving snapshots');
  assert.equal(a2.stateMessages().length, 1, 'replacement receives its own snapshot');
  hub.dispose();
});

test('targeted imperatives reach only the target renderer; broadcast reaches all', async () => {
  const clock = new FakeClock();
  const routed: WebviewToHostMessage[] = [];
  const { hub } = createHub(clock, routed);
  const a = new FakeRendererTransport('browser');
  const b = new FakeRendererTransport('browser');
  const regA = hub.registerRenderer(a);
  const regB = hub.registerRenderer(b);
  await ready(a, regA);
  await ready(b, regB);

  hub.postImperative({ type: 'sendRejected', sessionPath: '/sessions/a', text: 'restore' }, regA.rendererId);
  await settle();
  assert.equal(a.posted.filter((m) => m.type === 'sendRejected').length, 1);
  assert.equal(b.posted.filter((m) => m.type === 'sendRejected').length, 0);

  hub.postImperative({ type: 'playCompletionSound', volume: 50 });
  await settle();
  assert.equal(a.posted.filter((m) => m.type === 'playCompletionSound').length, 1);
  assert.equal(b.posted.filter((m) => m.type === 'playCompletionSound').length, 1);

  hub.postImperative({ type: 'sendRejected', sessionPath: '/sessions/a', text: 'x' }, 'unknown-renderer');
  await settle();
  assert.equal(a.posted.filter((m) => m.type === 'sendRejected').length, 1, 'unknown target is a no-op');
  hub.dispose();
});

test('one logical render produces exactly one projection shared by all renderers', async () => {
  const clock = new FakeClock();
  const routed: WebviewToHostMessage[] = [];
  const { hub, getProjections } = createHub(clock, routed);
  const a = new FakeRendererTransport('browser');
  const b = new FakeRendererTransport('browser');
  const regA = hub.registerRenderer(a);
  const regB = hub.registerRenderer(b);
  await ready(a, regA);
  await ready(b, regB);
  const projectionsAfterHandshake = getProjections();

  await scheduleAndSettle(hub, clock, [a, b]);
  assert.equal(getProjections() - projectionsAfterHandshake, 1, 'N renderers share one projection per logical render');

  // A second logical render projects again exactly once.
  await scheduleAndSettle(hub, clock, [a, b]);
  assert.equal(getProjections() - projectionsAfterHandshake, 2);
  hub.dispose();
});

test('requestState targets only the requested renderer', async () => {
  const clock = new FakeClock();
  const routed: WebviewToHostMessage[] = [];
  const { hub } = createHub(clock, routed);
  const a = new FakeRendererTransport('browser');
  const b = new FakeRendererTransport('browser');
  const regA = hub.registerRenderer(a);
  const regB = hub.registerRenderer(b);
  await ready(a, regA);
  await ready(b, regB);

  hub.requestState(regA.rendererId);
  await settle();
  assert.equal(a.stateMessages().length, 1);
  assert.equal(b.stateMessages().length, 0, 'requestState is renderer-scoped');
  hub.dispose();
});

test('requestState does not cancel a pending broadcast owed to other renderers', async () => {
  const clock = new FakeClock();
  const routed: WebviewToHostMessage[] = [];
  const { hub } = createHub(clock, routed);
  const a = new FakeRendererTransport('browser');
  const b = new FakeRendererTransport('browser');
  const regA = hub.registerRenderer(a);
  const regB = hub.registerRenderer(b);
  await ready(a, regA);
  await ready(b, regB);

  // A logical render is pending (debounce armed) when a targeted request
  // arrives: the target posts now, and the other renderer still receives the
  // pending broadcast instead of being left stale.
  hub.scheduleState();
  hub.requestState(regA.rendererId);
  await settle();
  assert.equal(a.stateMessages().length, 1, 'target posts immediately');
  assert.equal(b.stateMessages().length, 1, 'pending broadcast is not lost');
  hub.dispose();
});

test("requestState('all') posts every session immediately", async () => {
  const clock = new FakeClock();
  const routed: WebviewToHostMessage[] = [];
  const { hub } = createHub(clock, routed);
  const a = new FakeRendererTransport('browser');
  const b = new FakeRendererTransport('browser');
  const regA = hub.registerRenderer(a);
  const regB = hub.registerRenderer(b);
  await ready(a, regA);
  await ready(b, regB);

  hub.requestState('all');
  await settle();
  assert.equal(a.stateMessages().length, 1);
  assert.equal(b.stateMessages().length, 1);
  hub.dispose();
});

test('registration dispose unregisters the session from the hub', async () => {
  const clock = new FakeClock();
  const routed: WebviewToHostMessage[] = [];
  const { hub } = createHub(clock, routed);
  const a = new FakeRendererTransport('browser');
  const b = new FakeRendererTransport('browser');
  const regA = hub.registerRenderer(a);
  const regB = hub.registerRenderer(b);
  await ready(a, regA);
  await ready(b, regB);

  regA.dispose();
  regA.dispose(); // idempotent
  hub.scheduleState();
  clock.advance(50);
  await settle();
  assert.equal(a.stateMessages().length, 0, 'unregistered renderer receives nothing');
  assert.equal(b.stateMessages().length, 1, 'survivor still receives the broadcast');
  hub.dispose();
});

test('selection fan-out marks every renderer priority-dirty', async () => {
  const clock = new FakeClock();
  const routed: WebviewToHostMessage[] = [];
  const { hub } = createHub(clock, routed);
  const a = new FakeRendererTransport('browser');
  const b = new FakeRendererTransport('browser');
  const regA = hub.registerRenderer(a);
  const regB = hub.registerRenderer(b);
  await ready(a, regA);
  await ready(b, regB);

  hub.scheduleSelectionState();
  await settle();
  assert.equal(a.stateMessages().length, 1);
  assert.equal(b.stateMessages().length, 1, 'selection is shared host state and fans out');
  hub.dispose();
});

test('hidden renderer retains dirty intent and resnapshots on reveal', async () => {
  const clock = new FakeClock();
  const routed: WebviewToHostMessage[] = [];
  const { hub } = createHub(clock, routed);
  const a = new FakeRendererTransport('browser');
  const regA = hub.registerRenderer(a);
  await ready(a, regA);
  await scheduleAndSettle(hub, clock, [a]);
  const baselineCount = a.stateMessages().length;

  a.setVisible(false);
  hub.scheduleState();
  await settle();
  assert.equal(a.stateMessages().length, baselineCount, 'hidden renderer does not post');

  a.setVisible(true);
  await settle();
  assert.equal(a.stateMessages().length, baselineCount + 1, 'reveal resnapshots from a full snapshot');
  hub.dispose();
});

test('recoverable imperatives queue while not ready and flush on readiness', async () => {
  const clock = new FakeClock();
  const routed: WebviewToHostMessage[] = [];
  const { hub } = createHub(clock, routed);
  const a = new FakeRendererTransport('browser');
  const regA = hub.registerRenderer(a);

  // Not ready yet: the imperative queues.
  hub.postImperative({ type: 'sendRejected', sessionPath: '/sessions/a', text: 'restore' });
  await settle();
  assert.equal(a.posted.filter((m) => m.type === 'sendRejected').length, 0);

  await ready(a, regA);
  assert.equal(a.posted.filter((m) => m.type === 'sendRejected').length, 1, 'queued imperative flushes on readiness');
  hub.dispose();
});
