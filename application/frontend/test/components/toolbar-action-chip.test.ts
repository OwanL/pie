import assert from 'node:assert/strict';
import test from 'node:test';
import { h } from 'preact';
import renderToString from 'preact-render-to-string';
import { PanelChip, ToolbarActionChip } from '../../lib/components/panel-chip';

test('toolbar action chip owns the interactive shell and preserves action semantics', () => {
  let clicks = 0;
  const onClick = () => { clicks++; };
  const chip = ToolbarActionChip({
    label: 'Retry', tone: 'warning', title: 'Try loading again',
    ariaLabel: 'Retry loading the model catalog', onClick,
  });
  assert.equal(chip.type, PanelChip);
  assert.equal(chip.props.onClick, onClick);
  chip.props.onClick();
  assert.equal(clicks, 1);
  const html = renderToString(h(ToolbarActionChip, {
    label: 'Retry', tone: 'warning', title: 'Try loading again',
    ariaLabel: 'Retry loading the model catalog', onClick,
  }));
  assert.match(html, /<button[^>]*type="button"/);
  assert.match(html, /panel-chip-toolbar panel-chip-warning panel-chip-interactive/);
  assert.match(html, /aria-label="Retry loading the model catalog"/);
  assert.match(html, /title="Try loading again"/);
  assert.match(html, />Retry<\/span>/);
});
