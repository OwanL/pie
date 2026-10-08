import assert from 'node:assert/strict';
import test from 'node:test';

import { BackendClient } from '../../../agent-connection/client';
import { RequestTracker } from '../../../agent-connection/request-tracker';
import { SessionServiceState } from '../../../session-actions/state';
import { EffectRunner, type CommitAwareRequestOptions, type TimerSink } from '../../../conversation-state/effects/effect-runner';
import type { Effect } from '../../../conversation-state/effects/effects';
import type { Event } from '../../../conversation-state/events';
import { initialArchState, reducer, type ArchState } from '../../../conversation-state/reducer';
import { makeEffectRunnerDeps } from '../../helpers/effect-runner-deps';

const SESSION = '/repo/promoting.jsonl';
const PROMPT = 'keep this prompt';

class Timers implements TimerSink {
  private readonly pending = new Map<object, () => void>();
  schedule(fn: () => void): object { const handle = {}; this.pending.set(handle, fn); return handle; }
  cancel(handle: unknown): void { this.pending.delete(handle as object); }
  fire(): void {
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    for (const fn of callbacks) fn();
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function harness(statusError: Error) {
  let state: ArchState = {
    ...initialArchState,
    settings: { ...initialArchState.settings, backendReady: true },
    sessions: { ...initialArchState.sessions, activeSessionPath: SESSION },
  };
  const effects: Effect[] = [];
  const events: Event[] = [];
  const methods: string[] = [];
  const timers = new Timers();
  const tracker = new RequestTracker<unknown>();
  let lateAck: (() => void) | undefined;
  let delayed!: () => void;
  const deadline = new Promise<void>((resolve) => { delayed = resolve; });
  const queues = new SessionServiceState(new BackendClient(), () => undefined, () => state, dispatch);
  const { deps } = makeEffectRunnerDeps({
    queues,
    timer: timers,
    backend: {
      async request<T>(method: string, _params?: unknown, options?: CommitAwareRequestOptions<T>): Promise<T> {
        methods.push(method);
        if (method === 'operation.status') throw statusError;
        assert.equal(method, 'message.send', 'only the original mutation may execute');
        // Real transport deadline, not a fabricated SendResult failure. Retain
        // physical correlation after the application waiter has timed out.
        const pending = tracker.create('send-request', 1, options?.signal, () => undefined);
        lateAck = () => {
          const result = { requestId: 'backend-request' } as T;
          if (tracker.resolve('send-request', result)) options?.onCorrelatedResponse?.({ ok: true, result });
        };
        return await pending as T;
      },
    },
    dispatch,
    dispatchEvent: dispatch,
    dispatchCommand: dispatch,
  });
  const runner = new EffectRunner(deps);
  function dispatch(event: Event): void {
    events.push(event);
    const next = reducer(state, event);
    state = next.state;
    effects.push(...next.effects);
    for (const effect of next.effects) runner.run(effect);
    if (event.kind === 'SendOperationDelayed') delayed();
  }
  function send(id = 'one'): void {
    dispatch({
      kind: 'Command', cmd: {
        kind: 'Send', corrId: `corr-${id}`, operationId: `op-${id}`, operationAttempt: 1,
        operationSource: { kind: 'renderer', rendererId: 'sidebar', rendererKind: 'browser', rendererGeneration: 1 },
        backendGeneration: 7, sessionPath: SESSION, text: PROMPT, inputs: [],
        composedText: PROMPT, localId: `local-${id}`, previousSummary: null, timestamp: 100,
      },
    });
  }
  function preserved(): void {
    assert.ok(state.transcript.bySession[SESSION]?.some((row) => row.id === 'local-one' && row.markdown === PROMPT));
    assert.notEqual(state.composer.draftTextBySession[SESSION], PROMPT, 'no rollback draft restoration');
    assert.equal(effects.some((effect) => effect.kind === 'PostImperative'
      && effect.imperativeMessage.type === 'sendRejected'), false);
    assert.equal(events.some((event) => event.kind === 'SendResult' && !event.ok), false);
  }
  return {
    get state() { return state; }, effects, events, methods, send, dispatch, preserved,
    async start() { send(); await deadline; await settle(); },
    async poll() { timers.fire(); await settle(); },
    async acknowledge() { lateAck?.(); await settle(); },
    close() { runner.dispose(); tracker.rejectAll(new Error('fixture disposed')); },
  };
}

const notFound = () => Object.assign(new Error('No hot worker owns this session'), { code: 'SESSION_NOT_FOUND' });

test('lookup unavailable during promotion preserves the send until its late correlated acknowledgement and commit', async () => {
  const h = harness(notFound());
  try {
    await h.start();
    await h.poll();
    h.preserved();
    assert.equal(h.state.operations['op-one']?.phase, 'ambiguous');
    assert.equal(h.state.operations['op-one']?.reconciliation?.attempts, 1);
    h.send('two');
    await settle();
    assert.equal(h.state.operations['op-two'], undefined, 'second submit is blocked');
    assert.deepEqual(h.methods, ['message.send', 'operation.status']);
    await h.acknowledge();
    assert.equal(h.state.operations['op-one']?.acceptance, 'accepted');
    assert.equal(h.state.pending.promoted['corr-one']?.requestId, 'backend-request');
    const commit: Event = {
      kind: 'MessageStarted', sessionPath: SESSION, operationId: 'op-one', operationAttempt: 1,
      requestId: 'backend-request', messageId: 'assistant-one', timestamp: 200,
    };
    h.dispatch(commit);
    const terminal = h.state.operations['op-one']?.terminal;
    assert.equal(terminal?.outcome, 'settled');
    const releaseCount = h.effects.filter((effect) => effect.kind === 'ReleaseOperationResources').length;
    h.dispatch(commit);
    await h.acknowledge();
    await h.poll();
    assert.strictEqual(h.state.operations['op-one']?.terminal, terminal);
    assert.equal(h.effects.filter((effect) => effect.kind === 'ReleaseOperationResources').length, releaseCount);
    assert.equal(h.state.pending.ops['corr-one'], undefined);
    assert.equal(h.state.pending.promoted['corr-one'], undefined);
    h.preserved();
    assert.equal(h.methods.filter((method) => method === 'message.send').length, 1);
  } finally { h.close(); }
});

for (const [label, error] of [
  ['SESSION_NOT_FOUND', notFound()],
  ['message-only generation-ended text', new Error('lookup unavailable; SESSION_GENERATION_ENDED may be returned later')],
  ['unknown lookup error', new Error('temporary lookup failure')],
] as const) {
  test(`${label} exhausts bounded reconciliation without removing the prompt or replaying`, async () => {
    const h = harness(error);
    try {
      await h.start();
      for (let i = 0; i < 4; i++) await h.poll();
      h.preserved();
      assert.equal(h.state.operations['op-one']?.terminal, undefined);
      assert.equal(h.state.operations['op-one']?.recovery, 'restart-backend');
      assert.equal(h.state.operations['op-one']?.reconciliation?.attempts, 4);
      h.send('two');
      await h.poll();
      assert.equal(h.state.operations['op-two'], undefined);
      assert.deepEqual(h.methods, ['message.send', ...Array<string>(4).fill('operation.status')]);
    } finally { h.close(); }
  });
}

test('structured SESSION_GENERATION_ENDED remains definitive rollback authority', async () => {
  const h = harness(Object.assign(new Error('Owning generation ended'), { code: 'SESSION_GENERATION_ENDED' }));
  try {
    await h.start();
    await h.poll();
    assert.equal(h.state.operations['op-one']?.terminal?.outcome, 'failed');
    assert.equal(h.state.transcript.bySession[SESSION]?.some((row) => row.id === 'local-one'), false);
    assert.equal(h.state.composer.draftTextBySession[SESSION], PROMPT);
    assert.equal(h.effects.filter((effect) => effect.kind === 'PostImperative'
      && effect.imperativeMessage.type === 'sendRejected').length, 1);
    await h.acknowledge();
    await h.poll();
    assert.equal(h.state.operations['op-one']?.terminal?.outcome, 'failed');
    assert.deepEqual(h.methods, ['message.send', 'operation.status']);
  } finally { h.close(); }
});
