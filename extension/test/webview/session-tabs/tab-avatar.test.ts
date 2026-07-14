import test from 'node:test';
import assert from 'node:assert/strict';

import { getTabAvatarColor, getTabAvatarHue, getTabAvatarLabel } from '../../../src/webview/panel/session-tabs/tab-avatar';

test('getTabAvatarLabel returns the first alphanumeric character, uppercased', () => {
  assert.equal(getTabAvatarLabel('Refactor auth'), 'R');
  assert.equal(getTabAvatarLabel('fix: parsing bug'), 'F');
  assert.equal(getTabAvatarLabel('3rd-party import'), '3');
});

test('getTabAvatarLabel falls back to "?" for empty or symbol-only names', () => {
  assert.equal(getTabAvatarLabel(''), '?');
  assert.equal(getTabAvatarLabel('   '), '?');
  assert.equal(getTabAvatarLabel('— ✦ —'), '?');
});

test('getTabAvatarHue is deterministic and stable across calls', () => {
  const hueA = getTabAvatarHue('/workspace/a.jsonl');
  const hueB = getTabAvatarHue('/workspace/b.jsonl');
  assert.equal(hueA, getTabAvatarHue('/workspace/a.jsonl'), 'same path → same hue');
  assert.notEqual(hueA, hueB, 'different paths should usually differ in hue');
  assert.ok(hueA >= 0 && hueA < 360);
  assert.ok(hueB >= 0 && hueB < 360);
});

test('getTabAvatarColor produces a readable hsl background', () => {
  const color = getTabAvatarColor('/workspace/a.jsonl');
  assert.match(color, /^hsl\(\d+ 48% 46%\)$/);
});
