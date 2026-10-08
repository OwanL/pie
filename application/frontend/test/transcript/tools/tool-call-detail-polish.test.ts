import assert from 'node:assert/strict';
import test from 'node:test';
import { h } from 'preact';
import renderToString from 'preact-render-to-string';
import type { ToolCall } from '../../../../lib/protocol/index.js';
import { ToolCallBody } from '../../../transcript/tool-call-card/tool-call-body';

const noop = () => undefined;

function renderCall(toolCall: ToolCall, headerPath?: string, workingDirectory?: string | null) {
  return renderToString(h(ToolCallBody, { toolCall, headerPath, workingDirectory, onOpenFile: noop }));
}

const calls: Array<{ name: string; input: Record<string, unknown>; result?: unknown }> = [
  { name: 'read', input: { path: 'src/file.ts', limit: 20 }, result: 'file contents' },
  { name: 'edit', input: { path: 'src/file.ts', edits: [{ oldText: 'before', newText: 'after' }], mode: 'exact' }, result: { details: { diff: '- before\n+ after' } } },
  { name: 'write', input: { path: 'src/file.ts', content: 'written contents', encoding: 'utf8' } },
];

test('matching header paths are omitted while tool options and useful details remain', () => {
  for (const [index, { name, input, result }] of calls.entries()) {
    const html = renderCall({ id: `match-${index}`, name, input, result, status: 'completed' }, 'src/file.ts');
    assert.doesNotMatch(html, /<dt>path<\/dt>/, name);
    if (name === 'read') {
      assert.match(html, /<dt>limit<\/dt>/);
      assert.match(html, /file contents/);
    } else if (name === 'edit') {
      assert.match(html, /<dt>mode<\/dt>/);
      assert.match(html, /Applied changes/);
      assert.match(html, /after/);
    } else {
      assert.match(html, /<dt>encoding<\/dt>/);
      assert.match(html, /File content/);
      assert.match(html, /written contents/);
    }
  }
});

test('missing or mismatched header paths preserve the input path', () => {
  for (const [index, { name, input, result }] of calls.entries()) {
    const toolCall = { id: `path-${index}`, name, input, result, status: 'completed' as const };
    assert.match(renderCall(toolCall), /<dt>path<\/dt>/, `${name} without header path`);
    assert.match(renderCall(toolCall, 'src/other.ts'), /<dt>path<\/dt>/, `${name} with mismatched header path`);
  }
});

test('relative input paths match absolute header paths within the working directory', () => {
  const toolCall = { id: 'relative-match', name: 'read', status: 'completed' as const, input: { path: 'src/file.ts' }, result: 'file contents' };
  assert.doesNotMatch(renderCall(toolCall, '/repo/src/file.ts', '/repo'), /<dt>path<\/dt>/);
});

test('same-basename paths in different directories retain the input path', () => {
  const toolCall = { id: 'same-basename', name: 'read', status: 'completed' as const, input: { path: 'src/file.ts' }, result: 'file contents' };
  assert.match(renderCall(toolCall, '/repo/other/file.ts', '/repo'), /<dt>path<\/dt>/);
});

test('Windows working directories compare drive paths after slash normalization', () => {
  const toolCall = { id: 'windows-match', name: 'read', status: 'completed' as const, input: { path: 'src\\file.ts' }, result: 'file contents' };
  assert.doesNotMatch(renderCall(toolCall, 'D:/repo/src/file.ts', 'D:\\repo'), /<dt>path<\/dt>/);
});

test('relative input and absolute header paths do not match without a working directory', () => {
  const toolCall = { id: 'no-working-directory', name: 'read', status: 'completed' as const, input: { path: 'src/file.ts' }, result: 'file contents' };
  assert.match(renderCall(toolCall, '/repo/src/file.ts'), /<dt>path<\/dt>/);
});

test('provisional calls keep a matching input path visible', () => {
  const html = renderCall({
    id: 'provisional', name: 'edit', status: 'drafting', input: { path: 'src/file.ts', edits: [{ oldText: 'before', newText: 'after' }] },
  }, 'src/file.ts');
  assert.match(html, /<dt>path<\/dt>/);
  assert.doesNotMatch(html, /not executed|tool-call-provisional-notice/);
  assert.match(html, /Requested replacement/);
});
