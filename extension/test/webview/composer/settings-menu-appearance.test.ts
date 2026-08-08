import assert from 'node:assert/strict';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { AppearanceSection } from '../../../src/webview/panel/composer/settings-menu-subcomponents';
import { DEFAULT_CHAT_PREFS } from '../../../src/shared/protocol';
import type { ChatPrefs } from '../../../src/shared/protocol';

function prefsWith(overrides: Partial<ChatPrefs>): ChatPrefs {
  return { ...DEFAULT_CHAT_PREFS, ...overrides };
}

test('AppearanceSection selects the Night theme by default and lists all themes', () => {
  const html = renderToString(h(AppearanceSection, {
    prefs: prefsWith({}),
    onSetPrefs: () => undefined,
  }));

  // Lookahead pattern: match the <option> tag whose attribute list contains
  // both selected and value="night", regardless of attribute order.
  assert.match(html, /<option\b(?=[^>]*selected)(?=[^>]*value="night")[^>]*>Night</);
  assert.match(html, />Slate</);
  assert.match(html, />Warm</);
  assert.match(html, />Midnight</);
  assert.match(html, />Carbon</);
});

test('AppearanceSection shows Custom when colors do not match a preset', () => {
  const html = renderToString(h(AppearanceSection, {
    prefs: prefsWith({ uiAccentColor: '#abcdef' }),
    onSetPrefs: () => undefined,
  }));

  // Preact renders an empty-string option value as the bare attribute `value`.
  assert.match(html, /<option[^>]*>Custom</);
  assert.match(html, /<option selected value>Custom</);
});

test('AppearanceSection groups controls semantically and owns status/usage visibility', () => {
  const html = renderToString(h(AppearanceSection, {
    prefs: prefsWith({}),
    onSetPrefs: () => undefined,
  }));

  for (const heading of [
    'Theme &amp; colors',
    'Spacing &amp; shape',
    'Files &amp; paths',
    'Layout',
    'Content &amp; navigation',
    'Typography',
    'Status &amp; usage',
  ]) {
    assert.match(html, new RegExp(heading));
  }
  assert.match(html, /Hide bottom usage strip/);
  assert.match(html, /Hide session cost/);
});

test('AppearanceSection renders all color rows with default swatches and reset buttons', () => {
  const html = renderToString(h(AppearanceSection, {
    prefs: prefsWith({}),
    onSetPrefs: () => undefined,
  }));

  // Six color inputs and their labels (Background, Text, Border, Accent,
  // Muted text, Links).
  assert.match(html, /Background/);
  assert.match(html, /Text/);
  assert.match(html, /Border/);
  assert.match(html, /Accent/);
  assert.match(html, /Muted text/);
  assert.match(html, /Links/);

  // Default swatches.
  assert.match(html, /<input[^>]*type="color"[^>]*value="#050506"[^>]*aria-label="Background color"/);
  assert.match(html, /<input[^>]*type="color"[^>]*value="#f2eee4"[^>]*aria-label="Text color"/);
  assert.match(html, /<input[^>]*type="color"[^>]*value="#f2eee4"[^>]*aria-label="Border color"/);
  assert.match(html, /<input[^>]*type="color"[^>]*value="#d7a942"[^>]*aria-label="Accent color"/);
  assert.match(html, /<input[^>]*type="color"[^>]*value="#958f82"[^>]*aria-label="Muted text color"/);
  assert.match(html, /<input[^>]*type="color"[^>]*value="#d7a942"[^>]*aria-label="Link color"/);

  // Reset buttons are disabled because none of the colors are overridden.
  const resetTags = html.match(/<button\b[^>]*\bclass="toolbar-settings-color-reset"[^>]*>/g) ?? [];
  assert.equal(resetTags.length, 6, 'expected one reset button per color row');
  const disabledResets = resetTags.filter((tag) => /\bdisabled\b/.test(tag)).length;
  assert.equal(disabledResets, 6, 'all reset buttons should be disabled when no color is overridden');
});

test('AppearanceSection color rows enable Reset only when their pref is overridden', () => {
  const html = renderToString(h(AppearanceSection, {
    prefs: prefsWith({ uiBackground: '#0d1117', uiAccentColor: '#abcdef' }),
    onSetPrefs: () => undefined,
  }));

  // Enabled buttons have no disabled attribute; disabled ones do. Match
  // whole reset-button tags and check each for `disabled` so the assertion is
  // independent of attribute serialization order (preact/compat reorders attrs).
  const resetTags = html.match(/<button\b[^>]*\bclass="toolbar-settings-color-reset"[^>]*>/g) ?? [];
  const totalResets = resetTags.length;
  const disabledResets = resetTags.filter((tag) => /\bdisabled\b/.test(tag)).length;
  assert.equal(totalResets, 6, 'expected one reset button per color row');
  assert.equal(totalResets - disabledResets, 2, 'expected exactly the two overridden rows to be resettable');
});

test('AppearanceSection renders the corner-radius slider with the current value and range', () => {
  const html = renderToString(h(AppearanceSection, {
    prefs: prefsWith({ uiCornerRadius: 12 }),
    onSetPrefs: () => undefined,
  }));

  assert.match(html, /Corner radius/);
  assert.match(html, />12px</);
  assert.match(html, /<input[^>]*type="range"[^>]*min="0"[^>]*max="24"[^>]*step="1"[^>]*value="12"[^>]*aria-label="Corner radius"/);
});

test('AppearanceSection renders the density select with comfortable selected by default', () => {
  const html = renderToString(h(AppearanceSection, {
    prefs: prefsWith({}),
    onSetPrefs: () => undefined,
  }));

  assert.match(html, /Density/);
  assert.match(html, /<option\b(?=[^>]*selected)(?=[^>]*value="comfortable")[^>]*>Comfortable</);
  assert.match(html, />Compact</);
  assert.match(html, />Spacious</);
});

test('AppearanceSection renders the path-depth slider with filename-only support', () => {
  const html = renderToString(h(AppearanceSection, {
    prefs: prefsWith({ uiPathParentDepth: 0 }),
    onSetPrefs: () => undefined,
  }));

  assert.match(html, /Path parent depth/);
  assert.match(html, /<input[^>]*type="range"[^>]*min="0"[^>]*max="8"[^>]*step="1"[^>]*value="0"[^>]*aria-label="Path parent depth"/);
});

test('AppearanceSection renders the message-width slider with the current value', () => {
  const html = renderToString(h(AppearanceSection, {
    prefs: prefsWith({ uiMessageWidth: 70 }),
    onSetPrefs: () => undefined,
  }));

  assert.match(html, /Message width/);
  assert.match(html, />70%</);
  assert.match(html, /<input[^>]*type="range"[^>]*min="40"[^>]*max="100"[^>]*step="2"[^>]*value="70"[^>]*aria-label="Message width"/);
});

test('AppearanceSection renders the initial composer rows control with the configured value', () => {
  const html = renderToString(h(AppearanceSection, {
    prefs: prefsWith({ composerInitialRows: 4 }),
    onSetPrefs: () => undefined,
  }));

  assert.match(html, /Initial composer rows/);
  assert.match(html, />4 rows</);
  assert.match(html, /<input[^>]*type="range"[^>]*min="1"[^>]*max="6"[^>]*step="1"[^>]*value="4"[^>]*aria-label="Initial composer rows"/);
});

test('AppearanceSection renders the base-text and composer-text sliders with widened ranges', () => {
  const html = renderToString(h(AppearanceSection, {
    prefs: prefsWith({ uiBaseFontSize: 15, uiComposerFontSize: 17 }),
    onSetPrefs: () => undefined,
  }));

  assert.match(html, /Base text/);
  assert.match(html, />15px</);
  assert.match(html, /<input[^>]*type="range"[^>]*min="10"[^>]*max="24"[^>]*step="1"[^>]*value="15"[^>]*aria-label="Base font size"/);

  assert.match(html, /Composer text/);
  assert.match(html, />17px</);
  assert.match(html, /<input[^>]*type="range"[^>]*min="11"[^>]*max="28"[^>]*step="1"[^>]*value="17"[^>]*aria-label="Composer font size"/);
});

test('AppearanceSection renders the expanded-text slider with its widened range', () => {
  const html = renderToString(h(AppearanceSection, {
    prefs: prefsWith({ expandedSectionFontSize: 20 }),
    onSetPrefs: () => undefined,
  }));

  assert.match(html, /Expanded text/);
  assert.match(html, />20px</);
  assert.match(html, /<input[^>]*type="range"[^>]*min="8"[^>]*max="32"[^>]*step="1"[^>]*value="20"[^>]*aria-label="Expanded section font size"/);
});

test('AppearanceSection renders the expanded-height and activity-rows sliders with widened ranges', () => {
  const html = renderToString(h(AppearanceSection, {
    prefs: prefsWith({ expandedSectionMaxHeight: 1000, activityTailLines: 9 }),
    onSetPrefs: () => undefined,
  }));

  assert.match(html, /Expanded height/);
  assert.match(html, />1000px</);
  assert.match(html, /<input[^>]*type="range"[^>]*min="80"[^>]*max="1600"[^>]*step="20"[^>]*value="1000"[^>]*aria-label="Expanded section max height"/);

  assert.match(html, /Activity rows/);
  assert.match(html, />9</);
  assert.match(html, /<input[^>]*type="range"[^>]*min="1"[^>]*max="12"[^>]*step="1"[^>]*value="9"[^>]*aria-label="Activity preview rows"/);
});
