import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

// DOMPurify needs jsdom, not the component suite's happy-dom HTML parser.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
})) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

test('compact Markdown formats prose without full-transcript controls or headings', async () => {
  const { SubagentPreviewMarkdown } = await import('../../../transcript/subagent-preview-markdown');
  const { renderMarkdown } = await import('../../../transcript/markdown');
  const container = document.createElement('div');
  try {
    act(() => render(h(SubagentPreviewMarkdown, { text: [
      '# Findings',
      '**Passed** with *care* and `src/app.ts`.',
      'Next line',
      '',
      '- First',
      '- Second',
      '',
      '3. Third',
      '',
      '```ts',
      'const count = 1;',
      '```',
      '[details](https://example.com) ![diagram](https://example.com/image.png)',
    ].join('\n') }), container));
    assert.equal(container.querySelector('p > strong')?.textContent, 'Findings');
    assert.equal(container.querySelector('em')?.textContent, 'care');
    assert.equal(container.querySelector('code')?.textContent, 'src/app.ts');
    assert.equal(container.querySelectorAll('ul > li').length, 2);
    assert.equal(container.querySelector('ol')?.getAttribute('start'), '3');
    assert.ok(container.querySelector('br'));
    assert.equal(container.querySelector('pre > code')?.textContent?.trim(), 'const count = 1;');
    assert.match(container.textContent ?? '', /details diagram/);
    assert.ok(container.querySelector('h1, h2, h3, h4, h5, h6, a, button, img, [tabindex], [data-pie-file-path]') === null);

    // The isolated preview renderer must not change expanded transcript output.
    assert.match(renderMarkdown('# Findings'), /<h1>Findings<\/h1>/);
    assert.match(renderMarkdown('```ts\nconst count = 1;\n```'), /code-block-copy/);
  } finally {
    act(() => render(null, container));
  }
});

test('compact Markdown sanitizes HTML and tolerates incomplete streamed formatting', async () => {
  const { SubagentPreviewMarkdown } = await import('../../../transcript/subagent-preview-markdown');
  const container = document.createElement('div');
  try {
    for (const text of ['**Starting', '**Starting** with `code', '**Starting** with `code`']) {
      act(() => render(h(SubagentPreviewMarkdown, { text }), container));
      assert.match(container.textContent ?? '', /Starting/);
    }
    act(() => render(h(SubagentPreviewMarkdown, { text: '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)> **Safe** <strong onclick="alert(1)">text</strong>' }), container));
    assert.match(container.textContent ?? '', /Safe/);
    assert.ok(container.querySelector('script, img, [onclick], [onerror]') === null);
    assert.doesNotMatch(container.textContent ?? '', /alert/);
  } finally {
    act(() => render(null, container));
  }
});
