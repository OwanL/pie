import assert from 'node:assert/strict';
import test from 'node:test';

import { formatToolResult } from '../../../src/shared/tool-result-format';
import type { ToolResultContentPartLike } from '../../../src/shared/tool-result-format';

/**
 * `formatToolResult` reshapes a tool-result-like message into the value stored
 * on a `ToolCall.result`. It is intentionally defensive about `unknown` shapes:
 * it branches on whether `details` is present and whether `content` is a string
 * or a structured parts array, extracting text from `type:'text'` parts only.
 *
 * `textFromToolResultParts` is module-private, so we exercise every one of its
 * branches (empty, unknown part type, missing `text`, mixed parts) through
 * `formatToolResult`'s array path.
 */

test('details present with non-empty string content returns { content, details }', () => {
  const details = { code: 1, signal: 'SIGTERM' };
  assert.deepEqual(
    formatToolResult({ content: 'build failed', details }),
    { content: 'build failed', details },
  );
});

test('details present with non-empty content array returns { content, details }', () => {
  const content = [{ type: 'text', text: 'partial' }];
  const details = { truncated: true };
  assert.deepEqual(
    formatToolResult({ content, details }),
    { content, details },
  );
});

test('details present with empty string content falls back to details only', () => {
  const details = { only: 'details' };
  assert.equal(formatToolResult({ content: '', details }), details);
});

test('details present with empty content array falls back to details only', () => {
  const details = { only: 'details' };
  assert.equal(formatToolResult({ content: [], details }), details);
});

test('details present with undefined content falls back to details only', () => {
  const details = { only: 'details' };
  assert.equal(formatToolResult({ details }), details);
});

test('no details with content array joins text parts in order', () => {
  assert.equal(
    formatToolResult({ content: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }] }),
    'hello world',
  );
});

test('no details with mixed parts extracts only type:text parts with string text', () => {
  // Unknown part types and text-less text parts must be filtered out so they do
  // not contribute to the joined output.
  assert.equal(
    formatToolResult({
      content: [
        { type: 'text', text: 'a' },
        { type: 'image', text: 'ignored-image' },
        { type: 'json', text: 'ignored-json' },
        { type: 'text' }, // type text but no `text` string -> filtered
        { type: 'text', text: 'b' },
        { type: 'unknown-type' },
      ],
    }),
    'ab',
  );
});

test('no details with empty content array returns the empty array (text is falsy)', () => {
  // textFromToolResultParts([]) === '' which is falsy, so the raw content array
  // is returned rather than an empty string.
  const content: ToolResultContentPartLike[] = [];
  assert.equal(formatToolResult({ content }), content);
});

test('no details with content array of only non-text parts returns the raw array', () => {
  // No text extractable -> fall back to the structured content so callers can
  // still inspect the parts.
  const content = [{ type: 'image', text: 'x' }, { type: 'json' }];
  assert.equal(formatToolResult({ content }), content);
});

test('no details with a single empty-string text part returns the raw array', () => {
  // Edge: a text part whose text is '' yields joined text '' (falsy), so the
  // array is returned instead of an empty string.
  const content = [{ type: 'text', text: '' }];
  assert.equal(formatToolResult({ content }), content);
});

test('no details with string content returns the string unchanged', () => {
  assert.equal(formatToolResult({ content: 'plain output' }), 'plain output');
});

test('no details with undefined content returns null', () => {
  assert.equal(formatToolResult({}), null);
  assert.equal(formatToolResult({ content: undefined }), null);
});

test('null content with no details returns null (nullish coalescing)', () => {
  // `content ?? null` -> explicit null content becomes null too.
  assert.equal(formatToolResult({ content: null as unknown as undefined }), null);
});
