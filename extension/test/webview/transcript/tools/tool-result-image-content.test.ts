import assert from 'node:assert/strict';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import type { ToolCall } from '../../../../src/shared/protocol';
import { formatToolResult } from '../../../../src/shared/tool-result-format';
import { ToolCallBody } from '../../../../src/webview/panel/transcript/tool-call-card/tool-call-body';
import {
  classifyToolResultContent,
  hasImageToolResult,
} from '../../../../src/webview/panel/transcript/tool-call-card/tool-result-content';
import { formatToolCallResultForDisplay } from '../../../../src/webview/panel/transcript/tool-call-card/format';

const noop = () => undefined;

// A tiny real PNG (1×1) so the data URL is plausible without being huge.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

function toolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tool-1',
    name: 'screenshot_tool',
    input: { target: 'window' },
    status: 'completed',
    ...overrides,
  };
}

function renderBody(result: ToolCall['result']): string {
  const tree = h(ToolCallBody, { toolCall: toolCall({ result }), onOpenFile: noop });
  return renderToString(tree as Parameters<typeof renderToString>[0]);
}

/** Strip every `img src="data:image/png;base64,..."` so a base64 leak into
 *  text/YAML can be detected as leftover `iVBORw0`. */
function stripImgDataUrls(html: string): string {
  return html.replace(/src="data:image\/png;base64,[^"]*"/g, '');
}

/** Strip HTML tags so assertions can match the plain text of highlighted output. */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

// ── helper unit tests ──────────────────────────────────────────────────────

test('reloaded transcript formatting preserves mixed image rendering without YAML leakage', () => {
  const formatted = formatToolResult({
    content: [
      { type: 'text', text: 'reloaded caption' },
      { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
    ],
  });
  assert.equal(hasImageToolResult(formatted), true);
  const html = renderBody(formatted as ToolCall['result']);
  assert.match(html, /reloaded caption/);
  assert.ok(html.includes(`src="data:image/png;base64,${PNG_BASE64}"`));
  assert.doesNotMatch(stripImgDataUrls(html), /iVBORw0/);
});

test('hasImageToolResult detects any image-typed content part', () => {
  assert.equal(
    hasImageToolResult({ content: [{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }] }),
    true,
  );
  assert.equal(
    hasImageToolResult({
      content: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'x', mimeType: 'image/png' }],
    }),
    true,
  );
  // An image-typed part routes to the mixed path even when malformed, so its
  // base64 (if present) is never YAML-serialized.
  assert.equal(hasImageToolResult({ content: [{ type: 'image' }] }), true);
});

test('hasImageToolResult is false for text-only and non-content results', () => {
  assert.equal(hasImageToolResult({ content: [{ type: 'text', text: 'hi' }] }), false);
  assert.equal(
    hasImageToolResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
    false,
  );
  assert.equal(hasImageToolResult({ foo: 'bar' }), false);
  assert.equal(hasImageToolResult('plain string'), false);
  assert.equal(hasImageToolResult(undefined), false);
  assert.equal(hasImageToolResult({ content: 'not an array' }), false);
  assert.equal(hasImageToolResult({ content: [] }), false);
});

test('classifyToolResultContent builds a data URL for valid image parts in order', () => {
  const parts = classifyToolResultContent({
    content: [
      { type: 'text', text: 'caption' },
      { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
    ],
  })!;
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], { kind: 'text', text: 'caption' });
  assert.equal(parts[1].kind, 'image');
  if (parts[1].kind === 'image') {
    assert.equal(parts[1].src, `data:image/png;base64,${PNG_BASE64}`);
    assert.match(parts[1].alt, /Image/);
  }
  // base64 must never appear outside the image `src`.
  for (const part of parts) {
    if (part.kind === 'text') assert.doesNotMatch(part.text, /iVBORw0/);
    if (part.kind === 'unsupported') assert.doesNotMatch(part.message, /iVBORw0/);
  }
});

test('classifyToolResultContent gives a bounded, data-free fallback for malformed parts', () => {
  const parts = classifyToolResultContent({
    content: [
      { type: 'image', mimeType: 'image/png' }, // missing data
      { type: 'image', data: PNG_BASE64, mimeType: 'text/html' }, // bad mimeType
      { type: 'image', data: PNG_BASE64 }, // missing mimeType
      { type: 'weird', foo: 'bar' }, // unknown type
      'not-an-object',
    ],
  })!;
  assert.equal(parts.length, 5);
  for (const part of parts) {
    assert.equal(part.kind, 'unsupported');
    assert.ok(part.message.length <= 120, `fallback not bounded: "${part.message}"`);
    assert.doesNotMatch(part.message, /iVBORw0/);
  }
});

// ── rendering tests ────────────────────────────────────────────────────────

test('mixed text/image result renders text and an <img> data URL in order', () => {
  const html = renderBody({
    content: [
      { type: 'text', text: 'Before screenshot' },
      { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
      { type: 'text', text: 'After screenshot' },
    ],
  });

  assert.match(html, /Before screenshot/);
  assert.match(html, /After screenshot/);
  assert.match(html, /<img[^>]*class="tool-call-result-image"/);
  assert.match(html, /src="data:image\/png;base64,/);
  // Parts render in source order: text → image → text.
  assert.ok(html.indexOf('Before screenshot') < html.indexOf('<img'));
  assert.ok(html.indexOf('<img') < html.indexOf('After screenshot'));
  // base64 appears only inside the img src, never as bare text/YAML.
  assert.doesNotMatch(stripImgDataUrls(html), /iVBORw0/);
});

test('image-only result renders an <img> and never dumps base64 as YAML', () => {
  const html = renderBody({
    content: [{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }],
  });

  assert.match(html, /<img[^>]*src="data:image\/png;base64,/);
  // No base64 anywhere outside the img src.
  assert.doesNotMatch(stripImgDataUrls(html), /iVBORw0/);
  assert.doesNotMatch(html, /tool-call-result-unsupported/);
});

test('image-only result with a malformed image part falls back boundedly', () => {
  const html = renderBody({
    content: [{ type: 'image', data: PNG_BASE64, mimeType: 'text/html' }],
  });

  // No <img> (mimeType rejected), and no base64 leaked as text/YAML.
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(stripImgDataUrls(html), /iVBORw0/);
  assert.match(html, /tool-call-result-unsupported/);
  assert.match(html, /unsupported image part/);
});

test('text-only result is unchanged: highlighted text, no image renderer', () => {
  const html = renderBody({ content: [{ type: 'text', text: 'plain text result' }] });

  assert.match(html, /plain text result/);
  assert.doesNotMatch(html, /tool-call-result-image/);
  assert.doesNotMatch(html, /tool-call-result-content/);
});

test('non-image structured result renders as YAML (unchanged)', () => {
  const html = renderBody({
    content: [{ type: 'text', text: 'x' }],
    isError: false,
    count: 3,
  });

  // Structured result → YAML serialization of the whole object.
  const plain = stripTags(html);
  assert.match(plain, /isError: false/);
  assert.match(plain, /count: 3/);
  assert.doesNotMatch(html, /tool-call-result-image/);
  assert.doesNotMatch(html, /tool-call-result-content/);
});

test('a result with details + image renders the image (details not required for the body)', () => {
  const html = renderBody({
    content: [{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }],
    details: { truncation: { truncated: false } },
  });
  assert.match(html, /<img[^>]*src="data:image\/png;base64,/);
  assert.doesNotMatch(stripImgDataUrls(html), /iVBORw0/);
});

// ── display/summary formatter ──────────────────────────────────────────────

test('formatToolCallResultForDisplay never includes base64', () => {
  // image-only: bounded placeholder, no base64.
  assert.equal(
    formatToolCallResultForDisplay({
      name: 't',
      result: { content: [{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }] },
    }),
    '',
  );

  // mixed: returns the text part only, no base64.
  assert.equal(
    formatToolCallResultForDisplay({
      name: 't',
      result: {
        content: [
          { type: 'text', text: 'caption' },
          { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
        ],
      },
    }),
    'caption',
  );

  // malformed image (bad mimeType) with data: no base64 leak.
  assert.equal(
    formatToolCallResultForDisplay({
      name: 't',
      result: { content: [{ type: 'image', data: PNG_BASE64, mimeType: 'text/html' }] },
    }),
    '',
  );

  // non-image structured result: unchanged JSON serialization.
  assert.equal(
    formatToolCallResultForDisplay({ name: 't', result: { foo: 'bar' } }),
    JSON.stringify({ foo: 'bar' }, null, 2),
  );

  // undefined result: empty string, unchanged.
  assert.equal(formatToolCallResultForDisplay({ name: 't', result: undefined }), '');
});
