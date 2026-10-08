import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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
