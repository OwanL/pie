import assert from 'node:assert/strict';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { TurnActivityRegion } from '../../../../src/webview/panel/transcript/turn-activity-region.tsx';
import type { TurnActivityState } from '../../../../src/webview/panel/transcript/activity';
import type { TurnActivityTail } from '../../../../src/webview/panel/transcript/activity-tail';

function tail(overrides: Partial<TurnActivityTail> & { kind: TurnActivityTail['kind'] }): TurnActivityTail {
  return { lines: [], truncated: false, cursor: true, reservedRows: 2, ...overrides };
}

function stateWithTail(): TurnActivityState {
  return {
    phase: 'runningTool',
    label: 'bash',
    tone: 'active',
    ariaLabel: 'Agent is running bash',
    tail: tail({ kind: 'tool', label: 'bash', inputLine: 'ls', lines: ['out'] }),
  };
}

function stateWithoutTail(): TurnActivityState {
  return { phase: 'thinking', label: 'thinking', tone: 'processing', ariaLabel: 'Agent is thinking' };
}

// The region renders two anti-correlated grid tracks: the strip track is open
// when there is no tail, the block track is open when there is a tail. This is
// what drives the animated strip<->block swap (mirroring the bash tool-call
// body open/close).

test('TurnActivityRegion opens the block track and collapses the strip when a tail is present', () => {
  const html = renderToString(h(TurnActivityRegion, { state: stateWithTail() }));
  // Block track is open (visible), strip track is collapsed.
  assert.match(html, /turn-activity-track[^>]*data-open="true"[^>]*>\s*<div class="turn-activity-track-inner"[^>]*>\s*(<div class="turn-activity-block"|<TurnActivityBlock)/);
  // Both open-states appear: block "true", strip "false".
  const opens: string[] = html.match(/data-open="(true|false)"/g) ?? [];
  assert.ok(opens.includes('data-open="true"') && opens.includes('data-open="false"'), `expected both open states, got ${opens.join(',')}`);
  // The block content renders.
  assert.match(html, /turn-activity-block/);
  assert.match(html, /Agent is running bash/);
});

test('TurnActivityRegion opens the strip track and collapses the block when there is no tail', () => {
  const html = renderToString(h(TurnActivityRegion, { state: stateWithoutTail() }));
  assert.match(html, /turn-activity-strip/);
  assert.match(html, /turn-activity-strip-label">thinking/);
  // No block content is rendered when there has never been a tail.
  assert.doesNotMatch(html, /turn-activity-block/);
  // Strip track open, block track collapsed.
  const opens: string[] = html.match(/data-open="(true|false)"/g) ?? [];
  assert.ok(opens.includes('data-open="true"') && opens.includes('data-open="false"'), `expected both open states, got ${opens.join(',')}`);
});

test('TurnActivityRegion hides the collapsed track from assistive tech', () => {
  const withTail = renderToString(h(TurnActivityRegion, { state: stateWithTail() }));
  // The collapsed (strip) track's inner is aria-hidden; the open (block) track's is not.
  assert.match(withTail, /aria-hidden="true"/);
  const withoutTail = renderToString(h(TurnActivityRegion, { state: stateWithoutTail() }));
  assert.match(withoutTail, /aria-hidden="true"/);
});

test('TurnActivityRegion falls back to the preparing label for a null state (typing indicator)', () => {
  const html = renderToString(h(TurnActivityRegion, { state: null, standalone: true }));
  assert.match(html, /turn-activity-strip/);
  assert.match(html, /preparing response/);
  assert.match(html, /aria-label="Agent is preparing response"/);
});
