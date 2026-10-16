import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('provider home and modal stages share compact token-based settings controls', async () => {
  const css = await readFile(new URL('../../styles/settings-menu.css', import.meta.url), 'utf8');
  assert.match(css, /\.provider-setup-preview\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--panel-overlay-surface\) 95%, var\(--panel-black\)\);[^}]*box-shadow:\s*var\(--panel-shadow-overlay\);[^}]*border-radius:\s*var\(--panel-radius-md\);[^}]*padding:\s*12px;[^}]*max-height:\s*calc\(100dvh - 24px\);[^}]*overflow:\s*auto;/);
  assert.match(css, /\.provider-setup-preview h2\s*\{[^}]*font-size:\s*13px;[^}]*font-weight:\s*500;/);
  assert.match(css, /\.provider-setup-preview-home\s*\{[^}]*gap:\s*6px;[^}]*min-width:\s*0;[^}]*font-family:\s*var\(--panel-font-sans\);[^}]*font-size:\s*11px;/);
  assert.doesNotMatch(css, /\.provider-setup-preview-home\s*\{[^}]*(?:position:\s*fixed|height:\s*100vh)/);
  assert.match(css, /\.provider-setup-preview input:where\(:not\(\[type=checkbox\]\)\), \.provider-setup-preview select, \.provider-setup-preview button:where\(:not\(\[role=checkbox\]\)\)\s*\{[^}]*background:\s*var\(--panel-input-surface\);[^}]*border:\s*1px solid var\(--panel-border-subtle\);[^}]*min-height:\s*22px;/);
  assert.match(css, /\.provider-setup-preview-action-group\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/);
  assert.match(css, /\.provider-setup-preview-danger\s*\{[^}]*color:\s*var\(--panel-danger\)/);
  assert.match(css, /\.provider-setup-preview-danger-confirm\s*\{[^}]*background:\s*var\(--panel-danger-surface\)/);
  assert.match(css, /\.provider-setup-preview :focus-visible, \.provider-setup-preview-home :focus-visible\s*\{[^}]*outline:\s*1px solid var\(--panel-accent\)/);
  assert.match(css, /\.provider-setup-preview button:not\(:disabled\):hover, \.provider-setup-preview-home button:not\(:disabled\):hover/);
  assert.match(css, /\.provider-setup-preview-list li\s*\{[^}]*flex-wrap:\s*wrap;/);
  assert.match(css, /\.provider-setup-preview-model strong\s*\{[^}]*overflow-wrap:\s*anywhere;/);
  assert.match(css, /@media \(max-width: 420px\)\s*\{[^]*?\.provider-setup-preview-model select\s*\{[^}]*flex:\s*1 1 100%;[^}]*width:\s*100%;/);
  assert.match(css, /\.provider-setup-preview-home \.provider-setup-preview-actions\s*\{[^}]*width:\s*100%;/);
});

test('inline models page scrolls as one region between fixed header and fixed footer', async () => {
  const css = await readFile(new URL('../../styles/settings-menu.css', import.meta.url), 'utf8');
  assert.match(css, /\.toolbar-settings-menu-body:has\(\.provider-setup-preview-inline\[data-provider-screen="models"\]\)\s*\{[^}]*overflow:\s*hidden;/);
  assert.match(css, /\.provider-setup-preview-inline\[data-provider-screen="models"\] > \.provider-setup-preview-content\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;/);
  assert.match(css, /\.provider-setup-preview-inline\[data-provider-screen="models"\] \.provider-setup-preview-models-page\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/);
  // The bordered model list itself never becomes a nested scroller.
  assert.doesNotMatch(css, /\.provider-setup-preview-models \{[^}]*overflow-y:\s*auto;/);
  assert.doesNotMatch(css, /\.provider-setup-preview-models \{[^}]*max-height:/);
  assert.match(css, /\.provider-setup-preview \.provider-setup-preview-model-footer\s*\{[^}]*flex:\s*0 0 auto;/);
  assert.doesNotMatch(css, /\.provider-setup-preview-model-footer\s*\{[^}]*position:\s*(?:sticky|absolute|fixed)/);
});

test('settings preserve visible categories and bounded logical groups at narrow widths', async () => {
  const css = await readFile(new URL('../../styles/settings-menu.css', import.meta.url), 'utf8');
  assert.match(css, /\.toolbar-settings-tabs\s*\{[^}]*flex-direction:\s*row;[^}]*flex-wrap:\s*wrap;/);
  assert.match(css, /\.toolbar-settings-tab\.active\s*\{[^}]*border-bottom-color:\s*var\(--panel-accent\);[^}]*box-shadow:\s*none;/);
  assert.doesNotMatch(css, /\.toolbar-settings-tabs\s*\{[^}]*grid-template-columns:/);
  assert.match(css, /\.toolbar-settings-tab\s*\{[^}]*font-size:\s*11px;/);
  assert.doesNotMatch(css, /\.toolbar-settings-tabs\s*\{\s*display:\s*none;/);
  assert.match(css, /\.toolbar-settings-content-group\s*\{[^}]*border:\s*1px solid var\(--panel-border-subtle\)/);
  assert.match(css, /\.toolbar-settings-menu-body\s*\{[^}]*scrollbar-gutter:\s*stable;/);
  assert.match(css, /\.toolbar-settings-content-group-title\s*\{[^}]*text-transform:\s*none;/);
  assert.match(css, /\.toolbar-settings-menu \.toolbar-settings-number-input\s*\{[^}]*width:\s*88px;[^}]*max-width:\s*none;/);
  assert.match(css, /\.toolbar-settings-menu \.toolbar-settings-item\s*\{[^}]*min-height:\s*24px;/);
  assert.match(css, /\.toolbar-settings-menu \.toolbar-settings-select\s*\{[^}]*min-height:\s*22px;/);
  assert.match(css, /\.toolbar-settings-ui-inline-control\s*\{[^}]*flex-direction:\s*row;/);
  assert.match(css, /\.toolbar-settings-slider-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.2fr\) minmax\(60px, 1fr\) auto;/);
  assert.match(css, /@media \(hover: hover\)\s*\{\s*\.toolbar-settings-menu \.toolbar-settings-help\s*\{ opacity: 0; \}/);
  assert.match(css, /:is\(:hover, :focus-within\) \.toolbar-settings-help/);
  assert.match(css, /\.toolbar-settings-help:has\(> button\[aria-describedby\]\)\s*\{ opacity: 1; \}/);
  assert.doesNotMatch(css, /\.toolbar-settings-help\s*\{[^}]*(?:display:\s*none|visibility:\s*hidden)/);
  const imports = await readFile(new URL('../../styles/index.css', import.meta.url), 'utf8');
  assert.ok(imports.indexOf("@import './settings-menu.css';") > imports.indexOf("@import './composer.css';"));
});
