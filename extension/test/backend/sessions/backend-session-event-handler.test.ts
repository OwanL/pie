import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleSdkSessionEvent as handleSdkSessionEventImpl,
  summarizeToolResult,
  type BackendSessionEventHandlerDeps,
} from '../../../src/backend/session-event-handler';
import type { SdkSessionEvent } from '../../../src/backend/sdk';
import type { SessionContext } from '../../../src/backend/server-types';
import { BackendLiveTurnAccumulator } from '../../../src/backend/live-turn-accumulator';

interface EmittedEvent {
  event: string;
  payload?: unknown;
}

let durableEntryCounter = 0;

/** Existing mapper tests model the SDK's public stream. SDK 0.80.x is patched
 * in production to attach sessionEntryId after persistence; synthesize that
 * patched behavior here, including the persisted toolResult message_end. */
function handleSdkSessionEvent(
  deps: BackendSessionEventHandlerDeps,
  context: SessionContext,
  event: SdkSessionEvent,
): void {
  const patchedEvent = event.type === 'message_end'
    && (event.message?.role === 'assistant' || event.message?.role === 'toolResult')
    && !event.sessionEntryId
      ? { ...event, sessionEntryId: `durable-entry-${++durableEntryCounter}` }
      : event;
  handleSdkSessionEventImpl(deps, context, patchedEvent);
  if (event.type === 'tool_execution_end') {
    handleSdkSessionEventImpl(deps, context, {
      type: 'message_end',
      sessionEntryId: `durable-entry-${++durableEntryCounter}`,
      message: { role: 'toolResult', toolCallId: event.toolCallId ?? '' },
    });
  }
}

function createContext(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    runtime: {} as SessionContext['runtime'],
    session: {} as SessionContext['session'],
    sessionPath: '/workspace/session.jsonl',
    unsubscribe: () => undefined,
    busySeq: 0,
    ...overrides,
  };
}

function createDeps(options: { captureLive?: boolean } = {}) {
  const emitted: EmittedEvent[] = [];
  const busy: boolean[] = [];
  const sessionOpened: string[] = [];
  let listChangedCount = 0;
  let contextUsageChangedCount = 0;
  const contextUsageEstimates: Array<number | undefined> = [];

  const deps: BackendSessionEventHandlerDeps = {
    emit(event, payload) {
      if (!event.startsWith('live.') || options.captureLive) emitted.push({ event, payload });
    },
    emitBusyChanged(_context, nextBusy) {
      busy.push(nextBusy);
    },
    emitContextUsageChanged(_context, postCompactionEstimatedTokens) {
      contextUsageChangedCount += 1;
      contextUsageEstimates.push(postCompactionEstimatedTokens);
    },
    async emitSessionOpened(sessionPath) {
      sessionOpened.push(sessionPath);
    },
    async emitSessionListChanged() {
      listChangedCount += 1;
    },
    recoverStuckSession() {},
  };

  return {
    deps,
    emitted,
    busy,
    sessionOpened,
    contextUsageEstimates,
    getListChangedCount: () => listChangedCount,
    getContextUsageChangedCount: () => contextUsageChangedCount,
  };
}

test('compaction_end publishes the SDK post-compaction estimate immediately', () => {
  const { deps, contextUsageEstimates, sessionOpened } = createDeps();
  const context = createContext();

  handleSdkSessionEvent(deps, context, {
    type: 'compaction_end',
    result: {
      summary: 'Condensed history',
      firstKeptEntryId: 'kept-entry',
      tokensBefore: 100_000,
      estimatedTokensAfter: 12_345.9,
      details: {},
    },
  });

  assert.deepEqual(contextUsageEstimates, [12_345]);
  assert.deepEqual(sessionOpened, [context.sessionPath]);
});

test('handleSdkSessionEvent ignores unsupported or incomplete events', () => {
  const { deps, emitted, busy, getContextUsageChangedCount, getListChangedCount } = createDeps();
  const context = createContext();

  handleSdkSessionEvent(deps, context, { type: 'message_start', message: { role: 'assistant' } });
  handleSdkSessionEvent(deps, context, { type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta', delta: 'ignored' } });
  handleSdkSessionEvent(deps, context, { type: 'tool_execution_start' });
  handleSdkSessionEvent(deps, context, { type: 'message_end', message: { role: 'user' } });
  handleSdkSessionEvent(deps, context, { type: 'unknown-event' });

  assert.deepEqual(emitted, []);
  assert.deepEqual(busy, []);
  assert.equal(getContextUsageChangedCount(), 0);
  assert.equal(getListChangedCount(), 0);
});

test('agent_start forwards the persisted pruning result once without rescanning the branch', () => {
  const { deps, emitted } = createDeps();
  let branchReadCount = 0;
  const context = createContext({
    session: {
      sessionManager: {
        getBranch: () => {
          branchReadCount += 1;
          return [{
            id: 'prune-entry-1',
            type: 'custom_message',
            timestamp: '2026-01-01T00:00:00.000Z',
            customType: 'pruning-result',
            content: 'Kept 2/7 skills',
            display: true,
            details: { includedSkills: ['pi-logs'] },
          }];
        },
      },
    } as SessionContext['session'],
    activeRequest: { id: 'req-prune', messageIndex: 0, aborted: false },
  });

  handleSdkSessionEvent(deps, context, { type: 'agent_start' });
  handleSdkSessionEvent(deps, context, { type: 'agent_start' });
  handleSdkSessionEvent(deps, context, {
    type: 'message_end',
    message: { role: 'custom', customType: 'pruning-result', content: 'Kept 2/7 skills' } as any,
  });

  const custom = emitted.filter((entry) => entry.event === 'message.custom');
  assert.equal(custom.length, 1);
  assert.equal(branchReadCount, 1, 'a resolved pruning result must stop later O(branch) lookups');
  assert.deepEqual(custom[0]?.payload, {
    requestId: 'req-prune',
    sessionPath: '/workspace/session.jsonl',
    message: {
      id: 'prune-entry-1',
      role: 'system',
      createdAt: '2026-01-01T00:00:00.000Z',
      markdown: 'Kept 2/7 skills',
      status: 'completed',
      customType: 'pruning-result',
      customDetails: { includedSkills: ['pi-logs'] },
    },
  });
});

test('missing pruning result stops branch lookups after the first assistant message starts', () => {
  const { deps } = createDeps();
  let branchReadCount = 0;
  const context = createContext({
    session: {
      sessionManager: {
        getBranch: () => {
          branchReadCount += 1;
          return [];
        },
      },
    } as unknown as SessionContext['session'],
    activeRequest: { id: 'req-no-prune', messageIndex: 0, aborted: false },
  });

  handleSdkSessionEvent(deps, context, { type: 'agent_start' });
  handleSdkSessionEvent(deps, context, { type: 'turn_start' });
  handleSdkSessionEvent(deps, context, { type: 'message_start', message: { role: 'assistant' } });
  assert.equal(branchReadCount, 3, 'the first turn retains all timing fallbacks');

  handleSdkSessionEvent(deps, context, { type: 'turn_start' });
  handleSdkSessionEvent(deps, context, { type: 'message_start', message: { role: 'assistant' } });
  assert.equal(branchReadCount, 3, 'later turns must not rescan for a completed prepass');
});

test('message_start and message_update emit assistant events and update request state', () => {
  const { deps, emitted, getContextUsageChangedCount } = createDeps();
  const context = createContext({
    activeRequest: {
      id: 'req-1',
      messageIndex: 0,
      modelId: 'claude-test',
      provider: 'github-copilot',
      thinkingLevel: 'high',
      aborted: false,
    },
  });

  handleSdkSessionEvent(deps, context, { type: 'agent_start' });
  handleSdkSessionEvent(deps, context, { type: 'message_start', message: { role: 'assistant' } });
  handleSdkSessionEvent(deps, context, {
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
  });
  handleSdkSessionEvent(deps, context, {
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: { type: 'thinking_delta', delta: 'Reasoning' },
  });
  handleSdkSessionEvent(deps, context, {
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: { type: 'thinking_delta', delta: '' },
  });

  assert.equal(context.activeRequest?.messageIndex, 1);
  assert.equal(context.activeRequest?.currentMessageId, 'req-1:1');
  assert.equal(context.activeRequest?.lastAssistantMessageId, 'req-1:1');
  assert.equal(typeof context.activeRequest?.currentMessageStartedAt, 'number');

  assert.deepEqual(emitted.map((entry) => entry.event), [
    'message.started',
    'message.delta',
    'message.thinking',
  ]);
  assert.deepEqual(emitted[0]?.payload, {
    requestId: 'req-1',
    messageId: 'req-1:1',
    sessionPath: '/workspace/session.jsonl',
    modelId: 'claude-test',
    provider: 'github-copilot',
    thinkingLevel: 'high',
  });
  assert.deepEqual(emitted[1]?.payload, {
    requestId: 'req-1',
    sessionPath: '/workspace/session.jsonl',
    messageId: 'req-1:1',
    delta: 'Hello',
  });
  assert.deepEqual(emitted[2]?.payload, {
    requestId: 'req-1',
    sessionPath: '/workspace/session.jsonl',
    messageId: 'req-1:1',
    thinking: 'Reasoning',
  });
  // Only agent_start initializes context usage. message_start and deltas do not
  // change the latest completed assistant usage.
  assert.equal(getContextUsageChangedCount(), 1);
});

test('toolcall_start and toolcall_delta expose the live tool draft', () => {
  const { deps, emitted } = createDeps();
  const context = createContext({
    activeRequest: {
      id: 'req-tool-draft',
      messageIndex: 0,
      modelId: 'claude-test',
      thinkingLevel: 'medium',
      aborted: false,
    },
  });

  handleSdkSessionEvent(deps, context, { type: 'message_start', message: { role: 'assistant' } });
  const partial = {
    content: [{ type: 'toolCall', id: 'tool-1', name: 'bash' }],
  };
  handleSdkSessionEvent(deps, context, {
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, partial },
  });
  handleSdkSessionEvent(deps, context, {
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"command":', partial },
  });

  assert.deepEqual(emitted.slice(1), [
    {
      event: 'message.toolCallDelta',
      payload: {
        requestId: 'req-tool-draft',
        sessionPath: '/workspace/session.jsonl',
        messageId: 'req-tool-draft:1',
        toolCallId: 'tool-1',
        name: 'bash',
        delta: '',
      },
    },
    {
      event: 'message.toolCallDelta',
      payload: {
        requestId: 'req-tool-draft',
        sessionPath: '/workspace/session.jsonl',
        messageId: 'req-tool-draft:1',
        toolCallId: 'tool-1',
        name: 'bash',
        delta: '{"command":',
      },
    },
  ]);
});

test('streaming deltas and tool progress do not recompute context usage (avoids O(n) getBranch per token)', () => {
  // Regression: emitContextUsageChanged resolves the session branch
  // (sessionManager.getBranch()) to derive the context-window footprint.
  // getBranch() walks leaf→root calling Array.unshift each step, so it is
  // O(branch length) per call — and quadratic in the SDK today. Calling it
  // on every text/thinking delta (and every tool-progress event) made
  // streaming O(n²) per token: replies ground to a halt on long
  // conversations regardless of provider. The footprint only steps forward
  // when a new assistant usage lands (message_end), so deltas and tool
  // progress must NOT trigger the recomputation.
  const { deps, getContextUsageChangedCount } = createDeps();
  const context = createContext({
    activeRequest: {
      id: 'req-delta',
      messageIndex: 0,
      modelId: 'claude-test',
      thinkingLevel: 'medium',
      aborted: false,
    },
  });

  handleSdkSessionEvent(deps, context, { type: 'agent_start' });
  handleSdkSessionEvent(deps, context, { type: 'message_start', message: { role: 'assistant' } });
  const beforeDeltas = getContextUsageChangedCount(); // agent_start only

  // A burst of streaming deltas must not add any context-usage recomputation.
  for (let i = 0; i < 50; i++) {
    handleSdkSessionEvent(deps, context, {
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: { type: 'text_delta', delta: `token${i} ` },
    });
  }
  assert.equal(getContextUsageChangedCount(), beforeDeltas, 'deltas must not recompute context usage');

  // Streaming tool-progress events must not recompute context usage either
  // (tool_execution_update can fire repeatedly for streaming-output tools).
  for (let i = 0; i < 20; i++) {
    handleSdkSessionEvent(deps, context, {
      type: 'tool_execution_update',
      toolCallId: 'tool-1',
      partialResult: `chunk ${i}`,
    });
  }
  assert.equal(getContextUsageChangedCount(), beforeDeltas, 'tool progress must not recompute context usage');

  // message_end is where usage actually lands → recomputation is expected there.
  handleSdkSessionEvent(deps, context, {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    },
  } as SdkSessionEvent);
  assert.ok(getContextUsageChangedCount() > beforeDeltas, 'message_end recomputes context usage');
});

test('failed tool summaries include a bounded sanitized reason and result shape', () => {
  const summary = summarizeToolResult({
    content: [{ type: 'text', text: 'spawn failed: api_key=super-secret\nCommand exited with code 2' }],
    details: { exitCode: 2 },
  });
  assert.deepEqual(summary, {
    resultType: 'object',
    resultLen: 126,
    resultKeys: ['content', 'details'],
    errorSummary: 'spawn failed: api_key=[redacted] Command exited with code 2',
  });
});

test('tool execution events emit progress only when an active assistant message exists', () => {
  const { deps, emitted, getContextUsageChangedCount } = createDeps();
  const context = createContext({
    activeRequest: {
      id: 'req-2',
      messageIndex: 1,
      lastAssistantMessageId: 'req-2:1',
      aborted: false,
    },
  });

  handleSdkSessionEvent(deps, context, {
    type: 'tool_execution_start',
    toolCallId: 'tool-1',
    toolName: 'bash',
    args: { command: 'npm test' },
  });
  handleSdkSessionEvent(deps, context, {
    type: 'tool_execution_update',
    toolCallId: 'tool-1',
    partialResult: 'still running',
  });
  handleSdkSessionEvent(deps, context, {
    type: 'tool_execution_end',
    toolCallId: 'tool-1',
    result: { ok: true },
    isError: true,
  });

  assert.deepEqual(emitted.map((entry) => entry.event), [
    'tool.started',
    'tool.progress',
    'tool.finished',
  ]);
  assert.deepEqual(emitted[0]?.payload, {
    requestId: 'req-2',
    sessionPath: '/workspace/session.jsonl',
    messageId: 'req-2:1',
    toolCallId: 'tool-1',
    name: 'bash',
    input: { command: 'npm test' },
    startedAt: (emitted[0]?.payload as { startedAt: number }).startedAt,
    parallelGroupId: (emitted[0]?.payload as { parallelGroupId: string }).parallelGroupId,
  });
  assert.equal(typeof (emitted[0]?.payload as { startedAt: number }).startedAt, 'number');
  assert.equal(typeof (emitted[0]?.payload as { parallelGroupId: string }).parallelGroupId, 'string');
  assert.deepEqual(emitted[1]?.payload, {
    requestId: 'req-2',
    sessionPath: '/workspace/session.jsonl',
    messageId: 'req-2:1',
    toolCallId: 'tool-1',
    preview: { kind: 'generic', summary: 'still running' },
  });
  assert.deepEqual(emitted[2]?.payload, {
    requestId: 'req-2',
    sessionPath: '/workspace/session.jsonl',
    messageId: 'req-2:1',
    toolCallId: 'tool-1',
    name: 'bash',
    input: { command: 'npm test' },
    result: { ok: true },
    status: 'failed',
    startedAt: (emitted[2]?.payload as { startedAt: number }).startedAt,
    durationMs: (emitted[2]?.payload as { durationMs: number }).durationMs,
    durableEntryId: (emitted[2]?.payload as { durableEntryId: string }).durableEntryId,
  });
  assert.equal(typeof (emitted[2]?.payload as { durationMs: number }).durationMs, 'number');
  // Context usage is the latest assistant prompt footprint. Tool boundaries do
  // not change it, so they must not resolve the full SDK branch.
  assert.equal(getContextUsageChangedCount(), 0);
});

test('tool terminal publication waits for the persisted toolResult entry id', () => {
  const { deps, emitted } = createDeps();
  const context = createContext({
    activeRequest: {
      id: 'req-durable-tool',
      messageIndex: 1,
      lastAssistantMessageId: 'req-durable-tool:1',
      aborted: false,
    },
  });

  handleSdkSessionEventImpl(deps, context, {
    type: 'tool_execution_end',
    toolCallId: 'tool-durable',
    result: { ok: true },
    isError: false,
  });
  assert.equal(emitted.some((entry) => entry.event === 'tool.finished'), false);

  handleSdkSessionEventImpl(deps, context, {
    type: 'message_end',
    message: { role: 'toolResult', toolCallId: 'tool-durable' },
  });
  assert.equal(emitted.some((entry) => entry.event === 'tool.finished'), false);

  handleSdkSessionEventImpl(deps, context, {
    type: 'message_end',
    sessionEntryId: 'entry-tool-durable',
    message: { role: 'toolResult', toolCallId: 'tool-durable' },
  });
  const terminal = emitted.find((entry) => entry.event === 'tool.finished')?.payload as { durableEntryId?: string };
  assert.equal(terminal.durableEntryId, 'entry-tool-durable');
});

test('message_end emits finished and aborted payloads and clears the current message id', () => {
  const { deps, emitted, getContextUsageChangedCount } = createDeps();
  const originalNow = Date.now;
  Date.now = () => Date.UTC(2026, 0, 1, 0, 0, 5);
  try {
    const context = createContext({
      activeRequest: {
        id: 'req-3',
        messageIndex: 1,
        modelId: 'claude-test',
        thinkingLevel: 'medium',
        currentMessageId: 'req-3:1',
        currentMessageStartedAt: Date.UTC(2026, 0, 1, 0, 0, 2),
        aborted: false,
      },
    });

    const messageEndEvent: SdkSessionEvent = {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Trace' },
          { type: 'text', text: 'Done' },
        ],
        stopReason: 'aborted',
        usage: { input: 2, output: 3, cacheRead: 1, cacheWrite: 0 },
      },
    };

    handleSdkSessionEvent(deps, context, messageEndEvent);

    assert.equal(context.activeRequest?.currentMessageId, undefined);
    assert.equal(context.activeRequest?.lastAssistantMessageId, 'req-3:1');
    assert.equal(context.activeRequest?.currentMessageStartedAt, undefined);
    assert.deepEqual(emitted.map((entry) => entry.event), ['message.finished', 'message.aborted']);

    const finished = emitted[0]?.payload as { message: { id: string; markdown: string; status: string; durationMs?: number; usage?: { totalTokens: number } } };
    assert.equal(finished.message.id, 'req-3:1');
    assert.equal(finished.message.markdown, 'Done');
    assert.equal(finished.message.status, 'interrupted');
    assert.equal(finished.message.durationMs, 3000);
    assert.equal(finished.message.usage?.totalTokens, 6);

    assert.deepEqual(emitted[1]?.payload, {
      requestId: 'req-3',
      sessionPath: '/workspace/session.jsonl',
      messageId: 'req-3:1',
      userInitiated: false,
      reason: 'The session stopped unexpectedly before the assistant finished responding.',
    });
    assert.equal(getContextUsageChangedCount(), 1);
  } finally {
    Date.now = originalNow;
  }
});

test('message_end marks user-initiated interruptions without surfacing an unexpected-stop reason', () => {
  const { deps, emitted } = createDeps();
  const context = createContext({
    activeRequest: {
      id: 'req-user-stop',
      messageIndex: 1,
      currentMessageId: 'req-user-stop:1',
      aborted: true,
    },
  });

  handleSdkSessionEvent(deps, context, {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Stopped' }],
      stopReason: 'aborted',
    },
  });

  assert.deepEqual(emitted[1], {
    event: 'message.aborted',
    payload: {
      requestId: 'req-user-stop',
      sessionPath: '/workspace/session.jsonl',
      messageId: 'req-user-stop:1',
      userInitiated: true,
      reason: undefined,
    },
  });
});

test('message_end emits custom transcript messages for displayed extension output', () => {
  const { deps, emitted, getContextUsageChangedCount } = createDeps();
  const context = createContext({
    activeRequest: {
      id: 'req-custom',
      messageIndex: 0,
      aborted: false,
    },
  });

  handleSdkSessionEvent(deps, context, {
    type: 'message_end',
    message: {
      role: 'custom',
      customType: 'pruning-result',
      content: 'Kept 4/14 skills, Kept 8/13 tools · Saved 1815 tokens',
      details: {
        includedSkills: ['systematic-debugging'],
        excludedSkills: ['frontend-design'],
        includedTools: ['read'],
        excludedTools: ['web_search'],
        mode: 'auto',
        skillTokensSaved: 100,
        toolTokensSaved: 50,
      },
      timestamp: Date.UTC(2026, 0, 1, 0, 0, 1),
    },
  } as SdkSessionEvent);

  assert.deepEqual(emitted, [{
    event: 'message.custom',
    payload: {
      requestId: 'req-custom',
      sessionPath: '/workspace/session.jsonl',
      message: {
        id: 'req-custom:custom:1',
        role: 'system',
        createdAt: '2026-01-01T00:00:01.000Z',
        markdown: 'Kept 4/14 skills, Kept 8/13 tools · Saved 1815 tokens',
        status: 'completed',
        customType: 'pruning-result',
        customDetails: {
          includedSkills: ['systematic-debugging'],
          excludedSkills: ['frontend-design'],
          includedTools: ['read'],
          excludedTools: ['web_search'],
          mode: 'auto',
          skillTokensSaved: 100,
          toolTokensSaved: 50,
        },
      },
    },
  }]);
  assert.equal(context.activeRequest?.customMessageIndex, 1);
  assert.equal(context.activeRequest?.currentMessageId, undefined);
  assert.equal(context.activeRequest?.lastAssistantMessageId, undefined);
  assert.equal(getContextUsageChangedCount(), 0);
});

test('agent_end emits busy false, refreshes session state, and aborts requests with no message id', async () => {
  const { deps, emitted, busy, sessionOpened, getListChangedCount, getContextUsageChangedCount } = createDeps();
  const context = createContext({
    activeRequest: {
      id: 'req-4',
      messageIndex: 0,
      aborted: true,
    },
  });

  handleSdkSessionEvent(deps, context, { type: 'agent_end' });

  assert.deepEqual(busy, [false]);
  assert.equal(getContextUsageChangedCount(), 1);
  assert.deepEqual(sessionOpened, ['/workspace/session.jsonl']);
  assert.equal(getListChangedCount(), 1);
  assert.deepEqual(emitted, [{
    event: 'message.aborted',
    payload: {
      requestId: 'req-4',
      sessionPath: '/workspace/session.jsonl',
      userInitiated: true,
      reason: undefined,
    },
  }]);
  assert.equal(context.activeRequest, undefined);
});

test('agent_end with willRetry=true is a no-op (mid-retry: preserve activeRequest, busy, no abort)', () => {
  const { deps, emitted, busy, sessionOpened, getListChangedCount, getContextUsageChangedCount } = createDeps();
  const activeRequest = { id: 'req-retry', messageIndex: 1, aborted: false, lastAssistantMessageId: 'req-retry:1' };
  const context = createContext({ activeRequest });

  handleSdkSessionEvent(deps, context, { type: 'agent_end', willRetry: true });

  try {
    // Mid-retry agent_end must NOT finalize: activeRequest is preserved so the
    // retry turn can stream (message_start/message_end are gated on it), busy
    // stays true (no flicker, no premature session_finished trigger), and no
    // session.opened / message.aborted is emitted.
    assert.equal(context.activeRequest, activeRequest);
    assert.deepEqual(busy, []);
    assert.deepEqual(sessionOpened, []);
    assert.equal(getListChangedCount(), 0);
    assert.equal(getContextUsageChangedCount(), 0);
    assert.deepEqual(emitted, []);
  } finally {
    context.willRetryWatchdogClear?.();
  }
});

test('willRetry watchdog emits operational-error + retry.stuck when a retry backoff never completes', async () => {
  // The willRetry watchdog (armed on agent_end willRetry:true / re-armed on
  // auto_retry_start) emits BOTH an operational-error (code RETRY_STUCK,
  // user-facing message) and a retry.stuck (structured timing detail) when a
  // retry's backoff does not complete within delayMs + grace. These were
  // previously SILENTLY DROPPED by the host (no dispatch case); this test
  // pins the backend emission contract so the host wiring (event-dispatch +
  // handlers) has a signal to surface. Grace is pinned to 0 via env so the
  // watchdog fires promptly without a real wall-clock wait.
  const prevGrace = process.env.PIE_WILLRETRY_WATCHDOG_GRACE_MS;
  process.env.PIE_WILLRETRY_WATCHDOG_GRACE_MS = '0';
  try {
    const { deps, emitted } = createDeps();
    const context = createContext({
      activeRequest: { id: 'req-stuck', messageIndex: 1, aborted: false, lastAssistantMessageId: 'req-stuck:1' },
    });

    // agent_end willRetry:true arms the watchdog with delayMs=0; grace=0 →
    // windowMs=0 → the timer fires on the next macrotask.
    handleSdkSessionEvent(deps, context, { type: 'agent_end', willRetry: true });

    // Let the 0ms watchdog timer fire.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const opError = emitted.find((e) => e.event === 'operational-error');
    const retryStuck = emitted.find((e) => e.event === 'retry.stuck');
    assert.ok(opError, 'emits operational-error');
    assert.deepEqual(opError?.payload, {
      code: 'RETRY_STUCK',
      message: (opError?.payload as { message: string }).message,
      sessionPath: '/workspace/session.jsonl',
      requestId: 'req-stuck',
    });
    assert.match((opError?.payload as { message: string }).message, /retry has not completed/i);
    assert.ok(retryStuck, 'emits retry.stuck');
    assert.deepEqual(retryStuck?.payload, {
      sessionPath: '/workspace/session.jsonl',
      delayMs: 0,
      graceMs: 0,
      requestId: 'req-stuck',
    });
    // The watchdog cleared its timer handle after firing.
    assert.equal(context.willRetryWatchdogTimer, undefined);
  } finally {
    if (prevGrace === undefined) {
      delete process.env.PIE_WILLRETRY_WATCHDOG_GRACE_MS;
    } else {
      process.env.PIE_WILLRETRY_WATCHDOG_GRACE_MS = prevGrace;
    }
    // Defensive: clear any lingering watchdog timer so the test never leaks.
    // (No-op once the timer has fired.)
  }
});

test('auto_retry_start emits retry.started with attempt/delay/error', () => {
  const { deps, emitted } = createDeps();
  const context = createContext();

  handleSdkSessionEvent(deps, context, {
    type: 'auto_retry_start',
    attempt: 2,
    maxAttempts: 3,
    delayMs: 4000,
    errorMessage: '429 Too Many Requests',
  });

  assert.deepEqual(emitted, [{
    event: 'retry.started',
    payload: {
      sessionPath: '/workspace/session.jsonl',
      attempt: 2,
      maxAttempts: 3,
      delayMs: 4000,
      errorMessage: '429 Too Many Requests',
    },
  }]);
});

test('retry timing correlates scheduled delay with measured provider delay and duration', () => {
  const { deps, emitted } = createDeps();
  const context = createContext({
    activeRequest: { id: 'req-retry', messageIndex: 1, aborted: false },
  });

  handleSdkSessionEvent(deps, context, {
    type: 'auto_retry_start',
    attempt: 2,
    maxAttempts: 3,
    delayMs: 4_000,
    errorMessage: '429',
  });
  const started = context.activeRequest?.retryTiming?.startedAt;
  assert.equal(typeof started, 'number');
  context.activeRequest!.retryTiming!.providerAttemptStartedAt = started!;
  handleSdkSessionEvent(deps, context, {
    type: 'auto_retry_end', success: true, attempt: 2,
  });

  assert.equal((emitted[0]?.payload as any).retryId, 'req-retry:2');
  assert.equal((emitted[0]?.payload as any).delayMs, 4_000);
  assert.deepEqual(emitted.map((entry) => entry.event), [
    'retry.started', 'retry.measured', 'retry.ended',
  ]);
  assert.equal((emitted[1]?.payload as any).retryId, 'req-retry:2');
  assert.equal((emitted[1]?.payload as any).measuredDelayMs, 0);
  assert.equal(typeof (emitted[1]?.payload as any).durationMs, 'number');
});

test('auto_retry_end emits retry.ended with success/finalError', () => {
  const { deps, emitted } = createDeps();
  const context = createContext();

  handleSdkSessionEvent(deps, context, {
    type: 'auto_retry_end',
    success: false,
    attempt: 3,
    finalError: 'Retry cancelled',
  });

  assert.deepEqual(emitted, [{
    event: 'retry.ended',
    payload: {
      sessionPath: '/workspace/session.jsonl',
      success: false,
      attempt: 3,
      finalError: 'Retry cancelled',
    },
  }]);
});

test('message_end enriches generic stream-end error with the latest upstream retry error', () => {
  const { deps, emitted } = createDeps();
  const context = createContext({
    activeRequest: {
      id: 'req-stream-err',
      messageIndex: 1,
      currentMessageId: 'req-stream-err:1',
      aborted: false,
    },
  });

  handleSdkSessionEvent(deps, context, {
    type: 'auto_retry_start',
    attempt: 2,
    maxAttempts: 3,
    delayMs: 500,
    errorMessage: '429 Too Many Requests: account_suspended (cap_abuse)',
  });

  handleSdkSessionEvent(deps, context, {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'Stream ended without finish_reason',
    },
  } as SdkSessionEvent);

  const finished = emitted.find((entry) => entry.event === 'message.finished')?.payload as {
    message: { status: string; errorDetail?: string };
  };

  assert.equal(finished.message.status, 'error');
  assert.ok(
    finished.message.errorDetail?.includes('Stream ended without finish_reason'),
    'keeps the original stream-end symptom',
  );
  assert.ok(
    finished.message.errorDetail?.includes('429 Too Many Requests: account_suspended (cap_abuse)'),
    'surfaces upstream retry/provider root cause',
  );
});

test('agent_end reports unexpected interruptions when the run ends without any assistant message', () => {
  const { deps, emitted } = createDeps();
  const context = createContext({
    activeRequest: {
      id: 'req-no-message',
      messageIndex: 0,
      aborted: false,
    },
  });

  handleSdkSessionEvent(deps, context, { type: 'agent_end' });

  assert.deepEqual(emitted, [{
    event: 'message.aborted',
    payload: {
      requestId: 'req-no-message',
      sessionPath: '/workspace/session.jsonl',
      userInitiated: false,
      reason: 'The session stopped unexpectedly before the assistant finished responding.',
    },
  }]);
});

test('message_end falls back to the last or inferred message id and agent_end skips duplicate abort events', () => {
  const { deps, emitted } = createDeps();
  const context = createContext({
    activeRequest: {
      id: 'req-5',
      messageIndex: 2,
      lastAssistantMessageId: 'req-5:2',
      aborted: true,
    },
  });

  handleSdkSessionEvent(deps, context, {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'errored' }],
      stopReason: 'error',
    },
  });

  const finished = emitted[0]?.payload as { message: { id: string; status: string } };
  assert.equal(finished.message.id, 'req-5:2');
  assert.equal(finished.message.status, 'error');
  assert.equal(emitted.find((entry) => entry.event === 'message.aborted'), undefined);

  handleSdkSessionEvent(deps, context, { type: 'agent_end' });
  assert.equal(emitted.filter((entry) => entry.event === 'message.aborted').length, 0);
  assert.equal(context.activeRequest, undefined);

  const inferredContext = createContext({
    activeRequest: {
      id: 'req-6',
      messageIndex: 0,
      aborted: false,
    },
  });
  const secondDeps = createDeps();
  handleSdkSessionEvent(secondDeps.deps, inferredContext, {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'fresh reply' }],
    },
  });
  const inferred = secondDeps.emitted[0]?.payload as { message: { id: string } };
  assert.equal(inferred.message.id, 'req-6:1');
});

test('assistant message events ignore non-assistant roles and incomplete streaming state', () => {
  const { deps, emitted, getContextUsageChangedCount } = createDeps();
  const context = createContext({
    activeRequest: {
      id: 'req-5',
      messageIndex: 2,
      aborted: false,
    },
  });

  handleSdkSessionEvent(deps, context, { type: 'message_start', message: { role: 'user' } as any });
  handleSdkSessionEvent(deps, context, {
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: { type: 'text_delta', delta: 'ignored' },
  });
  handleSdkSessionEvent(deps, context, { type: 'message_end', message: { role: 'user' } as any });
  handleSdkSessionEvent(deps, context, { type: 'tool_execution_update', toolCallId: 'tool-1', partialResult: 'ignored' });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'message.queuedDelivered');
  assert.equal(getContextUsageChangedCount(), 0);
  assert.equal(context.activeRequest?.currentMessageId, undefined);
});

test('message_update emits thinking content from the explicit thinking field and skips empty tool execution state', () => {
  const { deps, emitted, getContextUsageChangedCount } = createDeps();
  const context = createContext({
    activeRequest: {
      id: 'req-6',
      messageIndex: 1,
      currentMessageId: 'req-6:1',
      lastAssistantMessageId: 'req-6:1',
      aborted: false,
    },
  });

  handleSdkSessionEvent(deps, context, {
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: { type: 'thinking_delta', thinking: 'full reasoning', delta: '' },
  });
  handleSdkSessionEvent(deps, createContext({
    activeRequest: {
      id: 'req-6b',
      messageIndex: 1,
      aborted: false,
    },
  }), {
    type: 'tool_execution_start',
    toolName: 'bash',
  });

  assert.deepEqual(emitted, [{
    event: 'message.thinking',
    payload: {
      requestId: 'req-6',
      sessionPath: '/workspace/session.jsonl',
      messageId: 'req-6:1',
      thinking: 'full reasoning',
    },
  }]);
  // message_update no longer recomputes context usage; the tool_execution_start
  // below targets a request with no lastAssistantMessageId, so it early-returns.
  assert.equal(getContextUsageChangedCount(), 0);
});

test('tool execution and message end events cover completed payloads and fallback message ids', () => {
  const { deps, emitted, getContextUsageChangedCount } = createDeps();
  const toolContext = createContext({
    activeRequest: {
      id: 'req-7',
      messageIndex: 3,
      lastAssistantMessageId: 'req-7:3',
      aborted: false,
    },
  });

  handleSdkSessionEvent(deps, toolContext, {
    type: 'tool_execution_end',
    toolCallId: undefined,
    result: { ok: true },
    isError: false,
  });

  const lastIdContext = createContext({
    activeRequest: {
      id: 'req-7b',
      messageIndex: 2,
      lastAssistantMessageId: 'req-7b:last',
      modelId: 'claude-test',
      aborted: false,
    },
  });
  handleSdkSessionEvent(deps, lastIdContext, {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Finished from last id' }],
      stopReason: 'end_turn',
    },
  } as any);

  const generatedIdContext = createContext({
    activeRequest: {
      id: 'req-7c',
      messageIndex: 4,
      modelId: 'claude-test',
      aborted: false,
    },
  });
  handleSdkSessionEvent(deps, generatedIdContext, {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Finished from generated id' }],
      stopReason: 'end_turn',
    },
  } as any);

  assert.deepEqual(emitted.map((entry) => entry.event), [
    'message.finished',
    'message.finished',
  ]);
  assert.equal((emitted[0]?.payload as any).message.id, 'req-7b:last');
  assert.equal((emitted[0]?.payload as any).message.status, 'completed');
  assert.equal((emitted[1]?.payload as any).message.id, 'req-7c:5');
  assert.equal((emitted[1]?.payload as any).message.durationMs, undefined);
  assert.equal(getContextUsageChangedCount(), 2);
});

test('sequenced production path emits only typed live envelopes with a durable terminal', () => {
  const { deps, emitted } = createDeps({ captureLive: true });
  const accumulator = new BackendLiveTurnAccumulator({
    protocolVersion: 5,
    sessionPath: '/workspace/session.jsonl',
    requestId: 'req-live',
    turnId: 'turn-live',
    attemptId: 'attempt-live',
    canonicalMessageId: 'req-live:1',
    startedAt: 100,
  });
  const context = createContext({
    session: {
      sessionManager: {
        getBranch: () => [{
          id: 'entry-assistant', type: 'message', timestamp: '2026-01-01T00:00:00.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }], stopReason: 'end_turn' },
        }],
      },
    } as unknown as SessionContext['session'],
    activeRequest: {
      id: 'req-live', messageIndex: 0, aborted: false,
      turnBoundaryAt: Date.now() - 20,
      liveTurnAccumulator: accumulator,
    },
  });

  handleSdkSessionEvent(deps, context, { type: 'turn_start' });
  handleSdkSessionEvent(deps, context, { type: 'message_start', message: { role: 'assistant' } });
  handleSdkSessionEvent(deps, context, {
    type: 'message_update', message: { role: 'assistant' },
    assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
  });
  handleSdkSessionEvent(deps, context, {
    type: 'message_end', sessionEntryId: 'entry-assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }], stopReason: 'end_turn' },
  } as any);

  assert.equal(emitted.some((entry) => entry.event.startsWith('message.')), false);
  const envelopes = emitted.filter((entry) => entry.event === 'live.semantic').map((entry) => entry.payload as any);
  assert.deepEqual(envelopes.map((entry) => [entry.seq, entry.kind]), [
    [1, 'turn.started'], [2, 'turn.phase'], [3, 'turn.phase'], [4, 'turn.text'], [5, 'turn.terminal'],
  ]);
  assert.equal(envelopes.at(-1)?.durableEntryId, 'entry-assistant');
  assert.equal(envelopes.at(-1)?.durableMessage.durableEntryId, 'entry-assistant');
  assert.equal(typeof envelopes.at(-1)?.durableMessage.turnLatencyMs, 'number');
  assert.equal(typeof envelopes.at(-1)?.durableMessage.overheadMs, 'number');
  assert.equal(typeof envelopes.at(-1)?.durableMessage.providerLatencyMs, 'number');
});

test('concurrent semantic tool starts carry one stable parallel group into live records', () => {
  const { deps, emitted } = createDeps({ captureLive: true });
  const accumulator = new BackendLiveTurnAccumulator({
    protocolVersion: 5, sessionPath: '/workspace/session.jsonl', requestId: 'req-parallel',
    turnId: 'turn-parallel', attemptId: 'attempt-parallel', canonicalMessageId: 'req-parallel:1', startedAt: 100,
  });
  const context = createContext({
    activeRequest: {
      id: 'req-parallel', messageIndex: 1, lastAssistantMessageId: 'req-parallel:1',
      aborted: false, liveTurnAccumulator: accumulator,
    },
  });
  handleSdkSessionEvent(deps, context, { type: 'message_start', message: { role: 'assistant' } });
  handleSdkSessionEvent(deps, context, {
    type: 'tool_execution_start', toolCallId: 'tool-a', toolName: 'read', args: {},
  });
  handleSdkSessionEvent(deps, context, {
    type: 'tool_execution_start', toolCallId: 'tool-b', toolName: 'read', args: {},
  });
  const starts = emitted
    .filter((entry) => entry.event === 'live.semantic' && (entry.payload as any).kind === 'tool.started')
    .map((entry) => entry.payload as any);
  assert.equal(starts.length, 2);
  assert.equal(typeof starts[0]?.parallelGroupId, 'string');
  assert.equal(starts[1]?.parallelGroupId, starts[0]?.parallelGroupId);
  assert.equal(accumulator.checkpoint().tools[0]?.parallelGroupId, starts[0]?.parallelGroupId);
  assert.equal(accumulator.checkpoint().tools[1]?.parallelGroupId, starts[0]?.parallelGroupId);
});

test('pre-first-semantic inactivity retires and replaces a runtime even when abort never settles', async () => {
  const previous = process.env.PIE_PROVIDER_SEMANTIC_INACTIVITY_MS;
  process.env.PIE_PROVIDER_SEMANTIC_INACTIVITY_MS = '5';
  try {
    const { deps, emitted, busy } = createDeps();
    let abortCalls = 0;
    const recoveries: Array<{ context: SessionContext; reason: string }> = [];
    deps.recoverStuckSession = (context, reason) => {
      recoveries.push({ context, reason });
    };
    const context = createContext({
      session: {
        isStreaming: true,
        sessionManager: { getBranch: () => [] },
        clearQueue: () => undefined,
        abortRetry: () => undefined,
        abort: () => {
          abortCalls += 1;
          return new Promise<void>(() => undefined);
        },
      } as unknown as SessionContext['session'],
      activeRequest: {
        id: 'req-semantic-timeout', messageIndex: 0, aborted: false,
        liveTurnAccumulator: new BackendLiveTurnAccumulator({
          protocolVersion: 5, sessionPath: '/workspace/session.jsonl', requestId: 'req-semantic-timeout',
          turnId: 'turn-timeout', attemptId: 'attempt-timeout', canonicalMessageId: 'req-semantic-timeout:1', startedAt: Date.now(),
        }),
      },
    });
    handleSdkSessionEvent(deps, context, { type: 'message_start', message: { role: 'assistant' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(recoveries.length, 1);
    assert.equal(recoveries[0]?.context, context);
    assert.match(recoveries[0]?.reason ?? '', /provider stopped producing semantic response events/i);
    assert.equal(abortCalls, 0, 'the shared recovery owner must own remote teardown');
    assert.deepEqual(busy, [], 'the old runtime must not be advertised idle before replacement');
    assert.equal(emitted.some((entry) => entry.event === 'message.aborted'), false, 'the shared recovery owner emits the terminal exactly once');
  } finally {
    if (previous === undefined) delete process.env.PIE_PROVIDER_SEMANTIC_INACTIVITY_MS;
    else process.env.PIE_PROVIDER_SEMANTIC_INACTIVITY_MS = previous;
  }
});

test('agent_end does not emit an extra aborted event when the request already has an assistant message', () => {
  const { deps, emitted, busy, sessionOpened, getListChangedCount, getContextUsageChangedCount } = createDeps();
  const context = createContext({
    activeRequest: {
      id: 'req-8',
      messageIndex: 1,
      lastAssistantMessageId: 'req-8:1',
      aborted: true,
    },
  });

  handleSdkSessionEvent(deps, context, { type: 'agent_end' });

  assert.deepEqual(busy, [false]);
  assert.equal(getContextUsageChangedCount(), 1);
  assert.deepEqual(sessionOpened, ['/workspace/session.jsonl']);
  assert.equal(getListChangedCount(), 1);
  assert.deepEqual(emitted, []);
  assert.equal(context.activeRequest, undefined);
});

test('turn latency is measured from the turn boundary, turn_start, and first content delta', () => {
  const { deps, emitted } = createDeps();
  const originalNow = Date.now;
  let t = 1_000;
  Date.now = () => t;
  try {
    const context = createContext({
      activeRequest: {
        id: 'req-lat',
        messageIndex: 0,
        modelId: 'claude-test',
        thinkingLevel: 'medium',
        // Prompt-send opened the latency window at t=1000.
        turnBoundaryAt: 1000,
        aborted: false,
      },
    });

    // turn_start at t=1100 — start of the provider request side.
    t = 1100;
    handleSdkSessionEvent(deps, context, { type: 'turn_start' });
    assert.equal(context.activeRequest?.turnStartedAt, 1100);

    // message_start at t=1150 — resets the per-message first-delta marker.
    t = 1150;
    handleSdkSessionEvent(deps, context, { type: 'message_start', message: { role: 'assistant' } });
    assert.equal(context.activeRequest?.providerFirstDeltaAt, undefined);

    // First content delta at t=1800 — the provider has begun replying.
    t = 1800;
    handleSdkSessionEvent(deps, context, {
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
    });
    assert.equal(context.activeRequest?.providerFirstDeltaAt, 1800);

    // A subsequent delta must not move the first-content timestamp.
    t = 1850;
    handleSdkSessionEvent(deps, context, {
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: { type: 'text_delta', delta: ' world' },
    });
    assert.equal(context.activeRequest?.providerFirstDeltaAt, 1800);

    // message_end at t=2000 — latency breakdown attached to the message.
    t = 2000;
    handleSdkSessionEvent(deps, context, {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }], stopReason: 'end_turn' },
    } as SdkSessionEvent);

    const finished = emitted.find((entry) => entry.event === 'message.finished')?.payload as {
      message: { turnLatencyMs?: number; overheadMs?: number; providerLatencyMs?: number };
    };
    assert.equal(finished.message.turnLatencyMs, 800, 'total = first delta - turn boundary');
    assert.equal(finished.message.overheadMs, 100, 'overhead = turn_start - turn boundary');
    assert.equal(finished.message.providerLatencyMs, 700, 'provider = first delta - turn_start');
  } finally {
    Date.now = originalNow;
  }
});

test('message_end aggregates correlated queue timing across folded provider turns', () => {
  const { deps, emitted } = createDeps();
  const context = createContext({
    activeRequest: {
      id: 'req-queue',
      messageIndex: 1,
      currentMessageId: 'req-queue:1',
      lastAssistantMessageId: 'req-queue:1',
      providerTurnSequence: 3,
      providerQueueByTurn: new Map([
        [1, { durationMs: 25, attemptCount: 1 }],
        [3, { durationMs: 0, attemptCount: 1 }],
      ]),
      aborted: false,
    },
  });
  handleSdkSessionEvent(deps, context, {
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
  } as any);

  const message = (emitted.find((entry) => entry.event === 'message.finished')?.payload as any).message;
  assert.equal(message.providerQueueMs, 25);
  assert.equal(message.providerQueueAttemptCount, 2);
  assert.equal(context.activeRequest?.providerQueueByTurn?.size, 0, 'emitted observations are consumed');
});

test('tool_execution_end advances the turn boundary and message_start resets the first-delta marker', () => {
  const { deps } = createDeps();
  const originalNow = Date.now;
  let t = 5_000;
  Date.now = () => t;
  try {
    const context = createContext({
      activeRequest: {
        id: 'req-multi',
        messageIndex: 0,
        lastAssistantMessageId: 'req-multi:0',
        aborted: false,
      },
    });

    // A prior turn left a first-delta timestamp behind; a new message_start must clear it.
    context.activeRequest!.providerFirstDeltaAt = 4_900;
    handleSdkSessionEvent(deps, context, { type: 'message_start', message: { role: 'assistant' } });
    assert.equal(context.activeRequest?.providerFirstDeltaAt, undefined, 'message_start resets the first-delta marker');

    t = 5_100;
    handleSdkSessionEvent(deps, context, {
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: { type: 'thinking_delta', thinking: 'reasoning' },
    });
    assert.equal(context.activeRequest?.providerFirstDeltaAt, 5_100, 'thinking_delta stamps the first-content marker');

    // tool_execution_end advances the latency window origin to "now" (last tool wins).
    t = 6_000;
    handleSdkSessionEvent(deps, context, {
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      result: { ok: true },
      isError: false,
    });
    assert.equal(context.activeRequest?.turnBoundaryAt, 6_000, 'tool_execution_end advances the turn boundary');

    // A parallel/second tool end overwrites (most recent wins).
    t = 6_050;
    handleSdkSessionEvent(deps, context, {
      type: 'tool_execution_end',
      toolCallId: 'tool-2',
      result: { ok: true },
      isError: false,
    });
    assert.equal(context.activeRequest?.turnBoundaryAt, 6_050);
  } finally {
    Date.now = originalNow;
  }
});

test('turn_start and toolless turns leave latency undefined when an anchoring event is missing', () => {
  const { deps, emitted } = createDeps();
  const originalNow = Date.now;
  let t = 9_000;
  Date.now = () => t;
  try {
    const context = createContext({
      activeRequest: {
        id: 'req-noboundary',
        messageIndex: 0,
        modelId: 'claude-test',
        aborted: false,
      },
    });

    // No turn_start observed and no turn boundary set.
    t = 9_100;
    handleSdkSessionEvent(deps, context, { type: 'message_start', message: { role: 'assistant' } });
    t = 9_200;
    handleSdkSessionEvent(deps, context, {
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: { type: 'text_delta', delta: 'hi' },
    });
    t = 9_300;
    handleSdkSessionEvent(deps, context, {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], stopReason: 'end_turn' },
    } as SdkSessionEvent);

    const finished = emitted.find((entry) => entry.event === 'message.finished')?.payload as {
      message: { turnLatencyMs?: number; overheadMs?: number; providerLatencyMs?: number };
    };
    assert.equal(finished.message.turnLatencyMs, undefined);
    assert.equal(finished.message.overheadMs, undefined);
    assert.equal(finished.message.providerLatencyMs, undefined);
  } finally {
    Date.now = originalNow;
  }
});
