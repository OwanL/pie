import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { DEFAULT_CHAT_PREFS } from '../../../../lib/protocol/index.js';

async function readToolCallCss() {
  return readFile(new URL('../../../styles/tool-call.css', import.meta.url), 'utf8');
}

async function readTranscriptCss() {
  return readFile(new URL('../../../styles/transcript.css', import.meta.url), 'utf8');
}

test('ordinary inspectors tighten spacing without shrinking control hitboxes or code text', async () => {
  const css = await readToolCallCss();

  assert.match(css, /\.tool-call-card:not\(\.tool-call-subagent\) > \.tool-call-header\s*\{\s*gap:\s*4px/);
  assert.match(css, /\.tool-call-action\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;/);
  assert.match(css, /\.tool-call-toggle\s*\{[^}]*min-height:\s*26px;/);
  assert.match(css, /\.tool-call-input-fields\s*\{[^}]*margin:\s*4px 0;[^}]*gap:\s*3px;/);
  assert.match(css, /\.tool-call-section-label\s*\{[^}]*margin-block:\s*4px 3px;/);
  assert.match(css, /\.tool-call-section \+ \.tool-call-section\s*\{[^}]*margin-top:\s*4px;/);
  assert.match(css, /\.tool-call-input-field dd\s*\{[^}]*font-size:\s*12px;/);
});

test('file actions appear on hover or keyboard focus on fine pointers', async () => {
  const css = await readToolCallCss();
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\)\s*\{[^}]*\.tool-call-header \.tool-call-action\s*\{\s*opacity:\s*0;\s*pointer-events:\s*none;/);
  assert.match(css, /\.tool-call-header:hover \.tool-call-action,\s*\.tool-call-header:focus-within \.tool-call-action\s*\{\s*opacity:\s*1;\s*pointer-events:\s*auto;/);
  assert.match(css, /\.tool-call-heading-content \.transcript-header-path-target,\s*\.tool-call-heading-content \.transcript-header-summary-command\s*\{\s*font-weight:\s*400;/);
});

test('coarse-pointer tools gain touch hitboxes and font floors without wrapping exact output', async () => {
  const css = await readToolCallCss();
  const touch = css.slice(css.indexOf('@media (pointer: coarse)'), css.indexOf('/* Placeholder when'));
  assert.match(touch, /\.tool-call-card > \.tool-call-header \.tool-call-toggle\s*\{\s*min-width:\s*44px;\s*min-height:\s*44px;/);
  assert.match(touch, /\.tool-call-raw-action,[\s\S]*?\.tool-call-action\s*\{\s*min-width:\s*44px;\s*min-height:\s*44px;/);
  assert.match(touch, /max-width:\s*24px;\s*max-height:\s*24px;/);
  assert.match(touch, /font-size:\s*max\(13px, var\(--panel-font-size, 11px\)\)/);
  assert.match(touch, /font-size:\s*max\(12px, var\(--panel-font-size, 11px\)\)/);
  assert.match(touch, /height:\s*calc\(var\(--tool-preview-lines, 2\) \* var\(--tool-preview-line-height\)\);\s*line-height:\s*var\(--tool-preview-line-height\)/);
  assert.doesNotMatch(touch, /white-space:|overflow-wrap:|word-break:/);
  assert.match(css, /\.tool-call-pre\s*\{\s*white-space:\s*pre;/);
  assert.match(css, /\.tool-call-pre\.tool-call-pre-resizable\s*\{[^}]*overflow:\s*auto;/);
  assert.match(css, /\.resizable-scroll-hint\s*\{\s*display:\s*none;/);
  assert.match(touch, /\.tool-call-card \.resizable-scroll-hint\s*\{[^}]*display:\s*block;[^}]*user-select:\s*none;/);
});

test('ordinary headers remain arrow-free while preserving the native toggle', async () => {
  const { ToolCallHeader } = await import('../../../transcript/tool-call-card.tsx');
  const html = renderToString(h(ToolCallHeader, { open: true, name: 'read', status: 'completed', summary: 'a.ts', summaryPath: '/repo/a.ts', onToggle: () => {}, onOpenFile: () => {} }));
  assert.doesNotMatch(html, /tool-call-disclosure|collapsible-chevron/);
  assert.match(html, /<button type="button" class="tool-call-toggle" aria-expanded="true"/);
  assert.match(html, /Collapse details/);
  assert.match(html, /tool-call-kind-icon/);
});

test('subagent headers retain the collapsible chevron', async () => {
  const { ToolCallHeader } = await import('../../../transcript/tool-call-card.tsx');
  const html = renderToString(h(ToolCallHeader, { open: true, name: 'subagent', status: 'running', summary: 'task', onToggle: () => {}, onOpenFile: () => {} }));
  assert.match(html, /tool-call-disclosure/);
  assert.match(html, /collapsible-chevron/);
  assert.match(html, /<button type="button" class="tool-call-toggle" aria-expanded="true"/);
  const css = await readToolCallCss();
  assert.match(css, /\.tool-call-disclosure\s*\{\s*flex:\s*0 0 auto;\s*color:\s*var\(--panel-muted\);\s*\}/);
  assert.match(css, /\.tool-call-inspector-body\s*\{\s*padding-left:\s*10px;/);
  assert.match(css, /\.tool-call-collapse-rail\s*\{\s*left:\s*0;/);
});

test('raw inspection has one vertical owner and sticky controls with horizontal JSON panes', async () => {
  const css = await readToolCallCss();
  const root = css.match(/\.tool-call-raw-inspector\s*\{([^}]+)\}/)?.[1] ?? '';
  const pre = css.match(/\.tool-call-raw-inspector pre\s*\{([^}]+)\}/)?.[1] ?? '';
  const heading = css.match(/\.tool-call-raw-heading\s*\{([^}]+)\}/)?.[1] ?? '';
  assert.match(root, /max-height:/);
  assert.match(root, /overflow: auto/);
  assert.match(pre, /max-height: none/);
  assert.match(pre, /overflow-x: auto/);
  assert.match(pre, /overflow-y: hidden/);
  assert.match(heading, /position: sticky/);
  assert.match(heading, /top: 0/);
});

test('failed ordinary results take a quiet danger edge through existing data-status without new labels', async () => {
  const css = await readToolCallCss();
  assert.match(css, /\.tool-call-card:not\(\.tool-call-subagent\)\[data-status="failed"\]\s*\{\s*box-shadow:\s*inset 2px 0 0 color-mix\(in srgb, var\(--panel-danger\) 32%, var\(--panel-border\)\);/);
  assert.doesNotMatch(css, /\.tool-call-card\[data-status="failed"\][^}]*content:/);
});

test('desktop tool output panes scroll with an explicit thin always-visible scrollbar', async () => {
  const css = await readToolCallCss();
  const block = css.slice(css.indexOf('/* Desktop tool-output panes'));
  const desktop = block.slice(0, block.indexOf('@media (pointer: coarse)'));
  assert.match(desktop, /@media \(hover: hover\) and \(pointer: fine\)\s*\{\s*\.tool-call-pre\.tool-call-pre-resizable,\s*\.tool-call-terminal-pre\s*\{\s*scrollbar-width:\s*thin;\s*scrollbar-color:\s*var\(--vscode-scrollbarSlider-background\) transparent;/);
  assert.match(desktop, /::-webkit-scrollbar\s*\{\s*width:\s*6px;\s*height:\s*6px;/);
  assert.match(desktop, /::-webkit-scrollbar-thumb\s*\{\s*background:\s*var\(--vscode-scrollbarSlider-background\);\s*border-radius:\s*4px;/);
});

test('tool output panes fade a genuinely clipped horizontal edge, scoped to the panes', async () => {
  const css = await readToolCallCss();
  // The mask is scoped to the tool output panes (no global CSS) and follows
  // the session-tab strip's conditional edge-fade pattern; ResizablePre and
  // TerminalOutput toggle the direction classes from live scroll metrics
  // (behavior tests under test/components/resizable-overflow.test.ts and
  // test/transcript/tools/terminal-output-edge-fade.test.ts).
  assert.match(css, /\.tool-call-pre\.fade-left,\s*\.tool-call-terminal-pre\.fade-left\s*\{[\s\S]*?mask-image:\s*linear-gradient\(to right,\s*transparent 0, black 14px\)/);
  assert.match(css, /\.tool-call-pre\.fade-right,\s*\.tool-call-terminal-pre\.fade-right\s*\{[\s\S]*?mask-image:\s*linear-gradient\(to left,\s*transparent 0, black 14px\)/);
  assert.match(css, /\.tool-call-pre\.fade-left\.fade-right,\s*\.tool-call-terminal-pre\.fade-left\.fade-right\s*\{[\s\S]*?mask-image:\s*linear-gradient\(to right,\s*transparent 0, black 14px, black calc\(100% - 14px\), transparent 100%\)/);
  // Code never defaults to wrapping; the fade is the only affordance change.
  assert.match(css, /\.tool-call-pre\s*\{\s*white-space:\s*pre;\s*\}/);
});

test('tool-result images size to the bitmap aspect ratio without flex letterboxing', async () => {
  const css = await readToolCallCss();
  const rule = css.match(/\.tool-call-result-image\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(rule, /align-self:\s*flex-start;/, 'column-flex container stretches img boxes to full card width; pinning keeps the box on the bitmap ratio (no dark contain-fit bands)');
  assert.match(rule, /width:\s*auto;/);
  assert.match(rule, /height:\s*auto;/);
  assert.match(rule, /max-width:\s*100%;/);
  assert.match(rule, /max-height:\s*var\(--expanded-section-max-height\);/);
});

test('user image attachments size to the bitmap aspect ratio inside the bubble', async () => {
  const css = await readTranscriptCss();
  const rule = css.match(/\.message-user-image-element\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(rule, /align-self:\s*flex-start;/, 'the column-flex figure stretches an auto-width element back to full bubble width; pinning keeps the box on the bitmap ratio (no dark pillarbox bars on the light bubble)');
  assert.match(rule, /width:\s*auto;/);
  assert.match(rule, /max-width:\s*min\(320px, 100%\);/);
  assert.match(rule, /max-height:\s*240px;/);
});

test('diff lines soft-wrap inside .tool-call-diff only, preserving the +/- marker column', async () => {
  const css = await readToolCallCss();
  assert.match(css, /\.tool-call-diff \.tool-call-diff-added,\s*\.tool-call-diff \.tool-call-diff-removed,\s*\.tool-call-diff \.tool-call-diff-context\s*\{\s*display:\s*block;\s*min-width:\s*0;\s*white-space:\s*pre-wrap;/);
  // The generic tool-call-pre stays nowrap; no unscoped line-span wrap rule.
  assert.match(css, /\.tool-call-pre\s*\{\s*white-space:\s*pre;/);
  // The old unscoped nowrap block rule (min-width: max-content) is gone.
  assert.doesNotMatch(css, /min-width:\s*max-content/);
});

test('collapsed tool-call headers use the shared path hierarchy', async () => {
  const { ToolCallHeader } = await import('../../../transcript/tool-call-card.tsx');
  const html = renderToString(h(ToolCallHeader, {
    open: false,
    name: 'read',
    nameTitle: 'Read file',
    status: 'completed',
    summary: 'src/example.ts',
    summaryPath: '/repo/src/example.ts',
    prefs: { ...DEFAULT_CHAT_PREFS, uiPathParentDepth: 1 },
    sizeHint: '+3 lines',
    onToggle: () => {},
    onOpenFile: () => {},
  }));

  assert.match(html, /tool-call-toggle/);
  assert.match(html, /tool-call-kind-icon/);
  assert.match(html, /aria-label="read tool call, Completed\. \/repo\/src\/example\.ts\. Expand details"/);
  assert.doesNotMatch(html, /transcript-header-title-mono/);
  assert.match(html, /aria-label="Open file \/repo\/src\/example.ts"/);
  assert.doesNotMatch(html, /transcript-header-path-prefix/);
  assert.match(html, /transcript-header-path-target/);
  assert.match(html, /data-pie-file-path="\/repo\/src\/example\.ts"/);
  assert.match(html, /tool-call-size/);
  assert.match(html, /tool-call-actions/);
});

test('tool-call path labels show filenames regardless of depth while retaining the full path', async () => {
  const { ToolCallHeader } = await import('../../../transcript/tool-call-card.tsx');
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

  assert.match(html, />example\.ts</);
  assert.doesNotMatch(html, /transcript-header-path-prefix/);
  assert.match(html, /title="\/repo\/dira\/dirb\/dirc\/example\.ts"/);
  assert.match(html, /data-pie-file-path="\/repo\/dira\/dirb\/dirc\/example\.ts"/);
});

test('collapsed bash headers emphasize the shell verb over the path context', async () => {
  const { ToolCallHeader } = await import('../../../transcript/tool-call-card.tsx');
  const html = renderToString(h(ToolCallHeader, {
    open: false,
    name: 'bash',
    status: 'completed',
    summary: 'rm somepath/somefile.txt',
    prefs: { ...DEFAULT_CHAT_PREFS, uiPathParentDepth: 1 },
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
  const { ToolCallHeader } = await import('../../../transcript/tool-call-card.tsx');
  const html = renderToString(h(ToolCallHeader, {
    open: false,
    name: 'bash',
    status: 'completed',
    summary: 'rm "some dir/file name.txt"',
    prefs: { ...DEFAULT_CHAT_PREFS, uiPathParentDepth: 1 },
    onToggle: () => {},
    onOpenFile: () => {},
  }));

  assert.doesNotMatch(html, /transcript-header-path-prefix[^>]*>&quot;some dir\//);
  assert.doesNotMatch(html, /transcript-header-path-target[^>]*>file name\.txt&quot;</);
  assert.match(html, /transcript-header-path-prefix/);
  assert.match(html, /some dir\//);
  assert.match(html, /transcript-header-path-target[^>]*>file name\.txt</);
});

test('expanded bash headers keep the command target visible for orientation', async () => {
  const { ToolCallHeader } = await import('../../../transcript/tool-call-card.tsx');
  const html = renderToString(h(ToolCallHeader, {
    open: false,
    bodyVisible: true,
    name: 'bash',
    status: 'running',
    summary: 'rm somepath/somefile.txt',
    onToggle: () => {},
    onOpenFile: () => {},
  }));

  assert.match(html, /aria-label="bash tool call, Running/);
  assert.match(html, /transcript-header-summary-command/);
  assert.match(html, />rm</);
});

test('transcript scrollbar freezes a broad custom hit area with a quiet visible thumb', async () => {
  const css = await readTranscriptCss();

  assert.match(css, /\.transcript::-webkit-scrollbar\s*\{[^}]*width:\s*0/);
  assert.match(css, /\.transcript-scrollbar\s*\{[^}]*width:\s*10px[^}]*touch-action:\s*none/);
  assert.match(css, /\.transcript-scrollbar-thumb::before\s*\{[^}]*inset:\s*0 3px/);
  assert.match(css, /\.transcript-scrollbar-thumb\s*\{[^}]*min-height:\s*24px/);
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

test('working and finished subagents share header geometry without uppercase terminal badges', async () => {
  const css = await readToolCallCss();
  const terminal = css.match(/\.subagent-header > \.status-chip\s*\{([^}]+)\}/)?.[1] ?? '';
  assert.match(terminal, /text-transform:\s*none;/);
  assert.match(terminal, /letter-spacing:\s*normal;/);
  assert.match(terminal, /font:\s*400 11px\/18px/);
  assert.match(terminal, /gap:\s*5px;/);
  assert.match(css, /\.subagent-header \.subagent-activity\s*\{[^}]*font:\s*400 11px\/18px/);
  assert.match(css, /\.tool-call\.tool-call-subagent\.running > \.subagent-header,\s*\.tool-call\.tool-call-subagent\.completed > \.subagent-header\s*\{/);
  assert.match(css, /\.tool-call\.tool-call-subagent\.running:hover > \.subagent-header,\s*\.tool-call\.tool-call-subagent\.completed:hover > \.subagent-header\s*\{/);
});

test('subagent header keeps metadata in one row without hiding reasoning or cost', async () => {
  const css = await readToolCallCss();
  const subagentSummaryRule = css.match(/\.subagent-header-summary\s*\{[\s\S]*?\n\}/);
  const primaryMetaRule = css.match(/\.subagent-primary-meta\s*\{[\s\S]*?\n\}/);

  assert.ok(subagentSummaryRule, 'expected subagent summary rule in tool-call.css');
  assert.match(subagentSummaryRule[0], /flex:\s*1 1 auto;/);

  assert.ok(primaryMetaRule, 'expected primary subagent metadata rule in tool-call.css');
  assert.match(primaryMetaRule[0], /display:\s*inline-flex;/);
  assert.match(primaryMetaRule[0], /align-items:\s*center;/);
  assert.match(primaryMetaRule[0], /flex:\s*0 0 auto;/);

  assert.doesNotMatch(css, /\.subagent-footer\b/);
  assert.match(css, /\.subagent-header\s*\{[^}]*flex-wrap:\s*nowrap/);
  assert.match(css, /\.subagent-reasoning-label\s*\{[^}]*flex:\s*0 0 auto/);
  assert.match(css, /\.subagent-header \.subagent-runtime-telemetry\s*\{[^}]*flex:\s*0 0 auto/);
  assert.match(css, /\.subagent-task-trigger\s*\{[^}]*display:\s*block;[^}]*min-width:\s*0/);
  assert.ok(!css.includes('.subagent-secondary-meta'), 'subagent secondary-meta chrome should be removed');
  assert.ok(!css.includes('.subagent-model-tag'), 'subagent model badges should be removed');
  assert.ok(!css.includes('.subagent-thinking-tag'), 'subagent thinking badges should be removed');
});
