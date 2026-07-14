import test from 'node:test';
import assert from 'node:assert/strict';

import { accentContrastColor } from '../../../src/webview/panel/accent-contrast';

test('accentContrastColor keeps dark text on the bundled gold accent', () => {
  // The shipped default accent (#d7a942) must stay dark-text so the default
  // appearance is unchanged when no override is set.
  assert.equal(accentContrastColor('#d7a942'), '#090704');
});

test('accentContrastColor switches to light text on dark accents', () => {
  // Dark accents need a light foreground or accent-button text is unreadable.
  assert.equal(accentContrastColor('#000000'), '#f2eee4');
  assert.equal(accentContrastColor('#1b1b2a'), '#f2eee4');
  assert.equal(accentContrastColor('#0a3d62'), '#f2eee4');
});

test('accentContrastColor keeps dark text on bright accents', () => {
  assert.equal(accentContrastColor('#ffffff'), '#090704');
  assert.equal(accentContrastColor('#f1c75b'), '#090704');
  assert.equal(accentContrastColor('#51d88a'), '#090704');
});

test('accentContrastColor accepts 3-digit hex shorthand', () => {
  assert.equal(accentContrastColor('#000'), '#f2eee4');
  assert.equal(accentContrastColor('#fff'), '#090704');
});

test('accentContrastColor is case-insensitive and trims whitespace', () => {
  assert.equal(accentContrastColor(' #D7A942 '), '#090704');
  assert.equal(accentContrastColor('#FfFfFf'), '#090704');
});

test('accentContrastColor returns null for non-hex values', () => {
  // Defensive: non-hex accents (named colors, rgb(), etc.) leave the
  // stylesheet default in place rather than guessing.
  assert.equal(accentContrastColor('red'), null);
  assert.equal(accentContrastColor('rgb(1, 2, 3)'), null);
  assert.equal(accentContrastColor('#12345'), null);
  assert.equal(accentContrastColor('#1234567'), null);
  assert.equal(accentContrastColor(''), null);
});
