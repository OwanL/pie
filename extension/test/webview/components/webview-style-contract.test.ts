import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readStyleSource(fileName: string): Promise<string> {
  return readFile(new URL(`../../../src/webview/panel/styles/${fileName}`, import.meta.url), 'utf8');
}

async function readWebviewSource(relativePath: string): Promise<string> {
  return readFile(new URL(`../../../src/webview/panel/${relativePath}`, import.meta.url), 'utf8');
}

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

test('panel chip styling is centralized instead of embedded in feature components', async () => {
  const indexCss = await readStyleSource('index.css');
  const panelChipCss = await readStyleSource('panel-chip.css');
  const toolbar = await readWebviewSource('composer/toolbar.tsx');
  const pruningHeader = await readWebviewSource('transcript/pruning-header.tsx');
  const panelChipComponent = await readWebviewSource('components/panel-chip.tsx');

  assert.match(indexCss, /@import '\.\/panel-chip\.css';/);
  assert.match(panelChipCss, /\.panel-chip-toolbar/);
  assert.match(panelChipCss, /\.panel-chip-pruning/);
  assert.match(panelChipCss, /\.pruning-stat-tile/);
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

  // The :root default (2 content rows × 18px row height) lands the preview at
  // its bundled height before the host effect runs.
  assert.match(transcriptCss, /--activity-tail-content-min-height:\s*36px/);
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
  assert.match(indexCss, /--panel-font-size:\s*13px/);
  assert.match(indexCss, /--panel-composer-font-size:\s*13px/);
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
  assert.match(inlineEditorCss, /\[data-role="user"\]\[data-editing="true"\] \.inline-editor-textarea\s*\{[^}]*color:\s*var\(--panel-user-foreground\)/);
  assert.match(messageShell, /role === 'user' && '.*rounded-lg px-2 py-1\.5/);
  assert.doesNotMatch(reasoningBlock, /bg-control|rounded-md/);

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
  assert.match(toolCallCss, /\.tool-call\.tool-call-subagent \.subagent-header\[aria-expanded="false"\]\s*\{[^}]*background:\s*var\(--panel-subagent-header-surface\)/);
  assert.match(toolCallCss, /\.subagent-header \.status-chip,[\s\S]*?background:\s*var\(--panel-control-surface\)/);
  assert.match(toolCallCss, /\.subagent-messages\s*\{[^}]*background:\s*var\(--panel-code-surface\)/);
  assert.match(toolCallCss, /\.tool-call-card\[data-provisional="true"\] > \.tool-call-header \.transcript-header-title-mono,[\s\S]*?color:\s*var\(--panel-muted\);[^}]*opacity:\s*1/);
  assert.doesNotMatch(toolCallCss, /\.tool-call-card\[data-provisional="true"\]\s*\{[^}]*(?:background|border-inline-start)/);
  assert.match(toolCallCss, /\.tool-call-provisional-input\s*\{[^}]*overflow-y:\s*auto;[^}]*white-space:\s*pre-wrap;[^}]*color:\s*var\(--panel-muted\)/);
  assert.doesNotMatch(toolCallCss, /tool-call-provisional-status|tool-call-draft-cursor/);
  assert.match(toolCallCss, /\.tool-call-live-preview\s*\{[^}]*background:\s*var\(--panel-code-surface\)/);
  assert.match(toolCallCss, /\.tool-call-live-preview \.turn-activity-tail-content\[data-empty="true"\],[\s\S]*?display:\s*none;[\s\S]*?height:\s*0/);
  assert.match(toolCallCss, /@media \(forced-colors: active\)[\s\S]*?\.tool-call-card\[data-provisional="true"\]/);
  assert.match(transcriptCss, /\.reasoning-block\[data-streaming="true"\]\[data-provisional="true"\]\s*\{[^}]*border-inline-start:\s*2px/);
  assert.match(transcriptCss, /\.message-item-shell\[data-role="user"\]\[data-queued="true"\] \.status-chip-neutral\s*\{[^}]*color:\s*var\(--panel-user-foreground\);[^}]*opacity:\s*1/);
  assert.doesNotMatch(toolCallCss, /(?:linear|radial)-gradient|backdrop-filter|filter:\s*blur/);

  assert.match(aggregateCss, /\.aggregate-strip\s*\{[^}]*height:\s*20px;[^}]*font-size:\s*9\.5px/);
  assert.doesNotMatch(tabsCss, /\.session-tab-shell::before/);
});
