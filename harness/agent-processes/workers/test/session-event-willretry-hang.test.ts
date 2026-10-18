/** Elapsed time cannot settle SDK-owned retry backoff or resumed streaming. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSdkSessionEvent } from '../session-event-handler';
import { createHarness, emitAssistantError } from './retry-fixture';

for (const resumed of [false, true]) {
  test(`${resumed ? 'resumed retry streaming' : 'stalled retry backoff'} retains ownership until explicit settlement`, (t) => {
    // Mock before starting the lifecycle so any newly scheduled watchdog would
    // actually execute. Advance both wall time and timeout callbacks, not just Date.
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000 });
    const h = createHarness();
    const request = h.context.activeRequest;
    const send = (event: Parameters<typeof handleSdkSessionEvent>[2]) =>
      handleSdkSessionEvent(h.deps, h.context, event);
    send({ type: 'agent_start' });
    emitAssistantError(h, 'retry-error', 'transient stream error');
    send({ type: 'agent_end', willRetry: true });
    send({
      type: 'auto_retry_start', attempt: 1, maxAttempts: 6,
      delayMs: 50, errorMessage: 'transient stream error',
    });
    assert.ok(h.emitted.some((e) => e.event === 'live.semantic'
      && e.payload?.kind === 'turn.phase' && e.payload?.phase === 'retry_wait'),
    'retry_wait is published');

    if (resumed) {
      // Backoff completes silently; the next attempt begins streaming.
      send({ type: 'agent_start' });
      send({ type: 'turn_start' });
      send({ type: 'message_start', message: { role: 'assistant' } });
    }
    // Cross the delay and historical grace windows without real-time sleeps.
    for (const elapsed of [50, 250, 60_000, 3_600_000]) {
      t.mock.timers.tick(elapsed);
      assert.equal(h.context.activeRequest, request, 'elapsed time preserves the exact request owner');
      assert.equal(h.busyEvents.at(-1), true, 'busy remains owned');
      assert.equal(h.busyEvents.includes(false), false, 'busy never flickers idle');
      assert.equal(h.emitted.some((e) => e.event === 'operational-error'), false);
      assert.equal(h.emitted.some((e) => e.event.startsWith('turn.terminal')
        || (e.event === 'live.semantic' && e.payload?.kind === 'turn.terminal')), false);
      assert.equal(h.accumulator.checkpoint().terminal, undefined);
    }

    if (resumed) {
      send({ type: 'message_end', sessionEntryId: 'retry-success', message: {
        role: 'assistant', content: [{ type: 'text', text: 'done' }],
        stopReason: 'stop', usage: { input: 1, output: 1 },
      } });
      send({ type: 'auto_retry_end', attempt: 1, success: true });
    }
    h.context.session.isStreaming = false;
    send({ type: 'agent_end', willRetry: false });
    assert.equal(h.context.activeRequest, request, 'agent_end alone cannot release ownership');
    assert.equal(h.busyEvents.at(-1), true);
    send({ type: 'agent_settled' });
    assert.equal(h.context.activeRequest, undefined, 'explicit SDK settlement releases ownership');
    assert.equal(h.busyEvents.at(-1), false);
    assert.equal(h.emitted.some((e) => e.event === 'operational-error'), false);
    if (resumed) {
      assert.equal(h.context.terminalLiveTurn?.accumulator.checkpoint().terminal?.durableEntryId, 'retry-success');
    }
  });
}
