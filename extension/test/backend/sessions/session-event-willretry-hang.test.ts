/**
 * Retry-backoff hang determinism — the retry watchdog is removed.
 *
 * Contract: a retry backoff that never completes is NOT automatically
 * terminalized by elapsed time. The retry stays owned by the exact SDK retry
 * lifecycle (`auto_retry_end`, the final `agent_end willRetry:false`, and
 * `agent_settled`), the exact provider queue/header/body deadlines, and
 * explicit user Stop. No heuristic wall-clock watchdog fires for it.
 *
 * Approach: drives the real `handleSdkSessionEvent` with a hand-built
 * `BackendSessionEventHandlerDeps` capturing emits + busy state. Mirrors the
 * `backend-request-handler.test.ts` harness pattern (no `vscode` import —
 * the backend handler is vscode-free).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleSdkSessionEvent } from '../../../src/backend/session-event-handler';
import { BackendLiveTurnAccumulator } from '../../../src/backend/live-turn-accumulator';
import type { SessionContext } from '../../../src/backend/server-types';
import type { SdkSessionEvent } from '../../../src/backend/sdk';

// ===========================================================================
// Shared harness
// ===========================================================================

interface EventHandlerHarness {
  emits: Array<{ event: string; payload?: unknown }>;
  busyEvents: boolean[];
  context: SessionContext;
  deps: {
    emit: (event: string, payload?: unknown) => void;
    emitBusyChanged: (context: SessionContext, busy: boolean) => void;
    emitContextUsageChanged: (context: SessionContext) => void;
    emitSessionOpened: (sessionPath: string, selectionToken?: string) => Promise<void>;
    emitSessionListChanged: () => Promise<void>;
  };
}

function createHarness(): EventHandlerHarness {
  const emits: Array<{ event: string; payload?: unknown }> = [];
  const busyEvents: boolean[] = [];
  const context: SessionContext = {
    runtime: {} as SessionContext['runtime'],
    session: { isStreaming: true, model: { id: 'model-a' } } as SessionContext['session'],
    sessionPath: '/repo/session.jsonl',
    unsubscribe: () => undefined,
    busySeq: 0,
    activeRequest: { id: 'req-willretry', messageIndex: 0, modelId: 'model-a', aborted: false },
  } as SessionContext;

  return {
    emits,
    busyEvents,
    context,
    deps: {
      emit: (event, payload) => { emits.push({ event, payload }); },
      emitBusyChanged: (_ctx, busy) => { busyEvents.push(busy); },
      emitContextUsageChanged: () => {},
      emitSessionOpened: async () => {},
      emitSessionListChanged: async () => {},
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function assertNoWatchdogFields(context: SessionContext): void {
  const timerFields = Object.keys(context.activeRequest ?? {}).filter(
    (key) => /Timer|Watchdog|Lease/.test(key),
  );
  assert.deepEqual(
    timerFields,
    [],
    'activeRequest must not carry heuristic watchdog/lease timer fields',
  );
}

// ===========================================================================
// A retry backoff that never completes is never terminalized by elapsed time
// ===========================================================================

test('an `agent_end willRetry` backoff that never completes is not terminalized by elapsed time', async () => {
  const h = createHarness();
  h.context.activeRequest!.currentMessageId = 'req-willretry:1';
  h.context.activeRequest!.liveTurnAccumulator = new BackendLiveTurnAccumulator({
    protocolVersion: 7,
    sessionPath: '/repo/session.jsonl',
    requestId: 'req-willretry',
    turnId: 'turn-retry',
    attemptId: 'attempt-retry',
    canonicalMessageId: 'req-willretry:1',
    startedAt: 100,
  });
  handleSdkSessionEvent(h.deps, h.context, { type: 'agent_start' });
  handleSdkSessionEvent(h.deps, h.context, {
    type: 'message_start',
    message: { role: 'assistant' },
  });
  handleSdkSessionEvent(h.deps, h.context, {
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'error', usage: { input: 1, output: 1 } },
  });
  handleSdkSessionEvent(h.deps, h.context, { type: 'agent_end', willRetry: true });

  assert.equal(h.context.activeRequest?.id, 'req-willretry', 'activeRequest preserved after willRetry');
  assert.equal(h.busyEvents.at(-1), true, 'busy stays true after willRetry');

  // The SDK reports the backoff; the retry never completes (no auto_retry_end,
  // no retry turn_start, no agent_end willRetry:false). Well beyond any
  // historical watchdog window (delayMs + grace), nothing may fire.
  handleSdkSessionEvent(h.deps, h.context, {
    type: 'auto_retry_start',
    attempt: 1,
    maxAttempts: 6,
    delayMs: 50,
    errorMessage: 'transient stream error',
  });
  assert.ok(
    h.emits.some((e) => e.event === 'live.semantic'
      && (e.payload as { kind?: string } | undefined)?.kind === 'turn.phase'
      && (e.payload as { phase?: string } | undefined)?.phase === 'retry_wait'),
    'the retry_wait phase publication is preserved',
  );

  await sleep(250);

  assert.notEqual(h.context.activeRequest, undefined, 'a stalled backoff is not automatically terminalized');
  assert.equal(h.busyEvents.at(-1), true, 'the session stays busy until the exact lifecycle settles it');
  assert.equal(
    h.emits.filter((e) => e.event === 'operational-error').length,
    0,
    'no heuristic operational-error fires for a stalled backoff',
  );
  assert.equal(h.emits.some((e) => e.event.startsWith('turn.terminal')), false, 'no turn terminal is published');
  assertNoWatchdogFields(h.context);

  // User Stop remains the authority: settle the lifecycle the way an explicit
  // interrupt would and verify the normal finalization still runs.
  h.context.session.isStreaming = false;
  handleSdkSessionEvent(h.deps, h.context, { type: 'agent_end', willRetry: false });
  handleSdkSessionEvent(h.deps, h.context, { type: 'agent_settled' });
  assert.equal(h.context.activeRequest, undefined, 'explicit lifecycle settlement still finalizes the request');
  assert.equal(h.busyEvents.at(-1), false, 'explicit lifecycle settlement still clears busy');
});

test('a healthy retry completing after a long backoff finalizes at agent_settled without any watchdog firing', async () => {
  const h = createHarness();
  h.context.activeRequest!.currentMessageId = 'req-retryturn:1';

  // First attempt fails with a transient error and the SDK starts its backoff.
  handleSdkSessionEvent(h.deps, h.context, { type: 'agent_start' });
  handleSdkSessionEvent(h.deps, h.context, { type: 'message_start', message: { role: 'assistant' } });
  handleSdkSessionEvent(h.deps, h.context, {
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'error', usage: { input: 1, output: 1 } },
  });
  handleSdkSessionEvent(h.deps, h.context, { type: 'agent_end', willRetry: true });
  handleSdkSessionEvent(h.deps, h.context, {
    type: 'auto_retry_start',
    attempt: 1,
    maxAttempts: 6,
    delayMs: 0,
    errorMessage: 'transient stream error',
  });

  // The backoff completes silently and the retry turn begins; the provider
  // queues and streams past any historical watchdog window. Nothing may
  // terminalize it during the wait.
  handleSdkSessionEvent(h.deps, h.context, { type: 'agent_start' });
  handleSdkSessionEvent(h.deps, h.context, { type: 'turn_start' });
  handleSdkSessionEvent(h.deps, h.context, { type: 'message_start', message: { role: 'assistant' } });
  await sleep(250);

  assert.equal(h.emits.filter((e) => e.event === 'operational-error').length, 0, 'no heuristic incident fires during the long healthy response');
  assert.notEqual(h.context.activeRequest, undefined, 'activeRequest survives the long healthy response');
  assert.equal(h.busyEvents.at(-1), true, 'session stays busy through the healthy response');

  // The response completes and the run finalizes normally.
  handleSdkSessionEvent(h.deps, h.context, {
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'stop', usage: { input: 1, output: 1 } },
  });
  handleSdkSessionEvent(h.deps, h.context, { type: 'auto_retry_end', attempt: 1, success: true });
  handleSdkSessionEvent(h.deps, h.context, { type: 'agent_end', willRetry: false });
  h.context.session.isStreaming = false;
  handleSdkSessionEvent(h.deps, h.context, { type: 'agent_settled' });

  assert.equal(h.context.activeRequest, undefined, 'healthy retry finalizes at agent_settled');
  assert.equal(h.busyEvents.at(-1), false, 'healthy retry clears busy at settlement');
  assert.equal(
    h.emits.filter((e) => e.event === 'operational-error').length,
    0,
    'no heuristic incident fires across the full healthy retry lifecycle',
  );
});