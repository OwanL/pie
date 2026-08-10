import test from 'node:test';
import assert from 'node:assert/strict';

import { onMessageAborted, onCompaction, onCompactionStarted } from '../../../../src/host/session-service/handlers/streaming';
import { createInitialArchState, type ArchState } from '../../../../src/host/core/arch-state';
import { NOOP_RUN_OBSERVER } from '../../../../src/host/stats-service';
import type { Event } from '../../../../src/host/core/events';

function createDeps(initialState?: ArchState) {
  let archState = initialState ?? createInitialArchState();
  const dispatched: Event[] = [];
  const touched: string[] = [];

  return {
    dispatched,
    touched,
    deps: {
      getArchState: () => archState,
      dispatchArch: (event: Event) => {
        dispatched.push(event);
        if (event.kind === 'NoticeShown') {
          archState = {
            ...archState,
            settings: {
              ...archState.settings,
              notice: event.notice,
              noticeKind: null,
              noticeRaw: null,
            },
          };
        }
      },
      runObserver: NOOP_RUN_OBSERVER,
      state: {
        touchSessionTranscript: (sessionPath: string) => {
          touched.push(sessionPath);
        },
      } as any,
      scheduleRender: () => undefined,
      requireEventSessionPath: (_eventName: string, sessionPath: string | undefined) => sessionPath ?? null,
    },
  };
}

test('onMessageAborted shows a notice for unexpected interruptions and sanitizes the reason', () => {
  const { deps, dispatched, touched } = createDeps();

  onMessageAborted({
    requestId: 'req-1',
    sessionPath: '/s',
    messageId: 'assistant-1',
    userInitiated: false,
    reason: 'Backend dropped req-7 before completion.',
  }, deps as any);

  assert.deepEqual(dispatched, [
    {
      kind: 'MessageAborted',
      sessionPath: '/s',
      requestId: 'req-1',
      messageId: 'assistant-1',
      userInitiated: false,
      reason: 'Backend dropped request before completion.',
    },
    {
      kind: 'NoticeShown',
      notice: 'Backend dropped request before completion.',
    },
  ]);
  assert.deepEqual(touched, ['/s']);
});

test('onMessageAborted suppresses the notice for user-initiated interruptions', () => {
  const { deps, dispatched } = createDeps();

  onMessageAborted({
    requestId: 'req-2',
    sessionPath: '/s',
    messageId: 'assistant-2',
    userInitiated: true,
    reason: 'ignored',
  }, deps as any);

  assert.deepEqual(dispatched, [
    {
      kind: 'MessageAborted',
      sessionPath: '/s',
      requestId: 'req-2',
      messageId: 'assistant-2',
      userInitiated: true,
      reason: undefined,
    },
  ]);
});

test('onMessageAborted appends to an active unrelated error notice instead of suppressing the interrupt alert', () => {
  const state = createInitialArchState();
  state.settings.notice = 'Backend exited unexpectedly.';
  state.settings.noticeRaw = 'Backend exited unexpectedly with code 1.';
  state.settings.noticeKind = 'send-failed';

  const { deps, dispatched } = createDeps(state);

  onMessageAborted({
    requestId: 'req-3',
    sessionPath: '/s',
    messageId: 'assistant-3',
    userInitiated: false,
    reason: 'The session stopped unexpectedly before the assistant finished responding.',
  }, deps as any);

  assert.deepEqual(dispatched, [
    {
      kind: 'MessageAborted',
      sessionPath: '/s',
      requestId: 'req-3',
      messageId: 'assistant-3',
      userInitiated: false,
      reason: 'The session stopped unexpectedly before the assistant finished responding.',
    },
    {
      kind: 'NoticeShown',
      notice: 'Backend exited unexpectedly. — The session stopped unexpectedly before the assistant finished responding.',
    },
  ]);
});

test('onMessageAborted does not re-show an identical notice when the reason matches the existing notice', () => {
  const state = createInitialArchState();
  state.settings.notice = 'The session stopped unexpectedly before the assistant finished responding.';

  const { deps, dispatched } = createDeps(state);

  onMessageAborted({
    requestId: 'req-4',
    sessionPath: '/s',
    messageId: 'assistant-4',
    userInitiated: false,
    reason: 'The session stopped unexpectedly before the assistant finished responding.',
  }, deps as any);

  assert.deepEqual(dispatched, [
    {
      kind: 'MessageAborted',
      sessionPath: '/s',
      requestId: 'req-4',
      messageId: 'assistant-4',
      userInitiated: false,
      reason: 'The session stopped unexpectedly before the assistant finished responding.',
    },
  ]);
});

test('onCompactionStarted dispatches a CompactionStarted arch event', () => {
  const { deps, dispatched } = createDeps();

  onCompactionStarted({ sessionPath: '/s' }, deps as any);

  assert.deepEqual(dispatched, [{ kind: 'CompactionStarted', sessionPath: '/s' }]);
});

test('onCompaction counts the run and dispatches CompactionEnded with token metrics', () => {
  const { deps, dispatched } = createDeps();
  let compactionCount = 0;
  const depsWithObserver = {
    ...deps,
    runObserver: {
      ...NOOP_RUN_OBSERVER,
      onCompaction: () => { compactionCount += 1; },
    },
  };

  onCompaction({
    sessionPath: '/s',
    occurredAt: 1_700_000_000_000,
    tokensBefore: 120_000,
    estimatedTokensAfter: 30_000,
  }, depsWithObserver as any);

  assert.equal(compactionCount, 1);
  assert.deepEqual(dispatched, [{
    kind: 'CompactionEnded',
    sessionPath: '/s',
    occurredAt: 1_700_000_000_000,
    tokensBefore: 120_000,
    estimatedTokensAfter: 30_000,
  }]);
});

test('onCompaction omits absent token metrics from the arch event', () => {
  const { deps, dispatched } = createDeps();

  onCompaction({ sessionPath: '/s' }, deps as any);

  const event = dispatched[0] as { kind: string; sessionPath: string; occurredAt: number };
  assert.equal(event.kind, 'CompactionEnded');
  assert.equal(event.sessionPath, '/s');
  assert.equal(typeof event.occurredAt, 'number');
  assert.equal('tokensBefore' in event, false);
  assert.equal('estimatedTokensAfter' in event, false);
});
