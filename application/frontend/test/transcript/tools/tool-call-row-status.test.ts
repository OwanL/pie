import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { h } from 'preact';
import renderToString from 'preact-render-to-string';
import { ToolCallHeader } from '../../../transcript/tool-call-card/tool-call-header';
import { ToolCallStatusGlyph } from '../../../transcript/tool-call-card/status-glyph';

for (const [status, label, className, title] of [
  ['drafting', 'Drafting', 'tool-call-status-draft', 'Generating tool arguments'],
  ['ready', 'Ready', 'tool-call-status-draft', 'Arguments ready'],
  ['running', 'Running', 'tool-call-status-spinner', 'Running · processing'],
] as const) {
  test(`${status} has a compact accessible mark and an explanatory tooltip`, () => {
    const html = renderToString(h(ToolCallStatusGlyph, { status }));
    assert.match(html, new RegExp(`class="${className}"`));
    assert.match(html, /role="img"/);
    assert.ok(html.includes(`aria-label="${label}"`));
    assert.ok(html.includes(`title="${title}"`));
    assert.doesNotMatch(html, /not executed/);
  });
}

test('completion has no glyph but retains the accessible Completed row label', () => {
  assert.equal(renderToString(h(ToolCallStatusGlyph, { status: 'completed' })), '');
  const html = renderToString(h(ToolCallHeader, {
    open: false, name: 'read', status: 'completed', summary: 'a.ts',
    onOpenFile: () => {}, onToggle: () => {},
  }));
  assert.match(html, /aria-label="read tool call, Completed\./);
  assert.doesNotMatch(html, /tool-call-status-completed|role="img"/);
});

test('failure retains the visible error-copy control instead of a quiet success mark', () => {
  const html = renderToString(h(ToolCallHeader, {
    open: false, name: 'bash', status: 'failed', summary: 'pnpm test', errorDetail: 'Command failed',
    onOpenFile: () => {}, onToggle: () => {},
  }));
  assert.match(html, /status-chip-failed/);
  assert.match(html, /Copy tool-call error detail/);
  assert.match(html, />Failed</);
  assert.doesNotMatch(html, /tool-call-status-completed|tool-call-status-spinner|tool-call-disclosure/);
});

test('pending and processing marks share a stable footprint without accent emphasis', async () => {
  const css = await readFile(new URL('../../../styles/tool-call.css', import.meta.url), 'utf8');
  for (const className of ['tool-call-status-draft', 'tool-call-status-spinner']) {
    const rule = css.match(new RegExp(`\\.${className}\\s*\\{[^}]*\\}`))?.[0];
    assert.ok(rule, `expected ${className} rule`);
    assert.match(rule, /width:\s*11px;/);
    assert.match(rule, /height:\s*11px;/);
    assert.match(rule, /var\(--panel-muted\)/);
    assert.doesNotMatch(rule, /panel-accent|panel-success/);
  }
});
