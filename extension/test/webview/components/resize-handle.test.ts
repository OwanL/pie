import assert from 'node:assert/strict';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { ResizeHandle } from '../../../src/webview/panel/components/resize-handle';

const noop = () => undefined;

// The handle was generalized from vertical-only (top/bottom) to also support
// horizontal edges (left/right) for the file-changes drawer. These tests pin
// the a11y contract for both axes so a future change can't silently regress
// either orientation.

test('vertical edge (top) renders a horizontal separator with height a11y', () => {
  const html = renderToString(
    h(ResizeHandle, {
      edge: 'top',
      onMouseDown: noop,
      height: 240,
      minHeight: 120,
      maxHeight: 720,
      onResizeBy: noop,
      onReset: noop,
    }),
  );
  assert.match(html, /class="resize-handle resize-handle-top"/);
  assert.match(html, /aria-orientation="horizontal"/);
  assert.match(html, /aria-valuemin="120"/);
  assert.match(html, /aria-valuemax="720"/);
  assert.match(html, /aria-valuenow="240"/);
});

test('horizontal edge (left) renders a vertical separator with width a11y', () => {
  const html = renderToString(
    h(ResizeHandle, {
      edge: 'left',
      onMouseDown: noop,
      width: 220,
      minWidth: 160,
      maxWidth: 480,
      onResizeBy: noop,
      onReset: noop,
    }),
  );
  assert.match(html, /class="resize-handle resize-handle-left"/);
  assert.match(html, /aria-orientation="vertical"/);
  assert.match(html, /aria-valuemin="160"/);
  assert.match(html, /aria-valuemax="480"/);
  assert.match(html, /aria-valuenow="220"/);
});

test('horizontal edge (right) mirrors left and omits aria-valuenow when width is null', () => {
  const html = renderToString(
    h(ResizeHandle, {
      edge: 'right',
      onMouseDown: noop,
      width: null,
      minWidth: 100,
      maxWidth: 400,
    }),
  );
  assert.match(html, /class="resize-handle resize-handle-right"/);
  assert.match(html, /aria-orientation="vertical"/);
  assert.doesNotMatch(html, /aria-valuenow/);
});
