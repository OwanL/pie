import assert from 'node:assert/strict';
import test from 'node:test';

import { transcriptRenderSignature } from '../src/shared/transcript-render-signature';
import { EMPTY_VIEW_STATE } from '../src/webview/panel/hooks/use-host-sync';

function state() {
  return {
    ...EMPTY_VIEW_STATE,
    activeSession: {
      path: '/s',
      name: 's',
      cwd: '/repo',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 1,
    },
    busy: true,
    transcript: [{
      id: 'assistant-1',
      role: 'assistant' as const,
      createdAt: '',
      markdown: 'working',
      status: 'streaming' as const,
      toolCalls: [{ id: 'tool-1', name: 'bash', input: {}, status: 'running' as const }],
    }],
  };
}

test('transcript render signature changes for live status and content changes', () => {
  const base = state();
  const initial = transcriptRenderSignature(base);
  assert.notEqual(transcriptRenderSignature({ ...base, busy: false }), initial);
  assert.notEqual(transcriptRenderSignature({
    ...base,
    transcript: [{ ...base.transcript[0]!, markdown: 'working.' }],
  }), initial);
  assert.notEqual(transcriptRenderSignature({
    ...base,
    transcript: [{
      ...base.transcript[0]!,
      toolCalls: [{ ...base.transcript[0]!.toolCalls![0]!, status: 'completed' as const }],
    }],
  }), initial);
});

test('transcript render signature rejects stale equal-length live content', () => {
  const base = state();
  const initial = transcriptRenderSignature(base);
  assert.notEqual(transcriptRenderSignature({
    ...base,
    transcript: [{ ...base.transcript[0]!, markdown: 'WORKING' }],
  }), initial, 'equal-length assistant text must have a distinct identity');

  const withSubagentProgress = {
    ...base,
    transcript: [{
      ...base.transcript[0]!,
      toolCalls: [{
        id: 'tool-1',
        name: 'subagent',
        input: {},
        status: 'running' as const,
        result: { details: { results: [{ streamingText: 'draft one' }] } },
      }],
    }],
  };
  const nextSubagentProgress = {
    ...withSubagentProgress,
    transcript: [{
      ...withSubagentProgress.transcript[0]!,
      toolCalls: [{
        ...withSubagentProgress.transcript[0]!.toolCalls[0]!,
        result: { details: { results: [{ streamingText: 'draft two' }] } },
      }],
    }],
  };
  assert.notEqual(
    transcriptRenderSignature(nextSubagentProgress),
    transcriptRenderSignature(withSubagentProgress),
    'equal-length subagent progress must not acknowledge a stale card',
  );
});

test('transcript render signature changes for transient tool-call drafting', () => {
  const base = state();
  const withDraft = {
    ...base,
    transcript: [{
      ...base.transcript[0]!,
      draftingToolCall: { id: 'draft-1', name: 'bash', argumentsText: '{"command":' },
    }],
  };
  assert.notEqual(transcriptRenderSignature(withDraft), transcriptRenderSignature(base));
  assert.notEqual(
    transcriptRenderSignature({
      ...withDraft,
      transcript: [{
        ...withDraft.transcript[0]!,
        draftingToolCall: { ...withDraft.transcript[0]!.draftingToolCall, argumentsText: '{"command":"test"}' },
      }],
    }),
    transcriptRenderSignature(withDraft),
  );
});
