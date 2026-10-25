import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import type { ToolCall } from '../../../../lib/protocol/index.js';
import { ToolCallHeader } from '../../../transcript/tool-call-card.tsx';

const noop = () => undefined;

function renderHeader(toolCall?: ToolCall, options: { name?: string; summary?: string | null; summaryPath?: string } = {}): string {
  const name = options.name ?? toolCall?.name ?? 'read';
  return renderToString(h(ToolCallHeader, {
    open: false,
    name,
    nameTitle: name,
    status: toolCall?.status ?? 'completed',
    summary: options.summary ?? 'src/example.ts',
    summaryPath: options.summaryPath ?? '/repo/src/example.ts',
    toolCall,
    onToggle: noop,
  }));
}

test('read offset renders as secondary detail without replacing the name or full-path affordances', () => {
  const html = renderHeader({ id: 'read-offset', name: 'read', input: { path: '/repo/src/example.ts', offset: 12 }, status: 'completed' });

  assert.match(html, /class="tool-call-primary-summary"/);
  assert.match(html, /class="tool-call-secondary-detail" title="from line 12">from line 12<\/span>/);
  assert.match(html, /aria-label="read tool call, Completed\. \/repo\/src\/example\.ts\. from line 12\. Expand details"/);
  assert.match(html, /title="\/repo\/src\/example\.ts · Expand details"/);
  assert.match(html, /data-pie-file-path="\/repo\/src\/example\.ts"/);
});

test('multiple edit replacements render their requested count and distinguish provisional from applied requests', () => {
  const input = { path: '/repo/src/example.ts', edits: [
    { oldText: 'before', newText: 'after' },
    { oldText: 'old', newText: 'new' },
  ] };
  const drafting = renderHeader({ id: 'edit-draft', name: 'edit', input, status: 'drafting' });
  assert.match(drafting, /title="2 replacements so far">2 replacements so far<\/span>/);
  assert.match(drafting, /aria-label="edit tool call, Drafting\. \/repo\/src\/example\.ts\. 2 replacements so far\. Expand details"/);

  const completed = renderHeader({ id: 'edit-complete', name: 'edit', input, status: 'completed', result: { content: [{ type: 'text', text: 'Applied successfully' }] } });
  assert.match(completed, /title="2 replacements">2 replacements<\/span>/);
  assert.doesNotMatch(completed, /2 replacements applied|2 changes applied/);
});

test('bash timeout detail preserves the full command summary', () => {
  const command = 'npm run build && node scripts/verify.js --verbose';
  const html = renderHeader({ id: 'bash-timeout', name: 'bash', input: { command, timeout: 45 }, status: 'completed' }, { summary: command, summaryPath: undefined });

  assert.match(html, /class="tool-call-secondary-detail" title="timeout 45s">timeout 45s<\/span>/);
  assert.match(html, /transcript-header-summary-command/);
  assert.ok(html.includes(`title="${command.replace(/&/g, '&amp;')}"`), 'full command remains available in the primary summary tooltip');
  assert.match(html, /run build &amp;&amp; node/);
  assert.match(html, />verify\.js</);
  assert.match(html, /--verbose/);
});

test('missing and default inputs do not add a secondary detail', () => {
  for (const toolCall of [
    undefined,
    { id: 'read-default', name: 'read', input: { path: '/repo/src/example.ts' }, status: 'completed' as const },
    { id: 'bash-default', name: 'bash', input: { command: 'echo hello' }, status: 'completed' as const },
  ]) {
    const html = renderHeader(toolCall);
    assert.doesNotMatch(html, /tool-call-secondary-detail/);
  }
});

test('subagent headers do not get the ordinary secondary-detail or primary-summary wrappers', () => {
  const html = renderHeader({ id: 'subagent', name: 'subagent', input: { task: 'inspect', timeout: 30 }, status: 'completed' }, { summary: 'Inspect repository' });

  assert.doesNotMatch(html, /tool-call-secondary-detail/);
  assert.doesNotMatch(html, /tool-call-primary-summary/);
  assert.match(html, /tool-call-disclosure/);
});

test('secondary detail flexes and truncates within the established header limits', async () => {
  const css = await readFile(new URL('../../../styles/tool-call.css', import.meta.url), 'utf8');
  const detailRule = css.match(/\.tool-call-secondary-detail\s*\{[^}]*\}/)?.[0];
  const headingRule = css.match(/\.tool-call-heading-content\s*\{[^}]*\}/)?.[0];
  const narrowRule = css.match(/@container tool-row \(max-width: 640px\)[\s\S]*?\.tool-call-secondary-detail\s*\{[^}]*\}/)?.[0];

  assert.ok(detailRule, 'expected secondary-detail styles');
  assert.match(detailRule, /flex:\s*0 3 auto;/);
  assert.match(detailRule, /max-width:\s*50%;/);
  assert.match(detailRule, /overflow:\s*hidden;/);
  assert.match(detailRule, /text-overflow:\s*ellipsis;/);
  assert.ok(headingRule, 'expected heading-content styles');
  assert.match(headingRule, /min-width:\s*0;/);
  assert.ok(narrowRule, 'expected narrow row detail rule');
  assert.match(narrowRule, /display:\s*none;/);
});
