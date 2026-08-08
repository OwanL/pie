import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { DEFAULT_CHAT_PREFS } from '../../../../src/shared/protocol';

async function readToolCallCss() {
  return readFile(new URL('../../../../src/webview/panel/styles/tool-call.css', import.meta.url), 'utf8');
}

async function readTranscriptCss() {
  return readFile(new URL('../../../../src/webview/panel/styles/transcript.css', import.meta.url), 'utf8');
}

test('collapsed tool-call headers use the shared path hierarchy', async () => {
  const { ToolCallHeader } = await import('../../../../src/webview/panel/transcript/tool-call-card.tsx');
  const html = renderToString(h(ToolCallHeader, {
    open: false,
    name: 'read',
    nameTitle: 'Read file',
    status: 'completed',
    summary: 'src/example.ts',
    summaryPath: '/repo/src/example.ts',
    sizeHint: '+3 lines',
    onToggle: () => {},
    onOpenFile: () => {},
  }));

  assert.match(html, /flex min-w-0 flex-1 items-center/);
  assert.doesNotMatch(html, /grid-template-columns:/);
  assert.match(html, /transcript-header-title-mono/);
  assert.match(html, /transcript-header-summary-link/);
  assert.match(html, /transcript-header-path-prefix/);
  assert.match(html, /transcript-header-path-target/);
  assert.match(html, /transcript-header-summary-link group/);
  assert.match(html, /flex-\[0_0_var\(--tool-call-size-column-width\)\]/);
  assert.match(html, /ml-auto/);
});

test('collapsed path labels honor depth while retaining the full path tooltip', async () => {
  const { ToolCallHeader } = await import('../../../../src/webview/panel/transcript/tool-call-card.tsx');
  const html = renderToString(h(ToolCallHeader, {
    open: false,
    name: 'read',
    status: 'completed',
    summary: 'dira/dirb/dirc/example.ts',
    summaryPath: '/repo/dira/dirb/dirc/example.ts',
    prefs: { ...DEFAULT_CHAT_PREFS, uiPathParentDepth: 1 },
    onToggle: () => {},
    onOpenFile: () => {},
  }));

  assert.match(html, /dirc\//);
  assert.match(html, />example\.ts</);
  assert.doesNotMatch(html, />dira\//);
  assert.match(html, /title="\/repo\/dira\/dirb\/dirc\/example\.ts"/);
});

test('collapsed bash headers emphasize the shell verb over the path context', async () => {
  const { ToolCallHeader } = await import('../../../../src/webview/panel/transcript/tool-call-card.tsx');
  const html = renderToString(h(ToolCallHeader, {
    open: false,
    name: 'bash',
    status: 'completed',
    summary: 'rm somepath/somefile.txt',
    sizeHint: '+3 lines',
    onToggle: () => {},
    onOpenFile: () => {},
  }));

  assert.match(html, /transcript-header-summary-command">rm</);
  assert.match(html, /transcript-header-path-prefix/);
  assert.match(html, />somepath\//);
  assert.match(html, /transcript-header-path-target">somefile\.txt</);
});

test('collapsed bash headers keep surrounding quotes separate from the emphasized path', async () => {
  const { ToolCallHeader } = await import('../../../../src/webview/panel/transcript/tool-call-card.tsx');
  const html = renderToString(h(ToolCallHeader, {
    open: false,
    name: 'bash',
    status: 'completed',
    summary: 'rm "some dir/file name.txt"',
    onToggle: () => {},
    onOpenFile: () => {},
  }));

  assert.doesNotMatch(html, /transcript-header-path-prefix[^>]*>&quot;some dir\//);
  assert.doesNotMatch(html, /transcript-header-path-target[^>]*>file name\.txt&quot;</);
  assert.match(html, /transcript-header-path-prefix/);
  assert.match(html, /some dir\//);
  assert.match(html, /transcript-header-path-target[^>]*>file name\.txt</);
});

test('expanded bash headers suppress the command summary while the terminal body is visible', async () => {
  const { ToolCallHeader } = await import('../../../../src/webview/panel/transcript/tool-call-card.tsx');
  const html = renderToString(h(ToolCallHeader, {
    open: false,
    bodyVisible: true,
    name: 'bash',
    status: 'running',
    summary: 'rm somepath/somefile.txt',
    onToggle: () => {},
    onOpenFile: () => {},
  }));

  assert.match(html, />bash</);
  assert.doesNotMatch(html, /transcript-header-summary-command/);
  assert.doesNotMatch(html, />rm</);
});

test('transcript scrollbar keeps a broad hit area with a quiet visible thumb', async () => {
  const css = await readTranscriptCss();

  assert.match(css, /\.transcript::-webkit-scrollbar\s*\{[^}]*width:\s*10px/);
  assert.match(css, /\.transcript::-webkit-scrollbar-thumb\s*\{[^}]*background-clip:\s*padding-box[^}]*border:\s*3px solid transparent/);
  assert.match(css, /\.transcript-message-rail\s*\{[^}]*right:\s*10px/);
});

test('shared collapsed-header typography is defined in transcript.css', async () => {
  const css = await readTranscriptCss();

  assert.match(css, /\.transcript-header-label\s*\{/);
  assert.match(css, /\.transcript-header-title-mono\s*\{/);
  assert.match(css, /\.transcript-header-summary-command\s*\{/);
  assert.match(css, /\.transcript-header-path-preview\s*\{/);
  assert.match(css, /\.transcript-header-command-details\s*\{/);
});

test('subagent headers keep primary metadata ahead of summary text without extra model or thinking chrome', async () => {
  const css = await readToolCallCss();
  const subagentSummaryRule = css.match(/\.subagent-header-summary\s*\{[\s\S]*?\n\}/);
  const primaryMetaRule = css.match(/\.subagent-primary-meta\s*\{[\s\S]*?\n\}/);

  assert.ok(subagentSummaryRule, 'expected subagent summary rule in tool-call.css');
  assert.match(subagentSummaryRule[0], /flex:\s*1 1 auto;/);

  assert.ok(primaryMetaRule, 'expected primary subagent metadata rule in tool-call.css');
  assert.match(primaryMetaRule[0], /display:\s*inline-flex;/);
  assert.match(primaryMetaRule[0], /align-items:\s*center;/);
  assert.match(primaryMetaRule[0], /flex:\s*0 0 auto;/);

  assert.ok(!css.includes('.subagent-secondary-meta'), 'subagent secondary-meta chrome should be removed');
  assert.ok(!css.includes('.subagent-model-tag'), 'subagent model badges should be removed');
  assert.ok(!css.includes('.subagent-thinking-tag'), 'subagent thinking badges should be removed');
});
