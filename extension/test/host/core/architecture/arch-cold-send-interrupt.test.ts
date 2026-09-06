import assert from 'node:assert/strict';
import test from 'node:test';

import { EffectRunner, type EffectRunnerDeps } from '../../../../src/host/core/effect-runner';
import type { Effect } from '../../../../src/host/core/effects';
import type { Event } from '../../../../src/host/core/events';
import { selectViewState } from '../../../../src/host/core/projection';
import { initialArchState, reducer, type ArchState } from '../../../../src/host/core/reducer';
import { makeEffectRunnerDeps } from '../../../helpers/effect-runner-deps';

const SESSION = '/repo/cold-session.jsonl';

function serializingQueues(): EffectRunnerDeps['queues'] {
  const tails = new Map<string, Promise<void>>();
  return {
    async enqueueLifecycle<T>(task: () => Promise<T>): Promise<T> {
      return await task();
    },
    async enqueueSessionOperation<T>(sessionPath: string, task: () => Promise<T>): Promise<T> {
      const result = (tails.get(sessionPath) ?? Promise.resolve()).then(task, task);
      const barrier = result.then(() => undefined, () => undefined);
      tails.set(sessionPath, barrier);
      void barrier.finally(() => {
        if (tails.get(sessionPath) === barrier) tails.delete(sessionPath);
      });
      return await result;
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function readyColdState(): ArchState {
  return {
    ...initialArchState,
    settings: { ...initialArchState.settings, backendReady: true },
    sessions: {
      ...initialArchState.sessions,
      activeSessionPath: SESSION,
    },
  };
}

test('immediate Stop during cold promotion stays priority and rolls the unaccepted prompt back to the composer', async () => {
  const sent = reducer(readyColdState(), {
    kind: 'Command',
    cmd: {
      kind: 'Send', corrId: 'send-corr', operationId: 'send-operation', operationAttempt: 1,
      operationSource: { kind: 'renderer', rendererId: 'renderer-1', rendererKind: 'browser', rendererGeneration: 1 },
      backendGeneration: 7, sessionPath: SESSION, text: 'long request', inputs: [],
      composedText: 'long request', localId: 'local-user', previousSummary: null, timestamp: 100,
    },
  } as Event);
  const stopped = reducer(sent.state, {
    kind: 'Command',
    cmd: {
      kind: 'Interrupt', corrId: 'stop-corr', operationId: 'stop-operation', operationAttempt: 1,
      operationSource: { kind: 'renderer', rendererId: 'renderer-1', rendererKind: 'browser', rendererGeneration: 1 },
      backendGeneration: 7, sessionPath: SESSION,
    },
  });
  const sendEffect = sent.effects.find((effect): effect is Extract<Effect, { kind: 'SendRpc' }> => effect.kind === 'SendRpc');
  const stopEffect = stopped.effects.find((effect): effect is Extract<Effect, { kind: 'InterruptRpc' }> => effect.kind === 'InterruptRpc');
  assert.ok(sendEffect);
  assert.ok(stopEffect);

  const methods: string[] = [];
  const { deps, events } = makeEffectRunnerDeps({
    queues: serializingQueues(),
    serviceOverrides: { isSessionRuntimeReady: () => false },
    requestImpl: async (method) => {
      methods.push(method);
      if (method === 'message.send') return await new Promise(() => {});
      if (method === 'message.interrupt') return { interrupted: true, settled: true };
      return {};
    },
  });
  const runner = new EffectRunner(deps);
  try {
    runner.run(sendEffect);
    await settle();
    assert.deepEqual(methods, ['message.send'], 'the cold-promotion request is in flight before Stop');
    runner.run(stopEffect);
    await settle();

    assert.deepEqual(
      methods,
      ['message.send', 'message.interrupt'],
      'Stop aborts the send waiter and reaches the coordinator without waiting for cold promotion',
    );
    const sendRejected = events.find((event) => event.kind === 'SendResult');
    const interruptSettled = events.find((event) => event.kind === 'InterruptResult');
    assert.equal(sendRejected?.kind, 'SendResult');
    assert.equal(sendRejected?.ok, false);
    assert.equal(interruptSettled?.kind, 'InterruptResult');
    assert.equal(interruptSettled?.ok, true);

    let hostState = stopped.state;
    let rollbackEffects: Effect[] = [];
    for (const event of events) {
      const reduced = reducer(hostState, event);
      hostState = reduced.state;
      rollbackEffects = [...rollbackEffects, ...reduced.effects];
    }
    assert.equal(
      hostState.transcript.bySession[SESSION]?.some((message) => message.id === 'local-user'),
      false,
      'the unaccepted optimistic row is removed',
    );
    assert.equal(hostState.composer.draftTextBySession[SESSION], 'long request');
    assert.equal(selectViewState(hostState).draftText, 'long request', 'a late/reconnect snapshot carries the restored draft');
    assert.ok(rollbackEffects.some((effect) => effect.kind === 'PostImperative'
      && effect.imperativeMessage.type === 'sendRejected'
      && effect.imperativeMessage.text === 'long request'));
  } finally {
    runner.dispose();
  }
});
