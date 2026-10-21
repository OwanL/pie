import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../../styles/context-menu.css', import.meta.url), 'utf8');
const rule = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1);
  return css.slice(start, css.indexOf('}', start));
};

test('deferred menu caps both width bounds to the clamp viewport, not just the generic shell', () => {
  const shell = rule('.deferred-triggers-menu');
  // This selector follows .block-context-menu and used to override its safe
  // max-width with 340px, putting Cancel outside a 280px panel.
  assert.match(shell, /min-width: min\(240px, calc\(100vw - 8px\)\)/);
  assert.match(shell, /max-width: min\(340px, calc\(100vw - 8px\)\)/);
});

test('deferred list scroll cap includes shell chrome and both clamp margins', () => {
  const shell = rule('.deferred-triggers-menu');
  const list = rule('.deferred-triggers-menu-list');
  assert.match(shell, /max-height: calc\(100vh - 8px\)/);
  assert.match(shell, /padding: 4px 0/);
  assert.match(list, /max-height: min\(280px, calc\(100vh - 18px\)\)/);
  assert.match(list, /overflow-y: auto/);
  // 18px = two 4px viewport margins + two 4px shell paddings + two 1px borders.
  // Keeping scrolling on the list makes every Cancel reachable even when the
  // viewport is shorter than the usual 280px list cap.
  for (const height of [180, 280, 900]) {
    assert.ok(Math.min(280, height - 18) + 10 <= height - 8);
  }
});
