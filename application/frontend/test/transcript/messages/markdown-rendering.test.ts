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
  ordinaryProseFilePathReference,
  resolveLocalFilePath,
} from '../../../transcript/markdown-file-path';

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
  return readFile(new URL('../../../styles/transcript.css', import.meta.url), 'utf8');
}

test('markdown tables and code scroll locally without forcing ordinary words to break', async () => {
  const css = await readTranscriptCss();
  assert.match(css, /\.message-body pre\s*\{[^}]*white-space:\s*pre;[^}]*word-break:\s*normal;[^}]*overflow-wrap:\s*normal;/);
  assert.match(css, /\.message-body table\s*\{[^}]*width:\s*max-content;[^}]*min-width:\s*100%;/);
  assert.match(css, /\.message-body td\s*\{[^}]*min-width:\s*12ch;[^}]*max-width:\s*40ch;[^}]*word-break:\s*normal;[^}]*overflow-wrap:\s*break-word;/);
});

async function loadRenderMarkdown() {
  const mod = await import('../../../transcript/markdown.ts');
  return mod.renderMarkdown;
}

test('common ecosystem manifest, notebook, and extensionless tool files are recognized', () => {
  // Go and .NET manifests plus Jupyter notebooks.
  for (const value of [
    'go.mod',
    'go.sum',
    'services/api/go.mod',
    'analysis.ipynb',
    'src/web/app.csproj',
    'MyApp.sln',
    'src/lib.fsproj',
    'src/lib.vbproj',
  ]) {
    assert.equal(isLocalFilePath(value), true, value);
  }

  // Extensionless conventional tool basenames.
  for (const value of ['Gemfile', 'Rakefile', 'Procfile', 'justfile', 'Vagrantfile', 'Brewfile']) {
    assert.equal(isLocalFilePath(value), true, value);
  }

  // Unrelated bare words with similar shapes stay inert.
  assert.equal(isLocalFilePath('notebook'), false);
  assert.equal(isLocalFilePath('sum'), false);
});

// Unquoted paths containing whitespace (`C:/Program Files/src/main.ts`) can
// never be joined safely by prose linkification; neither the truncated head
// (`C:/Program`) nor the whitespace-separated continuation
// (`Files/src/main.ts`) may become a partial link.
test('unquoted whitespace paths are never partially linkified in prose', async () => {
  const renderMarkdown = await loadRenderMarkdown();
  const samples = [
    'Edit C:/Program Files/src/main.ts now.',
    'Edit C:\\Program Files\\src\\main.ts, then restart.',
    'Edit /Program Files/src/main.ts now.',
  ];
  for (const source of samples) {
    const html = renderMarkdown(source);
    assert.doesNotMatch(html, /data-pie-file-path/, source);
  }
  // Complete whitespace-free references still linkify, alongside prose words.
  assert.match(
    renderMarkdown('Edit C:/workspace/src/main.ts now.'),
    /data-pie-file-path="C:\/workspace\/src\/main\.ts"/,
  );
  assert.match(
    renderMarkdown('Edit src/main.ts, then README.md.'),
    /data-pie-file-path="src\/main\.ts"[\s\S]*data-pie-file-path="README\.md"/,
  );
});

// Explicit references the user quoted themselves keep their full space-bearing
// value; only ambiguous ordinary prose is suppressed.
test('explicit codespans and markdown links keep full space-bearing local paths', async () => {
  const renderMarkdown = await loadRenderMarkdown();
  const codespanHtml = renderMarkdown('`C:/Program Files/src/main.ts`');
  assert.match(codespanHtml, /data-pie-file-path="C:\/Program Files\/src\/main\.ts"/);

  const linkedHtml = renderMarkdown('[main](<C:/Program Files/src/main.ts>)');
  assert.match(linkedHtml, /data-pie-file-path="C:\/Program Files\/src\/main\.ts"/);

  const externalHtml = renderMarkdown('`https://example.com/foo.md` [external](https://example.com/foo.md)');
  assert.doesNotMatch(externalHtml, /data-pie-file-path="https/);
});

test('local raster markdown images use safe placeholders, never filesystem src', async () => {
  const renderMarkdown = await loadRenderMarkdown();
  const html = renderMarkdown('![Chart & details](C:/workspace/chart.png "A & title")');
  assert.match(html, /data-pie-inline-image="C:\/workspace\/chart.png"/);
  assert.match(html, /data-pie-image-alt="Chart &amp; details"/);
  assert.match(html, /title="A &amp; title"/);
  assert.doesNotMatch(html, /<img|src=/);
  assert.match(html, /Chart &amp; details/);
  assert.doesNotMatch(renderMarkdown('![Chart](chart.png)', true, false), /data-pie-inline-image/);
  assert.doesNotMatch(renderMarkdown('![Vector](C:/vector.svg)'), /data-pie-inline-image/);
  assert.match(renderMarkdown('![Remote](https://example.com/chart.png)'), /src="https:\/\/example.com\/chart.png"/);
});

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

test('ordinary prose file references are clickable without absolute paths and retain punctuation', async () => {
  const renderMarkdown = await loadRenderMarkdown();
  const html = renderMarkdown('Open src/markdown.ts, then README.md. Keep response.ok, console.log, v1.2.3, 192.168.1.1, and example.com/docs/README.md unchanged.');
  const document = new JSDOM(`<body>${html}</body>`).window.document;
  const references = [...document.querySelectorAll('[data-pie-file-path]')];

  assert.deepEqual(references.map((reference) => reference.getAttribute('data-pie-file-path')), [
    'src/markdown.ts',
    'README.md',
  ]);
  assert.deepEqual(references.map((reference) => reference.textContent), ['src/markdown.ts', 'README.md']);
  assert.match(document.body.textContent ?? '', /src\/markdown\.ts, then README\.md\./);
  assert.doesNotMatch(html, /data-pie-file-path="(?:response\.ok|console\.log|v1\.2\.3|192\.168\.1\.1|example\.com)/);
  assert.match(html, /<a class="file-path-link"[^>]*data-pie-file-path="README\.md"[^>]*role="link" tabindex="0">README\.md<\/a>\./);

  const plainHtml = renderMarkdown('README.md & note', true, false);
  assert.doesNotMatch(plainHtml, /data-pie-file-path=/);
  assert.match(plainHtml, /README\.md &amp; note/);
});

test('ordinary prose detection leaves existing links and code unchanged', async () => {
  const renderMarkdown = await loadRenderMarkdown();
  const html = renderMarkdown([
    '`README.md` [linked README.md](README.md) https://example.com/README.md',
    '',
    '```text',
    'README.md',
    '```',
  ].join('\n'));
  const document = new JSDOM(`<body>${html}</body>`).window.document;

  assert.equal(document.querySelectorAll('code.file-path-link[data-pie-file-path="README.md"]').length, 1);
  assert.equal(document.querySelectorAll('a.file-path-link[data-pie-file-path="README.md"]').length, 1);
  assert.equal(document.querySelectorAll('a[href^="https://example.com"] [data-pie-file-path]').length, 0);
  assert.ok(document.querySelector('pre')?.querySelector('[data-pie-file-path]') === null);
});

test('ordinary prose path candidates reject domains and leave trailing punctuation outside references', () => {
  assert.equal(ordinaryProseFilePathReference('README.md:'), 'README.md');
  assert.equal(ordinaryProseFilePathReference('example.com/docs/README.md'), null);
  assert.equal(ordinaryProseFilePathReference('localhost/docs/README.md'), null);
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

test('rendered explicit destinations own code labels for delegated click and context menu', async () => {
  const renderMarkdown = await loadRenderMarkdown();
  const { handleDelegatedFilePathClick, handleDelegatedFilePathContextMenu } = await import('../../../transcript/file-path-interactions');
  for (const [source, expected] of [
    ['[`label.ts`](actual.ts)', 'actual.ts'],
    ['[`label.ts`](https://example.com/actual.ts)', null],
    ['`label.ts`', 'label.ts'],
  ] as const) {
    const document = new JSDOM(`<body>${renderMarkdown(source, false)}</body>`).window.document;
    const target = document.querySelector('code')!;
    if (target.closest('a')) assert.equal(target.hasAttribute('tabindex'), false);
    const event = { target, preventDefault() {}, stopPropagation() {} };
    const opens: unknown[][] = [];
    const menus: unknown[][] = [];
    assert.equal(handleDelegatedFilePathClick(event, '/work', (...args) => opens.push(args)), expected !== null);
    assert.equal(handleDelegatedFilePathContextMenu(event, '/work', (...args) => menus.push(args)), expected !== null);
    assert.deepEqual(opens, expected ? [[`/work/${expected}`, expected, '/work']] : []);
    if (expected) {
      assert.equal(menus[0]![1], `/work/${expected}`);
      assert.deepEqual(menus[0]![4], { reference: expected, workingDirectory: '/work' });
    } else assert.deepEqual(menus, []);
  }
});

test('explicit image link labels retain image preview markup', async () => {
  const renderMarkdown = await loadRenderMarkdown();
  const document = new JSDOM(`<body>${renderMarkdown('[![preview](./preview.png)](actual.ts)', false)}</body>`).window.document;
  assert.equal(document.querySelector('a')?.getAttribute('data-pie-file-path'), 'actual.ts');
  assert.equal(document.querySelector('a [data-pie-inline-image]')?.getAttribute('data-pie-inline-image'), './preview.png');
});

test('rendered file URI opens preserve raw references and decode filename characters only once', async () => {
  const renderMarkdown = await loadRenderMarkdown();
  const { handleDelegatedFilePathClick } = await import('../../../transcript/file-path-interactions');
  for (const [reference, path] of [
    ['file:///tmp/report.md%23backup.md', '/tmp/report.md#backup.md'],
    ['file:///tmp/report.md%23backup.md#L12', '/tmp/report.md#backup.md'],
    ['file:///tmp/report%2523.md', '/tmp/report%23.md'],
    ['file:///tmp/report.md%3Fbackup.md?raw=1#L12', '/tmp/report.md?backup.md'],
    ['file:///C:/My%20Docs/report.md%23backup.md#L12', 'C:/My Docs/report.md#backup.md'],
    ['file:///tmp/report.md#L12', '/tmp/report.md'],
    ['/tmp/report.md:12:3', '/tmp/report.md:12:3'],
  ]) {
    const document = new JSDOM(`<body>${renderMarkdown(`[report](${reference})`, false)}</body>`).window.document;
    const opens: unknown[][] = [];
    assert.equal(handleDelegatedFilePathClick({ target: document.querySelector('a')!, preventDefault() {}, stopPropagation() {} }, '/work', (...args) => opens.push(args)), true);
    // File URIs retain provenance, not a decoded pathname which could be
    // parsed as a new fragment.
    assert.deepEqual(opens, [[path, reference, '/work']]);
  }
});

test('rendered non-URI links delegate canonical references for bare-name workspace fallback', async () => {
  const renderMarkdown = await loadRenderMarkdown();
  const { handleDelegatedFilePathClick, handleDelegatedFilePathContextMenu } = await import('../../../transcript/file-path-interactions');
  for (const [destination, reference] of [
    ['report.md#L9', 'report.md'],
    ['report.md?raw=1#L9', 'report.md'],
    ['src/report.md#L12', 'src/report.md'],
    ['report#backup.md', 'report#backup.md'],
    ['report?backup.md', 'report?backup.md'],
    ['report%23.md', 'report%23.md'],
    ['report%2523.md', 'report%2523.md'],
  ]) {
    const document = new JSDOM(`<body>${renderMarkdown(`[report](${destination})`, false)}</body>`).window.document;
    const target = document.querySelector('a')!;
    assert.equal(target.getAttribute('data-pie-file-path'), reference);
    const event = { target, preventDefault() {}, stopPropagation() {} };
    const opens: unknown[][] = [];
    const menus: unknown[][] = [];
    assert.equal(handleDelegatedFilePathClick(event, '/work', (...args) => opens.push(args)), true);
    assert.deepEqual(opens, [[`/work/${reference}`, reference, '/work']]);
    assert.equal(handleDelegatedFilePathContextMenu(event, '/work', (...args) => menus.push(args)), true);
    assert.equal(menus[0]![1], `/work/${reference}`);
    assert.deepEqual(menus[0]![4], { reference, workingDirectory: '/work' });
  }
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

test('jump-to-latest stays muted with shadow for separation and leaves surrounding content interactive', async () => {
  const css = await readTranscriptCss();
  const rule = css.match(/\.transcript-jump-latest\s*\{[\s\S]*?\n\}/);
  assert.ok(rule, 'expected .transcript-jump-latest rule in transcript.css');
  assert.doesNotMatch(rule![0], /--composer-height|position:\s*(?:fixed|absolute);|bottom:/);
  const dock = css.match(/\.transcript-latest-dock\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(dock, /position:\s*absolute;/);
  assert.match(dock, /pointer-events:\s*none;/);
  assert.doesNotMatch(dock, /background:|--composer-height/);
  assert.match(rule![0], /pointer-events:\s*auto;/);
  assert.match(rule![0], /color:\s*var\(--panel-muted\);/);
  assert.match(rule![0], /box-shadow:\s*(?!none)[^;]+;/);
  assert.match(rule![0], /width:\s*32px;[^}]*height:\s*32px;/);
  assert.match(rule![0], /padding:\s*0;/);
  assert.match(css, /@media \(pointer: coarse\)\s*\{\s*\.transcript-jump-latest \{ height: 44px;/);
});
