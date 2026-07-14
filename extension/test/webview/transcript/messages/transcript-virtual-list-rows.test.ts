import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTranscriptRows, estimateTranscriptRowSize } from '../../../../src/webview/panel/transcript/virtual-list-rows';
import { deriveTurnActivityState, type TurnActivityState } from '../../../../src/webview/panel/transcript/activity';
import type { ChatMessage, PruningDetails } from '../../../../src/shared/protocol';

function makeMessage(id: string, role: ChatMessage['role']): ChatMessage {
  return {
    id,
    role,
    content: role === 'assistant' ? 'assistant reply' : 'user prompt',
    markdown: role === 'assistant' ? 'assistant reply' : 'user prompt',
    status: 'completed',
    parts: [],
    toolCalls: [],
    createdAt: '2026-05-16T00:00:00.000Z',
  } as unknown as ChatMessage;
}

function makePruningDetails(): PruningDetails {
  return {
    includedSkills: ['debugging'],
    excludedSkills: ['planning'],
    includedTools: ['read'],
    excludedTools: ['bash', 'write'],
    mode: 'auto',
    skillTokensSaved: 20,
    toolTokensSaved: 30,
    prepassThinking: 'The task only needs inspection.',
  };
}

function makePruningMessage(id: string): ChatMessage {
  return {
    id,
    role: 'system',
    markdown: 'Kept 1/2 skills, Kept 1/3 tools · Saved ~50 tokens',
    status: 'completed',
    customType: 'pruning-result',
    customDetails: makePruningDetails(),
    createdAt: '2026-05-16T00:00:01.000Z',
  } as unknown as ChatMessage;
}

test('buildTranscriptRows keeps system prompts, paging gaps, and messages in display order', () => {
  const rows = buildTranscriptRows({
    transcript: [
      makeMessage('user-1', 'user'),
      makeMessage('assistant-1', 'assistant'),
    ],
    systemPromptCount: 2,
    hasOlder: true,
    hasNewer: true,
    busy: false,
    hasPruningResult: false,
  });

  assert.deepEqual(
    rows.map((row) => row.kind),
    ['systemPrompts', 'topGap', 'message', 'message', 'bottomGap'],
  );
  assert.equal(rows[2]?.kind, 'message');
  assert.equal(rows[2]?.kind === 'message' ? rows[2].message.id : null, 'user-1');
  assert.equal(rows[3]?.kind === 'message' ? rows[3].message.id : null, 'assistant-1');
});

test('buildTranscriptRows omits optional system and gap rows when not needed', () => {
  const rows = buildTranscriptRows({
    transcript: [makeMessage('assistant-1', 'assistant')],
    systemPromptCount: 0,
    hasOlder: false,
    hasNewer: false,
    busy: false,
    hasPruningResult: false,
  });

  assert.deepEqual(rows.map((row) => row.kind), ['message']);
});

test('buildTranscriptRows does not create a systemPrompts row for pruning alone', () => {
  const rows = buildTranscriptRows({
    transcript: [makeMessage('user-1', 'user')],
    systemPromptCount: 0,
    hasOlder: false,
    hasNewer: false,
    busy: false,
    hasPruningResult: true,
  });

  assert.deepEqual(rows.map((row) => row.kind), ['message']);
});

test('buildTranscriptRows attaches pruning-result details to the following assistant row', () => {
  const rows = buildTranscriptRows({
    transcript: [
      makeMessage('user-1', 'user'),
      makePruningMessage('pruning-1'),
      makeMessage('assistant-1', 'assistant'),
    ],
    systemPromptCount: 0,
    hasOlder: false,
    hasNewer: false,
    busy: false,
    hasPruningResult: true,
  });

  assert.deepEqual(rows.map((row) => row.kind), ['message', 'message']);
  const assistantRow = rows[1];
  assert.equal(assistantRow?.kind, 'message');
  assert.equal(assistantRow?.kind === 'message' ? assistantRow.message.id : null, 'assistant-1');
  assert.equal(assistantRow?.kind === 'message' ? assistantRow.pruningHeaderState?.kind : null, 'result');
  assert.deepEqual(
    assistantRow?.kind === 'message' && assistantRow.pruningHeaderState?.kind === 'result'
      ? assistantRow.pruningHeaderState.details.includedSkills
      : null,
    ['debugging'],
  );
  assert.equal(
    assistantRow?.kind === 'message' && assistantRow.pruningHeaderState?.kind === 'result'
      ? assistantRow.pruningHeaderState.fallbackText
      : null,
    'Kept 1/2 skills, Kept 1/3 tools · Saved ~50 tokens',
  );
});

test('buildTranscriptRows hides pruning-result messages when pruning summaries are disabled', () => {
  const rows = buildTranscriptRows({
    transcript: [
      makeMessage('user-1', 'user'),
      makePruningMessage('pruning-1'),
      makeMessage('assistant-1', 'assistant'),
    ],
    systemPromptCount: 0,
    hasOlder: false,
    hasNewer: false,
    busy: false,
    hasPruningResult: false,
    showPruningMessages: false,
  });

  assert.deepEqual(rows.map((row) => row.kind), ['message', 'message']);
  const assistantRow = rows[1];
  assert.equal(assistantRow?.kind === 'message' ? assistantRow.pruningHeaderState : 'not-message', undefined);
});

test('buildTranscriptRows falls back to a raw pruning system message when details cannot be normalized', () => {
  const rows = buildTranscriptRows({
    transcript: [
      makeMessage('user-1', 'user'),
      {
        id: 'pruning-legacy',
        role: 'system',
        markdown: 'Pruned: legacy markdown only',
        status: 'completed',
        customType: 'pruning-result',
        customDetails: { legacy: true },
        createdAt: '2026-05-16T00:00:01.000Z',
      } as unknown as ChatMessage,
    ],
    systemPromptCount: 0,
    hasOlder: false,
    hasNewer: false,
    busy: false,
    hasPruningResult: true,
  });

  assert.deepEqual(rows.map((row) => row.kind), ['message', 'message']);
  const pruningRow = rows[1];
  assert.equal(pruningRow?.kind === 'message' ? pruningRow.message.id : null, 'pruning-legacy');
  assert.equal(pruningRow?.kind === 'message' ? pruningRow.message.role : null, 'system');
});

test('buildTranscriptRows keeps a stable assistant placeholder shell when pruning finishes before message_start', () => {
  const transcript = [
    makeMessage('user-1', 'user'),
    makePruningMessage('pruning-1'),
  ];
  const activityState = deriveTurnActivityState({
    busy: true,
    transcript,
    prefs: { extensionToggles: {}, activityTailLines: 2 },
    pruningSettings: { mode: 'auto' },
    pendingAssistantModelId: 'gpt-5.4',
    pendingAssistantThinkingLevel: 'xhigh',
  });
  const rows = buildTranscriptRows({
    transcript,
    systemPromptCount: 0,
    hasOlder: false,
    hasNewer: false,
    busy: true,
    hasPruningResult: true,
    activityState,
    pendingAssistantModelId: 'gpt-5.4',
    pendingAssistantThinkingLevel: 'xhigh',
  });

  assert.deepEqual(rows.map((row) => row.kind), ['message', 'message']);
  const assistantRow = rows[1];
  assert.equal(assistantRow?.kind, 'message');
  assert.equal(assistantRow?.kind === 'message' ? assistantRow.message.role : null, 'assistant');
  assert.equal(assistantRow?.kind === 'message' ? assistantRow.message.status : null, 'completed');
  assert.equal(assistantRow?.kind === 'message' ? assistantRow.message.id : null, 'assistant-placeholder:user-1');
  assert.equal(assistantRow?.kind === 'message' ? assistantRow.message.createdAt : null, '2026-05-16T00:00:00.000Z');
  assert.equal(assistantRow?.kind === 'message' ? assistantRow.message.modelId : null, 'gpt-5.4');
  assert.equal(assistantRow?.kind === 'message' ? assistantRow.message.thinkingLevel : null, 'xhigh');
  assert.equal(assistantRow?.kind === 'message' ? assistantRow.pruningHeaderState?.kind : null, 'result');
  assert.deepEqual(
    assistantRow?.kind === 'message' && assistantRow.pruningHeaderState?.kind === 'result'
      ? assistantRow.pruningHeaderState.details.includedSkills
      : null,
    ['debugging'],
  );
  assert.equal(
    assistantRow?.kind === 'message' && assistantRow.pruningHeaderState?.kind === 'result'
      ? assistantRow.pruningHeaderState.fallbackText
      : null,
    'Kept 1/2 skills, Kept 1/3 tools · Saved ~50 tokens',
  );
  assert.equal(assistantRow?.kind === 'message' && assistantRow.activityState ? assistantRow.activityState.phase : null, 'startingModel');
  assert.equal(assistantRow?.kind === 'message' && assistantRow.activityState ? assistantRow.activityState.label : null, 'starting model');
});

test('buildTranscriptRows preserves pruning result when the run ends before an assistant message starts', () => {
  const rows = buildTranscriptRows({
    transcript: [
      makeMessage('user-1', 'user'),
      makePruningMessage('pruning-1'),
    ],
    systemPromptCount: 0,
    hasOlder: false,
    hasNewer: false,
    busy: false,
    hasPruningResult: true,
  });

  assert.deepEqual(rows.map((row) => row.kind), ['message', 'message']);
  const assistantRow = rows[1];
  assert.equal(assistantRow?.kind === 'message' ? assistantRow.message.id : null, 'assistant-placeholder:user-1');
  assert.equal(assistantRow?.kind === 'message' ? assistantRow.pruningHeaderState?.kind : null, 'result');
});

test('buildTranscriptRows folds late pruning-result into the existing streaming assistant row', () => {
  const streamingAssistant = { ...makeMessage('assistant-1', 'assistant'), status: 'streaming' as const };
  const rows = buildTranscriptRows({
    transcript: [
      makeMessage('user-1', 'user'),
      streamingAssistant,
      makePruningMessage('pruning-1'),
    ],
    systemPromptCount: 0,
    hasOlder: false,
    hasNewer: false,
    busy: true,
    hasPruningResult: true,
  });

  assert.deepEqual(rows.map((row) => row.kind), ['message', 'message']);
  const assistantRow = rows[1];
  assert.equal(assistantRow?.kind === 'message' ? assistantRow.message.id : null, 'assistant-1');
  assert.deepEqual(
    assistantRow?.kind === 'message' && assistantRow.pruningHeaderState?.kind === 'result'
      ? assistantRow.pruningHeaderState.details.includedSkills
      : null,
    ['debugging'],
  );
});

test('buildTranscriptRows folds late pruning-result into a completed assistant row without standalone activity row', () => {
  const rows = buildTranscriptRows({
    transcript: [
      makeMessage('user-1', 'user'),
      makeMessage('assistant-1', 'assistant'),
      makePruningMessage('pruning-1'),
    ],
    systemPromptCount: 0,
    hasOlder: false,
    hasNewer: false,
    busy: true,
    hasPruningResult: true,
  });

  assert.deepEqual(rows.map((row) => row.kind), ['message', 'message']);
  const assistantRow = rows[1];
  assert.equal(assistantRow?.kind === 'message' ? assistantRow.message.id : null, 'assistant-1');
  assert.deepEqual(
    assistantRow?.kind === 'message' && assistantRow.pruningHeaderState?.kind === 'result'
      ? assistantRow.pruningHeaderState.details.includedSkills
      : null,
    ['debugging'],
  );
});

test('buildTranscriptRows shows a pending pruning header in a stable assistant placeholder row', () => {
  const transcript = [makeMessage('user-1', 'user')];
  const activityState = deriveTurnActivityState({
    busy: true,
    transcript,
    prefs: { extensionToggles: {}, activityTailLines: 2 },
    pruningSettings: { mode: 'auto' },
    pendingAssistantModelId: 'gpt-5.4',
    pendingAssistantThinkingLevel: 'xhigh',
  });
  const rows = buildTranscriptRows({
    transcript,
    systemPromptCount: 0,
    hasOlder: false,
    hasNewer: false,
    busy: true,
    hasPruningResult: false,
    activityState,
    pendingAssistantModelId: 'gpt-5.4',
    pendingAssistantThinkingLevel: 'xhigh',
  });

  assert.deepEqual(rows.map((row) => row.kind), ['message', 'message']);
  const assistantRow = rows[1];
  assert.equal(assistantRow?.kind === 'message' ? assistantRow.message.id : null, 'assistant-placeholder:user-1');
  assert.equal(assistantRow?.kind === 'message' ? assistantRow.message.createdAt : null, '2026-05-16T00:00:00.000Z');
  assert.equal(assistantRow?.kind === 'message' ? assistantRow.message.modelId : null, 'gpt-5.4');
  assert.equal(assistantRow?.kind === 'message' ? assistantRow.message.thinkingLevel : null, 'xhigh');
  assert.deepEqual(
    assistantRow?.kind === 'message' ? assistantRow.pruningHeaderState : null,
    { kind: 'pending', label: 'pruning skills/tools' },
  );
  assert.equal(assistantRow?.kind === 'message' && assistantRow.activityState ? assistantRow.activityState.phase : null, 'pruning');
  assert.equal(assistantRow?.kind === 'message' && assistantRow.activityState ? assistantRow.activityState.label : null, 'pruning skills/tools');
});

test('buildTranscriptRows suppresses standalone typingIndicator when busy and last message is assistant', () => {
  const transcript = [
    makeMessage('user-1', 'user'),
    makeMessage('assistant-1', 'assistant'),
  ];
  const activityState = deriveTurnActivityState({
    busy: true,
    transcript,
    prefs: { extensionToggles: {}, activityTailLines: 2 },
    pruningSettings: { mode: 'auto' },
  });
  const rows = buildTranscriptRows({
    transcript,
    systemPromptCount: 0,
    hasOlder: false,
    hasNewer: false,
    busy: true,
    hasPruningResult: false,
    activityState,
  });

  // No typingIndicator row — status text is rendered inline in the message item.
  assert.deepEqual(rows.map((row) => row.kind), ['message', 'message']);
  assert.equal(rows[1]?.kind === 'message' && rows[1].activityState ? rows[1].activityState.phase : null, 'thinking');
  assert.equal(rows[1]?.kind === 'message' && rows[1].activityState ? rows[1].activityState.label : null, 'thinking');
});

test('buildTranscriptRows suppresses standalone typingIndicator when assistant is streaming', () => {
  const streamingMsg = { ...makeMessage('assistant-1', 'assistant'), status: 'streaming' as const };
  const transcript = [
    makeMessage('user-1', 'user'),
    streamingMsg,
  ];
  const activityState = deriveTurnActivityState({
    busy: true,
    transcript,
    prefs: { extensionToggles: {}, activityTailLines: 2 },
    pruningSettings: { mode: 'auto' },
  });
  const rows = buildTranscriptRows({
    transcript,
    systemPromptCount: 0,
    hasOlder: false,
    hasNewer: false,
    busy: true,
    hasPruningResult: false,
    activityState,
  });

  assert.deepEqual(rows.map((row) => row.kind), ['message', 'message']);
  assert.equal(rows[1]?.kind === 'message' && rows[1].activityState ? rows[1].activityState.phase : null, 'streaming');
});

test('buildTranscriptRows shows standalone typingIndicator when busy with empty transcript', () => {
  const activityState = deriveTurnActivityState({
    busy: true,
    transcript: [],
    prefs: { extensionToggles: {}, activityTailLines: 2 },
    pruningSettings: { mode: 'auto' },
  });
  const rows = buildTranscriptRows({
    transcript: [],
    systemPromptCount: 0,
    hasOlder: false,
    hasNewer: false,
    busy: true,
    hasPruningResult: false,
    activityState,
  });

  assert.deepEqual(rows.map((row) => row.kind), ['typingIndicator']);
});

test('estimateTranscriptRowSize uses stable size buckets by row kind', () => {
  assert.equal(estimateTranscriptRowSize({ kind: 'systemPrompts', key: 'system-prompts' }), 140);
  assert.equal(estimateTranscriptRowSize({ kind: 'topGap', key: 'gap:older' }), 56);
  assert.equal(estimateTranscriptRowSize({ kind: 'bottomGap', key: 'gap:newer' }), 56);
  assert.equal(
    estimateTranscriptRowSize({ kind: 'message', key: 'message:user-1', message: makeMessage('user-1', 'user') }),
    120,
  );
  assert.equal(
    estimateTranscriptRowSize({ kind: 'message', key: 'message:assistant-1', message: makeMessage('assistant-1', 'assistant') }),
    180,
  );
  assert.equal(
    estimateTranscriptRowSize({
      kind: 'message',
      key: 'message:assistant-2',
      message: makeMessage('assistant-2', 'assistant'),
      pruningHeaderState: { kind: 'result', details: makePruningDetails(), fallbackText: 'Pruned' },
    }),
    220,
  );
});
