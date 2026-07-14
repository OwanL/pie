import assert from 'node:assert/strict';
import test from 'node:test';

import { transcriptRenderSignature } from '../../../../src/shared/transcript-render-signature';
import { EMPTY_VIEW_STATE } from '../../../../src/webview/panel/hooks/use-host-sync';

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
      toolStateRevision: 1,
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
      toolStateRevision: 1,
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
      toolStateRevision: 2,
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

test('transcript render signature tracks a running tool owner pushed out of the tail', () => {
  const base = state();
  const queuedTail = Array.from({ length: 4 }, (_, index) => ({
    id: `queued-${index}`,
    role: 'user' as const,
    createdAt: '',
    markdown: `follow-up ${index}`,
    status: 'queued' as const,
  }));
  const first = {
    ...base,
    transcript: [{ ...base.transcript[0]!, toolStateRevision: 1 }, ...queuedTail],
  };
  const second = {
    ...first,
    transcript: [{ ...first.transcript[0]!, toolStateRevision: 2 }, ...queuedTail],
  };

  assert.notEqual(
    transcriptRenderSignature(second),
    transcriptRenderSignature(first),
    'queued follow-ups must not let stale live-tool DOM acknowledge a snapshot',
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

test('transcript render signature bounds traversal of wide tool results', () => {
  const base = state();
  let valueReads = 0;
  const wideResult: Record<string, unknown> = {};
  for (let index = 0; index < 2_000; index += 1) {
    Object.defineProperty(wideResult, `field-${String(index).padStart(4, '0')}`, {
      enumerable: true,
      get: () => {
        valueReads += 1;
        return `value-${index}`;
      },
    });
  }

  assert.doesNotThrow(() => transcriptRenderSignature({
    ...base,
    transcript: [{
      ...base.transcript[0]!,
      toolCalls: [{
        ...base.transcript[0]!.toolCalls![0]!,
        result: wideResult,
      }],
    }],
  }));
  assert.equal(valueReads, 0, 'signature must not traverse arbitrary tool-result payloads');
});

test('transcript render signature bounds traversal of large tool-call collections', () => {
  const base = state();
  let toolFieldReads = 0;
  const toolCalls = Array.from({ length: 2_000 }, (_, index) => {
    const tool = {
      id: `tool-${index}`,
      name: 'bash',
      input: {},
    } as typeof base.transcript[0]['toolCalls'][number] & { result?: unknown };
    Object.defineProperties(tool, {
      status: {
        enumerable: true,
        get: () => {
          toolFieldReads += 1;
          return index >= 1_990 ? 'running' : 'completed';
        },
      },
      result: {
        enumerable: true,
        get: () => {
          toolFieldReads += 1;
          return { content: `output-${index}` };
        },
      },
    });
    return tool;
  });

  transcriptRenderSignature({
    ...base,
    transcript: [{ ...base.transcript[0]!, toolCalls }],
  });
  assert.equal(toolFieldReads, 0, 'signature must use the O(1) message revision instead of scanning tool calls');
});

test('transcript render signature uses the host tool revision for arbitrary generic progress', () => {
  const base = state();
  const first = {
    ...base,
    transcript: [{
      ...base.transcript[0]!,
      toolStateRevision: 1,
      toolCalls: [{ ...base.transcript[0]!.toolCalls![0]!, result: { answer: 'one' } }],
    }],
  };
  const second = {
    ...first,
    transcript: [{
      ...first.transcript[0]!,
      toolStateRevision: 2,
      toolCalls: [{ ...first.transcript[0]!.toolCalls[0]!, result: { answer: 'two' } }],
    }],
  };
  assert.notEqual(transcriptRenderSignature(second), transcriptRenderSignature(first));
});

test('transcript render signature samples large text while retaining append identity', () => {
  const base = state();
  const largeText = `${'prefix '.repeat(20_000)}tail-one`;
  const first = transcriptRenderSignature({
    ...base,
    transcript: [{ ...base.transcript[0]!, markdown: largeText }],
  });
  const second = transcriptRenderSignature({
    ...base,
    transcript: [{ ...base.transcript[0]!, markdown: `${largeText} more` }],
  });
  assert.notEqual(second, first, 'append-only streaming must advance the checksum');
});
