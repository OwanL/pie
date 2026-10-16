import assert from 'node:assert/strict';
import test from 'node:test';
import { placeSnoozeSubmenu } from '../../session-tabs/snooze-submenu-placement';

test('side cascades prefer right and flip left without covering trigger', () => {
  assert.equal(placeSnoozeSubmenu({ left: 100, right: 290, top: 50, bottom: 80 }, 190, 200, 800, 600).left, 290);
  assert.equal(placeSnoozeSubmenu({ left: 600, right: 790, top: 50, bottom: 80 }, 190, 200, 800, 600).left, 410);
});

for (const top of [4, 200, 570]) test(`360px fallback keeps trigger exposed at y=${top}`, () => {
  const rect = { left: 10, right: 350, top, bottom: top + 26 };
  const pos = placeSnoozeSubmenu(rect, 220, 200, 360, 640);
  const bottom = pos.top + Math.min(200, pos.maxHeight);
  assert.ok(pos.left >= 4 && pos.left + 220 <= 356);
  assert.ok(pos.top >= 4 && bottom <= 636);
  assert.ok(bottom <= rect.top || pos.top >= rect.bottom);
});

test('short viewport scrolls vertically rather than covering the trigger', () => {
  const pos = placeSnoozeSubmenu({ left: 4, right: 344, top: 90, bottom: 116 }, 220, 200, 360, 200);
  assert.deepEqual(pos, { left: 4, top: 4, maxHeight: 86 });
});
