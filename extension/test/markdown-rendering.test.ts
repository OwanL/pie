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

import { installDom } from './_helpers/dom';

installDom();

async function readTranscriptCss() {
  return readFile(new URL('../src/webview/panel/styles/transcript.css', import.meta.url), 'utf8');
}

async function loadRenderMarkdown() {
  const mod = await import('../src/webview/panel/markdown.ts');
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

test('renderMarkdown sanitizes unsafe HTML in enhanced output', async () => {
  const renderMarkdown = await loadRenderMarkdown();
  const html = renderMarkdown('Hello <script>alert(1)</script> normal text');

  assert.doesNotMatch(html, /<script/);
  assert.match(html, /normal text/);
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
