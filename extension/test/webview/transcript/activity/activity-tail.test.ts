import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTIVITY_TAIL_MAX_CHARS,
  ACTIVITY_TAIL_MAX_LINES,
  deriveMultiToolTail,
  deriveRunningToolTail,
  deriveStreamingTail,
  deriveSubagentTail,
  deriveToolTail,
  subagentDetailLines,
  estimateActivityTailHeight,
} from '../../../../src/webview/panel/transcript/activity-tail';
import { deriveTurnActivityState } from '../../../../src/webview/panel/transcript/activity';
import type { ChatMessage, ChatMessagePart, ToolCall } from '../../../../src/shared/protocol';

function makeToolCall(overrides: Partial<ToolCall> & { id?: string; name: string }): ToolCall {
  return {
    id: overrides.id ?? `tc-${overrides.name}`,
    name: overrides.name,
    input: overrides.input,
    result: overrides.result,
    status: overrides.status ?? 'running',
    startedAt: overrides.startedAt,
    durationMs: overrides.durationMs,
  };
}

function streamingAssistant(parts: ChatMessagePart[]): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    createdAt: '2026-05-16T00:00:00.000Z',
    markdown: '',
    status: 'streaming',
    parts,
    toolCalls: [],
  } as unknown as ChatMessage;
}

function userMessage(): ChatMessage {
  return {
    id: 'user-1',
    role: 'user',
    createdAt: '2026-05-16T00:00:00.000Z',
    markdown: 'do the thing',
    status: 'completed',
  } as unknown as ChatMessage;
}

function deriveFor(transcript: ChatMessage[]) {
  return deriveTurnActivityState({
    busy: true,
    transcript,
    prefs: { extensionToggles: {}, activityTailLines: 2 },
    pruningSettings: { mode: 'auto' },
  });
}

// ── deriveStreamingTail ─────────────────────────────────────────────────────

test('deriveStreamingTail surfaces the tail of the most recent reasoning segment', () => {
  const parts: ChatMessagePart[] = [
    { kind: 'reasoning', text: 'old reasoning that should be dropped\nfirst' },
    { kind: 'reasoning', text: 'so we need to do some stuff blah blah blah' },
  ];
  const result = deriveStreamingTail(parts);
  assert.ok(result);
  assert.equal(result.label, 'reasoning');
  assert.equal(result.tail.kind, 'reasoning');
  assert.equal(result.tail.cursor, true);
  assert.deepEqual(result.tail.lines, ['so we need to do some stuff blah blah blah']);
  assert.equal(result.tail.truncated, false);
  assert.equal(result.tail.sourceText, 'so we need to do some stuff blah blah blah');
});

test('deriveStreamingTail does not surface reply text — only reasoning is previewed', () => {
  // Reply text is rendered in the message body above, so it is intentionally not
  // duplicated in the compact bottom preview. Once `text` is the last part the
  // tail falls back to null (the plain "responding" strip renders instead), and
  // pure reply text with no reasoning is also not surfaced.
  const parts: ChatMessagePart[] = [
    { kind: 'reasoning', text: 'planning the answer' },
    { kind: 'text', text: 'Here is the answer so far' },
  ];
  assert.equal(deriveStreamingTail(parts), null);
  assert.equal(deriveStreamingTail([{ kind: 'text', text: 'just the answer' }]), null);
});

test('deriveStreamingTail ignores toolCall parts and returns null when no text/reasoning exists', () => {
  const parts: ChatMessagePart[] = [
    { kind: 'toolCall', toolCall: makeToolCall({ id: 'tc-1', name: 'bash', input: { command: 'ls' } }) },
  ];
  assert.equal(deriveStreamingTail(parts), null);
  assert.equal(deriveStreamingTail([]), null);
  assert.equal(deriveStreamingTail(undefined), null);
});

test('deriveStreamingTail collapses multi-line reasoning into a single flowing line', () => {
  const text = Array.from({ length: ACTIVITY_TAIL_MAX_LINES + 3 }, (_, i) => `line ${i}`).join('\n');
  const result = deriveStreamingTail([{ kind: 'reasoning', text }]);
  assert.ok(result);
  // Fits well within the char budget, so nothing is hidden: source newlines
  // collapse to spaces and the whole tail flows as one wrapping line.
  assert.equal(result.tail.truncated, false);
  assert.equal(result.tail.lines.length, 1);
  assert.deepEqual(result.tail.lines, ['line 0 line 1 line 2 line 3 line 4']);
  assert.equal(result.tail.sourceText, text);
});

test('deriveStreamingTail marks truncated when a single segment exceeds the char cap', () => {
  const huge = 'x'.repeat(2000);
  const result = deriveStreamingTail([{ kind: 'reasoning', text: huge }]);
  assert.ok(result);
  assert.equal(result.tail.truncated, true);
  assert.equal(result.tail.lines.length, 1);
  assert.equal(result.tail.lines[0]!.length, 480);
  assert.equal(result.tail.sourceText, huge);
});

// ── deriveToolTail ───────────────────────────────────────────────────────────

test('deriveToolTail shows the bash command plus the tail of streaming output', () => {
  const toolCall = makeToolCall({
    name: 'bash',
    input: { command: 'npm run test' },
    result: {
      content: [{ type: 'text', text: 'running...\nsomefile.py pass\nsomefile2.py pass' }],
      details: {},
    },
  });
  const result = deriveToolTail(toolCall);
  assert.ok(result);
  assert.equal(result.label, 'bash');
  assert.equal(result.tail.kind, 'tool');
  assert.equal(result.tail.label, 'bash');
  assert.equal(result.tail.inputLine, 'npm run test');
  assert.equal(result.tail.cursor, true);
  assert.deepEqual(result.tail.lines, ['running... somefile.py pass somefile2.py pass']);
  assert.equal(result.tail.truncated, false);
  assert.equal(result.tail.sourceText, 'running...\nsomefile.py pass\nsomefile2.py pass');
});

test('deriveToolTail renders the command + a lone cursor before any output arrives', () => {
  const toolCall = makeToolCall({ name: 'bash', input: { command: 'npm run test' } });
  const result = deriveToolTail(toolCall);
  assert.ok(result);
  assert.equal(result.tail.inputLine, 'npm run test');
  assert.deepEqual(result.tail.lines, []);
  assert.equal(result.tail.cursor, true);
  assert.equal(result.tail.sourceText, undefined);
});

test('deriveToolTail marks truncated when output exceeds the line cap and honors SDK truncation', () => {
  const lines = Array.from({ length: ACTIVITY_TAIL_MAX_LINES + 2 }, (_, i) => `out ${i}`);
  const toolCall = makeToolCall({
    name: 'bash',
    input: { command: 'heavy' },
    result: { content: [{ type: 'text', text: lines.join('\n') }], details: {} },
  });
  const result = deriveToolTail(toolCall);
  assert.ok(result);
  // Output fits the char budget, so it is shown in full (collapsed) — not truncated.
  assert.equal(result.tail.truncated, false);
  assert.equal(result.tail.lines.length, 1);
  assert.deepEqual(result.tail.lines, ['out 0 out 1 out 2 out 3']);

  const sdkTruncated = makeToolCall({
    name: 'bash',
    input: { command: 'c' },
    result: {
      content: [{ type: 'text', text: 'only line' }],
      details: { truncation: { truncated: true } },
    },
  });
  const sdkResult = deriveToolTail(sdkTruncated);
  assert.ok(sdkResult);
  assert.equal(sdkResult!.tail.truncated, true);
});

test('deriveToolTail returns null for a tool with no input summary and no output', () => {
  const toolCall = makeToolCall({ name: 'mystery', input: {} });
  assert.equal(deriveToolTail(toolCall), null);
});

test('deriveToolTail omits tools that surface their own visible UI (ask_user)', () => {
  const toolCall = makeToolCall({
    name: 'ask_user',
    input: { question: 'pick one', options: ['a', 'b'] },
    result: { content: [{ type: 'text', text: 'prompt shown to user' }], details: {} },
  });
  // The ask_user prompt is already shown to the user, so it is omitted from the
  // bottom preview tail to avoid duplicate visibility.
  assert.equal(deriveToolTail(toolCall), null);
});

test('deriveToolTail marks truncated and char-bounds output that exceeds the char cap', () => {
  const toolCall = makeToolCall({
    name: 'bash',
    input: { command: 'heavy' },
    result: { content: [{ type: 'text', text: 'x'.repeat(800) }], details: {} },
  });
  const result = deriveToolTail(toolCall);
  assert.ok(result);
  assert.equal(result.tail.truncated, true);
  assert.equal(result.tail.lines.length, 1);
  assert.equal(result.tail.lines[0]!.length, ACTIVITY_TAIL_MAX_CHARS);
  assert.equal(result.tail.sourceText, 'x'.repeat(800));
});

// ── deriveSubagentTail ───────────────────────────────────────────────────────

function subagentResult(runningTools?: string[], streamingText?: string, exitCode = -1) {
  return {
    content: [{ type: 'text', text: 'subagent running' }],
    details: {
      results: [
        {
          agent: 'worker',
          task: 'fix the failing tests',
          exitCode,
          messages: [],
          runningTools,
          streamingText,
        },
      ],
    },
  };
}

test('deriveSubagentTail peeks into a running subagent and shows its running tool', () => {
  const toolCall = makeToolCall({
    name: 'subagent',
    status: 'running',
    input: { agent: 'worker', task: 'fix the failing tests' },
    result: subagentResult(['bash', 'read']),
  });
  const result = deriveSubagentTail(toolCall);
  assert.ok(result);
  assert.equal(result.label, 'worker');
  assert.equal(result.tail.kind, 'subagent');
  assert.equal(result.tail.label, 'worker');
  assert.equal(result.tail.inputLine, 'fix the failing tests');
  assert.equal(result.tail.cursor, true);
  assert.deepEqual(result.tail.lines, ['→ bash · read']);
});

test('deriveSubagentTail fills idle preview rows with lifecycle and model diagnostics', () => {
  const now = Date.now();
  const result = subagentResult() as any;
  Object.assign(result.details.results[0], {
    activityPhase: 'waiting_provider',
    activityDetail: 'first token',
    activitySince: now - 17_000,
    lastProgressAt: now - 18_000,
    inactivityBudgetMs: 120_000,
    selectedModel: 'openai/gpt-5.2',
    provider: 'openai',
    contextWindow: 200_000,
    thinkingLevel: 'high',
    retryCount: 1,
    selectionPool: ['openai/gpt-5.2', 'anthropic/claude-opus-4.1'],
    usage: { input: 1250, output: 42, cacheRead: 1000, cacheWrite: 0, contextTokens: 50_000 },
    turnThroughputSamples: [{ endedAt: '2026-01-01T00:00:00.000Z', outputTokens: 100, generationDurationMs: 10_000, status: 'completed' }],
  });
  const toolCall = makeToolCall({
    name: 'subagent',
    status: 'running',
    input: { agent: 'worker', task: 'fix the failing tests' },
    result,
  });

  const tail = deriveSubagentTail(toolCall);
  assert.ok(tail);
  assert.match(tail.tail.lines[0]!, /Waiting for provider · first token · \d+s in state · \d+s since progress · 2m 0s stall limit/);
  assert.equal(tail.tail.lines[1], 'openai/gpt-5.2 · thinking high · context 50k / 200k (25%) · tokens 1.3k in / 42 out · 1.0k cached · last 10.0 tok/s · 1 retry · 2 model candidates');
});

test('subagent detail omits zero-output terminal throughput samples', () => {
  const result = subagentResult() as any;
  Object.assign(result.details.results[0], {
    usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 10 },
    turnThroughputSamples: [{ endedAt: '2026-01-01T00:00:00.000Z', outputTokens: 0, generationDurationMs: 10_000, status: 'error' }],
  });
  const lines = subagentDetailLines(result.details.results[0]);
  assert.doesNotMatch(lines.join(' · '), /last .*0\.0 tok\/s/);
});

test('deriveSubagentTail falls back to the tail of streaming text when no tool is running', () => {
  const toolCall = makeToolCall({
    name: 'subagent',
    status: 'running',
    input: { agent: 'worker', task: 'fix the failing tests' },
    result: subagentResult(undefined, 'thinking\nabout it\nso we need to do some stuff'),
  });
  const result = deriveSubagentTail(toolCall);
  assert.ok(result);
  assert.deepEqual(result.tail.lines, ['so we need to do some stuff']);
});

test('deriveSubagentTail returns null when no sub-result is still running', () => {
  const toolCall = makeToolCall({
    name: 'subagent',
    status: 'completed',
    input: { agent: 'worker', task: 'fix the failing tests' },
    result: subagentResult(undefined, undefined, 0),
  });
  assert.equal(deriveSubagentTail(toolCall), null);
});

// ── deriveRunningToolTail / deriveMultiToolTail ─────────────────────────────

test('deriveRunningToolTail routes subagent calls to the subagent derivation', () => {
  const sub = makeToolCall({
    name: 'subagent',
    status: 'running',
    input: { agent: 'worker', task: 't' },
    result: subagentResult(['bash']),
  });
  const routed = deriveRunningToolTail(sub);
  assert.ok(routed);
  assert.equal(routed.tail.kind, 'subagent');

  const bash = makeToolCall({ name: 'bash', input: { command: 'ls' }, result: { content: [{ type: 'text', text: 'a\nb' }] } });
  const routedBash = deriveRunningToolTail(bash);
  assert.ok(routedBash);
  assert.equal(routedBash!.tail.kind, 'tool');
  assert.equal(routedBash!.label, 'bash');
});

test('deriveRunningToolTail returns null for an omitted tool (ask_user)', () => {
  const askUser = makeToolCall({
    name: 'ask_user',
    status: 'running',
    input: { question: 'pick one', options: ['a', 'b'] },
    result: { content: [{ type: 'text', text: 'prompt shown' }], details: {} },
  });
  // Omitted tools fall back to the generic activity strip (no preview tail).
  assert.equal(deriveRunningToolTail(askUser), null);
});

test('deriveMultiToolTail lists each running tool and caps to the line budget', () => {
  const tools = Array.from({ length: ACTIVITY_TAIL_MAX_LINES + 2 }, (_, i) =>
    makeToolCall({ id: `tc-${i}`, name: `tool${i}`, input: {} }),
  );
  const result = deriveMultiToolTail(tools);
  assert.equal(result.label, `running ${tools.length} tools`);
  assert.equal(result.tail.label, `running ${tools.length} tools`);
  assert.equal(result.tail.lines.length, ACTIVITY_TAIL_MAX_LINES);
  assert.equal(result.tail.truncated, true);
  assert.equal(result.tail.lines[0], '→ tool2');
});

// ── sourceText: discrete-line tails omit it ─────────────────────────────────

test('deriveSubagentTail and deriveMultiToolTail omit sourceText (discrete status lines, not a growing char stream)', () => {
  const sub = makeToolCall({
    name: 'subagent',
    status: 'running',
    input: { agent: 'worker', task: 't' },
    result: subagentResult(['bash', 'read']),
  });
  const subResult = deriveSubagentTail(sub);
  assert.ok(subResult);
  assert.equal(subResult!.tail.sourceText, undefined);

  const multi = deriveMultiToolTail([
    makeToolCall({ id: 'tc-0', name: 'bash', input: {} }),
    makeToolCall({ id: 'tc-1', name: 'read', input: {} }),
  ]);
  assert.equal(multi.tail.sourceText, undefined);
});

// ── estimateActivityTailHeight ────────────────────────────────────────────

test('estimateActivityTailHeight scales with rendered rows and is zero without a tail', () => {
  assert.equal(estimateActivityTailHeight(null), 0);
  assert.equal(estimateActivityTailHeight(undefined), 0);
  const withRows = deriveToolTail(
    makeToolCall({
      name: 'bash',
      input: { command: 'npm run test' },
      result: { content: [{ type: 'text', text: 'a\nb\nc' }], details: {} },
    }),
  )!;
  const height = estimateActivityTailHeight(withRows.tail);
  assert.ok(height > 0);
  // Tools reserve a 3-row block (label ▸ input on row 1 + two output rows).
  assert.equal(height, 3 * 18 + 8);
});

// ── deriveTurnActivityState integration ─────────────────────────────────────

test('deriveTurnActivityState labels a running compaction as compacting history', () => {
  // Compaction emits no message_start/message_end: the transcript still shows
  // the previous completed turn, which would otherwise read as "thinking".
  const transcript = [userMessage(), streamingAssistant([])];
  const state = deriveTurnActivityState({
    busy: true,
    compacting: true,
    transcript,
    prefs: { extensionToggles: {}, activityTailLines: 2 },
    pruningSettings: { mode: 'auto' },
  });
  assert.ok(state);
  assert.equal(state!.phase, 'compacting');
  assert.equal(state!.label, 'compacting history');
  assert.equal(state!.ariaLabel, 'Agent is compacting conversation history');
  assert.equal(state!.tone, 'processing');
});

test('deriveTurnActivityState ignores compacting when the session is idle', () => {
  const state = deriveTurnActivityState({
    busy: false,
    compacting: true,
    transcript: [],
    prefs: { extensionToggles: {}, activityTailLines: 2 },
    pruningSettings: { mode: 'auto' },
  });
  assert.equal(state, null);
});

test('deriveTurnActivityState keeps reasoning lifecycle-only when ReasoningBlock owns the stream', () => {
  const transcript = [userMessage(), streamingAssistant([{ kind: 'reasoning', text: 'planning the work' }])];
  const state = deriveFor(transcript);
  assert.ok(state);
  assert.equal(state!.phase, 'streaming');
  assert.equal(state!.label, 'reasoning');
  assert.equal(state!.tail, undefined);
});

test('deriveTurnActivityState identifies a streaming tool-call draft and reports its token count', () => {
  const assistant = streamingAssistant([]);
  assistant.draftingToolCall = {
    id: 'tc-bash',
    name: 'bash',
    argumentsText: '{"command":"npm test"}',
  };

  const state = deriveFor([userMessage(), assistant]);
  assert.ok(state);
  assert.equal(state!.phase, 'draftingTool');
  assert.equal(state!.label, 'drafting bash call');
  assert.match(state!.detail!, /^\d+ tokens?$/);
  assert.match(state!.ariaLabel, /^Agent is drafting a bash tool call, \d+ tokens?$/);
});

test('deriveTurnActivityState represents projected drafting and ready tool rows without a duplicate tail', () => {
  const drafting = streamingAssistant([{
    kind: 'toolCall',
    toolCall: makeToolCall({
      id: 'draft-1',
      name: 'read',
      status: 'drafting',
      input: '{"path":',
      argumentsText: '{"path":',
    }),
  }]);
  const draftState = deriveFor([userMessage(), drafting]);
  assert.equal(draftState?.label, 'drafting read call');
  assert.equal(draftState?.tail, undefined);

  const ready = streamingAssistant([{
    kind: 'toolCall',
    toolCall: makeToolCall({
      id: 'draft-1',
      name: 'read',
      status: 'ready',
      input: '{"path":"src/a.ts"}',
      argumentsText: '{"path":"src/a.ts"}',
    }),
  }]);
  const readyState = deriveFor([userMessage(), ready]);
  assert.equal(readyState?.label, 'read call ready');
  assert.match(readyState?.ariaLabel ?? '', /^read tool call is ready/);
  assert.equal(readyState?.tail, undefined);
});

test('deriveTurnActivityState keeps running-tool lifecycle-only when the card owns output', () => {
  const assistant: ChatMessage = {
    id: 'assistant-1',
    role: 'assistant',
    createdAt: '2026-05-16T00:00:00.000Z',
    markdown: '',
    status: 'completed',
    parts: [
      { kind: 'toolCall', toolCall: makeToolCall({ id: 'tc-1', name: 'bash', input: { command: 'npm run test' }, result: { content: [{ type: 'text', text: 'somefile.py pass' }], details: {} } }) },
    ],
    toolCalls: [],
  } as unknown as ChatMessage;
  const transcript = [userMessage(), assistant];
  const state = deriveFor(transcript);
  assert.ok(state);
  assert.equal(state!.phase, 'runningTool');
  assert.equal(state!.label, 'running bash');
  assert.equal(state!.runningToolName, 'bash');
  assert.equal(state!.tail, undefined);
});

test('deriveTurnActivityState omits a tail for a running ask_user (the prompt UI is the surface)', () => {
  const assistant: ChatMessage = {
    id: 'assistant-1',
    role: 'assistant',
    createdAt: '2026-05-16T00:00:00.000Z',
    markdown: '',
    status: 'completed',
    parts: [
      { kind: 'toolCall', toolCall: makeToolCall({ id: 'tc-1', name: 'ask_user', status: 'running', input: { question: 'pick one' }, result: { content: [{ type: 'text', text: 'prompt' }], details: {} } }) },
    ],
    toolCalls: [],
  } as unknown as ChatMessage;
  const state = deriveFor([userMessage(), assistant]);
  assert.ok(state);
  assert.equal(state!.phase, 'runningTool');
  // Falls back to the generic strip label; no preview tail is derived.
  assert.equal(state!.label, 'running ask_user');
  assert.equal(state!.runningToolName, 'ask_user');
  assert.equal(state!.tail, undefined);
});

test('deriveTurnActivityState omits the redundant bottom tail while a subagent card previews the run', () => {
  const assistant: ChatMessage = {
    id: 'assistant-1',
    role: 'assistant',
    createdAt: '2026-05-16T00:00:00.000Z',
    markdown: '',
    status: 'completed',
    parts: [
      { kind: 'toolCall', toolCall: makeToolCall({ id: 'tc-1', name: 'subagent', status: 'running', input: { agent: 'worker', task: 'fix it' }, result: subagentResult(['bash']) }) },
    ],
    toolCalls: [],
  } as unknown as ChatMessage;
  const transcript = [userMessage(), assistant];
  const state = deriveFor(transcript);
  assert.ok(state);
  assert.equal(state!.phase, 'runningTool');
  assert.equal(state!.label, 'running subagent');
  assert.equal(state!.runningToolName, 'subagent');
  assert.equal(state!.tail, undefined);
});

test('deriveTurnActivityState suppresses the multi-tool preview rows when any running tool is a subagent', () => {
  // A parallel batch mixing a subagent with a plain tool: the subagent card
  // already previews its own live child activity, so the bottom multi-tool
  // preview rows are suppressed — but the compact status strip stays.
  const assistant: ChatMessage = {
    id: 'assistant-1',
    role: 'assistant',
    createdAt: '2026-05-16T00:00:00.000Z',
    markdown: '',
    status: 'completed',
    parts: [
      { kind: 'toolCall', toolCall: makeToolCall({ id: 'tc-sub', name: 'subagent', status: 'running', input: { agent: 'worker', task: 'fix it' }, result: subagentResult(['bash']) }) },
      { kind: 'toolCall', toolCall: makeToolCall({ id: 'tc-bash', name: 'bash', status: 'running', input: { command: 'npm run test' }, result: { content: [{ type: 'text', text: 'running...' }], details: {} } }) },
    ],
    toolCalls: [],
  } as unknown as ChatMessage;
  const state = deriveFor([userMessage(), assistant]);
  assert.ok(state);
  assert.equal(state!.phase, 'runningTool');
  assert.equal(state!.label, 'running 2 tools');
  // The compact strip still carries the count and the tool-name detail.
  assert.equal(state!.runningToolSummary, 'running 2 tools');
  assert.equal(state!.detail, 'subagent, bash');
  // ...but the duplicate multi-tool preview rows are gone.
  assert.equal(state!.tail, undefined);
});

test('deriveTurnActivityState keeps multi-tool activity lifecycle-only because each card owns its preview', () => {
  const assistant: ChatMessage = {
    id: 'assistant-1',
    role: 'assistant',
    createdAt: '2026-05-16T00:00:00.000Z',
    markdown: '',
    status: 'completed',
    parts: [
      { kind: 'toolCall', toolCall: makeToolCall({ id: 'tc-bash', name: 'bash', status: 'running', input: { command: 'npm run test' }, result: { content: [{ type: 'text', text: 'running...' }], details: {} } }) },
      { kind: 'toolCall', toolCall: makeToolCall({ id: 'tc-read', name: 'read', status: 'running', input: { path: 'a.ts' } }) },
    ],
    toolCalls: [],
  } as unknown as ChatMessage;
  const state = deriveFor([userMessage(), assistant]);
  assert.ok(state);
  assert.equal(state!.phase, 'runningTool');
  assert.equal(state!.label, 'running 2 tools');
  assert.equal(state!.detail, 'bash, read');
  assert.equal(state!.tail, undefined);
});
