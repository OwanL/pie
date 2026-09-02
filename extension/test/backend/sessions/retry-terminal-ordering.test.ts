import test from 'node:test';
import assert from 'node:assert/strict';

import { BackendLiveTurnAccumulator } from '../../../src/backend/live-turn-accumulator';
import {
  handleSdkSessionEvent,
  type BackendSessionEventHandlerDeps,
} from '../../../src/backend/session-event-handler';
import type { ActiveRequest, SessionContext } from '../../../src/backend/server-types';
import { LIVE_PIPELINE_PROTOCOL_VERSION } from '../../../src/shared/live-pipeline-protocol';

function createHarness() {
  const emitted: Array<{ event: string; payload?: any }> = [];
  const accumulator = new BackendLiveTurnAccumulator({
    protocolVersion: LIVE_PIPELINE_PROTOCOL_VERSION,
    sessionPath: '/session.jsonl',
    requestId: 'request-1',
    turnId: 'turn-1',
    attemptId: 'attempt-1',
    canonicalMessageId: 'request-1:1',
    modelId: 'model-1',
    startedAt: 1_000,
  });
  const context = {
    runtime: {},
    session: {
      isStreaming: true,
      model: { id: 'model-1', provider: 'provider-1', contextWindow: 100_000 },
      sessionManager: { getBranch: () => [] },
    },
    sessionPath: '/session.jsonl',
    unsubscribe: () => undefined,
    busySeq: 0,
    activeRequest: {
      id: 'request-1',
      messageIndex: 0,
      modelId: 'model-1',
      provider: 'provider-1',
      aborted: false,
      liveTurnAccumulator: accumulator,
    },
  } as unknown as SessionContext;
  const deps: BackendSessionEventHandlerDeps = {
    emit: (event: string, payload?: unknown) => emitted.push({ event, payload }),
    emitBusyChanged: () => undefined,
    emitContextUsageChanged: () => undefined,
    emitSessionOpened: async () => undefined,
    emitSessionListChanged: async () => undefined,
    recoverStuckSession: () => undefined,
  };
  return { accumulator, context, deps, emitted };
}

function emitAssistantError(
  harness: ReturnType<typeof createHarness>,
  entryId: string,
  errorMessage: string,
): void {
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'message_start',
    message: { role: 'assistant' },
  });
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'message_end',
    sessionEntryId: entryId,
    message: {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage,
      usage: { input: 1, output: 0 },
    },
  });
}

test('overflow compaction re-arms the finalized request before the SDK automatically continues', () => {
  const harness = createHarness();

  emitAssistantError(harness, 'overflow-entry-1', 'prompt is too long: context window exceeded');
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'agent_end',
    willRetry: false,
  });

  assert.equal(harness.context.activeRequest, undefined, 'the SDK reports agent_end before checking overflow compaction');

  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'compaction_start',
    reason: 'overflow',
  });
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'compaction_end',
    reason: 'overflow',
    willRetry: true,
    result: {
      summary: 'Compacted context',
      firstKeptEntryId: 'kept-entry',
      tokensBefore: 100_000,
      estimatedTokensAfter: 20_000,
    },
  });

  const continued = harness.context.activeRequest as ActiveRequest | undefined;
  assert.equal(continued?.id, 'request-1', 'overflow recovery keeps the original request correlation');
  assert.notEqual(continued?.liveTurnAccumulator, harness.accumulator, 'the continuation gets a fresh live turn owner');
  assert.equal(continued?.liveTurnAccumulator?.checkpoint().terminal, undefined);

  handleSdkSessionEvent(harness.deps, harness.context, { type: 'agent_start' });
  handleSdkSessionEvent(harness.deps, harness.context, { type: 'turn_start' });
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'message_start',
    message: { role: 'assistant' },
  });
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: { type: 'text_delta', delta: 'continued after compaction' },
  });

  assert.equal(
    harness.emitted.some((entry) =>
      entry.event === 'live.semantic'
      && entry.payload?.kind === 'turn.text'
      && entry.payload?.delta === 'continued after compaction'),
    true,
    'the automatically continued reply remains visible to the host',
  );

  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'message_end',
    sessionEntryId: 'continued-entry',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'continued after compaction' }],
      stopReason: 'stop',
      usage: { input: 20_000, output: 20 },
    },
  });
  handleSdkSessionEvent(harness.deps, harness.context, { type: 'agent_end', willRetry: false });

  assert.equal(harness.context.activeRequest, undefined, 'the continued run settles normally');
  const continuationTerminal = [...harness.emitted].reverse().find((entry) =>
    entry.event === 'live.semantic' && entry.payload?.kind === 'turn.terminal');
  assert.equal(continuationTerminal?.payload?.requestId, 'request-1');
  assert.equal(continuationTerminal?.payload?.durableEntryId, 'continued-entry');
});

test('soft threshold compaction re-arms a request finalized before compaction starts', () => {
  const harness = createHarness();

  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'message_start',
    message: { role: 'assistant' },
  });
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'message_end',
    sessionEntryId: 'zero-usage-length-terminal',
    message: {
      role: 'assistant',
      content: [],
      stopReason: 'length',
      usage: { input: 0, cacheRead: 0, output: 0 },
    },
  });
  handleSdkSessionEvent(harness.deps, harness.context, { type: 'agent_end', willRetry: false });

  assert.equal(harness.context.activeRequest, undefined);
  assert.equal(
    harness.context.thresholdCompactionContinuationCandidate?.id,
    'request-1',
    'post-run threshold timing retains correlation even when provider usage is unavailable',
  );
  assert.equal(
    harness.context.thresholdCompactionContinuationCandidate?.liveTurnAccumulator,
    undefined,
    'idle candidate retention must not pin the completed live transcript in memory',
  );

  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'compaction_end',
    reason: 'threshold',
    willRetry: true,
    result: {
      summary: 'Compacted context',
      firstKeptEntryId: 'kept-entry',
      tokensBefore: 196_541,
      estimatedTokensAfter: 41_133,
    },
  });

  const continued = harness.context.activeRequest as ActiveRequest | undefined;
  assert.equal(continued?.id, 'request-1');
  assert.notEqual(continued?.liveTurnAccumulator, harness.accumulator);
  assert.equal(harness.context.hardCompactionContinuationPending, true);

  handleSdkSessionEvent(harness.deps, harness.context, { type: 'agent_start' });
  assert.equal(harness.context.hardCompactionContinuationPending, false);
  handleSdkSessionEvent(harness.deps, harness.context, { type: 'agent_end', willRetry: false });
  assert.equal(harness.context.activeRequest, undefined);
});

test('hard threshold compaction preserves request ownership for its deferred continuation', () => {
  const harness = createHarness();

  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'message_start',
    message: { role: 'assistant' },
  });
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'message_end',
    sessionEntryId: 'pre-compaction-terminal',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'partial result before compaction' }],
      stopReason: 'stop',
      usage: { input: 80_000, output: 20 },
    },
  });
  assert.ok(harness.accumulator.lifecycleWatermark(), 'the pre-compaction reply is durably terminal');

  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'compaction_end',
    reason: 'threshold',
    willRetry: true,
    result: {
      summary: 'Compacted context',
      firstKeptEntryId: 'kept-entry',
      tokensBefore: 80_000,
      estimatedTokensAfter: 20_000,
    },
  });

  assert.equal(
    harness.context.activeRequest?.liveTurnAccumulator,
    harness.accumulator,
    'rotation waits until agent_end proves no tool or queued turn continued naturally',
  );

  handleSdkSessionEvent(harness.deps, harness.context, { type: 'agent_end', willRetry: false });
  const continued = harness.context.activeRequest;
  assert.equal(continued?.id, 'request-1', 'intermediate agent_end must not detach the continuation');
  assert.notEqual(continued?.liveTurnAccumulator, harness.accumulator, 'continuation gets a fresh live owner');
  assert.equal(continued?.liveTurnAccumulator?.checkpoint().terminal, undefined);

  handleSdkSessionEvent(harness.deps, harness.context, { type: 'agent_start' });
  handleSdkSessionEvent(harness.deps, harness.context, { type: 'agent_end', willRetry: false });
  assert.equal(harness.context.activeRequest, undefined, 'the continued run still settles normally');
});

test('backend finalizes when the SDK declines a deferred threshold continuation', () => {
  const harness = createHarness();
  (harness.context.session as unknown as {
    hasPendingHistoryCompactionContinuation: () => boolean;
  }).hasPendingHistoryCompactionContinuation = () => false;

  handleSdkSessionEvent(harness.deps, harness.context, { type: 'message_start', message: { role: 'assistant' } });
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'message_end',
    sessionEntryId: 'terminating-tool-result',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'tool requested termination' }],
      stopReason: 'stop',
      usage: { input: 80_000, output: 10 },
    },
  });
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'compaction_end',
    reason: 'threshold',
    willRetry: true,
    result: { summary: 'summary', firstKeptEntryId: 'kept', tokensBefore: 80_000 },
  });
  assert.equal(harness.context.hardCompactionContinuationPending, true);

  handleSdkSessionEvent(harness.deps, harness.context, { type: 'agent_end', willRetry: false });

  assert.equal(harness.context.hardCompactionContinuationPending, false);
  assert.equal(harness.context.activeRequest, undefined, 'a declined SDK continuation must settle normally');
});

test('a successful threshold compaction settling after interrupt cannot re-arm continuation', () => {
  const harness = createHarness();
  handleSdkSessionEvent(harness.deps, harness.context, { type: 'message_start', message: { role: 'assistant' } });
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'message_end',
    sessionEntryId: 'terminal-before-interrupt',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'terminal result' }],
      stopReason: 'stop',
      usage: { input: 80_000, output: 10 },
    },
  });
  assert.ok(harness.context.activeRequest);
  harness.context.activeRequest.aborted = true;
  harness.context.hardCompactionContinuationPending = false;

  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'compaction_end',
    reason: 'threshold',
    willRetry: true,
    result: { summary: 'summary', firstKeptEntryId: 'kept', tokensBefore: 80_000 },
  });
  handleSdkSessionEvent(harness.deps, harness.context, { type: 'agent_end', willRetry: false });

  assert.equal(harness.context.hardCompactionContinuationPending, false);
  assert.equal(harness.context.activeRequest, undefined, 'the interrupted request settles instead of being re-armed');
});

test('willRetry compaction clears busy when interruption removed the continuation owner', () => {
  const harness = createHarness();
  const busy: boolean[] = [];
  harness.deps.emitBusyChanged = (_context: SessionContext, value: boolean) => { busy.push(value); };

  handleSdkSessionEvent(harness.deps, harness.context, { type: 'message_start', message: { role: 'assistant' } });
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'message_end',
    sessionEntryId: 'terminal-before-post-agent-compaction',
    message: {
      role: 'assistant', content: [], stopReason: 'length',
      usage: { input: 0, cacheRead: 0, output: 0 },
    },
  });
  handleSdkSessionEvent(harness.deps, harness.context, { type: 'agent_end', willRetry: false });
  harness.context.thresholdCompactionContinuationCandidate = undefined;
  handleSdkSessionEvent(harness.deps, harness.context, { type: 'compaction_start', reason: 'threshold' });
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'compaction_end',
    reason: 'threshold',
    willRetry: true,
    result: { summary: 'summary', firstKeptEntryId: 'kept', tokensBefore: 80_000 },
  });

  assert.equal(busy.at(-1), false);
  assert.equal(harness.context.activeRequest, undefined);
});

test('a natural post-compaction turn cancels the deferred outer-loop continuation', () => {
  const harness = createHarness();
  handleSdkSessionEvent(harness.deps, harness.context, { type: 'message_start', message: { role: 'assistant' } });
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'message_end',
    sessionEntryId: 'terminal-before-queued-turn',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'first segment' }],
      stopReason: 'stop',
      usage: { input: 80_000, output: 10 },
    },
  });
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'compaction_end',
    reason: 'threshold',
    willRetry: true,
    result: { summary: 'summary', firstKeptEntryId: 'kept', tokensBefore: 80_000 },
  });

  handleSdkSessionEvent(harness.deps, harness.context, { type: 'turn_start' });
  handleSdkSessionEvent(harness.deps, harness.context, { type: 'agent_end', willRetry: false });

  assert.equal(harness.context.activeRequest, undefined, 'the natural turn owns the only continuation');
  assert.equal(harness.context.hardCompactionContinuationPending, false);
});

test('failed overflow compaction discards the finalized recovery candidate', () => {
  const harness = createHarness();

  emitAssistantError(harness, 'overflow-entry-failed', 'context length exceeded');
  handleSdkSessionEvent(harness.deps, harness.context, { type: 'agent_end', willRetry: false });
  handleSdkSessionEvent(harness.deps, harness.context, { type: 'compaction_start', reason: 'overflow' });
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'compaction_end',
    reason: 'overflow',
    willRetry: false,
    errorMessage: 'Context overflow recovery failed',
  });

  assert.equal(harness.context.activeRequest, undefined);
  assert.equal(harness.context.overflowRecoveryCandidate, undefined);
});

test('silent zero-output context exhaustion also preserves automatic continuation', () => {
  const harness = createHarness();

  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'message_start',
    message: { role: 'assistant' },
  });
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'message_end',
    sessionEntryId: 'silent-overflow-entry',
    message: {
      role: 'assistant',
      content: [],
      stopReason: 'length',
      usage: { input: 99_000, output: 0 },
    },
  });
  handleSdkSessionEvent(harness.deps, harness.context, { type: 'agent_end', willRetry: false });
  handleSdkSessionEvent(harness.deps, harness.context, { type: 'compaction_start', reason: 'overflow' });
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'compaction_end',
    reason: 'overflow',
    willRetry: true,
    result: {
      summary: 'Compacted context',
      firstKeptEntryId: 'kept-entry',
      tokensBefore: 99_000,
      estimatedTokensAfter: 20_000,
    },
  });

  assert.equal(harness.context.activeRequest?.id, 'request-1');
  assert.notEqual(harness.context.activeRequest?.liveTurnAccumulator, harness.accumulator);
});

test('a retryable error does not terminalize and tombstone the still-running live turn', () => {
  const harness = createHarness();

  emitAssistantError(harness, 'error-entry-1', 'Connection error.');
  assert.equal(harness.accumulator.checkpoint().terminal, undefined);
  assert.ok(harness.context.activeRequest?.pendingErrorTerminal);
  assert.equal(
    harness.emitted.some((entry) =>
      entry.event === 'live.semantic' && entry.payload?.kind === 'turn.terminal'),
    false,
  );

  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'agent_end',
    willRetry: true,
  });
  assert.equal(harness.accumulator.checkpoint().terminal, undefined);
  assert.equal(harness.context.activeRequest?.pendingErrorTerminal, undefined);

  emitAssistantError(harness, 'error-entry-final', '429 quota exceeded');
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'agent_end',
    willRetry: false,
  });

  const terminal = harness.context.terminalLiveTurn?.accumulator.checkpoint().terminal;
  assert.equal(terminal?.status, 'error');
  assert.equal(terminal?.durableEntryId, 'error-entry-final');
  assert.equal(harness.context.activeRequest, undefined);
  assert.equal(
    harness.emitted.filter((entry) =>
      entry.event === 'live.semantic' && entry.payload?.kind === 'turn.terminal').length,
    1,
  );
});
