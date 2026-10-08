import assert from 'node:assert/strict';
import test from 'node:test';
import { liveToolPreview } from '../../../transcript/tool-call-card/display-model';
import type { ToolCall } from '../../../../lib/protocol/index.js';

const edit: ToolCall = { id: 'draft-edit', name: 'edit', input: {}, status: 'drafting' };

test('provisional edits identify the last complete or visually repaired replacement', () => {
  const partial: ToolCall = {
    ...edit,
    argumentsText: '{"path":"a.ts","edits":[{"oldText":"first","newText":"one"},{"oldText":"second","newText":"current partial',
  };
  assert.deepEqual(liveToolPreview(partial), {
    text: 'current partial', provisional: true, truncated: false, lines: 1, editIndex: 2,
  });
  assert.equal(partial.input, edit.input, 'display repair must not replace execution input');

  const ready: ToolCall = {
    ...edit,
    status: 'ready',
    argumentsText: JSON.stringify({ path: 'a.ts', edits: [{ oldText: 'one', newText: 'first' }, { oldText: 'two', newText: 'last\nline' }] }),
  };
  assert.deepEqual(liveToolPreview(ready), {
    text: 'last\nline', provisional: true, truncated: false, lines: 2, editIndex: 2,
  });
});

test('non-edit drafts, running tools, and malformed fallbacks never expose an edit index', () => {
  for (const call of [
    { ...edit, name: 'write', argumentsText: '{"content":"file text"}' },
    { ...edit, name: 'custom', status: 'running' as const, result: 'progress' },
  ]) {
    assert.equal(Object.hasOwn(liveToolPreview(call)!, 'editIndex'), false);
  }
  const malformed: ToolCall = {
    ...edit,
    input: 'execution input',
    argumentsText: '{not-json',
  };
  assert.deepEqual(liveToolPreview(malformed), {
    text: '{not-json', provisional: true, truncated: false, lines: 1,
  });
  assert.equal(malformed.input, 'execution input');
});

test('only exact short single-line provisional bash commands omit redundant previews', () => {
  for (const status of ['drafting', 'ready'] as const) {
    for (const name of ['bash', ' BASH ']) {
      for (const command of ['echo hello', 'x'.repeat(180)]) {
        assert.equal(liveToolPreview({ ...edit, name, status, argumentsText: JSON.stringify({ command }) }), null);
      }
      assert.equal(liveToolPreview({ ...edit, name, status, argumentsText: '{"command":"echo partial' }), null);
    }
  }
});

test('multiline, long, whitespace-normalized headers and malformed commands keep previews', () => {
  for (const command of ['echo one\necho two', 'echo one\r\necho two', 'x'.repeat(181), ' echo hello ', 'echo  hello', 'echo\thello']) {
    const call = { ...edit, name: 'bash', argumentsText: JSON.stringify({ command }) };
    assert.ok(liveToolPreview(call), `preview retained for ${JSON.stringify(command)}`);
  }
  for (const call of [
    { ...edit, name: 'bash', argumentsText: '{not-json' },
    { ...edit, name: 'bash', input: { command: 'echo hello' }, argumentsText: '{not-json "command":"echo hello"' },
    { ...edit, name: 'bash', argumentsText: '{"command":42}' },
    { ...edit, name: 'shell', argumentsText: '{"command":"echo hello"}' },
    { ...edit, name: 'write', argumentsText: '{"content":"echo hello"}' },
  ]) assert.ok(liveToolPreview(call));
  assert.deepEqual(liveToolPreview({ ...edit, name: 'bash', status: 'running', input: { command: 'echo hello' }, result: 'echo hello' }), {
    text: 'echo hello', provisional: false, truncated: false, lines: 1,
  });
});

test('draft and live previews retain their bounded tail and line behavior', () => {
  const longDraft: ToolCall = {
    ...edit,
    argumentsText: JSON.stringify({ path: 'a.ts', edits: [{ oldText: '', newText: `${'x'.repeat(250)}\n${'y'.repeat(4100)}` }] }),
  };
  const preview = liveToolPreview(longDraft, 1)!;
  assert.equal(preview.editIndex, 1);
  assert.equal(preview.lines, 1);
  assert.equal(preview.text, `${'y'.repeat(239)}…`);
  assert.equal(preview.truncated, true);

  const running: ToolCall = { ...edit, name: 'bash', status: 'running', result: `${'old\n'.repeat(10)}tail` };
  assert.deepEqual(liveToolPreview(running, 2), {
    text: 'old\ntail', provisional: false, truncated: true, lines: 2,
  });
});
