import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatToolCallResultForDisplay,
  getRenderableSubagentResult,
  getRenderableSubagentResultFromToolCall,
  rawMessagesToChatMessages,
  subagentSingleResultToChatMessages,
} from '../src/webview/panel/transcript';
import { singleResultStatus, subagentActivity } from '../src/webview/panel/transcript/tool-call-item';

test('rawMessagesToChatMessages resolves subagent toolResult messages by toolCallId', () => {
  const messages = rawMessagesToChatMessages([
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Checking files' },
        { type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'pwd' } },
        { type: 'toolCall', id: 'tc-2', name: 'read', arguments: { path: 'panel.css' } },
      ],
      timestamp: Date.parse('2026-01-01T00:00:00.000Z'),
    },
    {
      role: 'toolResult',
      toolCallId: 'tc-1',
      details: { exitCode: 0 },
      timestamp: Date.parse('2026-01-01T00:00:01.000Z'),
    },
  ] as any, 'subagent');

  const assistant = messages.find((message) => message.role === 'assistant');

  assert.deepEqual(
    assistant?.toolCalls?.map((toolCall) => ({
      id: toolCall.id,
      status: toolCall.status,
      result: toolCall.result,
    })),
    [
      { id: 'tc-1', status: 'completed', result: { exitCode: 0 } },
      { id: 'tc-2', status: 'running', result: undefined },
    ],
  );
});

test('rawMessagesToChatMessages preserves failed subagent tool results', () => {
  const messages = rawMessagesToChatMessages([
    {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'exit 1' } },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: 'tc-1',
      content: 'permission denied',
      isError: true,
    },
  ] as any, 'subagent');

  const assistant = messages.find((message) => message.role === 'assistant');

  assert.equal(assistant?.toolCalls?.[0]?.status, 'failed');
  assert.equal(assistant?.toolCalls?.[0]?.result, 'permission denied');
});

test('rawMessagesToChatMessages still supports legacy user-carried tool results', () => {
  const messages = rawMessagesToChatMessages([
    {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'tc-1', name: 'read', arguments: { path: 'panel.css' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'toolResult', id: 'tc-1', result: { lines: 42 } },
      ],
    },
  ] as any, 'subagent');

  const assistant = messages.find((message) => message.role === 'assistant');

  assert.equal(assistant?.toolCalls?.[0]?.status, 'completed');
  assert.deepEqual(assistant?.toolCalls?.[0]?.result, { lines: 42 });
});

test('rawMessagesToChatMessages merges adjacent assistant chunks and keeps reasoning parts', () => {
  const messages = rawMessagesToChatMessages([
    {
      role: 'assistant',
      content: 'Starting analysis. ',
      timestamp: Date.parse('2026-01-01T00:00:00.000Z'),
    },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Inspect files carefully. ' },
        { type: 'text', text: 'Done.' },
        { type: 'toolCall', id: 'tc-1', name: 'read', arguments: { path: 'panel.css' } },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: 'tc-1',
      details: { lines: 42 },
    },
  ] as any, 'subagent');

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, 'assistant');
  assert.equal(messages[0]?.markdown, 'Starting analysis. Done.');
  assert.equal(messages[0]?.thinking, 'Inspect files carefully. ');
  assert.equal(messages[0]?.toolCalls?.[0]?.status, 'completed');
  assert.deepEqual(messages[0]?.toolCalls?.[0]?.result, { lines: 42 });
});

test('rawMessagesToChatMessages joins multi-part user text with paragraph breaks', () => {
  const messages = rawMessagesToChatMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'First paragraph' },
        { type: 'text', text: 'Second paragraph' },
      ],
    },
  ] as any, 'subagent');

  assert.deepEqual(
    messages.map((message) => ({ role: message.role, markdown: message.markdown })),
    [{ role: 'user', markdown: 'First paragraph\n\nSecond paragraph' }],
  );
});

test('getRenderableSubagentResult falls back when a failed parallel dispatch has no child results', () => {
  assert.equal(getRenderableSubagentResult({
    content: [{ type: 'text', text: 'Too many parallel tasks (6). Max is 5.' }],
    details: {
      mode: 'parallel',
      results: [],
    },
    isError: true,
  } as any), undefined);
});

test('running subagent placeholders stay visibly active before the first progress update', () => {
  const result = {
    agent: 'reviewer',
    task: 'Inspect regression',
    exitCode: -1 as const,
    messages: [],
  };
  assert.equal(singleResultStatus(result, 'running', false), 'running');
  assert.deepEqual(subagentActivity(result, 1_000), {
    label: 'Starting',
    detail: 'waiting for first status update',
    elapsed: undefined,
    diagnostic: 'Starting · waiting for first status update',
  });
});

test('terminal tool status overrides stale child running-tool state', () => {
  const staleCompleted = {
    agent: 'reviewer',
    task: 'Inspect regression',
    exitCode: 0,
    messages: [],
    runningTools: ['bash'],
  };
  assert.equal(singleResultStatus(staleCompleted, 'completed', false), 'completed');

  const staleFailed = { ...staleCompleted, exitCode: 1, stopReason: 'error' as const };
  assert.equal(singleResultStatus(staleFailed, 'completed', false), 'failed');
  assert.equal(singleResultStatus(staleCompleted, 'failed', false), 'failed');
});

test('explicitly queued subagents explain the concurrency wait while retaining the idle treatment', () => {
  const result = {
    agent: 'reviewer',
    task: 'Inspect regression',
    exitCode: -1,
    messages: [],
    activityPhase: 'queued' as const,
    activityDetail: 'waiting for parallel worker slot',
    activitySince: 1_000,
  };
  assert.equal(singleResultStatus(result, 'running', false), 'idle');
  assert.deepEqual(subagentActivity(result, 16_000), {
    label: 'Waiting for concurrency',
    detail: 'waiting for parallel worker slot',
    elapsed: '15s',
    diagnostic: 'Waiting for concurrency · waiting for parallel worker slot · 15s in this state',
  });
});

test('getRenderableSubagentResultFromToolCall synthesizes running single-mode state from input', () => {
  assert.deepEqual(
    getRenderableSubagentResultFromToolCall({
      input: { agent: 'reviewer', task: 'Inspect regression' },
      result: undefined,
      status: 'running',
    } as any),
    {
      mode: 'single',
      results: [{
        agent: 'reviewer',
        task: 'Inspect regression',
        exitCode: -1,
        messages: [],
        activityPhase: 'preparing',
        activityDetail: 'waiting for subagent runtime status',
      }],
    },
  );
});

test('getRenderableSubagentResult prefers top-level results when both top-level and nested details exist', () => {
  const result = getRenderableSubagentResult({
    mode: 'single',
    results: [{
      agent: 'scout',
      task: 'Inspect regression',
      exitCode: 0,
      messages: [],
    }],
    details: {
      mode: 'single',
      results: [{
        agent: 'reviewer',
        task: 'Review regression',
        exitCode: 1,
        messages: [],
      }],
    },
  } as any);

  assert.equal(result?.results[0]?.agent, 'scout');
});

test('getRenderableSubagentResult reads nested details payloads when top-level results are absent', () => {
  const result = getRenderableSubagentResult({
    details: {
      mode: 'parallel',
      results: [{
        agent: 'reviewer',
        task: 'Review regression',
        exitCode: 0,
        messages: [],
      }],
    },
  } as any);

  assert.equal(result?.mode, 'parallel');
  assert.equal(result?.results[0]?.agent, 'reviewer');
});

test('getRenderableSubagentResultFromToolCall synthesizes fresh running chain-mode state from the first step', () => {
  assert.deepEqual(
    getRenderableSubagentResultFromToolCall({
      input: {
        chain: [
          { agent: 'planner', task: 'Plan the work' },
          { agent: 'reviewer', task: 'Review the result' },
        ],
      },
      result: undefined,
      status: 'running',
    } as any),
    {
      mode: 'chain',
      results: [{
        agent: 'planner',
        task: 'Plan the work',
        exitCode: -1,
        messages: [],
        activityPhase: 'preparing',
        activityDetail: 'waiting for subagent runtime status',
      }],
    },
  );
});

test('getRenderableSubagentResultFromToolCall keeps single-mode progress updates running until the top-level tool finishes', () => {
  const result = getRenderableSubagentResultFromToolCall({
    input: { agent: 'reviewer', task: 'Inspect regression' },
    result: {
      details: {
        mode: 'single',
        results: [{
          agent: 'reviewer',
          task: 'Inspect regression',
          exitCode: 0,
          messages: [],
          runningTools: ['bash'],
        }],
      },
    },
    status: 'running',
  } as any);

  assert.equal(result?.mode, 'single');
  assert.equal(result?.results[0]?.exitCode, -1);
  assert.deepEqual(result?.results[0]?.runningTools, ['bash']);
});

test('getRenderableSubagentResultFromToolCall keeps empty multi-result progress updates running until the top-level tool finishes', () => {
  for (const mode of ['parallel', 'chain'] as const) {
    const result = getRenderableSubagentResultFromToolCall({
      input: mode === 'parallel'
        ? { tasks: [{ agent: 'reviewer', task: 'Step one' }] }
        : { chain: [{ agent: 'reviewer', task: 'Step one' }] },
      result: {
        details: {
          mode,
          results: [{
            agent: 'reviewer',
            task: 'Step one',
            exitCode: 0,
            messages: [],
            runningTools: ['bash'],
          }],
        },
      },
      status: 'running',
    } as any);

    assert.equal(result?.results[0]?.exitCode, -1, `${mode} child should stay running`);
    assert.deepEqual(
      subagentSingleResultToChatMessages(result!.results[0]!, mode).map((message) => message.markdown),
      ['Step one'],
      `${mode} child should not render a premature no-output fallback`,
    );
  }
});

test('getRenderableSubagentResultFromToolCall keeps completed child output visible while the parent call is still running', () => {
  const result = getRenderableSubagentResultFromToolCall({
    input: { agent: 'reviewer', task: 'Inspect regression' },
    result: {
      details: {
        mode: 'single',
        results: [{
          agent: 'reviewer',
          task: 'Inspect regression',
          exitCode: 0,
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }],
        }],
      },
    },
    status: 'running',
  } as any);

  assert.equal(result?.results[0]?.exitCode, 0);
  assert.deepEqual(
    subagentSingleResultToChatMessages(result!.results[0]!, 'subagent').map((message) => message.markdown),
    ['Inspect regression', 'Done.'],
  );
});

test('getRenderableSubagentResultFromToolCall preserves failed child states while the parent call is still running', () => {
  const result = getRenderableSubagentResultFromToolCall({
    input: { agent: 'reviewer', task: 'Inspect regression' },
    result: {
      details: {
        mode: 'single',
        results: [{
          agent: 'reviewer',
          task: 'Inspect regression',
          exitCode: 1,
          messages: [],
          errorMessage: 'spawn EPERM',
        }],
      },
    },
    status: 'running',
  } as any);

  assert.equal(result?.results[0]?.exitCode, 1);
  assert.equal(result?.results[0]?.errorMessage, 'spawn EPERM');
});

test('getRenderableSubagentResultFromToolCall ignores running placeholders without valid agent and task text', () => {
  assert.equal(
    getRenderableSubagentResultFromToolCall({
      input: {
        tasks: [
          { agent: '   ', task: 'Inspect regression' },
          { agent: 'reviewer', task: '   ' },
        ],
      },
      result: undefined,
      status: 'running',
    } as any),
    undefined,
  );
});

test('getRenderableSubagentResultFromToolCall leaves completed result payloads unchanged once the parent call is done', () => {
  const result = getRenderableSubagentResultFromToolCall({
    input: { agent: 'reviewer', task: 'Inspect regression' },
    result: {
      details: {
        mode: 'single',
        results: [{
          agent: 'reviewer',
          task: 'Inspect regression',
          exitCode: 0,
          messages: [],
        }],
      },
    },
    status: 'completed',
  } as any);

  assert.equal(result?.results[0]?.exitCode, 0);
});

test('formatToolCallResultForDisplay extracts readable top-level subagent failure text', () => {
  assert.equal(
    formatToolCallResultForDisplay({
      name: 'subagent',
      result: {
        content: [{ type: 'text', text: 'Too many parallel tasks (6). Max is 5.' }],
        details: { mode: 'parallel', results: [] },
        isError: true,
      },
    }),
    'Too many parallel tasks (6). Max is 5.',
  );
});

test('rawMessagesToChatMessages preserves top-level subagent failure content when details are present', () => {
  const messages = rawMessagesToChatMessages([
    {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'tc-sub', name: 'subagent', arguments: { tasks: [{ agent: 'scout', task: 'Investigate' }] } },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: 'tc-sub',
      content: [{ type: 'text', text: 'Too many parallel tasks (6). Max is 5.' }],
      details: { mode: 'parallel', results: [] },
      isError: true,
    },
  ] as any, 'subagent');

  const toolCall = messages.find((message) => message.role === 'assistant')?.toolCalls?.[0];

  assert.equal(toolCall?.status, 'failed');
  assert.equal(getRenderableSubagentResult(toolCall?.result), undefined);
  assert.equal(formatToolCallResultForDisplay(toolCall as any), 'Too many parallel tasks (6). Max is 5.');
});

test('subagentSingleResultToChatMessages prepends the delegated task when nested messages have no user turn', () => {
  const messages = subagentSingleResultToChatMessages({
    agent: 'reviewer',
    task: 'Inspect regression',
    exitCode: 0,
    messages: [{
      role: 'assistant',
      content: [{ type: 'text', text: 'Looks good.' }],
    }],
  } as any, 'subagent');

  assert.deepEqual(
    messages.map((message) => ({ role: message.role, markdown: message.markdown, status: message.status })),
    [
      { role: 'user', markdown: 'Inspect regression', status: 'completed' },
      { role: 'assistant', markdown: 'Looks good.', status: 'completed' },
    ],
  );
});

test('subagentSingleResultToChatMessages does not duplicate a nested delegated user task', () => {
  const messages = subagentSingleResultToChatMessages({
    agent: 'reviewer',
    task: 'Outer task',
    exitCode: 0,
    messages: [
      {
        role: 'user',
        content: 'Inner delegated task',
      },
      {
        role: 'assistant',
        content: 'Resolved.',
      },
    ],
  } as any, 'subagent');

  assert.deepEqual(
    messages.map((message) => ({ role: message.role, markdown: message.markdown })),
    [
      { role: 'user', markdown: 'Inner delegated task' },
      { role: 'assistant', markdown: 'Resolved.' },
    ],
  );
});

test('subagentSingleResultToChatMessages synthesizes failure details when no nested messages exist', () => {
  const messages = subagentSingleResultToChatMessages({
    agent: 'reviewer',
    task: 'Inspect dispatch failure',
    exitCode: 1,
    messages: [],
    stderr: 'spawn EPERM',
    stopReason: 'error',
  } as any, 'subagent');

  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, 'user');
  assert.equal(messages[0]?.markdown, 'Inspect dispatch failure');
  assert.equal(messages[1]?.status, 'error');
  assert.match(messages[1]?.markdown ?? '', /spawn EPERM/);
});

test('subagentSingleResultToChatMessages trims aborted fallback details', () => {
  const messages = subagentSingleResultToChatMessages({
    agent: 'reviewer',
    task: 'Inspect cancellation',
    exitCode: 1,
    messages: [],
    stderr: '  cancelled by caller  ',
    stopReason: 'aborted',
  } as any, 'subagent');

  assert.equal(messages[1]?.markdown, 'Aborted: cancelled by caller');
  assert.equal(messages[1]?.status, 'error');
});

test('subagentSingleResultToChatMessages uses exit codes when no explicit stop reason is present', () => {
  const messages = subagentSingleResultToChatMessages({
    agent: 'reviewer',
    task: 'Inspect process failure',
    exitCode: 23,
    messages: [],
    stderr: ' permission denied ',
  } as any, 'subagent');

  assert.equal(messages[1]?.markdown, 'Exit code 23: permission denied');
  assert.equal(messages[1]?.status, 'error');
});

test('subagentSingleResultToChatMessages uses a generic failure message when no details are available', () => {
  const messages = subagentSingleResultToChatMessages({
    agent: 'reviewer',
    task: 'Inspect unexplained failure',
    exitCode: 2,
    messages: [],
  } as any, 'subagent');

  assert.equal(messages[1]?.markdown, 'Exit code 2: agent failed before producing any output.');
  assert.equal(messages[1]?.status, 'error');
});

test('subagentSingleResultToChatMessages keeps placeholder running results in task form instead of mislabeling them as failures', () => {
  const messages = subagentSingleResultToChatMessages({
    agent: 'reviewer',
    task: 'Inspect dispatch failure',
    exitCode: -1,
    messages: [],
    runningTools: ['bash'],
  } as any, 'subagent');

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, 'user');
  assert.equal(messages[0]?.markdown, 'Inspect dispatch failure');
});

test('subagentSingleResultToChatMessages renders streaming assistant output for in-progress runs', () => {
  const messages = subagentSingleResultToChatMessages({
    agent: 'reviewer',
    task: 'Inspect streaming output',
    exitCode: -1,
    messages: [],
    streamingText: 'Still working... ',
  } as any, 'subagent');

  assert.deepEqual(
    messages.map((message) => ({ role: message.role, markdown: message.markdown, status: message.status })),
    [
      { role: 'user', markdown: 'Inspect streaming output', status: 'completed' },
      { role: 'assistant', markdown: 'Still working...', status: 'streaming' },
    ],
  );
});

test('subagentSingleResultToChatMessages renders a completed no-output fallback when no task or nested transcript exists', () => {
  const messages = subagentSingleResultToChatMessages({
    agent: 'reviewer',
    task: '   ',
    exitCode: 0,
    messages: [],
  } as any, 'subagent');

  assert.deepEqual(
    messages.map((message) => ({ role: message.role, markdown: message.markdown, status: message.status })),
    [{ role: 'assistant', markdown: '(no output)', status: 'completed' }],
  );
});

test('subagentSingleResultToChatMessages omits model metadata from synthesized no-output fallbacks', () => {
  const messages = subagentSingleResultToChatMessages({
    agent: 'reviewer',
    task: '   ',
    exitCode: 0,
    model: 'gpt-4.1',
    messages: [],
  } as any, 'subagent');

  assert.equal(messages[0]?.role, 'assistant');
  assert.equal(messages[0]?.modelId, undefined);
});

test('subagentSingleResultToChatMessages returns no rows for running results without task text or transcript', () => {
  const messages = subagentSingleResultToChatMessages({
    agent: 'reviewer',
    task: '   ',
    exitCode: -1,
    messages: [],
  } as any, 'subagent');

  assert.deepEqual(messages, []);
});
