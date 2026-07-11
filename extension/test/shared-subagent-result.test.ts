import assert from 'node:assert/strict';
import test from 'node:test';

import type { SubagentResult, SubagentSingleResult } from '../src/shared/subagent-result';
import type { ToolCall } from '../src/shared/protocol';
import {
  getRenderableSubagentResult,
  getRenderableSubagentResultFromToolCall,
  isSubagentSingleResultRunning,
  isSubagentSingleResultFailed,
  nonEmptyText,
  subagentSingleResultFallbackMarkdown,
} from '../src/shared/subagent-result';

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
  // normalizeRenderableSubagentResult is a no-op for non-running status.
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
    results: [{ agent: 'scout', task: 'find files', exitCode: -1, messages: [] }],
  });
});

test('running tool call carries taskScores onto the synthesized placeholder when present', () => {
  const toolCall: Pick<ToolCall, 'input' | 'result' | 'status'> = {
    input: { agent: 'scout', task: 't', taskScores: { scout: 0.9 } },
    status: 'running',
    result: undefined,
  };
  const out = getRenderableSubagentResultFromToolCall(toolCall)!;
  assert.deepEqual(out.results[0]!.taskScores, { scout: 0.9 });
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

test('normalize: running result with exitCode 0 and no messages/runningTools is inferred running (exitCode -> -1)', () => {
  const toolCall: Pick<ToolCall, 'input' | 'result' | 'status'> = {
    input: {},
    status: 'running',
    result: resultWith(single({ exitCode: 0, messages: [] })),
  };
  const out = getRenderableSubagentResultFromToolCall(toolCall)!;
  assert.equal(out.results[0]!.exitCode, -1);
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

test('normalize: running result with runningTools is inferred running even with messages present', () => {
  const toolCall: Pick<ToolCall, 'input' | 'result' | 'status'> = {
    input: {},
    status: 'running',
    result: resultWith(single({ exitCode: 0, messages: [{ role: 'assistant', content: 'hi' }], runningTools: ['bash'] })),
  };
  const out = getRenderableSubagentResultFromToolCall(toolCall)!;
  assert.equal(out.results[0]!.exitCode, -1);
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

test('isSubagentSingleResultRunning: non-empty runningTools means running regardless of exitCode', () => {
  assert.equal(isSubagentSingleResultRunning(single({ exitCode: 0, runningTools: ['bash'] })), true);
  assert.equal(isSubagentSingleResultRunning(single({ exitCode: 5, runningTools: ['bash'] })), true);
});

test('isSubagentSingleResultRunning: exitCode 0 with no runningTools is not running', () => {
  assert.equal(isSubagentSingleResultRunning(single({ exitCode: 0 })), false);
  assert.equal(isSubagentSingleResultRunning(single({ exitCode: 0, runningTools: [] })), false);
});

test('isSubagentSingleResultRunning: a failed result (non-zero, non -1 exitCode) with no runningTools is not running', () => {
  // "Failed" is distinct from "running": only exitCode -1 (or live tools) counts.
  assert.equal(isSubagentSingleResultRunning(single({ exitCode: 5 })), false);
});

// --- isSubagentSingleResultFailed ---

test('isSubagentSingleResultFailed: running results are not failed', () => {
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
