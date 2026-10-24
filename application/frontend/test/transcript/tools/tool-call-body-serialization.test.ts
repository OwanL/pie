import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { installDom } from '../../helpers/dom';
installDom();
import { h } from 'preact';
import renderToString from 'preact-render-to-string';
import type { ToolCall } from '../../../../lib/protocol/index.js';
import { ToolCallBody } from '../../../transcript/tool-call-card/tool-call-body';
import { formatValueAsHighlightedYaml, stringifyValueAsYamlText } from '../../../transcript/highlight';
import { setToolTextSegmentThreshold, TOOL_TEXT_SEGMENT_DEFAULT_CHARS } from '../../../transcript/tool-call-card/segmented-text';

const base: ToolCall = { id: 'serialization', name: 'custom', input: {}, status: 'completed' };
const noop = () => undefined;
const renderResult = (result: unknown) => renderToString(h(ToolCallBody, { toolCall: { ...base, result }, onOpenFile: noop }));
afterEach(() => setToolTextSegmentThreshold(TOOL_TEXT_SEGMENT_DEFAULT_CHARS));

test('small structured results serialize once and retain the existing highlighted HTML', () => {
  const record = { path: 'src/example.ts', message: '<tag> & Ω' };
  const expectedHtml = formatValueAsHighlightedYaml({ record });
  let serializations = 0;
  const observedRecord = new Proxy(record, {
    ownKeys(target) {
      serializations += 1;
      return Reflect.ownKeys(target);
    },
  });
  const html = renderResult({ record: observedRecord });
  // Observe a nested record: root classification also enumerates result keys.
  assert.equal(serializations, 1);
  assert.ok(html.includes(`<code class="hljs language-yaml">${expectedHtml}</code>`));
});

test('structured results retain the exact segmentation threshold and complete text', () => {
  const result = { output: 'line & Ω\n'.repeat(24) };
  const yaml = stringifyValueAsYamlText(result);
  setToolTextSegmentThreshold(yaml.length);
  assert.doesNotMatch(renderResult(result), /tool-call-segment-range/);
  setToolTextSegmentThreshold(yaml.length - 1);
  const container = document.createElement('div');
  container.innerHTML = renderResult(result);
  assert.ok(container.querySelectorAll('.tool-call-segment-range').length > 1);
  assert.equal(Array.from(container.querySelectorAll('code')).map((code) => code.textContent).join(''), yaml);
});

test('string fallbacks stay escaped and image results never serialize their payload as YAML', () => {
  // ANSI-only text has no extracted plain-text result and reaches the fallback.
  const value = '\u001b[31m';
  assert.ok(renderResult(value).includes(`<code class="hljs language-yaml">${formatValueAsHighlightedYaml(value)}</code>`));
  const html = renderResult({ content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }], extra: 'structured' });
  assert.match(html, /src="data:image\/png;base64,aGVsbG8="/);
  assert.doesNotMatch(html, /language-yaml/);
});
