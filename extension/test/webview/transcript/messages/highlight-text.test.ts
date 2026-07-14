import assert from 'node:assert/strict';
import test from 'node:test';

import { textFromToolResult } from '../../../../src/webview/panel/transcript/highlight';

/**
 * `textFromToolResult` is the single display chokepoint for human-readable
 * tool-result text (terminal pane, error detail, activity tail). It must strip
 * ANSI CSI sequences so forced-color tool output (e.g. `ls --color=always`,
 * test runners with `--color`) renders as plain text, while preserving the
 * existing extraction semantics (string vs `content` array, text-part filtering,
 * `\n\n` join, undefined when no text).
 */

test('textFromToolResult strips ANSI from a top-level string result', () => {
  assert.equal(
    textFromToolResult('hello \x1b[31mred\x1b[0m world'),
    'hello red world',
  );
});

test('textFromToolResult strips ANSI from string content', () => {
  assert.equal(
    textFromToolResult({ content: '\x1b[1mbold\x1b[0m line' }),
    'bold line',
  );
});

test('textFromToolResult strips ANSI from each text part of a content array', () => {
  assert.equal(
    textFromToolResult({
      content: [
        { type: 'text', text: '\x1b[32mgreen\x1b[0m one' },
        { type: 'text', text: '\x1b[33myellow\x1b[0m two' },
      ],
    }),
    'green one\n\nyellow two',
  );
});

test('textFromToolResult joins text parts with a blank line and filters non-text parts', () => {
  assert.equal(
    textFromToolResult({
      content: [
        { type: 'text', text: 'a' },
        { type: 'image', text: 'ignored-image' },
        { type: 'text', text: 'b' },
      ],
    }),
    'a\n\nb',
  );
});

test('textFromToolResult returns undefined when there is no text content', () => {
  assert.equal(textFromToolResult({ content: [] }), undefined);
  assert.equal(textFromToolResult({ content: [{ type: 'image', text: 'x' }] }), undefined);
  assert.equal(textFromToolResult({}), undefined);
  assert.equal(textFromToolResult(null), undefined);
  assert.equal(textFromToolResult(undefined), undefined);
});

test('textFromToolResult returns undefined for ANSI-only content (strips to empty)', () => {
  // After stripping, the text is empty — treat as no text so callers fall back
  // to structured formatting instead of rendering an empty terminal pane.
  assert.equal(textFromToolResult({ content: '\x1b[0m' }), undefined);
  assert.equal(textFromToolResult({ content: [{ type: 'text', text: '\x1b[31m\x1b[0m' }] }), undefined);
});
