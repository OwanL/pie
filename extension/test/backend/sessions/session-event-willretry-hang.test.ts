/**
 * Phase 1 red-test battery — session-event-handler willRetry hang (Bug 6, pie).
 *
 * Bug 6 — `willRetry:true` hang: on `agent_end willRetry`, the handler returns
 *         early (correct — don't finalize mid-retry). The SDK then sleeps
 *         `delayMs` and retries. If that backoff/retry never completes (the
 *         SDK's retry turn hangs — e.g. provider dies mid-backoff, or an
 *         extension hook blocks the retry), `activeRequest` stays set forever
 *         with NO bound on the willRetry window. There is no watchdog that
 *         fires when a `willRetry` agent_end is followed by neither a
 *         successful retry's agent_start nor an `auto_retry_end` within a
 *         bounded window.
 *
 * Approach: drives the real `handleSdkSessionEvent` with a hand-built
 * `BackendSessionEventHandlerDeps` capturing emits + busy state. Mirrors the
 * `backend-request-handler.test.ts` harness pattern (no `vscode` import —
 * the backend handler is vscode-free).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleSdkSessionEvent } from '../../../src/backend/session-event-handler';
import type { SessionContext } from '../../../src/backend/server-types';
import type { SdkSessionEvent } from '../../../src/backend/sdk';

// ===========================================================================
// Shared harness
// ===========================================================================

interface EventHandlerHarness {
  emits: Array<{ event: string; payload?: unknown }>;
  busyEvents: boolean[];
  context: SessionContext;
  recoveries: string[];
  deps: {
    emit: (event: string, payload?: unknown) => void;
    emitBusyChanged: (context: SessionContext, busy: boolean) => void;
    emitContextUsageChanged: (context: SessionContext) => void;
    emitSessionOpened: (sessionPath: string, selectionToken?: string) => Promise<void>;
    emitSessionListChanged: () => Promise<void>;
    recoverStuckSession: (context: SessionContext, reason: string) => void;
  };
}

function createHarness(): EventHandlerHarness {
  const emits: Array<{ event: string; payload?: unknown }> = [];
  const busyEvents: boolean[] = [];
  const recoveries: string[] = [];
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
    recoveries,
    deps: {
      emit: (event, payload) => { emits.push({ event, payload }); },
      emitBusyChanged: (_ctx, busy) => { busyEvents.push(busy); },
      emitContextUsageChanged: () => {},
      emitSessionOpened: async () => {},
      emitSessionListChanged: async () => {},
      recoverStuckSession: (ctx, reason) => {
        recoveries.push(reason);
        ctx.activeRequest = undefined;
        busyEvents.push(false);
      },
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
// Bug 6 — willRetry agent_end that is never followed by a retry leaves the
// session permanently marked running (no bound on the willRetry window)
// ===========================================================================

test('Bug 6: an `agent_end willRetry:true` that is never followed by a retry turn emits operational-error + retry.stuck within a bounded window (Phase 2 fix: willRetry watchdog)', async () => {
  // The handler correctly returns early on willRetry (don't finalize mid-retry).
  // Bug 6 watchdog: a watchdog arms on agent_end willRetry:true (delayMs=0 +
  // grace) and re-arms on auto_retry_start (delayMs + grace). If the retry
  // never completes (no auto_retry_end / agent_end willRetry:false), the
  // watchdog emits `operational-error` + `retry.stuck` so the user can recover.
  // Tighten the grace to 50ms so the test does not wait the full 60s.
  const prevGrace = process.env.PIE_WILLRETRY_WATCHDOG_GRACE_MS;
  process.env.PIE_WILLRETRY_WATCHDOG_GRACE_MS = '50';
  const h = createHarness();

  // Commit point reached (so the prompt-safety-timer is cleared — out of scope).
  h.context.activeRequest!.currentMessageId = 'req-willretry:1';

  // Normal turn: agent_start, message_start (assistant), message_end, then a
  // transient-error agent_end with willRetry=true.
  handleSdkSessionEvent(h.deps, h.context, { type: 'agent_start' });
  handleSdkSessionEvent(h.deps, h.context, {
    type: 'message_start',
    message: { role: 'assistant' },
  });
  handleSdkSessionEvent(h.deps, h.context, {
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'error', usage: { input: 1, output: 1 } },
  });
  // willRetry=true → handler returns early (correct). The watchdog arms.
  handleSdkSessionEvent(h.deps, h.context, { type: 'agent_end', willRetry: true });

  // activeRequest is preserved (correct — don't finalize mid-retry).
  assert.equal(h.context.activeRequest?.id, 'req-willretry', 'activeRequest preserved after willRetry (correct)');
  assert.equal(h.busyEvents.at(-1), true, 'busy stays true after willRetry (correct)');

  // An auto_retry_start arrives (re-arms the watchdog with delayMs=3000 + grace).
  // Since delayMs (3000) > grace (50), the watchdog window is 3000+50ms — too
  // long for the test. Override delayMs to 0 so the grace alone bounds it.
  handleSdkSessionEvent(h.deps, h.context, {
    type: 'auto_retry_start',
    attempt: 1,
    maxAttempts: 6,
    delayMs: 0,
    errorMessage: 'transient stream error',
  });

  // Phase 2 fix: the watchdog fires after the grace window elapses.
  await sleep(120);

  assert.equal(h.context.activeRequest, undefined, 'stuck retry is terminalized instead of remaining busy forever');
  assert.equal(h.busyEvents.at(-1), false, 'stuck retry recovery leaves the session idle');
  assert.equal(h.recoveries.length, 1, 'recovery runs exactly once');

  const operationalErrors = h.emits.filter((e) => e.event === 'operational-error');
  const retryStuck = h.emits.filter((e) => e.event === 'retry.stuck');
  assert.ok(operationalErrors.length >= 1, 'Phase 2 FIX: operational-error emitted for a willRetry that never completes');
  assert.ok(retryStuck.length >= 1, 'Phase 2 FIX: retry.stuck emitted for a willRetry that never completes');
  const opPayload = operationalErrors[0]?.payload as { code?: string; message?: string } | undefined;
  assert.match(`${opPayload?.code ?? ''} ${opPayload?.message ?? ''}`, /RETRY_STUCK|retry.+not completed/i);

  if (prevGrace === undefined) delete process.env.PIE_WILLRETRY_WATCHDOG_GRACE_MS;
  else process.env.PIE_WILLRETRY_WATCHDOG_GRACE_MS = prevGrace;
});

test('Bug 6 (control): a completed retry finalizes at agent_settled without firing the retry watchdog', async () => {
  // Control proving the willRetry early-return is correct for the happy path.
  // Phase 2's watchdog must NOT fire here — only when a willRetry never
  // resolves within a bounded window.
  const h = createHarness();
  h.context.activeRequest!.currentMessageId = 'req-control:1';

  handleSdkSessionEvent(h.deps, h.context, { type: 'agent_start' });
  handleSdkSessionEvent(h.deps, h.context, { type: 'message_start', message: { role: 'assistant' } });
  handleSdkSessionEvent(h.deps, h.context, {
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'error', usage: { input: 1, output: 1 } },
  });
  handleSdkSessionEvent(h.deps, h.context, { type: 'agent_end', willRetry: true });

  // The retry completes normally.
  handleSdkSessionEvent(h.deps, h.context, { type: 'auto_retry_start', attempt: 1, maxAttempts: 6, delayMs: 0, errorMessage: 'transient' });
  handleSdkSessionEvent(h.deps, h.context, { type: 'auto_retry_end', attempt: 1, success: true });
  // The successful retry attempt ends before the complete SDK run settles.
  handleSdkSessionEvent(h.deps, h.context, { type: 'agent_end', willRetry: false });
  assert.notEqual(h.context.activeRequest, undefined);
  h.context.session.isStreaming = false;
  handleSdkSessionEvent(h.deps, h.context, { type: 'agent_settled' });

  assert.equal(h.context.activeRequest, undefined, 'happy retry path clears activeRequest at settlement');
  assert.equal(h.busyEvents.at(-1), false, 'happy retry path sets busy false');
});
