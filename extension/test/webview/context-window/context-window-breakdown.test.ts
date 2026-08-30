import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage, SystemPromptEntry } from '../../../src/shared/protocol';
import {
  contextBreakdownTranscriptSignature,
  systemPromptsSignature,
} from '../../../src/webview/panel/composer/indicator-signature';
import {
  buildContextWindowBreakdown,
  clearToolCallTokenCache,
  getToolCallTokenCacheSize,
  TOOL_CALL_TOKEN_CACHE_MAX_ENTRIES,
} from '../../../src/webview/panel/context-window/breakdown';

function makePrompt(overrides: Partial<SystemPromptEntry> = {}): SystemPromptEntry {
  return {
    source: 'user',
    title: 'User system prompt',
    text: 'abcd',
    summary: 'abcd',
    availability: 'available',
    ...overrides,
  };
}

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'message-1',
    role: 'user',
    createdAt: new Date().toISOString(),
    markdown: '',
    status: 'completed',
    ...overrides,
  };
}

test('buildContextWindowBreakdown sorts top contributors first, uses derived Other when exact usage is known', () => {
  const breakdown = buildContextWindowBreakdown({
    contextUsage: {
      tokens: 100,
      contextWindow: 100,
      percent: 100,
    },
    effectiveContextWindow: 100,
    systemPrompts: [
      makePrompt({ source: 'provider', availability: 'unknown', text: '' }),
      makePrompt({ source: 'harness', text: 'abcd' }),
      makePrompt({ source: 'user', title: 'System append', text: 'abcde' }),
      makePrompt({ source: 'user', title: 'Repo prompt', text: 'abcdefgh' }),
      makePrompt({ source: 'user', title: 'Disabled prompt', disabled: true, text: 'x'.repeat(400) }),
    ],
    transcript: [
      makeMessage({ role: 'user', markdown: 'abcd' }),
      makeMessage({
        id: 'message-2',
        role: 'assistant',
        markdown: 'abcdefgh',
        thinking: 'abcd',
        toolCalls: [{
          id: 'tool-1',
          name: 'run',
          input: 'abcd',
          result: 'abcdefgh',
          status: 'completed',
        }],
      }),
      makeMessage({ id: 'message-3', role: 'system', markdown: 'ab' }),
    ],
    isPartial: false,
  });

  const byLabel = new Map(breakdown.entries.map((entry) => [entry.label ?? entry.key, entry]));
  const footer = new Map(breakdown.footerEntries.map((entry) => [entry.key, entry]));

  assert.equal(byLabel.get('System prompt')?.kind, 'estimated');
  assert.equal(byLabel.get('User message')?.kind, 'estimated');
  assert.ok(byLabel.get('User message')?.note?.includes('abcd'));
  assert.equal(byLabel.get('Assistant responses')?.note, '1 response');
  assert.equal(byLabel.get('Reasoning')?.note, '1 response');
  assert.equal(byLabel.get('System messages')?.note, '1 message');
  assert.equal(byLabel.get('Tool: run')?.note, '1 call');
  assert.equal(byLabel.get('Other')?.kind, 'derived');

  assert.deepEqual(breakdown.summary, {
    usedTokens: 100,
    usedKind: 'exact',
    remainingTokens: 0,
    remainingKind: 'exact',
    totalWindow: 100,
  });

  assert.equal(footer.get('window.total')?.value, '100');
  assert.equal(footer.get('window.used')?.value, '100');
  assert.equal(footer.get('window.remaining')?.value, '0');

  assert.match(breakdown.title, /Used: 100/m);
  assert.match(breakdown.title, /Remaining: 0/m);
  assert.match(breakdown.title, /System prompt: 4 estimated/m);
});

test('buildContextWindowBreakdown aggregates read_file tool calls into one total row', () => {
  const breakdown = buildContextWindowBreakdown({
    contextUsage: null,
    effectiveContextWindow: 200000,
    systemPrompts: [],
    transcript: [
      makeMessage({
        id: 'msg-1',
        role: 'assistant',
        markdown: '',
        toolCalls: [
          {
            id: 'tool-1',
            name: 'read_file',
            input: { filePath: 'src/backend/index.ts' },
            result: 'abcdefghijklmnopqrstuvwxyz',
            status: 'completed',
          },
          {
            id: 'tool-2',
            name: 'read_file',
            input: { filePath: '/home/user/skills/frontend-design/SKILL.md' },
            result: 'abcdefgh',
            status: 'completed',
          },
          {
            id: 'tool-2b',
            name: 'read_file',
            input: { filePath: '/home/user/skills/frontend-design/SKILL.md' },
            result: 'abcd',
            status: 'completed',
          },
          {
            id: 'tool-3',
            name: 'bash',
            input: { command: 'ls' },
            result: 'file1\nfile2',
            status: 'completed',
          },
        ],
      }),
    ],
    isPartial: false,
  });

  // read_file calls with non-skill paths are aggregated into a single row:
  // one total token count, with the file count as the note (no per-file rows).
  const readFileEntries = breakdown.entries.filter((entry) => (entry.label ?? entry.key) === 'Read file');
  assert.equal(readFileEntries.length, 1);
  const readFileEntry = readFileEntries[0]!;
  assert.equal(readFileEntry.note, '1 file');

  const skillEntry = breakdown.entries.find((entry) => (entry.label ?? entry.key) === 'Skill: frontend-design');
  assert.ok(skillEntry);
  assert.equal(skillEntry.note, '2 loads');

  const bashEntry = breakdown.entries.find((entry) => (entry.label ?? entry.key) === 'Tool: bash');
  assert.ok(bashEntry);
  assert.equal(bashEntry.note, '1 call');

  const otherEntry = breakdown.entries.find((entry) => entry.key === 'other');
  assert.equal(otherEntry, undefined, 'a zero-value residual should not create a generic Other row');
});

test('buildContextWindowBreakdown aggregates repeated non-file tools by normalized name', () => {
  const breakdown = buildContextWindowBreakdown({
    contextUsage: null,
    effectiveContextWindow: 1000,
    systemPrompts: [],
    transcript: [makeMessage({
      role: 'assistant',
      toolCalls: [
        { id: 'bash-1', name: 'Bash', input: { command: 'pwd' }, result: '/repo', status: 'completed' },
        { id: 'bash-2', name: ' bash ', input: { command: 'ls' }, result: 'src', status: 'completed' },
      ],
    })],
    isPartial: false,
  });

  const toolEntries = breakdown.entries.filter((entry) => entry.label === 'Tool: bash');
  assert.equal(toolEntries.length, 1);
  assert.equal(toolEntries[0]?.note, '2 calls');
  assert.ok((toolEntries[0]?.tokens ?? 0) > 0);
});

test('buildContextWindowBreakdown excludes pre-compaction display history from active-context attribution', () => {
  const breakdown = buildContextWindowBreakdown({
    contextUsage: {
      tokens: 1000,
      contextWindow: 200000,
      percent: 0.5,
    },
    effectiveContextWindow: 200000,
    systemPrompts: [],
    transcript: [
      makeMessage({
        id: 'old-assistant',
        role: 'assistant',
        toolCalls: [{
          id: 'old-subagent',
          name: 'subagent',
          input: { task: 'old task' },
          result: 'x'.repeat(20_000),
          status: 'completed',
        }],
      }),
      makeMessage({ id: 'retained-user', role: 'user', markdown: 'recent work retained by pi' }),
      makeMessage({
        id: 'compaction',
        role: 'system',
        customType: 'compaction-summary',
        markdown: 'Summary of the older conversation.',
      }),
      makeMessage({
        id: 'new-assistant',
        role: 'assistant',
        toolCalls: [{
          id: 'new-bash',
          name: 'bash',
          input: { command: 'pwd' },
          result: '/repo',
          status: 'completed',
        }],
      }),
    ],
    isPartial: false,
  });

  assert.equal(
    breakdown.entries.some((entry) => entry.label === 'Tool: subagent'),
    false,
    'historical tools before the latest compaction summary are no longer in the active prompt',
  );
  assert.equal(breakdown.entries.some((entry) => entry.label === 'Tool: bash'), true);
  assert.equal(breakdown.entries.some((entry) => entry.key === 'other'), true);
  assert.ok(breakdown.notes.some((note) => note.includes('Compacted history is excluded')));
});

test('buildContextWindowBreakdown reconciles estimated contributors that exceed reported usage', () => {
  const breakdown = buildContextWindowBreakdown({
    contextUsage: {
      tokens: 25,
      contextWindow: 1000,
      percent: 2.5,
    },
    effectiveContextWindow: 1000,
    systemPrompts: [],
    transcript: [makeMessage({
      role: 'assistant',
      toolCalls: [
        {
          id: 'oversized-subagent',
          name: 'subagent',
          input: { task: 'large result' },
          result: 'x'.repeat(20_000),
          status: 'completed',
        },
        {
          id: 'oversized-bash',
          name: 'bash',
          input: { command: 'large output' },
          result: 'y'.repeat(10_000),
          status: 'completed',
        },
      ],
    })],
    isPartial: false,
  });

  const attributedTokens = breakdown.entries.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0);
  const subagentTokens = breakdown.entries.find((entry) => entry.label === 'Tool: subagent')?.tokens ?? 0;
  const bashTokens = breakdown.entries.find((entry) => entry.label === 'Tool: bash')?.tokens ?? 0;
  assert.equal(attributedTokens, 25, 'contributor rows must partition the PI-reported used total');
  assert.ok(subagentTokens > bashTokens && bashTokens > 0, 'multiple contributors retain proportional weight');
  assert.equal(breakdown.entries.some((entry) => entry.key === 'other'), false);
  assert.equal(breakdown.summary.usedTokens, 25);
  assert.equal(breakdown.summary.remainingTokens, 975);
  assert.ok(breakdown.notes.some((note) => note.includes('proportionally reconciled')));
});

test('buildContextWindowBreakdown reports unknown usage after compaction when PI has no snapshot', () => {
  const breakdown = buildContextWindowBreakdown({
    contextUsage: null,
    effectiveContextWindow: 200000,
    systemPrompts: [],
    transcript: [
      makeMessage({ id: 'retained-user', role: 'user', markdown: 'recent work retained by pi' }),
      makeMessage({
        id: 'compaction',
        role: 'system',
        customType: 'compaction-summary',
        markdown: 'Summary of the older conversation.',
      }),
    ],
    isPartial: false,
  });

  assert.deepEqual(breakdown.entries, []);
  assert.equal(breakdown.summary.usedTokens, null);
  assert.equal(breakdown.summary.remainingTokens, null);
  assert.ok(breakdown.notes.some((note) => note.includes('does not expose which pre-summary messages PI retained')));
  assert.equal(breakdown.notes.some((note) => note.includes('PI-reported remainder')), false);
});

test('buildContextWindowBreakdown estimates footer values without a PI usage snapshot', () => {
  const breakdown = buildContextWindowBreakdown({
    contextUsage: {
      tokens: null,
      contextWindow: 200000,
      percent: null,
    },
    effectiveContextWindow: 200000,
    systemPrompts: [makePrompt({ source: 'user', availability: 'missing', text: '' })],
    transcript: [],
    isPartial: false,
  });

  const footer = new Map(breakdown.footerEntries.map((entry) => [entry.key, entry]));
  assert.equal(footer.get('window.used')?.value, '0');
  assert.equal(footer.get('window.remaining')?.value, '200,000');
  assert.equal(footer.get('window.total')?.value, '200,000');
});

test('buildContextWindowBreakdown omits a system prompt after its disabled state changes', () => {
  const options = {
    contextUsage: null,
    effectiveContextWindow: 200000,
    systemPrompts: [makePrompt({ text: 'system prompt content' })],
    transcript: [],
    isPartial: false,
  };
  const enabled = buildContextWindowBreakdown(options);
  const disabled = buildContextWindowBreakdown({
    ...options,
    systemPrompts: [makePrompt({ text: 'system prompt content', disabled: true })],
  });

  assert.notEqual(systemPromptsSignature(options.systemPrompts), systemPromptsSignature([{ ...options.systemPrompts[0]!, disabled: true }]));
  assert.ok(enabled.entries.some((entry) => entry.label === 'System prompt'));
  assert.equal(disabled.entries.some((entry) => entry.label === 'System prompt'), false);
});

test('context breakdown key and estimate invalidate for generic tool result content and seq', () => {
  const firstTool = {
    id: 'generic-tool',
    name: 'bash',
    input: { command: 'pwd' },
    result: 'a'.repeat(1000),
    status: 'completed' as const,
  };
  const firstTranscript = [makeMessage({ role: 'assistant', toolCalls: [firstTool] })];
  const changedTool = { ...firstTool, result: 'different-token '.repeat(1000) };
  const changedTranscript = [makeMessage({ role: 'assistant', toolCalls: [changedTool] })];
  assert.notEqual(
    contextBreakdownTranscriptSignature(firstTranscript),
    contextBreakdownTranscriptSignature(changedTranscript),
  );
  const firstTokens = buildContextWindowBreakdown({
    contextUsage: null,
    effectiveContextWindow: 200000,
    systemPrompts: [],
    transcript: firstTranscript,
    isPartial: false,
  }).entries.find((entry) => entry.label === 'Tool: bash')?.tokens;
  const changedTokens = buildContextWindowBreakdown({
    contextUsage: null,
    effectiveContextWindow: 200000,
    systemPrompts: [],
    transcript: changedTranscript,
    isPartial: false,
  }).entries.find((entry) => entry.label === 'Tool: bash')?.tokens;
  assert.notEqual(changedTokens, firstTokens, 'changed generic result must not reuse a stale terminal estimate');

  const liveFirst = { ...firstTool, status: 'running' as const, seq: 1 };
  const liveChanged = { ...liveFirst, result: 'different-token '.repeat(1000), seq: 2 };
  assert.notEqual(
    contextBreakdownTranscriptSignature([makeMessage({ role: 'assistant', toolCalls: [liveFirst] })]),
    contextBreakdownTranscriptSignature([makeMessage({ role: 'assistant', toolCalls: [liveChanged] })]),
  );
});

test('buildContextWindowBreakdown suppresses contributor rows when transcript is partial', () => {
  const breakdown = buildContextWindowBreakdown({
    contextUsage: {
      tokens: 64000,
      contextWindow: 200000,
      percent: 32,
    },
    effectiveContextWindow: 200000,
    systemPrompts: [makePrompt({ text: 'system' })],
    transcript: [
      makeMessage({ id: 'msg-user', role: 'user', markdown: 'hello' }),
      makeMessage({ id: 'msg-assistant', role: 'assistant', markdown: 'world' }),
    ],
    isPartial: true,
  });

  assert.deepEqual(breakdown.entries, []);
  assert.equal(breakdown.summary.usedTokens, 64000);
  assert.equal(breakdown.summary.usedKind, 'exact');
  assert.match(breakdown.title, /partial transcript window is loaded/i);
});

// ─── per-tool-call token cache ──────────────────────────────────────────────

function makeToolCall(overrides: Partial<{ id: string; name: string; input: unknown; result: unknown; status: 'running' | 'completed' | 'failed'; seq: number }> = {}): {
  id: string;
  name: string;
  input: unknown;
  result?: unknown;
  status: 'running' | 'completed' | 'failed';
  seq?: number;
} {
  return {
    id: 'tool-1',
    name: 'run',
    input: 'abcd',
    result: 'abcdefgh',
    status: 'completed',
    ...overrides,
  };
}

function buildWithToolCalls(toolCalls: ReturnType<typeof makeToolCall>[]): ReturnType<typeof buildContextWindowBreakdown> {
  return buildContextWindowBreakdown({
    contextUsage: { tokens: 1000, contextWindow: 200000, percent: 1 },
    effectiveContextWindow: 200000,
    systemPrompts: [],
    transcript: [
      makeMessage({
        id: 'msg-1',
        role: 'assistant',
        markdown: '',
        toolCalls,
      }),
    ],
    isPartial: false,
  });
}

test('per-tool-call token cache: a completed tool call is cached and reused on recompute', () => {
  // The breakdown recomputes on contextUsage / tool-call-signature changes
  // during an active turn. Without the cache each recompute re-runs cl100k_base
  // BPE over every accumulated tool result; the cache makes a recompute skip
  // completed calls whose result already landed (immutable, id-unique).
  clearToolCallTokenCache();
  const tc = makeToolCall({ id: 'cache-hit-1', result: 'a'.repeat(2000) });
  const first = buildWithToolCalls([tc]);
  assert.equal(getToolCallTokenCacheSize(), 1, 'completed tool call should be cached');
  const firstOther = first.entries.find((e) => e.key === 'other')?.value;
  // Recompute with the content-identical call: cache hit, no new entry, same estimate.
  const second = buildWithToolCalls([tc]);
  assert.equal(getToolCallTokenCacheSize(), 1, 'repeat build should hit the cache, not add an entry');
  assert.equal(
    second.entries.find((e) => e.key === 'other')?.value,
    firstOther,
    'cached estimate is stable across recomputes',
  );
});

test('per-tool-call token cache: running tool calls are not cached (no result yet)', () => {
  clearToolCallTokenCache();
  buildWithToolCalls([makeToolCall({ id: 'running-1', status: 'running', result: undefined })]);
  assert.equal(getToolCallTokenCacheSize(), 0, 'running calls have no result and are not cached');
});

test('per-tool-call token cache: a running live revision is reused and invalidated by seq', () => {
  clearToolCallTokenCache();
  const payload = { details: { results: [{ messages: ['x'.repeat(20_000)] }] } };
  const running = makeToolCall({ id: 'running-live-1', name: 'subagent', status: 'running', seq: 7, result: payload });
  const first = buildWithToolCalls([running]);
  assert.equal(getToolCallTokenCacheSize(), 1);
  const second = buildWithToolCalls([{ ...running, result: { changedWithoutRevision: true } }]);
  assert.equal(getToolCallTokenCacheSize(), 1, 'unchanged seq reuses the cached serialized/tokenized preview');
  assert.deepEqual(second.entries, first.entries);

  buildWithToolCalls([{ ...running, seq: 8, result: { changedAtNewRevision: true } }]);
  assert.equal(getToolCallTokenCacheSize(), 2, 'new seq computes and caches a new estimate');
});

test('per-tool-call token cache: distinct completed calls are bounded by LRU eviction', () => {
  clearToolCallTokenCache();
  const toolCalls = [];
  for (let i = 0; i < TOOL_CALL_TOKEN_CACHE_MAX_ENTRIES + 50; i++) {
    toolCalls.push(makeToolCall({ id: `evict-${i}`, result: `payload-${i}` }));
  }
  buildWithToolCalls(toolCalls);
  assert.equal(
    getToolCallTokenCacheSize(),
    TOOL_CALL_TOKEN_CACHE_MAX_ENTRIES,
    'cache should cap and evict LRU entries past the max',
  );
});
