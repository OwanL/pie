import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../../../../src/shared/protocol';
import { reasoningSummary } from '../../../../src/webview/panel/markdown';
import {
  decideTranscriptCommit,
  type CommitLeaf,
  type TranscriptCommitTarget,
} from '../../../../src/webview/panel/transcript/commit-registry';

const message: ChatMessage = {
  id: 'assistant-1',
  role: 'assistant',
  createdAt: '2026-01-01T00:00:00.000Z',
  markdown: 'new text',
  parts: [{ kind: 'text', text: 'new text' }],
  status: 'streaming',
};
const transcriptWindow = {
  totalCount: 1,
  loadedStart: 0,
  loadedEnd: 1,
  hasOlder: false,
  hasNewer: false,
  isPartial: false,
  hasUserMessages: false,
};
const target: TranscriptCommitTarget = {
  revision: 4,
  viewGeneration: 2,
  expectedTranscriptIdentity: 'opaque-host-identity',
  acceptedAt: 0,
  state: {
    transcript: [message],
    transcriptWindow,
    activeSessionPath: '/session/a',
    openTabPaths: ['/session/a'],
  },
};

function model(renderedTranscript: ChatMessage[] = [message], intentionallyHiddenMessageIds = new Set<string>()) {
  return {
    renderedTranscript,
    window: transcriptWindow,
    mountedVirtualRowIndexes: [0],
    rowIndexByMessageId: new Map(renderedTranscript.map((item, index) => [item.id, index])),
    intentionallyHiddenMessageIds,
  };
}

function leaves(text: string): Map<string, CommitLeaf> {
  return new Map([
    ['message:assistant-1', { kind: 'message', messageId: 'assistant-1', role: 'assistant', status: 'streaming' }],
    ['text:assistant-1:0', { kind: 'text', messageId: 'assistant-1', partIndex: 0, text }],
  ]);
}

test('stale buffered text cannot satisfy a newer transcript revision', () => {
  assert.equal(decideTranscriptCommit(target, leaves('old text'), model()).matches, false);
  assert.deepEqual(decideTranscriptCommit(target, leaves('new text'), model()), {
    matches: true,
    evidence: 'displayed',
  });
});

test('optimistic overlay structure cannot acknowledge authoritative host identity', () => {
  const optimistic: ChatMessage = {
    id: 'local-1', role: 'user', createdAt: '', markdown: 'pending', status: 'completed',
  };
  assert.equal(decideTranscriptCommit(target, leaves('new text'), model([message, optimistic])).matches, false);
});

test('offscreen is accepted only when the current virtual range excludes the active row', () => {
  const noLeaves = new Map<string, CommitLeaf>();
  const excluded = {
    ...model(),
    mountedVirtualRowIndexes: [5, 6],
  };
  assert.deepEqual(decideTranscriptCommit(target, noLeaves, excluded), {
    matches: true,
    evidence: 'offscreen',
  });
  assert.equal(decideTranscriptCommit(target, noLeaves, model()).matches, false);
});

test('tool lifecycle metadata must match the committed card', () => {
  const toolMessage: ChatMessage = {
    ...message,
    parts: [{ kind: 'toolCall', toolCall: { id: 'tool-1', name: 'read', input: {}, status: 'running' } }],
    markdown: '',
    toolStateRevision: 9,
  };
  const toolTarget = { ...target, state: { ...target.state, transcript: [toolMessage] } };
  const toolLeaves = new Map<string, CommitLeaf>([
    ['message:assistant-1', { kind: 'message', messageId: 'assistant-1', role: 'assistant', status: 'streaming' }],
    ['tool:assistant-1:tool-1', {
      kind: 'tool', messageId: 'assistant-1', toolCallId: 'tool-1', status: 'running',
      executionId: 'tool-1', attempt: 0, seq: 8, phase: 'running', revision: 9,
    }],
  ]);
  assert.equal(decideTranscriptCommit(toolTarget, toolLeaves, model([toolMessage])).matches, false);
  toolLeaves.set('tool:assistant-1:tool-1', {
    kind: 'tool', messageId: 'assistant-1', toolCallId: 'tool-1', status: 'running',
    executionId: 'tool-1', attempt: 0, seq: 9, phase: 'running', revision: 9,
  });
  assert.equal(decideTranscriptCommit(toolTarget, toolLeaves, model([toolMessage])).matches, true);
});

function assistantTextMessage(id: string, text: string): ChatMessage {
  return {
    ...message,
    id,
    markdown: text,
    parts: [{ kind: 'text', text }],
    status: 'completed',
  };
}

function textLeaves(messages: readonly ChatMessage[]): Map<string, CommitLeaf> {
  return new Map(messages.flatMap((item) => [
    [`message:${item.id}`, { kind: 'message', messageId: item.id, role: item.role, status: item.status } as CommitLeaf],
    [`text:${item.id}:0`, { kind: 'text', messageId: item.id, partIndex: 0, text: item.parts?.[0]?.kind === 'text' ? item.parts[0].text : item.markdown } as CommitLeaf],
  ]));
}

test('requires fresh evidence for the penultimate and third signed-tail messages', () => {
  const transcript = [
    assistantTextMessage('older', 'older'),
    assistantTextMessage('third-tail', 'third fresh'),
    assistantTextMessage('penultimate', 'penultimate fresh'),
    assistantTextMessage('final', 'final fresh'),
  ];
  const tailTarget: TranscriptCommitTarget = { ...target, state: { ...target.state, transcript } };
  const fresh = textLeaves(transcript.slice(1));
  assert.equal(decideTranscriptCommit(tailTarget, fresh, model(transcript)).matches, true);

  fresh.set('text:penultimate:0', { kind: 'text', messageId: 'penultimate', partIndex: 0, text: 'stale penultimate' });
  assert.equal(decideTranscriptCommit(tailTarget, fresh, model(transcript)).matches, false);

  fresh.set('text:penultimate:0', { kind: 'text', messageId: 'penultimate', partIndex: 0, text: 'penultimate fresh' });
  fresh.set('text:third-tail:0', { kind: 'text', messageId: 'third-tail', partIndex: 0, text: 'stale third tail' });
  assert.equal(decideTranscriptCommit(tailTarget, fresh, model(transcript)).matches, false);
});

test('historical terminal tools do not exhaust live commit evidence', () => {
  const historical: ChatMessage[] = Array.from({ length: 200 }, (_, index) => ({
    id: `historical-${index}`,
    role: 'assistant' as const,
    createdAt: '',
    markdown: '',
    status: 'completed' as const,
    parts: [{
      kind: 'toolCall' as const,
      toolCall: { id: `tool-${index}`, name: 'read', input: {}, status: 'completed' as const },
    }],
  }));
  const tail = [
    assistantTextMessage('tail-a', 'one'),
    assistantTextMessage('tail-b', 'two'),
    assistantTextMessage('tail-c', 'three'),
  ];
  const transcript = [...historical, ...tail];
  const window = {
    ...transcriptWindow,
    totalCount: transcript.length,
    loadedEnd: transcript.length,
    hasUserMessages: true,
  };
  const toolHeavyTarget: TranscriptCommitTarget = {
    ...target,
    state: { ...target.state, transcript, transcriptWindow: window },
  };
  const toolHeavyModel = {
    renderedTranscript: transcript,
    window,
    mountedVirtualRowIndexes: [200, 201, 202],
    rowIndexByMessageId: new Map(transcript.map((item, index) => [item.id, index])),
    intentionallyHiddenMessageIds: new Set<string>(),
  };

  assert.deepEqual(decideTranscriptCommit(toolHeavyTarget, textLeaves(tail), toolHeavyModel), {
    matches: true,
    evidence: 'displayed',
  });
});

test('a valid live owner can commit more than 512 tool leaves', () => {
  const toolCount = 600;
  const toolStateRevision = toolCount;
  const tools = Array.from({ length: toolCount }, (_, index) => ({
    id: `live-tool-${index}`,
    name: 'read',
    input: {},
    status: 'running' as const,
  }));
  const liveOwner: ChatMessage = {
    id: 'large-live-owner',
    role: 'assistant',
    createdAt: '',
    markdown: '',
    status: 'streaming',
    parts: tools.map((toolCall) => ({ kind: 'toolCall' as const, toolCall })),
    toolStateRevision,
  };
  const largeTarget: TranscriptCommitTarget = {
    ...target,
    state: { ...target.state, transcript: [liveOwner] },
  };
  const evidence = new Map<string, CommitLeaf>([
    ['message:large-live-owner', {
      kind: 'message', messageId: 'large-live-owner', role: 'assistant', status: 'streaming',
    }],
    ...tools.map((toolCall) => [
      `tool:large-live-owner:${toolCall.id}`,
      {
        kind: 'tool' as const,
        messageId: 'large-live-owner',
        toolCallId: toolCall.id,
        status: 'running' as const,
        executionId: toolCall.id,
        attempt: 0,
        seq: toolStateRevision,
        phase: 'running',
        revision: toolStateRevision,
      },
    ] as const),
  ]);

  assert.equal(evidence.size, toolCount + 1);
  assert.deepEqual(decideTranscriptCommit(largeTarget, evidence, model([liveOwner])), {
    matches: true,
    evidence: 'displayed',
  });
});

test('collapsed reasoning acknowledges its visible summary, never the hidden source', () => {
  const source = 'A deliberately long reasoning source that has more than eighty visible characters and must not be acknowledged while collapsed.';
  const reasoningMessage: ChatMessage = {
    ...message,
    status: 'completed',
    markdown: source,
    parts: [{ kind: 'reasoning', text: source }],
  };
  const reasoningTarget: TranscriptCommitTarget = { ...target, state: { ...target.state, transcript: [reasoningMessage] } };
  const reasoningLeaves = new Map<string, CommitLeaf>([
    ['message:assistant-1', { kind: 'message', messageId: 'assistant-1', role: 'assistant', status: 'completed' }],
    ['reasoning:assistant-1:0', { kind: 'reasoning', messageId: 'assistant-1', partIndex: 0, text: source, policy: 'collapsed' }],
  ]);
  assert.equal(decideTranscriptCommit(reasoningTarget, reasoningLeaves, model([reasoningMessage])).matches, false);

  reasoningLeaves.set('reasoning:assistant-1:0', {
    kind: 'reasoning', messageId: 'assistant-1', partIndex: 0, text: reasoningSummary(source), policy: 'collapsed',
  });
  assert.equal(decideTranscriptCommit(reasoningTarget, reasoningLeaves, model([reasoningMessage])).matches, true);
});

test('only an explicitly hidden pruning-result row may settle without a mounted leaf', () => {
  const user: ChatMessage = { id: 'user-1', role: 'user', createdAt: '', markdown: 'Prompt', status: 'completed' };
  const pruning: ChatMessage = {
    id: 'pruning-1', role: 'system', createdAt: '', markdown: 'Pruning summary', status: 'completed',
    customType: 'pruning-result', customDetails: {},
  } as ChatMessage;
  const hiddenTarget: TranscriptCommitTarget = { ...target, state: { ...target.state, transcript: [user, pruning] } };
  const userLeaves = new Map<string, CommitLeaf>([
    ['message:user-1', { kind: 'message', messageId: 'user-1', role: 'user', status: 'completed' }],
    ['text:user-1:0', { kind: 'text', messageId: 'user-1', partIndex: 0, text: 'Prompt' }],
  ]);
  assert.equal(
    decideTranscriptCommit(hiddenTarget, userLeaves, model([user, pruning], new Set(['pruning-1']))).matches,
    true,
    'disabled pruning display is intentional evidence, so no commit watchdog retry is needed',
  );

  const activeAssistant = assistantTextMessage('active-missing', 'still missing');
  const activeTarget: TranscriptCommitTarget = { ...target, state: { ...target.state, transcript: [activeAssistant] } };
  assert.equal(
    decideTranscriptCommit(activeTarget, new Map(), model([activeAssistant], new Set(['active-missing']))).matches,
    false,
    'an arbitrary active row cannot masquerade as intentionally hidden',
  );
  const staleModel = {
    ...model([activeAssistant], new Set(['active-missing'])),
    rowIndexByMessageId: new Map<string, number>(),
  };
  assert.equal(
    decideTranscriptCommit(activeTarget, new Map(), staleModel).matches,
    false,
    'an arbitrary stale/missing row cannot masquerade as intentionally hidden',
  );
});
