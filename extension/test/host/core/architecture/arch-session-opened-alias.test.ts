/**
 * Regression tests for message-id aliasing across a busy `session.opened` refresh.
 *
 * Bug: when a busy `session.opened` carries the SDK-persisted form of a message
 * the host is already streaming under a host-generated id, the merge code keeps
 * the local streaming row but does not record a `messageIdAlias` for the SDK id.
 * Later backend events that reference the SDK id then either update the wrong
 * row or append a duplicate assistant panel.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';
import type { ChatMessage, SessionOpenedPayload, TranscriptWindow, SessionSummary } from '../../../../src/shared/protocol';

const sessionSummary: SessionSummary = {
  path: '/s',
  name: 'Session',
  cwd: '/workspace',
  modifiedAt: new Date().toISOString(),
  messageCount: 2,
  isPlaceholder: false,
};

const transcriptWindow: TranscriptWindow = {
  totalCount: 2,
  loadedStart: 0,
  loadedEnd: 2,
  hasOlder: false,
  hasNewer: false,
  isPartial: false,
  hasUserMessages: true,
};

function userMessage(id: string, markdown: string): ChatMessage {
  return {
    id,
    role: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown,
    status: 'completed',
  };
}

function streamingAssistant(
  id: string,
  markdown: string,
  toolCallId = 'tool-1',
): ChatMessage {
  return {
    id,
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown,
    status: 'streaming',
    parts: [
      { kind: 'text', text: markdown },
      {
        kind: 'toolCall',
        toolCall: {
          id: toolCallId,
          name: 'bash',
          input: { command: 'ls' },
          status: 'running',
        },
      },
    ],
    toolCalls: [
      {
        id: toolCallId,
        name: 'bash',
        input: { command: 'ls' },
        status: 'running',
      },
    ],
  };
}

function buildBaseState(): ArchState {
  return {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: [sessionSummary],
      openTabPaths: ['/s'],
      activeSessionPath: '/s',
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [
          userMessage('user-1', 'Hello'),
          streamingAssistant('host-1', 'Working on it'),
        ],
      },
      windowBySession: {
        '/s': { ...transcriptWindow },
      },
    },
    pending: {
      ...initialArchState.pending,
      currentTurnBySession: {
        '/s': { requestId: 'req-1', firstMessageId: 'host-1', firstMessageIndex: 1 },
      },
    },
  };
}

function sessionOpenedEvent(payload: SessionOpenedPayload): Event {
  return { kind: 'SessionOpened', sessionPath: '/s', payload };
}

test('busy session.opened records messageIdAlias when SDK message is deduped against local streaming row', () => {
  const state = buildBaseState();

  const incoming: SessionOpenedPayload = {
    session: sessionSummary,
    transcript: [
      userMessage('user-1', 'Hello'),
      {
        id: 'sdk-1',
        role: 'assistant',
        createdAt: '2026-01-01T00:00:00.000Z',
        markdown: 'Working on it',
        status: 'streaming',
        parts: [
          { kind: 'text', text: 'Working on it' },
          {
            kind: 'toolCall',
            toolCall: {
              id: 'tool-1',
              name: 'bash',
              input: { command: 'ls' },
              status: 'running',
            },
          },
        ],
        toolCalls: [
          {
            id: 'tool-1',
            name: 'bash',
            input: { command: 'ls' },
            status: 'running',
          },
        ],
      },
    ],
    transcriptWindow: { ...transcriptWindow },
    busy: true,
  };

  const result = reducer(state, sessionOpenedEvent(incoming));

  // The local streaming row with the live tool-call state wins.
  const assistantMessages = result.state.transcript.bySession['/s']!.filter((m) => m.role === 'assistant');
  assert.equal(assistantMessages.length, 1);
  assert.equal(assistantMessages[0]!.id, 'host-1');

  // Critical: the SDK id must be aliased to the local canonical id so that
  // later backend events carrying the SDK id resolve to the row we kept.
  assert.deepEqual(result.state.pending.messageIdAlias['sdk-1'], {
    canonicalId: 'host-1',
    sessionPath: '/s',
  });
});

test('aliased continuation MessageFinished accumulates usage for the live session cost', () => {
  const state = buildBaseState();
  const canonical = state.transcript.bySession['/s']![1]!;
  canonical.durableEntryId = 'durable-first';
  canonical.usage = {
    inputTokens: 10_000,
    outputTokens: 1_000,
    cacheReadTokens: 5_000,
    cacheWriteTokens: 0,
    totalTokens: 16_000,
    reportedCostUsd: 0.06,
  };
  state.pending.messageIdAlias['sdk-next'] = { canonicalId: 'host-1', sessionPath: '/s' };

  const result = reducer(state, {
    kind: 'MessageFinished',
    sessionPath: '/s',
    message: {
      id: 'sdk-next',
      role: 'assistant',
      createdAt: '2026-01-01T00:01:00.000Z',
      markdown: 'continued',
      status: 'completed',
      durableEntryId: 'durable-latest',
      usage: {
        inputTokens: 20_000,
        outputTokens: 2_000,
        cacheReadTokens: 8_000,
        cacheWriteTokens: 100,
        totalTokens: 30_100,
        reportedCostUsd: 0.09,
      },
    },
  });

  assert.equal(result.state.transcript.bySession['/s']![1]!.durableEntryId, 'durable-latest');
  assert.deepEqual(result.state.transcript.bySession['/s']![1]!.usage, {
    inputTokens: 30_000,
    outputTokens: 3_000,
    cacheReadTokens: 13_000,
    cacheWriteTokens: 100,
    totalTokens: 46_100,
    reportedCostUsd: 0.15,
  });
});

test('MessageFinished carrying deduped SDK id merges into kept local row instead of creating a duplicate', () => {
  const state = buildBaseState();

  const incoming: SessionOpenedPayload = {
    session: sessionSummary,
    transcript: [
      userMessage('user-1', 'Hello'),
      {
        id: 'sdk-1',
        role: 'assistant',
        createdAt: '2026-01-01T00:00:00.000Z',
        markdown: 'Working on it',
        status: 'streaming',
        parts: [
          { kind: 'text', text: 'Working on it' },
          {
            kind: 'toolCall',
            toolCall: {
              id: 'tool-1',
              name: 'bash',
              input: { command: 'ls' },
              status: 'running',
            },
          },
        ],
        toolCalls: [
          {
            id: 'tool-1',
            name: 'bash',
            input: { command: 'ls' },
            status: 'running',
          },
        ],
      },
    ],
    transcriptWindow: { ...transcriptWindow },
    busy: true,
  };

  let result = reducer(state, sessionOpenedEvent(incoming));

  // Simulate a backend event that still references the SDK id.
  const finishedMessage: ChatMessage = {
    id: 'sdk-1',
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: 'Done!',
    status: 'completed',
  };

  result = reducer(result.state, {
    kind: 'MessageFinished',
    sessionPath: '/s',
    message: finishedMessage,
  });

  const assistantMessages = result.state.transcript.bySession['/s']!.filter((m) => m.role === 'assistant');
  assert.equal(assistantMessages.length, 1, 'SDK MessageFinished must merge into the local row, not create a duplicate');
  assert.equal(assistantMessages[0]!.id, 'host-1');
  assert.equal(assistantMessages[0]!.status, 'completed');
});
