import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { installDom } from '../helpers/dom';
installDom();

import DOMPurify from 'dompurify';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import renderToString from 'preact-render-to-string';
import { TurnActivityStrip, activityToneToStripTone } from '../../transcript/turn-activity-strip';
import { CompactionSummary } from '../../transcript/compaction-summary';

DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

test('routine processing stays neutral rather than masquerading as a warning', () => {
  assert.equal(activityToneToStripTone('processing'), 'neutral');
  assert.equal(activityToneToStripTone('neutral'), 'neutral');
  assert.equal(activityToneToStripTone('active'), 'accent');
});

test('activity preserves phase, motion semantics, tone and full accessible detail', () => {
  for (const tone of ['accent', 'warning', 'error'] as const) {
    const html = renderToString(h(TurnActivityStrip, {
      label: 'running read', detail: 'a/very/long/path.ts', tone,
      phase: 'runningTool', runningDot: true, ariaLabel: 'Agent is running read',
    }));
    assert.match(html, /role="status"/);
    assert.match(html, /data-phase="runningTool"/);
    assert.ok(html.includes(`turn-activity-strip ${tone} running`));
    assert.match(html, /aria-label="Agent is running read, a\/very\/long\/path.ts"/);
    assert.match(html, /title="running read: a\/very\/long\/path.ts"/);
    assert.match(html, /aria-hidden="true"><span>\.<\/span>/);
  }
  const quiet = renderToString(h(TurnActivityStrip, { label: 'preparing' }));
  assert.match(quiet, /Activity status: preparing/);
  assert.doesNotMatch(quiet, /<span>\.<\/span>/);
});

test('history compaction keeps provenance expanded, summary lazy, and header compact', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  try {
    act(() => render(h(CompactionSummary, {
      collapsibleKey: 'transcript-status-polish:provenance',
      summary: '**Preserved** context',
      details: { reason: 'overflow', tokensBefore: 100, estimatedTokensAfter: 50,
        modelId: 'model-long', provider: 'provider', thinkingLevel: 'medium', durationMs: 4200 },
    }), container));
    const header = container.querySelector('.compaction-summary-header')!;
    assert.match(header.textContent ?? '', /Overflow.*100 → 50.*50%/);
    assert.doesNotMatch(header.textContent ?? '', /model-long|provider|medium|4\.2s/);
    assert.match(header.getAttribute('title') ?? '', /model-long.*medium.*provider.*4\.2s/);
    assert.ok(container.querySelector('.compaction-summary-provenance') === null);
    assert.ok(container.querySelector('strong') === null);
    const button = container.querySelector('button')!;
    act(() => button.click());
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.match(container.querySelector('.compaction-summary-provenance')?.textContent ?? '', /model-long.*medium.*provider.*4\.2s/);
    assert.equal(container.querySelector('strong')?.textContent, 'Preserved');
    assert.ok(container.querySelector('.collapsible-close-footer') === null);
    assert.ok(container.querySelector('.collapsible-gutter'), 'side close affordance remains available');
    act(() => button.click());
    assert.equal(button.getAttribute('aria-expanded'), 'false');
  } finally {
    render(null, container);
    container.remove();
  }
});

test('history compaction missing metrics stay truthful, never invented', () => {
  for (const [details, expected] of [
    [undefined, 'Compaction summary'],
    [{ reason: 'manual', tokensBefore: 100 }, '100 → —'],
    [{ reason: 'manual', estimatedTokensAfter: 50 }, '— → 50'],
    [{ reason: 'manual', durationMs: 0 }, 'Compaction summary'],
  ] as const) {
    const key = `transcript-status-polish:missing-metrics:${expected}`;
    const html = renderToString(h(CompactionSummary, { collapsibleKey: key, summary: 'hidden body', details }));
    const container = document.createElement('div');
    container.innerHTML = html;
    assert.ok(container.querySelector('.compaction-summary-header')?.textContent?.includes(expected));
    assert.doesNotMatch(container.textContent ?? '', /%|hidden body/);
    if (!details) assert.ok(container.querySelector('.compaction-summary-meta') === null);
  }
});

test('composer edge fade stays fixed, short and transparent to input', () => {
  const css = readFileSync(new URL('../../styles/transcript.css', import.meta.url), 'utf8');
  const fade = css.match(/\.transcript-viewport::after\s*\{([^}]+)\}/)?.[1];
  assert.ok(fade);
  assert.match(fade, /position: absolute/);
  assert.match(fade, /bottom: 0/);
  assert.match(fade, /height: 8px/);
  assert.match(fade, /linear-gradient\(to bottom, transparent, var\(--panel-surface\)\)/);
  assert.match(fade, /pointer-events: none/);
  assert.match(fade, /z-index: 4/);
  assert.match(css, /@media \(forced-colors: active\)\s*\{\s*\.transcript-viewport::after \{ display: none;/);
});

test('status CSS is readable, detail shrinks first and spinner is compact inline', () => {
  const css = readFileSync(new URL('../../styles/transcript.css', import.meta.url), 'utf8');
  const block = (selector: string) => css.slice(css.indexOf(`${selector} {`)).split('}')[0];
  assert.match(block('.turn-activity-strip'), /font-family: var\(--panel-font-sans\)/);
  assert.match(block('.turn-activity-strip'), /font-size: 11px/);
  assert.match(block('.turn-activity-strip-label'), /flex: 0 0 auto/);
  assert.match(block('.message-activity-footer'), /margin-top: 0/);
  assert.match(block('.transcript'), /\) var\(--panel-gap-lg\) var\(--panel-gap-lg\)/);
  const listSource = readFileSync(new URL('../../transcript/virtual-list.tsx', import.meta.url), 'utf8');
  assert.match(listSource, /row === lastRow \? 'pb-0'/);
  assert.match(listSource, /aria-label="Jump to latest"/);
  assert.match(block('.turn-activity-strip-detail'), /flex: 0 1 auto/);
  assert.match(block('.turn-activity-strip-detail'), /min-width: 0/);
  assert.doesNotMatch(block('.turn-activity-strip-detail'), /opacity:/);
  assert.match(block('.turn-activity-strip.warning .turn-activity-strip-label'), /--panel-warning/);
  assert.match(block('.turn-activity-strip.error .turn-activity-strip-label'), /--panel-danger/);
  assert.match(block('.loading-wheel'), /width: 14px/);
  assert.match(block('.loading-wheel'), /height: 14px/);
  assert.doesNotMatch(block('.loading-indicator'), /flex-direction: column/);
  assert.match(block('.compaction-summary-card'), /background: transparent/);
});
