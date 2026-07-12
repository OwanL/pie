import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readStyleSource(fileName: string): Promise<string> {
  return readFile(new URL(`../src/webview/panel/styles/${fileName}`, import.meta.url), 'utf8');
}

async function readWebviewSource(relativePath: string): Promise<string> {
  return readFile(new URL(`../src/webview/panel/${relativePath}`, import.meta.url), 'utf8');
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

test('panel chip styling is centralized instead of embedded in feature components', async () => {
  const indexCss = await readStyleSource('index.css');
  const panelChipCss = await readStyleSource('panel-chip.css');
  const toolbar = await readWebviewSource('composer/toolbar.tsx');
  const pruningHeader = await readWebviewSource('transcript/pruning-header.tsx');
  const panelChipComponent = await readWebviewSource('components/panel-chip.tsx');

  assert.match(indexCss, /@import '\.\/panel-chip\.css';/);
  assert.match(panelChipCss, /\.panel-chip-toolbar/);
  assert.match(panelChipCss, /\.panel-chip-pruning/);
  assert.match(panelChipCss, /\.pruning-detail-row/);
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

  // The host emits the var from the pref (content rows × row-height constant),
  // and the pref is an effect dependency so updates propagate live.
  assert.match(
    prefsCss,
    /setProperty\(['"]--activity-tail-content-min-height['"],\s*`\$\{activityTailLines\s*\*\s*ACTIVITY_TAIL_ROW_HEIGHT_PX\}px`\)/,
  );
  assert.match(prefsCss, /activityTailLines,/);
});

test('subagent preview-rows pref uses an independent CSS var for collapsed cards', async () => {
  const transcriptCss = await readStyleSource('transcript.css');
  const prefsCss = await readWebviewSource('use-chat-prefs-css.ts');

  assert.match(transcriptCss, /--subagent-preview-content-min-height:\s*36px/);
  assert.match(
    transcriptCss,
    /\.subagent-live-preview\s+\.turn-activity-tail-content\s*\{[^}]*height:\s*var\(--subagent-preview-content-min-height\)/,
  );
  assert.match(
    prefsCss,
    /setProperty\(['"]--subagent-preview-content-min-height['"],\s*`\$\{subagentPreviewLines\s*\*\s*ACTIVITY_TAIL_ROW_HEIGHT_PX\}px`\)/,
  );
  assert.match(prefsCss, /subagentPreviewLines,/);
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