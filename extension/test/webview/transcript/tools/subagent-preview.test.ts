import assert from 'node:assert/strict';
import test from 'node:test';

import { installDom } from '../../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import {
  CONTINUOUS_PREVIEW_MAX_CHARS,
  isIdle,
  mergeContinuousPreviewSource,
  subagentPreviewTail,
  TurnActivityTailBody,
} from '../../../../src/webview/panel/transcript/activity-tail-preview';
import type { SubagentSingleResult } from '../../../../src/shared/subagent-result';

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

test('continuous subagent preview appends source changes without clearing prior rows', () => {
  let stream = mergeContinuousPreviewSource({ accumulated: '', segment: '' }, 'Inspecting the event path');
  stream = mergeContinuousPreviewSource(stream, 'Inspecting the event path now');
  stream = mergeContinuousPreviewSource(stream, '12 tests passed');
  stream = mergeContinuousPreviewSource(stream, '');
  assert.equal(stream.accumulated, 'Inspecting the event path now\n12 tests passed');
});

test('continuous subagent preview handles a bounded source tail sliding forward', () => {
  let stream = mergeContinuousPreviewSource({ accumulated: '', segment: '' }, 'abcdef');
  stream = mergeContinuousPreviewSource(stream, 'defghi');
  assert.equal(stream.accumulated, 'abcdefghi');
});

test('continuous subagent preview bounds its retained animation history', () => {
  let stream = mergeContinuousPreviewSource({ accumulated: '', segment: '' }, 'a'.repeat(19_000));
  for (let i = 0; i < 10; i += 1) {
    stream = mergeContinuousPreviewSource(stream, `${stream.segment.slice(-10_000)}${String(i).repeat(10_000)}`);
  }
  assert.ok(stream.accumulated.length <= CONTINUOUS_PREVIEW_MAX_CHARS);
});

test('TurnActivityTailBody continuous mode retains rows across an empty transition', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const makeTail = (sourceText?: string) => ({
    kind: 'subagent' as const,
    label: 'task',
    inputLine: 'trace issue',
    lines: sourceText ? [sourceText] : [],
    sourceText,
    truncated: false,
    cursor: false,
    reservedRows: 3,
  });
  try {
    act(() => render(h(TurnActivityTailBody, { tail: makeTail('reasoning so far'), continuous: true }), container));
    assert.match(container.textContent ?? '', /reasoning so far/);
    act(() => render(h(TurnActivityTailBody, { tail: makeTail(), continuous: true }), container));
    assert.match(container.textContent ?? '', /reasoning so far/);
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});

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

test('subagentPreviewTail shows live reasoning instead of a generating placeholder', () => {
  const tail = subagentPreviewTail(
    result({
      agent: 'scout',
      task: 'trace the issue',
      exitCode: -1,
      streaming: true,
      streamingReasoning: 'Inspecting the event path now',
      activityPhase: 'streaming',
    }),
    3,
    true,
  );
  assert.ok(tail);
  assert.equal(tail.kind, 'reasoning');
  assert.deepEqual(tail.lines, ['Inspecting the event path now']);
  assert.equal(tail.sourceText, 'Inspecting the event path now');
  assert.doesNotMatch(tail.lines.join(' '), /Generating/);
});

test('subagentPreviewTail does not waste output rows before visible content arrives', () => {
  const tail = subagentPreviewTail(
    result({ agent: 'worker', task: 'fix tests', exitCode: -1, streaming: true }),
    3,
    true,
  );
  assert.ok(tail);
  assert.deepEqual(tail.lines, []);
  assert.equal(tail.inputLine, 'fix tests');
  assert.equal(tail.cursor, false);
  assert.equal(tail.reservedRows, 1);
});

test('subagentPreviewTail leaves tool-only lifecycle detail in the card header', () => {
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
  assert.deepEqual(tail.lines, []);
  assert.equal(tail.sourceText, undefined);
  assert.equal(tail.cursor, false);
  assert.doesNotMatch(tail.lines.join(' '), /gpt-5/);
});

test('subagentPreviewTail includes the latest bash call and completed output', () => {
  const tail = subagentPreviewTail(
    result({
      agent: 'worker',
      task: 'run tests',
      exitCode: -1,
      activityPhase: 'waiting_provider',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'bash-1', name: 'bash', arguments: { command: 'npm test' } }],
        },
        {
          role: 'toolResult',
          toolCallId: 'bash-1',
          content: [{ type: 'text', text: '12 tests passed' }],
        },
      ],
    }),
    2,
    true,
  );
  assert.ok(tail);
  assert.equal(tail.kind, 'tool');
  assert.equal(tail.label, 'bash');
  assert.equal(tail.inputLine, 'npm test');
  assert.deepEqual(tail.lines, ['12 tests passed']);
  assert.equal(tail.cursor, false);
  assert.doesNotMatch(tail.lines.join(' '), /Waiting for provider/);
});

test('subagentPreviewTail shows a running tool call before output arrives', () => {
  const tail = subagentPreviewTail(
    result({
      agent: 'worker',
      task: 'inspect files',
      exitCode: -1,
      activityPhase: 'running_tool',
      runningTools: ['read'],
      messages: [{
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'src/app.ts' } }],
      }],
    }),
    2,
    true,
  );
  assert.ok(tail);
  assert.equal(tail.kind, 'tool');
  assert.equal(tail.label, 'read');
  assert.match(tail.inputLine ?? '', /src\/app\.ts/);
  assert.deepEqual(tail.lines, []);
  assert.equal(tail.cursor, true);
});

test('subagentPreviewTail keeps only the task row for a genuinely queued child', () => {
  const tail = subagentPreviewTail(
    result({ agent: 'worker', task: 'fix tests', exitCode: -1, activityPhase: 'queued' }),
    2,
    true,
  );
  assert.ok(tail);
  assert.deepEqual(tail.lines, []);
  assert.equal(tail.cursor, false);
  assert.equal(tail.reservedRows, 1);
});

test('subagentPreviewTail leaves provider lifecycle activity in the card header', () => {
  const tail = subagentPreviewTail(
    result({ agent: 'worker', task: 'fix tests', exitCode: -1, activityPhase: 'waiting_provider' }),
    2,
    true,
  );
  assert.ok(tail);
  assert.deepEqual(tail.lines, []);
  assert.equal(tail.cursor, false);
  assert.equal(tail.reservedRows, 1);
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
