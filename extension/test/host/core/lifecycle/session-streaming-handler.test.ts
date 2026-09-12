import test from 'node:test';
import assert from 'node:assert/strict';

import { onMessageAborted, onCompaction, onCompactionStarted, onMessageFinished, onMessageStarted } from '../../../../src/host/session-service/handlers/streaming';
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
              noticeKind: event.noticeKind ?? null,
              noticeRaw: event.noticeRaw ?? null,
              noticeSessionPath: event.notice ? (event.sessionPath ?? null) : null,
            },
          };
        }
      },
      runObserver: NOOP_RUN_OBSERVER,
      state: {
        touchSessionTranscript: (sessionPath: string) => {
          touched.push(sessionPath);
        },
        unbindRequestSessionPath: () => undefined,
      } as any,
      scheduleRender: () => undefined,
      requireEventSessionPath: (_eventName: string, sessionPath: string | undefined) => sessionPath ?? null,
    },
  };
}

test('onMessageFinished forwards exact durable transcript and operation identity to accounting', () => {
  const { deps } = createDeps();
  let billing: { durableEntryId?: string; operationId?: string; requestId?: string; generationDurationMs?: number } | undefined;
  const observer = {
    ...NOOP_RUN_OBSERVER,
    onAssistantTurnEnded: (
      _sessionPath: string,
      _turnId: string,
      _durationMs: number,
      _usage: unknown,
      _status: unknown,
      _latency: unknown,
      value: { durableEntryId?: string; operationId?: string; requestId?: string },
    ) => { billing = value; },
  };
  onMessageFinished({
    requestId: 'request-durable',
    operationId: 'operation-durable',
    sessionPath: '/session-durable',
    message: {
      id: 'assistant-durable',
      role: 'assistant',
      content: [],
      createdAt: '2027-01-15T08:00:00.000Z',
      status: 'completed',
      durationMs: 17,
      durableEntryId: 'entry-durable-1',
    },
  } as any, { ...deps, runObserver: observer } as any);

  assert.equal(billing?.durableEntryId, 'entry-durable-1');
  assert.equal(billing?.operationId, 'operation-durable');
  assert.equal(billing?.requestId, 'request-durable');
  assert.equal(billing?.generationDurationMs, 17);
});

test('onMessageStarted forwards the accepted operation identity to the observer', () => {
  const { deps } = createDeps();
  let identity: { operationId?: string | null; requestId?: string; operationAttempt?: number } | undefined;
  const observer = {
    ...NOOP_RUN_OBSERVER,
    onAssistantTurnStarted: (
      _sessionPath: string,
      _turnId: string,
      value: { operationId?: string | null; requestId?: string; operationAttempt?: number },
    ) => { identity = value; },
  };
  onMessageStarted({
    requestId: 'request-started',
    operationId: 'operation-started',
    operationAttempt: 2,
    messageId: 'message-started',
    sessionPath: '/session-started',
  }, { ...deps, runObserver: observer, state: {
    ...deps.state,
    bindRequestSessionPath: () => undefined,
  } } as any);

  assert.deepEqual(identity, {
    operationId: 'operation-started',
    requestId: 'request-started',
    operationAttempt: 2,
  });
});

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
      noticeKind: 'operational-error',
      noticeRaw: 'Backend dropped request before completion.',
      sessionPath: '/s',
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
      noticeKind: 'operational-error',
      noticeRaw: 'Backend exited unexpectedly. — The session stopped unexpectedly before the assistant finished responding.',
      sessionPath: null,
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
    reason: 'threshold',
    outcome: 'succeeded',
    occurredAt: 1_700_000_000_000,
    tokensBefore: 120_000,
    estimatedTokensAfter: 30_000,
  }, depsWithObserver as any);

  assert.equal(compactionCount, 1);
  assert.deepEqual(dispatched, [{
    kind: 'CompactionEnded',
    sessionPath: '/s',
    reason: 'threshold',
    outcome: 'succeeded',
    occurredAt: 1_700_000_000_000,
    tokensBefore: 120_000,
    estimatedTokensAfter: 30_000,
  }]);
});

test('onCompaction preserves failed outcomes without token metrics', () => {
  const { deps, dispatched } = createDeps();

  onCompaction({ sessionPath: '/s', reason: 'manual', outcome: 'failed' }, deps as any);

  const event = dispatched[0] as {
    kind: string;
    sessionPath: string;
    reason?: string;
    outcome: string;
    occurredAt: number;
  };
  assert.equal(event.kind, 'CompactionEnded');
  assert.equal(event.sessionPath, '/s');
  assert.equal(event.reason, 'manual');
  assert.equal(event.outcome, 'failed');
  assert.equal(typeof event.occurredAt, 'number');
  assert.equal('tokensBefore' in event, false);
  assert.equal('estimatedTokensAfter' in event, false);
});
