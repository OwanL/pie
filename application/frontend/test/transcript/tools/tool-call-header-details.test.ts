import assert from 'node:assert/strict';
import test from 'node:test';
import { toolHeaderDetail } from '../../../transcript/tool-call-card/header-details';
import type { ToolCall } from '../../../../lib/protocol/index.js';

const base: ToolCall = { id: 'detail', name: 'read', input: {}, status: 'completed' };
const detail = (name: string, input: unknown, status: ToolCall['status'] = 'completed', extra: Partial<ToolCall> = {}) =>
  toolHeaderDetail({ ...base, name, input, status, ...extra });

test('read and cat show only an explicitly supplied positive finite integer offset', () => {
  assert.equal(detail('read', { offset: 4, limit: 20 }), 'from line 4');
  assert.equal(detail(' CAT ', { offset: 1, limit: 50 }), 'from line 1');
  for (const offset of [undefined, 0, -1, 1.5, Infinity, NaN, '4']) {
    assert.equal(detail('read', { offset, limit: 20 }), null);
  }
});

test('edit counts only valid requested replacements and distinguishes provisional state', () => {
  const input = { edits: [
    { oldText: 'café 🧭', newText: '雪' },
    { oldText: '', newText: '' },
    { oldText: 'missing new' },
    { oldText: 1, newText: 'invalid old' },
  ] };
  assert.equal(detail('edit', input, 'drafting'), '2 replacements so far');
  assert.equal(detail('edit', input, 'ready'), '2 replacements so far');
  for (const status of ['running', 'completed', 'failed'] as const) {
    assert.equal(detail('edit', input, status), '2 replacements');
  }
  assert.equal(detail('edit', { edits: [{ oldText: 'a', newText: 'b' }] }), null);
  assert.equal(detail('edit', { edits: [{ oldText: 1, newText: 'b' }, null] }), null);
  assert.equal(detail('edit', { oldText: 'a', newText: 'b' }), null);
});

test('partial draft JSON uses safe visual parsing without modifying execution input', () => {
  const call: ToolCall = { ...base, name: 'edit', status: 'drafting', input: 'provider-owned', argumentsText: '{"edits":[{"oldText":"☃","newText":"雪"},{"oldText":"x","newText":"y"' };
  assert.equal(toolHeaderDetail(call), '2 replacements so far');
  assert.equal(call.input, 'provider-owned');
  const malformed: ToolCall = { ...call, argumentsText: '{not json' };
  assert.equal(toolHeaderDetail(malformed), null);
});

test('shell timeout is shown only for an explicit positive finite integer', () => {
  assert.equal(detail('bash', { command: 'echo hi', timeout: 30 }), 'timeout 30s');
  assert.equal(detail('PowerShell', { timeout: 2 }), 'timeout 2s');
  for (const timeout of [undefined, 0, -2, 2.5, Infinity, NaN, '30']) {
    assert.equal(detail('shell', { timeout }), null);
  }
});

test('grep and search expose at most two explicit known modifiers within 80 characters', () => {
  assert.equal(detail('grep', { pattern: 'TODO', ignoreCase: true, literal: true, context: 3, glob: '**/*.ts' }), 'ignore case, literal');
  assert.equal(detail('search', { query: 'needle', context: 2, glob: ' src/**/*.ts  ' }), '2 context lines, glob src/**/*.ts');
  assert.equal(detail('grep', { glob: 'x'.repeat(500) })?.length, 80);
  assert.equal(detail('grep', { glob: 'x'.repeat(500) })?.startsWith('glob '), true);
  assert.equal(detail('grep', { ignoreCase: 'true', literal: 1, context: 0, glob: '   ' }), null);
});

test('unknown tools, subagents, writes and inferred/result-only details are omitted', () => {
  assert.equal(detail('subagent', { task: 'do work', timeout: 10 }), null);
  assert.equal(detail('mcp__grep', { pattern: 'x', ignoreCase: true }), null);
  assert.equal(detail('write', { path: 'a', content: 'abc', sizeBytes: 3 }), null);
  assert.equal(detail('read', {}, 'completed', { result: { offset: 10, timeout: 5 } }), null);
  assert.equal(detail('read', null), null);
});
