import assert from 'node:assert/strict';
import test from 'node:test';

import type { SubagentResult, SubagentSingleResult } from '../../../src/shared/subagent-result';
import type { ToolCall } from '../../../src/shared/protocol';
import {
  getRenderableSubagentResult,
  getRenderableSubagentResultFromToolCall,
  isSubagentSingleResultRunning,
  isSubagentSingleResultInterrupted,
  isSubagentSingleResultFailed,
  nonEmptyText,
  subagentSingleResultFallbackMarkdown,
} from '../../../src/shared/subagent-result';

/**
 * Defensive `unknown` parsing: the raw `result`/`input` of a `subagent` tool call
 * is untyped, so every public extractor must return a safe default (typically
 * `undefined`) for malformed shapes and the correct shape for well-formed ones.
 * `synthesizeRenderableSubagentResult` and `normalizeRenderableSubagentResult`
 * are module-private, exercised through `getRenderableSubagentResultFromToolCall`.
 */

function single(overrides: Partial<SubagentSingleResult> = {}): SubagentSingleResult {
  return {
    agent: 'worker',
    task: 'do the thing',
    exitCode: 0,
    messages: [],
    ...overrides,
  };
}

function resultWith(singleResult: SubagentSingleResult, mode: SubagentResult['mode'] = 'single'): SubagentResult {
  return { mode, results: [singleResult] };
}

test('typed live subagent preview rehydrates the running child reply', () => {
  const out = getRenderableSubagentResultFromToolCall({
    input: { agent: 'worker', task: 'inspect the queue' },
    status: 'running',
    result: {
      kind: 'subagent',
      mode: 'single',
      omittedChildren: 0,
      children: [{
        id: 'worker', phase: 'running', agent: 'worker', task: 'inspect the queue',
        exitCode: -1, model: 'provider/model', provider: 'provider', thinkingLevel: 'high',
        startedAt: 1000, contextWindow: 200000,
        usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, contextTokens: 125, cost: 0.01, turns: 1 },
        messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'complete live reasoning' }, { type: 'toolCall', id: 'nested', name: 'subagent', arguments: {} }] }],
        streaming: true, streamingText: 'Live reply before interruption.',
      }],
    },
  });

  assert.equal(out?.results[0]?.exitCode, -1);
  assert.equal(out?.results[0]?.model, 'provider/model');
  assert.equal(out?.results[0]?.thinkingLevel, 'high');
  assert.equal(out?.results[0]?.streamingText, 'Live reply before interruption.');
  assert.equal(out?.results[0]?.streaming, true);
  assert.equal(out?.results[0]?.startedAt, 1000);
  assert.equal(out?.results[0]?.usage?.input, 100);
  assert.match(JSON.stringify(out?.results[0]?.messages), /complete live reasoning/);
  assert.match(JSON.stringify(out?.results[0]?.messages), /nested/);
});

// --- getRenderableSubagentResult: raw result field parsing ---

test('getRenderableSubagentResult returns the top-level results object when results is a non-empty array', () => {
  const raw = { mode: 'single', results: [single({ agent: 'a' })] };
  assert.equal(getRenderableSubagentResult(raw), raw);
});

test('getRenderableSubagentResult unwraps nested details.results', () => {
  const nested = { mode: 'single', results: [single({ agent: 'b' })] };
  const raw = { details: nested };
  // Returns the nested object holding results, not the outer wrapper.
  assert.equal(getRenderableSubagentResult(raw), nested);
});

test('getRenderableSubagentResult prefers top-level results over nested details.results', () => {
  const top = [single({ agent: 'top' })];
  const nested = [single({ agent: 'nested' })];
  const raw = { results: top, details: { results: nested } };
  assert.equal(getRenderableSubagentResult(raw), raw);
});

test('getRenderableSubagentResult returns undefined for every malformed shape', () => {
  assert.equal(getRenderableSubagentResult(undefined), undefined);
  assert.equal(getRenderableSubagentResult(null), undefined);
  assert.equal(getRenderableSubagentResult('not-an-object'), undefined);
  assert.equal(getRenderableSubagentResult(42), undefined);
  assert.equal(getRenderableSubagentResult({}), undefined);
  assert.equal(getRenderableSubagentResult({ results: [] }), undefined); // empty array
  assert.equal(getRenderableSubagentResult({ details: 'nope' }), undefined);
  assert.equal(getRenderableSubagentResult({ details: {} }), undefined);
  assert.equal(getRenderableSubagentResult({ details: { results: [] } }), undefined);
});

// --- getRenderableSubagentResultFromToolCall: completed/finished path ---

test('completed tool call with a well-formed result returns the result unchanged', () => {
  const toolCall: Pick<ToolCall, 'input' | 'result' | 'status'> = {
    input: {},
    status: 'completed',
    result: resultWith(single({ exitCode: 0 })),
  };
  assert.deepEqual(getRenderableSubagentResultFromToolCall(toolCall), resultWith(single({ exitCode: 0 })));
});

test('completed tool call with no result and no synthesizable input returns undefined', () => {
  const toolCall: Pick<ToolCall, 'input' | 'result' | 'status'> = {
    input: {},
    status: 'completed',
    result: undefined,
  };
  assert.equal(getRenderableSubagentResultFromToolCall(toolCall), undefined);
});

test('completed tool call with lazy detail keeps a subagent placeholder renderable', () => {
  const toolCall: Pick<ToolCall, 'input' | 'result' | 'status' | 'detailRef'> = {
    input: { agent: 'worker', task: 'Keep the preview card mounted' },
    status: 'completed',
    result: undefined,
    detailRef: {
      key: 'durable:tool:/session:entry:tool:0', kind: 'tool-result', source: 'durable',
      sessionPath: '/session', messageId: 'message', toolCallId: 'tool',
      sizeBytes: 100_000, summary: '1 subagent child', available: true,
    },
  };
  const result = getRenderableSubagentResultFromToolCall(toolCall);
  assert.equal(result?.results[0]?.agent, 'worker');
  assert.equal(result?.results[0]?.task, 'Keep the preview card mounted');
  assert.equal(result?.results[0]?.exitCode, 0, 'terminal lazy placeholders must not look like running children');
});

test('terminal force-settle with empty child results renders failed cards from the original parallel input', () => {
  const toolCall: Pick<ToolCall, 'input' | 'result' | 'status'> = {
    input: {
      tasks: [
        { agent: 'scout', task: 'Audit reliability' },
        { agent: 'reviewer', task: 'Review findings' },
      ],
    },
    status: 'failed',
    result: {
      content: [{ type: 'text', text: 'Subagent did not settle within 1800s and was force-settled.' }],
      details: { mode: 'parallel', results: [] },
      isError: true,
    },
  };

  const out = getRenderableSubagentResultFromToolCall(toolCall)!;
  assert.equal(out.mode, 'parallel');
  assert.deepEqual(out.results.map((result) => ({
    agent: result.agent,
    task: result.task,
    exitCode: result.exitCode,
    stopReason: result.stopReason,
    errorMessage: result.errorMessage,
  })), [
    {
      agent: 'scout', task: 'Audit reliability', exitCode: 1, stopReason: 'error',
      errorMessage: 'Subagent did not settle within 1800s and was force-settled.',
    },
    {
      agent: 'reviewer', task: 'Review findings', exitCode: 1, stopReason: 'error',
      errorMessage: 'Subagent did not settle within 1800s and was force-settled.',
    },
  ]);
});

// --- getRenderableSubagentResultFromToolCall: synthesize placeholder (running) ---

test('running tool call with no result synthesizes a single placeholder from agent+task', () => {
  const toolCall: Pick<ToolCall, 'input' | 'result' | 'status'> = {
    input: { agent: 'scout', task: 'find files' },
    status: 'running',
    result: undefined,
  };
  assert.deepEqual(getRenderableSubagentResultFromToolCall(toolCall), {
    mode: 'single',
    results: [{
      agent: 'scout',
      task: 'find files',
      exitCode: -1,
      messages: [],
      activityPhase: 'preparing',
      activityDetail: 'waiting for subagent runtime status',
    }],
  });
});

test('running tool call with input.tasks synthesizes a parallel placeholder per task', () => {
  const toolCall: Pick<ToolCall, 'input' | 'result' | 'status'> = {
    input: {
      tasks: [
        { agent: 'a', task: 't1' },
        { agent: 'b', task: 't2' },
      ],
    },
    status: 'running',
    result: undefined,
  };
  const out = getRenderableSubagentResultFromToolCall(toolCall)!;
  assert.equal(out.mode, 'parallel');
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0]!.agent, 'a');
  assert.equal(out.results[1]!.agent, 'b');
  assert.equal(out.results[0]!.exitCode, -1);
  assert.deepEqual(out.results.map((result) => [result.activityPhase, result.activityDetail]), [
    ['queued', 'waiting for parallel task dispatch'],
    ['queued', 'waiting for parallel task dispatch'],
  ]);
});

test('running tool call with input.chain synthesizes a chain placeholder from the first step', () => {
  const toolCall: Pick<ToolCall, 'input' | 'result' | 'status'> = {
    input: { chain: [{ agent: 'a', task: 't1' }, { agent: 'b', task: 't2' }] },
    status: 'running',
    result: undefined,
  };
  const out = getRenderableSubagentResultFromToolCall(toolCall)!;
  assert.equal(out.mode, 'chain');
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0]!.agent, 'a');
});

test('running tool call with input.tasks where no task has both agent+task returns undefined', () => {
  // Every placeholder is dropped because placeholderSingleResult needs both a
  // non-empty agent and a non-empty task.
  const toolCall: Pick<ToolCall, 'input' | 'result' | 'status'> = {
    input: { tasks: [{ agent: 'a' /* no task */ }] },
    status: 'running',
    result: undefined,
  };
  assert.equal(getRenderableSubagentResultFromToolCall(toolCall), undefined);
});

test('running tool call with empty chain returns undefined', () => {
  const toolCall: Pick<ToolCall, 'input' | 'result' | 'status'> = {
    input: { chain: [] },
    status: 'running',
    result: undefined,
  };
  assert.equal(getRenderableSubagentResultFromToolCall(toolCall), undefined);
});

test('running tool call with input lacking agent/task/tasks/chain returns undefined', () => {
  const toolCall: Pick<ToolCall, 'input' | 'result' | 'status'> = {
    input: { unrelated: 'field' },
    status: 'running',
    result: undefined,
  };
  assert.equal(getRenderableSubagentResultFromToolCall(toolCall), undefined);
});

test('synthesized placeholder trims whitespace from agent and task and rejects blank ones', () => {
  const toolCall: Pick<ToolCall, 'input' | 'result' | 'status'> = {
    input: { agent: '  scout  ', task: '\tfind ' },
    status: 'running',
    result: undefined,
  };
  const out = getRenderableSubagentResultFromToolCall(toolCall)!;
  assert.equal(out.results[0]!.agent, 'scout');
  assert.equal(out.results[0]!.task, 'find');
});

// --- getRenderableSubagentResultFromToolCall: normalizeRenderableSubagentResult (running) ---

test('normalize: running result with exitCode 0 and no messages/runningTools keeps the reported exitCode 0', () => {
  const toolCall: Pick<ToolCall, 'input' | 'result' | 'status'> = {
    input: {},
    status: 'running',
    result: resultWith(single({ exitCode: 0, messages: [] })),
  };
  const out = getRenderableSubagentResultFromToolCall(toolCall)!;
  assert.equal(out.results[0]!.exitCode, 0);
});

test('normalize: running result with messages and no runningTools keeps exitCode 0 (already produced output)', () => {
  const toolCall: Pick<ToolCall, 'input' | 'result' | 'status'> = {
    input: {},
    status: 'running',
    result: resultWith(single({ exitCode: 0, messages: [{ role: 'assistant', content: 'hi' }] })),
  };
  const out = getRenderableSubagentResultFromToolCall(toolCall)!;
  assert.equal(out.results[0]!.exitCode, 0);
});

test('normalize: running result with runningTools keeps the reported exitCode 0', () => {
  const toolCall: Pick<ToolCall, 'input' | 'result' | 'status'> = {
    input: {},
    status: 'running',
    result: resultWith(single({ exitCode: 0, messages: [{ role: 'assistant', content: 'hi' }], runningTools: ['bash'] })),
  };
  const out = getRenderableSubagentResultFromToolCall(toolCall)!;
  assert.equal(out.results[0]!.exitCode, 0);
});

test('normalize: running result with a non-zero exitCode is left unchanged', () => {
  const toolCall: Pick<ToolCall, 'input' | 'result' | 'status'> = {
    input: {},
    status: 'running',
    result: resultWith(single({ exitCode: 5 })),
  };
  const out = getRenderableSubagentResultFromToolCall(toolCall)!;
  assert.equal(out.results[0]!.exitCode, 5);
});

test('normalize: running result with stopReason is left unchanged', () => {
  const toolCall: Pick<ToolCall, 'input' | 'result' | 'status'> = {
    input: {},
    status: 'running',
    result: resultWith(single({ exitCode: 0, stopReason: 'end_turn' })),
  };
  const out = getRenderableSubagentResultFromToolCall(toolCall)!;
  assert.equal(out.results[0]!.exitCode, 0);
});

test('normalize: terminal tool calls clear stale live state and settle unfinished children', () => {
  const failed = getRenderableSubagentResultFromToolCall({
    input: {},
    status: 'failed',
    result: resultWith(single({
      exitCode: -1,
      runningTools: ['bash'],
      streaming: true,
      activityPhase: 'running_tool',
    })),
  })!;
  assert.equal(failed.results[0]!.exitCode, 1);
  assert.equal(failed.results[0]!.stopReason, 'error');
  assert.deepEqual(failed.results[0]!.runningTools, []);
  assert.equal(failed.results[0]!.streaming, false);
  assert.equal(failed.results[0]!.activityPhase, 'failed');

  const completed = getRenderableSubagentResultFromToolCall({
    input: {},
    status: 'completed',
    result: resultWith(single({ exitCode: -1, runningTools: ['read'] })),
  })!;
  assert.equal(completed.results[0]!.exitCode, 0);
  assert.deepEqual(completed.results[0]!.runningTools, []);
  assert.equal(completed.results[0]!.activityPhase, 'completed');

  const interrupted = getRenderableSubagentResultFromToolCall({
    input: {},
    status: 'failed',
    result: resultWith(single({
      exitCode: 1,
      stopReason: 'aborted',
      runningTools: ['bash'],
      activityPhase: 'running_tool',
    })),
  })!;
  assert.equal(interrupted.results[0]!.activityPhase, 'cancelled');
  assert.deepEqual(interrupted.results[0]!.runningTools, []);

  const completedSibling = getRenderableSubagentResultFromToolCall({
    input: {},
    status: 'failed',
    result: resultWith(single({ exitCode: 0, runningTools: ['stale-tool'] }), 'parallel'),
  })!;
  assert.equal(completedSibling.results[0]!.exitCode, 0);
  assert.equal(completedSibling.results[0]!.activityPhase, 'completed');
});

test('normalize does not mutate the original result object', () => {
  // A shared result reference passed in for a running call must not be mutated
  // in place; normalize spreads into a new object.
  const original = resultWith(single({ exitCode: 0, messages: [] }));
  const toolCall: Pick<ToolCall, 'input' | 'result' | 'status'> = {
    input: {},
    status: 'running',
    result: original,
  };
  getRenderableSubagentResultFromToolCall(toolCall);
  assert.equal(original.results[0]!.exitCode, 0);
});

// --- isSubagentSingleResultRunning ---

test('isSubagentSingleResultRunning: exitCode -1 means running', () => {
  assert.equal(isSubagentSingleResultRunning(single({ exitCode: -1 })), true);
});

test('isSubagentSingleResultRunning: terminal exitCode overrides stale runningTools', () => {
  assert.equal(isSubagentSingleResultRunning(single({ exitCode: 0, runningTools: ['bash'] })), false);
  assert.equal(isSubagentSingleResultRunning(single({ exitCode: 5, runningTools: ['bash'] })), false);
});

test('isSubagentSingleResultRunning: exitCode 0 with no runningTools is not running', () => {
  assert.equal(isSubagentSingleResultRunning(single({ exitCode: 0 })), false);
  assert.equal(isSubagentSingleResultRunning(single({ exitCode: 0, runningTools: [] })), false);
});

test('isSubagentSingleResultRunning: a failed result (non-zero, non -1 exitCode) with no runningTools is not running', () => {
  // "Failed" is distinct from "running": only exitCode -1 (or live tools) counts.
  assert.equal(isSubagentSingleResultRunning(single({ exitCode: 5 })), false);
});

// --- isSubagentSingleResultInterrupted / isSubagentSingleResultFailed ---

test('isSubagentSingleResultInterrupted: abort reason or cancelled phase means interrupted', () => {
  assert.equal(isSubagentSingleResultInterrupted(single({ stopReason: 'aborted' })), true);
  assert.equal(isSubagentSingleResultInterrupted(single({ activityPhase: 'cancelled' })), true);
  assert.equal(isSubagentSingleResultInterrupted(single({ stopReason: 'error', activityPhase: 'failed' })), false);
});

test('isSubagentSingleResultFailed: only an in-progress exitCode suppresses failure', () => {
  assert.equal(isSubagentSingleResultFailed(single({ exitCode: -1 })), false);
  assert.equal(isSubagentSingleResultFailed(single({ exitCode: 0, runningTools: ['bash'] })), false);
});

test('isSubagentSingleResultFailed: non-zero exitCode, error, or aborted stopReason is failed', () => {
  assert.equal(isSubagentSingleResultFailed(single({ exitCode: 1 })), true);
  assert.equal(isSubagentSingleResultFailed(single({ exitCode: 0, stopReason: 'error' })), true);
  assert.equal(isSubagentSingleResultFailed(single({ exitCode: 0, stopReason: 'aborted' })), true);
});

test('isSubagentSingleResultFailed: clean exitCode 0 with no error stopReason is not failed', () => {
  assert.equal(isSubagentSingleResultFailed(single({ exitCode: 0 })), false);
  assert.equal(isSubagentSingleResultFailed(single({ exitCode: 0, stopReason: 'end_turn' })), false);
});

// --- nonEmptyText ---

test('nonEmptyText trims and returns undefined for blank input', () => {
  assert.equal(nonEmptyText('  hi  '), 'hi');
  assert.equal(nonEmptyText('hi'), 'hi');
  assert.equal(nonEmptyText(''), undefined);
  assert.equal(nonEmptyText('   '), undefined);
  assert.equal(nonEmptyText('\t\n'), undefined);
  assert.equal(nonEmptyText(undefined), undefined);
});

// --- subagentSingleResultFallbackMarkdown ---

test('fallback markdown: a non-failed result yields "(no output)"', () => {
  assert.equal(subagentSingleResultFallbackMarkdown(single({ exitCode: 0 })), '(no output)');
  assert.equal(subagentSingleResultFallbackMarkdown(single({ exitCode: -1 })), '(no output)');
});

test('fallback markdown: exit code label with no detail uses the generic failure message', () => {
  assert.equal(
    subagentSingleResultFallbackMarkdown(single({ exitCode: 1 })),
    'Exit code 1: agent failed before producing any output.',
  );
});

test('fallback markdown: exit code label with errorMessage or stderr surfaces the detail', () => {
  assert.equal(
    subagentSingleResultFallbackMarkdown(single({ exitCode: 2, errorMessage: 'boom' })),
    'Exit code 2: boom',
  );
  assert.equal(
    subagentSingleResultFallbackMarkdown(single({ exitCode: 2, stderr: 'trace output' })),
    'Exit code 2: trace output',
  );
});

test('fallback markdown: aborted stopReason labels "Aborted" and prefers errorMessage over stderr', () => {
  assert.equal(
    subagentSingleResultFallbackMarkdown(single({ exitCode: 0, stopReason: 'aborted', errorMessage: 'cancelled' })),
    'Aborted: cancelled',
  );
  assert.equal(
    subagentSingleResultFallbackMarkdown(single({ exitCode: 0, stopReason: 'aborted', stderr: 'fallback' })),
    'Aborted: fallback',
  );
  assert.equal(
    subagentSingleResultFallbackMarkdown(single({ exitCode: 0, stopReason: 'aborted' })),
    'Aborted: agent failed before producing any output.',
  );
});

test('fallback markdown: error stopReason labels "Error"', () => {
  assert.equal(
    subagentSingleResultFallbackMarkdown(single({ exitCode: 0, stopReason: 'error', stderr: 'stack' })),
    'Error: stack',
  );
  assert.equal(
    subagentSingleResultFallbackMarkdown(single({ exitCode: 0, stopReason: 'error' })),
    'Error: agent failed before producing any output.',
  );
});

test('fallback markdown: a non -1 negative exit code with no stopReason falls back to the "Failed" label', () => {
  assert.equal(
    subagentSingleResultFallbackMarkdown(single({ exitCode: -2 })),
    'Failed: agent failed before producing any output.',
  );
});

// --- ToolCall nominal compatibility (the extractor reads a ToolCall-shaped object) ---

test('getRenderableSubagentResultFromToolCall accepts a full ToolCall fixture', () => {
  const toolCall: ToolCall = {
    id: 'sub1',
    name: 'subagent',
    input: { agent: 'worker', task: 't' },
    status: 'running',
    result: undefined,
  };
  const out = getRenderableSubagentResultFromToolCall(toolCall);
  assert.equal(out?.mode, 'single');
  assert.equal(out?.results[0]!.agent, 'worker');
});
