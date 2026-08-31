/**
 * Section 7 — dense markdown/code rendering.
 *
 * Verifies renderMarkdown emits code-block affordances (language label, copy
 * button, long-output collapse) and table scroll wrappers, and that the
 * enhanced markup is still sanitized by DOMPurify.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import {
  isLocalFilePath,
  localFilePathReference,
  resolveLocalFilePath,
} from '../../../../src/webview/panel/markdown-file-path';

// DOMPurify explicitly supports jsdom for server-side sanitization. happy-dom
// is used by the component suite, but its HTML parser currently strips benign
// wrapper elements while retaining <script>, making a sanitizer test both
// misleading and unsafe. Keep this security-sensitive seam on the supported
// DOM implementation.
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

async function readTranscriptCss() {
  return readFile(new URL('../../../../src/webview/panel/styles/transcript.css', import.meta.url), 'utf8');
}

async function loadRenderMarkdown() {
  const mod = await import('../../../../src/webview/panel/markdown.ts');
  return mod.renderMarkdown;
}

test('renderMarkdown wraps fenced code with a language label and copy button', async () => {
  const renderMarkdown = await loadRenderMarkdown();
  const html = renderMarkdown('```ts\nconst x = 1;\n```');

  assert.match(html, /class="code-block hljs-scope"/);
  assert.match(html, /class="code-block-lang">typescript</);
  assert.match(html, /class="code-block-copy"[^>]*aria-label="Copy code"/);
  assert.match(html, /<code class="hljs language-typescript">/);
  assert.match(html, /<span class="hljs-keyword">const<\/span>/);
  assert.match(html, /<span class="hljs-number">1<\/span>/);
  assert.match(html, / x = /);
  // Short blocks are not collapsible.
  assert.doesNotMatch(html, /code-block-collapsible/);
  assert.doesNotMatch(html, /code-block-toggle/);
});

test('renderMarkdown collapses long code blocks with a show-all toggle', async () => {
  const renderMarkdown = await loadRenderMarkdown();
  const lines = Array.from({ length: 25 }, (_, i) => `line${i}`).join('\n');
  const html = renderMarkdown('```\n' + lines + '\n```');

  assert.match(html, /code-block code-block-collapsible code-block-collapsed hljs-scope/);
  assert.match(html, /class="code-block-toggle"[^>]*aria-expanded="false">Show all 25 lines</);
});

test('renderMarkdown wraps tables in a horizontal scroll container', async () => {
  const renderMarkdown = await loadRenderMarkdown();
  const html = renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |');

  assert.match(html, /<div class="md-table-wrap"><table>/);
  assert.match(html, /<\/table><\/div>/);
});

test('local path recognition accepts Windows files but rejects URL schemes and bare directory code', () => {
  assert.equal(isLocalFilePath('C:\\workspace\\reveal\\docs\\foo.md'), true);
  assert.equal(localFilePathReference('file:///C:/workspace/reveal/docs/foo.md'), 'C:/workspace/reveal/docs/foo.md');
  assert.equal(isLocalFilePath('https://example.com/foo.md'), false);
  assert.equal(isLocalFilePath('reveal/docs'), false);
  assert.equal(isLocalFilePath('1.5.0'), false);
  assert.equal(isLocalFilePath('192.168.1.1'), false);
});

test('bare filename recognition is conservative about code identifiers and CSS selectors', () => {
  // Common bare filenames and conventional dotfiles stay interactive.
  assert.equal(isLocalFilePath('README.md'), true);
  assert.equal(isLocalFilePath('foo.ts'), true);
  assert.equal(isLocalFilePath('package.json'), true);
  assert.equal(isLocalFilePath('settings-menu.tsx'), true);
  assert.equal(isLocalFilePath('main.go'), true);
  assert.equal(isLocalFilePath('yarn.lock'), true);
  assert.equal(isLocalFilePath('.gitignore'), true);
  assert.equal(isLocalFilePath('.env'), true);
  assert.equal(isLocalFilePath('.env.local'), true);
  assert.equal(isLocalFilePath('.prettierrc.json'), true);

  // Property access and CSS selectors stay ordinary inline code.
  assert.equal(isLocalFilePath('response.ok'), false);
  assert.equal(isLocalFilePath('process.env'), false);
  assert.equal(isLocalFilePath('console.log'), false);
  assert.equal(isLocalFilePath('foo.bar'), false);
  assert.equal(isLocalFilePath('.message-body'), false);
  assert.equal(isLocalFilePath('.btn.primary'), false);

  // Separated paths are explicit references and keep the looser rule.
  assert.equal(isLocalFilePath('reveal/docs/foo.md'), true);
  assert.equal(isLocalFilePath('docs/guide.unknown-ext'), true);
});

test('renderMarkdown marks local inline paths and links without changing ordinary code or external links', async () => {
  const renderMarkdown = await loadRenderMarkdown();
  const html = renderMarkdown('`reveal/docs/foo.md` `ordinary code` [the doc](reveal/docs/foo.md) [external](https://example.com/foo.md)');

  assert.match(html, /<code class="file-path-link"[^>]*data-pie-file-path="reveal\/docs\/foo\.md"[^>]*role="link"[^>]*tabindex="0">reveal\/docs\/foo\.md<\/code>/);
  assert.match(html, /<a href="reveal\/docs\/foo\.md" class="file-path-link"[^>]*data-pie-file-path="reveal\/docs\/foo\.md"[^>]*role="link"[^>]*tabindex="0">the doc<\/a>/);
  assert.match(html, /<code>ordinary code<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com\/foo\.md">external<\/a>/);
  assert.doesNotMatch(html, /data-pie-file-path="ordinary code"/);
  assert.doesNotMatch(html, /class="file-path-link"[^>]*data-pie-file-path="https:\/\/example\.com/);

  const plainHtml = renderMarkdown('`reveal/docs/foo.md` <span role="link" tabindex="0">ordinary</span>', true, false);
  assert.match(plainHtml, /<code>reveal\/docs\/foo\.md<\/code>/);
  assert.match(plainHtml, /<span role="link" tabindex="0">ordinary<\/span>/);
});

test('renderMarkdown emits semantic rich markdown and task-list controls', async () => {
  const renderMarkdown = await loadRenderMarkdown();
  const html = renderMarkdown([
    '# Heading',
    '',
    '- first',
    '  - nested',
    '',
    '1. ordered',
    '',
    '> quoted',
    '',
    '---',
    '',
    '| Name | Value |',
    '| --- | --- |',
    '| a | b |',
    '',
    '- [ ] todo',
    '- [x] done',
    '',
    'separator paragraph',
    '',
    '- [ ] loose todo',
    '',
    '- [x] loose done',
  ].join('\n'));
  const document = new JSDOM(`<body>${html}</body>`).window.document;

  assert.equal(document.querySelector('h1')?.textContent, 'Heading');
  assert.ok(document.querySelector('ul > li > ul'), 'nested unordered list remains semantic');
  assert.ok(document.querySelector('ol > li'), 'ordered list remains semantic');
  assert.equal(document.querySelector('blockquote')?.textContent?.trim(), 'quoted');
  assert.ok(document.querySelector('hr'));
  assert.ok(document.querySelector('.md-table-wrap > table'));

  const taskInputs = [...document.querySelectorAll('li > input[type="checkbox"]')];
  assert.equal(taskInputs.length, 2);
  assert.equal(taskInputs[0]?.hasAttribute('disabled'), true);
  assert.equal(taskInputs[1]?.hasAttribute('checked'), true);

  // Loose lists wrap each item's checkbox in a paragraph; the marker-suppression
  // selector must cover this shape too.
  const looseTaskInputs = [...document.querySelectorAll('li > p > input[type="checkbox"]')];
  assert.equal(looseTaskInputs.length, 2);
  assert.equal(looseTaskInputs[0]?.hasAttribute('disabled'), true);
  assert.equal(looseTaskInputs[1]?.hasAttribute('checked'), true);
});

test('renderMarkdown keeps code identifiers and CSS selectors as plain inline code', async () => {
  const renderMarkdown = await loadRenderMarkdown();
  const html = renderMarkdown('`response.ok` `.message-body` `README.md` `foo.ts` `package.json` `.gitignore`');

  assert.match(html, /<code>response\.ok<\/code>/);
  assert.match(html, /<code>\.message-body<\/code>/);
  assert.match(html, /<code class="file-path-link"[^>]*data-pie-file-path="README\.md"[^>]*role="link"/);
  assert.match(html, /<code class="file-path-link"[^>]*data-pie-file-path="foo\.ts"[^>]*role="link"/);
  assert.match(html, /<code class="file-path-link"[^>]*data-pie-file-path="package\.json"[^>]*role="link"/);
  assert.match(html, /<code class="file-path-link"[^>]*data-pie-file-path="\.gitignore"[^>]*role="link"/);
  assert.doesNotMatch(html, /data-pie-file-path="response\.ok"/);
  assert.doesNotMatch(html, /data-pie-file-path="\.message-body"/);
});

test('resolveLocalFilePath handles relative, absolute, URI-encoded, and UNC references directly', () => {
  assert.equal(
    resolveLocalFilePath('../docs/guide.md', '/workspace/pie/src'),
    '/workspace/pie/docs/guide.md',
  );
  assert.equal(
    resolveLocalFilePath('src\\..\\README.md', 'D:\\Projects\\pie'),
    'D:\\Projects\\pie\\README.md',
  );
  assert.equal(
    resolveLocalFilePath('/workspace/pie/src/../README.md', 'D:\\Projects\\pie'),
    '/workspace/pie/README.md',
  );
  assert.equal(
    resolveLocalFilePath('file:///C:/workspace/My%20Docs/guide.md', '/workspace/pie'),
    'C:/workspace/My Docs/guide.md',
  );
  assert.equal(
    resolveLocalFilePath('\\\\server\\share\\docs\\..\\README.md', '/workspace/pie'),
    '\\\\server\\share\\README.md',
  );
});

test('sanitized Windows and file-URI anchors retain an announced keyboard target when href is removed', async () => {
  const renderMarkdown = await loadRenderMarkdown();
  const html = renderMarkdown(
    '[Windows path](C:/workspace/reveal/docs/README.md) [Encoded URI](file:///C:/workspace/My%20Docs/README.md)',
    false,
  );
  const document = new JSDOM(`<body>${html}</body>`).window.document;
  const links = [...document.querySelectorAll('a.file-path-link')];

  assert.equal(links.length, 2);
  for (const link of links) {
    assert.equal(link.getAttribute('role'), 'link');
    assert.equal(link.getAttribute('tabindex'), '0');
    assert.notEqual(link.getAttribute('data-pie-file-path'), null);
  }
  // DOMPurify rejects the drive-letter/file schemes as href values; delegated
  // handling must not rely on a native href for accessibility or activation.
  assert.equal(links[0]!.getAttribute('href'), null);
  assert.equal(links[1]!.getAttribute('href'), null);
});

test('renderMarkdown sanitizes unsafe HTML in enhanced output', async () => {
  const renderMarkdown = await loadRenderMarkdown();
  const html = renderMarkdown('Hello <script>alert(1)</script> normal text');

  assert.doesNotMatch(html, /<script/);
  assert.match(html, /normal text/);
});

test('transcript.css gives delegated file paths visible hover and keyboard focus styling', async () => {
  const css = await readTranscriptCss();
  assert.match(css, /\.message-body \.file-path-link\s*\{[\s\S]*?cursor:\s*pointer;/);
  assert.match(css, /\.message-body \.file-path-link:hover,[\s\S]*?\.message-body \.file-path-link:focus-visible/);
  assert.match(css, /code\.file-path-link:focus-visible\s*\{[\s\S]*?outline:/);
});

test('transcript.css styles the enhanced code-block affordances', async () => {
  const css = await readTranscriptCss();
  assert.match(css, /\.code-block\s*\{/);
  assert.match(css, /\.code-block\s+\.code-block-header\s*\{/);
  assert.match(css, /\.code-block-copy[\s\S]*?cursor:\s*pointer;/);
  assert.match(css, /\.code-block\.code-block-collapsed\s*>\s*pre\s*\{[\s\S]*?max-height:/);
  assert.match(css, /\.md-table-wrap\s*\{[\s\S]*?overflow-x:\s*auto;/);
});

test('jump-to-latest stays above the composer via --composer-height', async () => {
  const css = await readTranscriptCss();
  const rule = css.match(/\.transcript-jump-latest\s*\{[\s\S]*?\n\}/);
  assert.ok(rule, 'expected .transcript-jump-latest rule in transcript.css');
  assert.match(rule![0], /bottom:\s*calc\(var\(--composer-height[^)]*\)\s*\+\s*\d+px\);/);
});
