import assert from 'node:assert/strict';
import test from 'node:test';

import renderToString from 'preact-render-to-string';

import { getRowRenderer, type RowRendererProps } from '../../../../src/webview/panel/transcript/registry';
import type { TranscriptRow } from '../../../../src/webview/panel/transcript/virtual-list-rows';
import '../../../../src/webview/panel/transcript/rows/top-gap-row.tsx';
import '../../../../src/webview/panel/transcript/rows/bottom-gap-row.tsx';

const noop = () => undefined;

function renderGap(row: TranscriptRow, loading = false): string {
  const renderer = getRowRenderer(row.kind);
  assert.ok(renderer);
  return renderToString(renderer({
    row,
    isLoadingOlder: loading,
    isLoadingNewer: loading,
    onRequestOlder: noop,
    onRequestNewer: noop,
  } as RowRendererProps) as any);
}

test('paging gap buttons disclose the page size and exact unloaded history', () => {
  const older = { kind: 'topGap', key: 'gap:older', hiddenCount: 1_942 } as TranscriptRow;
  const newer = { kind: 'bottomGap', key: 'gap:newer', hiddenCount: 75 } as TranscriptRow;

  assert.match(renderGap(older), /Load 120 older messages · 1942 not loaded/);
  assert.match(renderGap(older, true), /Loading older messages… · 1942 not loaded/);
  assert.match(renderGap(newer), /Load 75 newer messages · 75 not loaded/);
  assert.match(renderGap(newer, true), /Loading newer messages… · 75 not loaded/);
});
