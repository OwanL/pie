import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readStyleSource(fileName: string): Promise<string> {
  return readFile(new URL(`../../styles/${fileName}`, import.meta.url), 'utf8');
}

async function readWebviewSource(relativePath: string): Promise<string> {
  const sourcePath = {
    'composer/toolbar.tsx': '../../composer/toolbar.tsx',
    'transcript/pruning-header.tsx': '../../transcript/pruning-header.tsx',
    'components/panel-chip.tsx': '../../lib/components/panel-chip.tsx',
    'use-chat-prefs-css.ts': '../../settings/use-chat-prefs-css.ts',
    'app-body.tsx': '../../shell/app-body.tsx',
    'panel.tsx': '../../shell/panel.tsx',
    'transcript/message-item/inner.tsx': '../../transcript/message-item/inner.tsx',
    'transcript/message-item/header.tsx': '../../transcript/message-item/header.tsx',
    'transcript/message-item/reasoning-block.tsx': '../../transcript/message-item/reasoning-block.tsx',
  }[relativePath];
  assert.ok(sourcePath, `unmapped frontend source: ${relativePath}`);
  return readFile(new URL(sourcePath, import.meta.url), 'utf8');
}

test('user-input status segment stays muted like open-session counts', async () => {
  const css = await readStyleSource('aggregate-stats-strip.css');
  const userInputRule = css.match(/\.aggregate-strip-user-input\s*\{([^}]*)\}/)?.[1] ?? '';
  const totalRule = css.match(/\.aggregate-strip-user-input-total\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(userInputRule, /color:\s*var\(--panel-muted\)/);
  assert.match(userInputRule, /font-weight:\s*normal/);
  assert.doesNotMatch(userInputRule + totalRule, /panel-accent/);
  assert.match(totalRule, /color:\s*inherit/);
});

test('global focus fallback lives in Tailwind base so component outline utilities can override it', async () => {
  const indexCss = await readStyleSource('index.css');
  const baseLayerStart = indexCss.indexOf('@layer base');
  const baseLayerEnd = indexCss.indexOf('@utility message-prose');
  const focusFallbackStart = indexCss.indexOf(':focus-visible');

  assert.ok(baseLayerStart >= 0, 'expected index.css to define Tailwind base overrides');
  assert.ok(baseLayerEnd >= 0, 'expected @utility after @layer base');
  assert.ok(focusFallbackStart > baseLayerStart, 'expected global focus fallback inside base setup');
  assert.ok(focusFallbackStart < baseLayerEnd, 'expected global focus fallback inside @layer base block');
  // tokens.css merged into index.css — focus-visible belongs to @layer base only
});

test('reduced motion preserves essential progress-wheel animation', async () => {
  const indexCss = await readStyleSource('index.css');
  const reducedMotion = indexCss.slice(indexCss.indexOf('@media (prefers-reduced-motion: reduce)'));

  for (const spinner of ['loading-wheel', 'tool-call-status-spinner', 'composer-retry-spinner']) {
    assert.match(reducedMotion, new RegExp(`\\.${spinner}[\\s\\S]*animation-iteration-count:\\s*infinite\\s*!important`));
  }
});

test('virtual transcript spacer reserves the full estimated height inside the flex scroller', async () => {
  const transcriptCss = await readStyleSource('transcript.css');
  const spacerRule = transcriptCss.match(/\.transcript-virtual-inner\s*\{([^}]*)\}/)?.[1] ?? '';

  assert.match(spacerRule, /flex:\s*0 0 auto|flex-shrink:\s*0/);
});

test('panel chip styling is centralized instead of embedded in feature components', async () => {
  const indexCss = await readStyleSource('index.css');
  const panelChipCss = await readStyleSource('panel-chip.css');
  const toolbar = await readWebviewSource('composer/toolbar.tsx');
  const pruningHeader = await readWebviewSource('transcript/pruning-header.tsx');
  const panelChipComponent = await readWebviewSource('components/panel-chip.tsx');

  assert.match(indexCss, /@import '\.\/panel-chip\.css';/);
  assert.match(panelChipCss, /\.panel-chip-toolbar/);
  assert.match(panelChipCss, /\.panel-chip-pruning/);
  assert.match(panelChipCss, /\.pruning-meta-line/);
  assert.doesNotMatch(panelChipCss, /\.pruning-stat-tile/);
  assert.match(panelChipComponent, /function PanelChip/);
  assert.match(panelChipComponent, /export function ToolbarIndicatorChip/);
  assert.match(panelChipComponent, /export function PruningHeaderChipControl/);

  assert.match(toolbar, /ModelPicker/);
  assert.match(toolbar, /ToolbarIndicatorChip/);
  assert.doesNotMatch(toolbar, /PanelChip/);
  assert.doesNotMatch(toolbar, /variant=/);
  assert.doesNotMatch(toolbar, /className="panel-chip/);

  assert.match(pruningHeader, /PruningHeaderChipControl/);
  assert.match(pruningHeader, /PruningDiagnostics/);
  assert.doesNotMatch(pruningHeader, /PanelChip/);
  assert.doesNotMatch(pruningHeader, /variant=/);

  for (const [name, source] of [
    ['toolbar', toolbar],
    ['pruning header', pruningHeader],
  ] as const) {
    assert.doesNotMatch(source, /inline-flex h-\[(18|22)px\]/, `${name} should not own chip height/layout utilities`);
    assert.doesNotMatch(source, /rounded-full border border-transparent bg-control/, `${name} should not own chip shell utilities`);
    assert.doesNotMatch(source, /max-w-\[30ch\]/, `${name} should not hard-code pruning chip truncation width`);
    assert.doesNotMatch(source, /text-\[10px\] font-(bold|semibold) uppercase tracking-wider text-muted/, `${name} should not duplicate chip typography utilities`);
  }
});

test('expanded-section max-height pref is wired to a CSS var with a :root default', async () => {
  const highlightCss = await readStyleSource('highlight.css');
  const prefsCss = await readWebviewSource('use-chat-prefs-css.ts');
  const appBody = await readWebviewSource('app-body.tsx');

  // app-body must call the hook so the CSS vars actually get applied.
  assert.match(appBody, /useChatPrefsCss/);

  // The :root default mirrors --expanded-font-size (both expanded-section
  // theme tokens live together in highlight.css).
  assert.match(highlightCss, /--expanded-section-max-height:\s*240px/);
  assert.match(
    highlightCss,
    /\.reasoning-scroll\s*\{[^}]*max-height:\s*var\(--expanded-section-max-height\)/,
  );

  // The host emits the var from the pref (alongside --expanded-font-size),
  // and the pref is an effect dependency so updates propagate.
  assert.match(
    prefsCss,
    /setProperty\(['"]--expanded-section-max-height['"],\s*`\$\{expandedSectionMaxHeight\}px`\)/,
  );
  assert.match(prefsCss, /expandedSectionMaxHeight,/);
});

test('activity-tail preview-rows pref is wired to a CSS var with a :root default', async () => {
  const transcriptCss = await readStyleSource('transcript.css');
  const prefsCss = await readWebviewSource('use-chat-prefs-css.ts');

  // The :root default (5 content rows × 18px row height) lands the preview at
  // its bundled height before the host effect runs.
  assert.match(transcriptCss, /--activity-tail-content-min-height:\s*90px/);
  assert.match(
    transcriptCss,
    /\.turn-activity-tail-content\s*\{[^}]*(?<!min-)height:\s*var\(--activity-tail-content-min-height\)/,
  );
  assert.match(
    transcriptCss,
    /\.turn-activity-tail-content-single-row\s*\{[^}]*height:\s*var\(--activity-tail-row-height\)/,
  );

  // The host emits the var from the pref (content rows × row-height constant),
  // and the pref is an effect dependency so updates propagate live.
  assert.match(
    prefsCss,
    /setProperty\(['"]--activity-tail-content-min-height['"],\s*`\$\{activityTailLines\s*\*\s*ACTIVITY_TAIL_ROW_HEIGHT_PX\}px`\)/,
  );
  assert.match(prefsCss, /activityTailLines,/);
});

test('per-place font sizes and link/muted color prefs are wired to CSS vars', async () => {
  const indexCss = await readStyleSource('index.css');
  const transcriptCss = await readStyleSource('transcript.css');
  const promptCss = await readStyleSource('extension-ui-prompt.css');
  const prefsCss = await readWebviewSource('use-chat-prefs-css.ts');
  const appBody = await readWebviewSource('app-body.tsx');

  // app-body must call the hook so the CSS vars actually get applied.
  assert.match(appBody, /useChatPrefsCss/);

  // :root defaults reproduce the bundled sizes so an uncustomized panel is unchanged.
  assert.match(indexCss, /--panel-font-size:\s*11px/);
  assert.match(indexCss, /--panel-composer-font-size:\s*11px/);
  // Link color defaults to the accent so links match the bundled appearance.
  assert.match(indexCss, /--panel-link:\s*var\(--panel-accent\)/);

  // Base body text and message prose consume the base-size var.
  assert.match(indexCss, /body\s*\{[^}]*font-size:\s*var\(--panel-font-size/);
  assert.match(indexCss, /@utility message-prose\s*\{[\s\S]*?font-size:\s*var\(--panel-font-size/);

  // Hyperlinks route through --panel-link (not --panel-accent directly).
  assert.match(transcriptCss, /\.message-body a\s*\{[^}]*color:\s*var\(--panel-link\)/);
  assert.match(promptCss, /\.ask-prose a\s*\{[^}]*color:\s*var\(--panel-link\)/);

  // The host emits the per-place font sizes from prefs…
  assert.match(prefsCss, /setProperty\(['"]--panel-font-size['"],\s*`\$\{uiBaseFontSize\}px`\)/);
  assert.match(prefsCss, /setProperty\(['"]--panel-composer-font-size['"],\s*`\$\{uiComposerFontSize\}px`\)/);
  // …applies the muted override on top of the foreground-derived shade…
  assert.match(prefsCss, /uiMutedColor/);
  // …and sets/removes the link override.
  assert.match(prefsCss, /uiLinkColor/);

  // All four new prefs are effect dependencies so updates propagate live.
  assert.match(prefsCss, /uiBaseFontSize,/);
  assert.match(prefsCss, /uiComposerFontSize,/);
  assert.match(prefsCss, /uiMutedColor,/);
  assert.match(prefsCss, /uiLinkColor,/);
});

test('font preferences reach normal prose and monospace UI surfaces', async () => {
  const transcriptCss = await readStyleSource('transcript.css');
  const highlightCss = await readStyleSource('highlight.css');
  const prefsCss = await readWebviewSource('use-chat-prefs-css.ts');
  const panelSource = await readWebviewSource('panel.tsx');
  const monoSources = await Promise.all([
    readStyleSource('extension-ui-prompt.css'),
    readStyleSource('status-chip.css'),
    readStyleSource('tabs.css'),
    readStyleSource('tool-call.css'),
    readStyleSource('transcript.css'),
  ]);

  const messageBodyRule = transcriptCss.match(/\.message-body\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(messageBodyRule, /font-size:\s*var\(--panel-font-size,\s*11px\)/);
  assert.doesNotMatch(messageBodyRule, /font-size:\s*13px/);

  // Code remains an intentionally distinct, explicit size while inheriting the
  // user-selected monospace family rather than the VS Code editor setting.
  const messagePreRule = transcriptCss.match(/\.message-body pre,\s*\n?\.tool-call-pre\s*\{([^}]*)\}/)?.[1] ?? '';
  const messageCodeRule = transcriptCss.match(/\.message-body code\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(messagePreRule, /font-family:\s*var\(--panel-font-mono\)/);
  assert.match(messagePreRule, /font-size:\s*12px/);
  assert.match(messageCodeRule, /font-family:\s*var\(--panel-font-mono\)/);
  assert.match(messageCodeRule, /font-size:\s*12px/);
  assert.match(highlightCss, /\.collapsible-body\s*\{[^}]*font-size:\s*var\(--expanded-font-size\)/);

  for (const source of monoSources) {
    assert.doesNotMatch(source, /--vscode-editor-font-family/);
  }
  assert.doesNotMatch(panelSource, /--vscode-editor-font-family/);
  assert.match(prefsCss, /setProperty\(['"]--panel-font-mono['"],\s*uiFontMono\)/);
  assert.match(prefsCss, /uiFontMono,/);
});

test('markdown prose restores markers, hierarchy, rich blocks, and separators in both scopes', async () => {
  const transcriptCss = await readStyleSource('transcript.css');
  const promptCss = await readStyleSource('extension-ui-prompt.css');

  for (const [scope, css] of [['message-body', transcriptCss], ['ask-prose', promptCss]] as const) {
    assert.match(css, new RegExp(`\\.${scope} ul,\\s*\\.${scope} ol\\s*\\{[^}]*list-style-position:\\s*outside;`));
    assert.match(css, new RegExp(`\\.${scope} ul\\s*\\{[^}]*list-style-type:\\s*disc;`));
    assert.match(css, new RegExp(`\\.${scope} ol\\s*\\{[^}]*list-style-type:\\s*decimal;`));
    assert.match(css, new RegExp(`\\.${scope} ul ul\\s*\\{[^}]*list-style-type:\\s*circle;`));
    assert.match(css, new RegExp(`\\.${scope} ul ul ul\\s*\\{[^}]*list-style-type:\\s*square;`));
    assert.match(css, new RegExp(`\\.${scope} ol ol\\s*\\{[^}]*list-style-type:\\s*lower-alpha;`));
    assert.match(css, new RegExp(`\\.${scope} ol ol ol\\s*\\{[^}]*list-style-type:\\s*lower-roman;`));
    assert.match(css, new RegExp(`\\.${scope} li:has\\(> input\\[type="checkbox"\\]\\),\\s*\\.${scope} li:has\\(> p > input\\[type="checkbox"\\]\\)\\s*\\{[^}]*list-style-type:\\s*none;`));
  }

  const transcriptHeadingSizes = [
    ['h1', '1.6em'], ['h2', '1.35em'], ['h3', '1.2em'],
    ['h4', '1.1em'], ['h5', '1em'], ['h6', '0.95em'],
  ] as const;
  for (const [heading, size] of transcriptHeadingSizes) {
    assert.match(transcriptCss, new RegExp(`\\.message-body ${heading}\\s*\\{[^}]*margin:\\s*[^;]+;[^}]*font-size:\\s*${size.replace('.', '[.]')};`));
  }

  const promptHeadingSizes = [
    ['h1', '1.35em'], ['h2', '1.2em'], ['h3', '1.1em'],
    ['h4', '1em'], ['h5', '0.95em'], ['h6', '0.9em'],
  ] as const;
  for (const [heading, size] of promptHeadingSizes) {
    assert.match(promptCss, new RegExp(`\\.ask-prose ${heading}\\s*\\{[^}]*margin:\\s*[^;]+;[^}]*font-size:\\s*${size.replace('.', '[.]')};`));
  }

  assert.match(transcriptCss, /\.message-body hr\s*\{[^}]*margin:\s*12px 0;[^}]*border:\s*0;[^}]*border-top:\s*1px solid var\(--panel-border\);/);
  assert.match(transcriptCss, /\.message-item-shell\[data-role="user"\]:not\(\[data-synthetic="true"\]\) \.message-body hr\s*\{[^}]*border-top-color:\s*var\(--panel-user-border\);/);
  assert.match(promptCss, /\.ask-prose blockquote\s*\{[^}]*margin:\s*4px 0;[^}]*padding:\s*2px 0 2px 8px;[^}]*border-left:\s*2px solid var\(--panel-border\);/);
  assert.match(promptCss, /\.ask-prose hr\s*\{[^}]*margin:\s*6px 0;[^}]*border:\s*0;[^}]*border-top:\s*1px solid var\(--panel-border\);/);
  assert.match(promptCss, /\.ask-prose \.md-table-wrap\s*\{[^}]*overflow-x:\s*auto;[^}]*margin:\s*4px 0;/);
  assert.match(promptCss, /\.ask-prose \.md-table-wrap th,[\s\S]*?\.ask-prose \.md-table-wrap td\s*\{[^}]*padding:\s*3px 6px;/);

});

test('unified transcript refinement keeps operational rows quiet and user prompts distinct', async () => {
  const indexCss = await readStyleSource('index.css');
  const transcriptCss = await readStyleSource('transcript.css');
  const inlineEditorCss = await readStyleSource('inline-editor.css');
  const composerCss = await readStyleSource('composer.css');
  const fileChangesCss = await readStyleSource('file-changes.css');
  const toolCallCss = await readStyleSource('tool-call.css');
  const aggregateCss = await readStyleSource('aggregate-stats-strip.css');
  const tabsCss = await readStyleSource('tabs.css');
  const messageShell = await readWebviewSource('transcript/message-item/inner.tsx');
  const messageHeader = await readWebviewSource('transcript/message-item/header.tsx');
  const reasoningBlock = await readWebviewSource('transcript/message-item/reasoning-block.tsx');

  const assistantRule = transcriptCss.match(
    /\.message-item-shell\[data-role="assistant"\],[\s\S]*?\.message-item-shell\[data-role="assistant"\]\[data-streaming="true"\]\s*\{([^}]*)\}/,
  )?.[1] ?? '';
  assert.match(assistantRule, /background:\s*var\(--panel-black\)/);
  assert.match(assistantRule, /border-color:\s*transparent/);
  assert.match(assistantRule, /box-shadow:\s*none/);
  assert.match(messageHeader, /role === 'assistant' \? 'message-assistant-header' : undefined/);
  assert.match(
    transcriptCss,
    /\.message-assistant-header\s*\{[^}]*padding-bottom:\s*5px;[^}]*border-bottom:\s*1px solid color-mix\(in srgb, var\(--panel-accent\) 24%, var\(--panel-border-subtle\)\)/,
  );

  const userRule = transcriptCss.match(/\.message-item-shell\[data-role="user"\]\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(indexCss, /--panel-user-surface:\s*color-mix\(in srgb, var\(--panel-foreground\) 72%, var\(--panel-black\)\)/);
  assert.match(indexCss, /--panel-user-foreground:\s*color-mix\(in srgb, var\(--panel-black\) 88%, var\(--panel-foreground\)\)/);
  assert.match(indexCss, /--panel-user-link:\s*color-mix\(in srgb, var\(--panel-accent\) 20%, var\(--panel-user-foreground\)\)/);
  assert.match(userRule, /background:\s*var\(--panel-user-surface\)/);
  assert.match(userRule, /border-color:\s*var\(--panel-user-border\)/);
  assert.match(userRule, /color:\s*var\(--panel-user-foreground\)/);
  assert.match(userRule, /box-shadow:\s*inset 0 1px 0 var\(--panel-user-highlight\)/);
  assert.match(transcriptCss, /\[data-role="user"\]:not\(\[data-synthetic="true"\]\) \.message-body code\s*\{[^}]*color:\s*var\(--panel-user-foreground\)/);
  assert.match(transcriptCss, /\.message-user-image-caption\s*\{\s*color:\s*color-mix\(in srgb, var\(--panel-user-foreground\) 78%, var\(--panel-user-surface\)\)/);
  assert.match(inlineEditorCss, /\[data-role="user"\]\[data-editing="true"\] \.inline-editor\s*\{[^}]*color:\s*var\(--panel-user-foreground\)/);
  assert.match(messageShell, /role === 'assistant' && 'self-start w-full max-w-full px-1 py-2'/);
  assert.match(messageShell, /role === 'user' && 'w-fit max-w-\[88%\] self-end rounded-lg px-2 py-1\.5/);
  assert.doesNotMatch(messageShell, /message-assistant-width|uiMessageWidth/);
  assert.doesNotMatch(transcriptCss, /message-assistant-width/);
  assert.doesNotMatch(composerCss, /\.pref-toggle(?:-icon|-check)?\b/);
  assert.doesNotMatch(reasoningBlock, /bg-control|rounded-md/);
  assert.match(
    transcriptCss,
    /\.reasoning-block \.message-body,\s*\.reasoning-block \.reasoning-preview\s*\{\s*color:\s*var\(--panel-muted\);\s*\}/,
  );

  const toolTitleRule = transcriptCss.match(/\.transcript-header-title-mono\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.doesNotMatch(toolTitleRule, /\b(?:background|border|padding)\s*:/);

  assert.match(
    composerCss,
    /\.composer-shell:hover,\s*\.composer-shell:focus-within\s*\{[^}]*border-color:\s*transparent;[^}]*box-shadow:\s*none;/,
  );
  const sliverRule = fileChangesCss.match(/\.file-changes-sliver\s*\{([^}]*)\}/)?.[1] ?? '';
  const drawerRule = fileChangesCss.match(/\.file-changes-drawer\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(sliverRule, /background:\s*transparent/);
  assert.match(sliverRule, /border-right:\s*1px solid var\(--panel-optical-edge\)/);
  assert.doesNotMatch(fileChangesCss, /\.file-changes-sliver::after|mask-image/);
  assert.match(fileChangesCss, /\.file-changes-sliver:hover,[\s\S]*?border-right-color:\s*var\(--panel-optical-edge-strong\)/);
  assert.match(fileChangesCss, /\.panel-main:has\(> \.file-changes-rail:not\(\.is-pinned\)\)[^{]*\{[^}]*padding-inline-start:\s*var\(--panel-gap-sm\)/);
  assert.match(drawerRule, /background:\s*var\(--panel-black\)/);
  assert.doesNotMatch(sliverRule, /(?:linear|radial)-gradient|backdrop-filter/);
  assert.doesNotMatch(drawerRule, /(?:linear|radial)-gradient|backdrop-filter/);
  assert.doesNotMatch(fileChangesCss, /backdrop-filter/);

  assert.match(toolCallCss, /\.tool-call-header\s*\{[^}]*background:\s*transparent/);
  assert.match(toolCallCss, /\.tool-call-header \.status-chip\s*\{[^}]*background:\s*transparent/);
  assert.match(toolCallCss, /\.tool-call\.tool-call-subagent,[\s\S]*?\.tool-call-card\.tool-call-subagent\s*\{[^}]*border:\s*1px solid var\(--panel-border-subtle\);[^}]*background:\s*var\(--panel-card-surface\)/);
  // Disclosure does not change the quiet header surface; active work has its
  // own state treatment rather than a collapsed-only panel.
  assert.match(toolCallCss, /\.subagent-header\s*\{[^}]*background:\s*var\(--panel-subtle-surface\)/);
  assert.match(toolCallCss, /\.subagent-header:hover\s*\{[^}]*background:\s*var\(--panel-card-surface\)/);
  assert.match(toolCallCss, /\.subagent-pending-prompt\s*\{[^}]*background:\s*var\(--panel-control-surface\)/);
  assert.match(toolCallCss, /\.subagent-messages\s*\{[^}]*background:\s*var\(--panel-code-surface\)/);
  assert.match(toolCallCss, /\.tool-call-status-draft\s*\{[^}]*border:\s*1px dashed var\(--panel-muted\)/);
  assert.doesNotMatch(toolCallCss, /\.tool-call-card\[data-provisional="true"\]\s*\{[^}]*(?:background|border-inline-start)/);
  assert.match(toolCallCss, /\.tool-call-live-preview pre\s*\{[^}]*height:\s*calc\(var\(--tool-preview-lines/);
  assert.doesNotMatch(toolCallCss, /tool-call-provisional-status|tool-call-draft-cursor/);
  assert.match(toolCallCss, /\.tool-call-live-preview\s*\{[^}]*background:\s*var\(--panel-code-surface\)/);
  assert.match(toolCallCss, /\.tool-call-toggle:focus-visible/);
  assert.match(toolCallCss, /\.tool-call-action:focus-visible/);
  assert.match(toolCallCss, /@media \(forced-colors: active\)[\s\S]*?\.tool-call-card\[data-provisional="true"\]/);
  assert.match(transcriptCss, /\.reasoning-block\[data-streaming="true"\]\[data-provisional="true"\]\s*\{[^}]*border-inline-start:\s*2px/);
  assert.match(transcriptCss, /\.message-item-shell\[data-role="user"\]\[data-queued="true"\] \.status-chip-neutral\s*\{[^}]*color:\s*var\(--panel-user-foreground\);[^}]*opacity:\s*1/);
  // Gradient *paint* and blur decorations are banned on tool cards; the one
  // allowed gradient is the functional mask-image overflow cue (Tabs-4 edge
  // fade on clipped tool-output panes), not a painted surface.
  assert.doesNotMatch(toolCallCss, /(?:background|filter|backdrop-filter)\s*:[^;{}]*?(?:linear|radial)-gradient/);
  // Explicitly disabling inherited popup blur is allowed; adding blur is not.
  for (const [, value] of toolCallCss.matchAll(/(?:-webkit-)?backdrop-filter\s*:\s*([^;{}]+)/g)) {
    assert.equal(value.trim(), 'none');
  }
  assert.doesNotMatch(toolCallCss, /filter:\s*blur/);

  // Global costs are an intrinsic, muted inline pair, not a fixed footer.
  assert.match(aggregateCss, /\.aggregate-strip\s*\{[^}]*display:\s*inline-flex/);
  assert.match(aggregateCss, /\.aggregate-strip\s*\{[^}]*color:\s*var\(--panel-muted\)/);
  assert.doesNotMatch(aggregateCss, /overflow-x:\s*auto|scrollbar-width/);
  assert.match(aggregateCss, /\.aggregate-strip-metrics\s*\{[^}]*display:\s*flex/);
  assert.match(aggregateCss, /\.aggregate-strip-measurements\s*\{[^}]*visibility:\s*hidden/);
  assert.doesNotMatch(aggregateCss, /aggregate-strip-status-cluster/);
  assert.match(tabsCss, /@media \(max-width: 520px\)[\s\S]*?--session-tabs-scrollbar-height:\s*5px/);
  assert.doesNotMatch(tabsCss, /\.session-tab-shell::before/);
});

test('sticky prompt is quiet right-aligned text with stable row-hover navigation and a conditional fade', async () => {
  const css = await readStyleSource('transcript.css');
  const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`)).match(/\{([^}]*)\}/)?.[1] ?? '';
  const shell = rule('.transcript-prompt-context');
  assert.match(shell, /position:\s*relative/);
  assert.match(shell, /height:\s*28px/);
  assert.doesNotMatch(css, /transcript-prompt-context\.is-compact|transcript-prompt-context-meta|transcript-prompt-navigation-position|\.transcript-prompt-navigation\s*\{/);
  const row = rule('.transcript-prompt-context-row');
  assert.match(row, /width:\s*fit-content/);
  assert.match(row, /max-width:\s*100%/);
  assert.match(row, /margin-left:\s*auto/);
  assert.match(row, /gap:\s*2px/);
  const preview = rule('.transcript-prompt-context-preview');
  for (const pattern of [/background:\s*transparent/, /border:\s*0/, /box-shadow:\s*none/, /padding:\s*0/, /text-align:\s*right/, /text-overflow:\s*ellipsis/, /white-space:\s*nowrap/, /cursor:\s*pointer/]) {
    assert.match(preview, pattern);
  }
  assert.match(rule('.transcript-prompt-context-preview:hover'), /text-decoration:\s*underline/);
  const navigation = rule('.transcript-prompt-navigation-button');
  assert.match(navigation, /opacity:\s*0/);
  assert.match(navigation, /flex:\s*0 0 24px/);
  assert.doesNotMatch(navigation, /visibility:|display:\s*none|pointer-events:\s*none/);
  assert.match(css, /\.transcript-prompt-context-row:hover \.transcript-prompt-navigation-button,\s*\.transcript-prompt-context-row:focus-within \.transcript-prompt-navigation-button\s*\{\s*opacity:\s*1/);
  assert.match(css, /@media \(hover: none\), \(pointer: coarse\)\s*\{\s*\.transcript-prompt-navigation-button\s*\{[^}]*width:\s*32px;[^}]*height:\s*28px;[^}]*opacity:\s*1/);
  for (const selector of ['.transcript-prompt-navigation-button:focus-visible', '.transcript-prompt-context-preview:focus-visible']) {
    assert.match(rule(selector), /outline:\s*1px solid var\(--panel-accent\)/);
  }
  const fade = rule('.transcript-prompt-context::after');
  assert.match(fade, /top:\s*100%/);
  assert.match(fade, /height:\s*8px/);
  assert.match(fade, /linear-gradient\(to bottom, var\(--panel-surface\), transparent\)/);
  assert.match(fade, /pointer-events:\s*none/);
  assert.match(rule('.transcript-viewport::after'), /linear-gradient\(to bottom, transparent, var\(--panel-surface\)\)/);
  assert.doesNotMatch(css, /\.transcript-viewport::before/);
  assert.match(rule('.transcript-prompt-context.is-hidden'), /visibility:\s*hidden/);
  assert.doesNotMatch(fade, /visibility:\s*visible/);
  assert.match(css, /@media \(forced-colors: active\)\s*\{\s*\.transcript-prompt-context::after\s*\{\s*display:\s*none/);
});

test('global cost pair stays intrinsic and unwrapped while standalone measurements stay inert', async () => {
  const css = await readStyleSource('aggregate-stats-strip.css');
  const strip = css.match(/\.aggregate-strip\s*\{([^}]*)\}/)?.[1] ?? '';
  const measurements = css.match(/\.aggregate-strip-measurements\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(strip, /display:\s*inline-flex/);
  assert.match(strip, /flex-shrink:\s*0/);
  assert.match(strip, /font-family:\s*var\(--panel-font-mono\)/);
  assert.match(strip, /white-space:\s*nowrap/);
  assert.doesNotMatch(strip, /(?:^|;)\s*(?:height|min-height|width|min-width|background|border|overflow)\s*:/,
    'costs use their intrinsic size without a footer shell or clipping');
  // Narrow panels retain the same intrinsic pair, not a stacked or scrolled layout.
  assert.doesNotMatch(css, /@media \(max-width: 520px\)/,
    'the cost pair keeps one compact row in narrow panels');
  assert.doesNotMatch(css, /overflow-x:\s*auto|scrollbar-width|::-webkit-scrollbar/,
    'global costs never introduce a horizontal scroller');
  // The inert measurement row is invisible by construction.
  assert.match(measurements, /position:\s*absolute/);
  assert.match(measurements, /visibility:\s*hidden/);
  assert.match(measurements, /pointer-events:\s*none/);
  assert.doesNotMatch(css, /aggregate-strip-(?:cost|tokens|providers|deferred|user-input|counts)[^{]*\{[^}]*display:\s*none/,
    'no statistics are hidden by CSS');
});

test('the session tab context menu is viewport-capped and scrolls tall dynamic group lists', async () => {
  const composerCss = await readStyleSource('composer.css');
  const rule = composerCss.match(/\.session-tab-context-menu\s*\{([^}]*)\}/)?.[1] ?? '';
  // Dynamic "Group with…"/"Merge" actions make the menu arbitrarily tall; it
  // must cap to the viewport (matching the 4px clamp margin on each side in
  // useMenuViewportClamp) and scroll overflow instead of clipping items.
  assert.ok(rule, 'expected a .session-tab-context-menu rule in composer.css');
  assert.match(rule, /max-height:\s*calc\(100vh - 8px\)/);
  assert.match(rule, /overflow-y:\s*auto/);
});

test('settings notes opt out of the toolbar-settings-item check+label grid', async () => {
  const composerCss = await readStyleSource('composer.css');
  const rule = composerCss.match(/\.toolbar-settings-note\s*\{([^}]*)\}/)?.[1] ?? '';
  // Notes carry .toolbar-settings-item but hold a bare text node; if the
  // item's 3-column grid applies, the text lands in the 14px check column
  // and wraps into an unusably narrow sliver (observed at 320/390 widths).
  assert.ok(rule, 'expected a .toolbar-settings-note rule in composer.css');
  assert.match(rule, /display:\s*block/);
});
