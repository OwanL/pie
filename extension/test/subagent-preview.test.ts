import assert from 'node:assert/strict';
import test from 'node:test';

import { isIdle, subagentPreviewTail } from '../src/webview/panel/transcript/activity-tail-preview';
import type { SubagentSingleResult } from '../src/shared/subagent-result';

function result(overrides: Partial<SubagentSingleResult> & { agent: string; task: string }): SubagentSingleResult {
  const { agent, task, ...rest } = overrides;
  return {
    agent,
    task,
    exitCode: 0,
    messages: [],
    ...rest,
  } as SubagentSingleResult;
}

test('subagentPreviewTail shows streaming text for a running child', () => {
  const tail = subagentPreviewTail(
    result({ agent: 'worker', task: 'fix tests', exitCode: -1, streamingText: 'almost done' }),
    2,
    true,
  );
  assert.ok(tail);
  assert.deepEqual(tail.lines, ['almost done']);
  assert.equal(tail.sourceText, 'almost done');
  assert.equal(tail.cursor, true);
  assert.equal(tail.inputLine, 'fix tests');
  assert.equal(tail.label, 'task');
});

test('subagentPreviewTail shows active generation before visible text arrives', () => {
  const tail = subagentPreviewTail(
    result({ agent: 'worker', task: 'fix tests', exitCode: -1, streaming: true }),
    3,
    true,
  );
  assert.ok(tail);
  assert.deepEqual(tail.lines, ['Generating...']);
  assert.equal(tail.cursor, true);
  assert.equal(tail.reservedRows, 4); // header row + 3 content rows
});

test('subagentPreviewTail shows running tools instead of pending', () => {
  const tail = subagentPreviewTail(
    result({
      agent: 'worker',
      task: 'fix tests',
      exitCode: -1,
      runningTools: ['bash', 'read'],
      activityPhase: 'running_tool',
      activityDetail: 'heavy work',
      model: 'openai/gpt-5',
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    }),
    2,
    true,
  );
  assert.ok(tail);
  assert.deepEqual(tail.lines, ['Running bash, read...']);
  assert.equal(tail.sourceText, undefined);
  assert.equal(tail.cursor, true);
  assert.doesNotMatch(tail.lines.join(' '), /gpt-5/);
});

test('subagentPreviewTail reserves pending for a genuinely queued child', () => {
  const tail = subagentPreviewTail(
    result({ agent: 'worker', task: 'fix tests', exitCode: -1, activityPhase: 'queued' }),
    2,
    true,
  );
  assert.ok(tail);
  assert.deepEqual(tail.lines, ['pending...']);
  assert.equal(tail.cursor, false);
});

test('subagentPreviewTail shows provider lifecycle activity', () => {
  const tail = subagentPreviewTail(
    result({ agent: 'worker', task: 'fix tests', exitCode: -1, activityPhase: 'waiting_provider' }),
    2,
    true,
  );
  assert.ok(tail);
  assert.deepEqual(tail.lines, ['Waiting for provider...']);
  assert.equal(tail.cursor, true);
});

test('subagentPreviewTail keeps the task header for completed children', () => {
  const tail = subagentPreviewTail(
    result({ agent: 'reviewer', task: 'Inspect regression', exitCode: 0 }),
    2,
    false,
  );
  assert.ok(tail);
  assert.equal(tail.inputLine, 'Inspect regression');
  assert.deepEqual(tail.lines, []);
  assert.equal(tail.cursor, false);
  assert.equal(tail.truncated, false);
});

test('subagentPreviewTail does not show pending for terminal children with stale running tools', () => {
  const tail = subagentPreviewTail(
    result({ agent: 'reviewer', task: 'Inspect regression', exitCode: 0, runningTools: ['bash'] }),
    2,
    false,
  );
  assert.ok(tail);
  assert.deepEqual(tail.lines, []);
  assert.equal(tail.cursor, false);
});

test('subagentPreviewTail returns undefined when there is nothing to preview', () => {
  const tail = subagentPreviewTail(
    result({ agent: 'reviewer', task: '   ', exitCode: 0 }),
    2,
    false,
  );
  assert.equal(tail, undefined);
});

test('subagentPreviewTail trims whitespace from streaming text', () => {
  const tail = subagentPreviewTail(
    result({ agent: 'worker', task: 't', exitCode: -1, streamingText: '  still going  ' }),
    2,
    true,
  );
  assert.ok(tail);
  assert.deepEqual(tail.lines, ['still going']);
  assert.equal(tail.sourceText, 'still going');
});

// ── isIdle: the genuine-queue classifier (drives the preview caret) ──────────
// Only a dispatched-but-not-yet-started child waiting on local concurrency is
// idle; reasoning, provider waits, tool execution, and terminal children must
// all remain visibly active (isIdle false) so the preview caret stays lit.

test('isIdle is true only for a genuinely queued child with no activity', () => {
  assert.equal(isIdle(result({ agent: 'worker', task: 't', exitCode: -1, activityPhase: 'queued' })), true);
});

test('isIdle is false once the child has produced any activity', () => {
  assert.equal(
    isIdle(result({ agent: 'worker', task: 't', exitCode: -1, activityPhase: 'queued', streamingText: 'going' })),
    false,
  );
  assert.equal(
    isIdle(result({ agent: 'worker', task: 't', exitCode: -1, activityPhase: 'queued', runningTools: ['bash'] })),
    false,
  );
  assert.equal(
    isIdle(result({ agent: 'worker', task: 't', exitCode: -1, activityPhase: 'queued', messages: [{ role: 'assistant', content: 'hi' }] })),
    false,
  );
});

test('isIdle is false for non-queued phases (provider waits / running tool stay active)', () => {
  assert.equal(
    isIdle(result({ agent: 'worker', task: 't', exitCode: -1, activityPhase: 'waiting_provider' })),
    false,
  );
  assert.equal(
    isIdle(result({ agent: 'worker', task: 't', exitCode: -1, activityPhase: 'running_tool' })),
    false,
  );
});

test('isIdle is false for terminal children', () => {
  assert.equal(isIdle(result({ agent: 'worker', task: 't', exitCode: 0 })), false);
  assert.equal(isIdle(result({ agent: 'worker', task: 't', exitCode: 0, activityPhase: 'queued' })), false);
});
