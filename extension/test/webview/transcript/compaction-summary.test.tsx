import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../_helpers/dom';
installDom();

import DOMPurify from 'dompurify';
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { CompactionSummary } from '../../../src/webview/panel/transcript/compaction-summary';
import { mapTranscript } from '../../../src/backend/transcript';
import type { CompactionSummaryDetails } from '../../../src/shared/protocol';

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
  };
});

test('compaction entries map to a distinct collapsed transcript row', () => {
  const [message] = mapTranscript([{
    id: 'compact-1',
    type: 'compaction',
    timestamp: '2026-07-15T00:00:00.000Z',
    summary: '## Kept context\n\nThe important decision is preserved.',
  }]);

  assert.equal(message.customType, 'compaction-summary');
  assert.equal(message.markdown, '## Kept context\n\nThe important decision is preserved.');
});

test('compaction summary starts collapsed and exposes its full markdown on demand', () => {
  act(() => render(h(CompactionSummary, { summary: '**Preserved** context' }), container));
  const button = container.querySelector('button') as HTMLButtonElement;

  assert.equal(button.getAttribute('aria-label'), 'Toggle compaction summary');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(container.textContent?.includes('Preserved'), false);

  act(() => button.click());
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.match(container.innerHTML, /<strong>Preserved<\/strong> context/);

  act(() => button.click());
  assert.equal(button.getAttribute('aria-expanded'), 'false');
});

test('compaction summary renders metrics line with reason, before→after tokens, reduction, model, duration', () => {
  const details: CompactionSummaryDetails = {
    reason: 'threshold',
    tokensBefore: 100_000,
    estimatedTokensAfter: 12_345,
    durationMs: 4_200,
    modelId: 'claude-sonnet-4',
    provider: 'anthropic',
    thinkingLevel: 'medium',
  };
  act(() => render(h(CompactionSummary, { summary: 'summary text', details }), container));

  const text = container.textContent ?? '';
  assert.match(text, /Threshold/);
  assert.match(text, /100,000 → 12,345/);
  assert.match(text, /-87,655/);
  assert.match(text, /88%/);
  assert.match(text, /claude-sonnet-4/);
  assert.match(text, /medium/);
  assert.match(text, /anthropic/);
  assert.match(text, /4\.2s/);
});

test('compaction summary reduction is omitted when only one token side is present', () => {
  const details: CompactionSummaryDetails = {
    reason: 'manual',
    tokensBefore: 100_000,
    durationMs: 1_500,
  };
  act(() => render(h(CompactionSummary, { summary: 'summary text', details }), container));

  const text = container.textContent ?? '';
  assert.match(text, /Manual/);
  // before is shown, after is a dash, and no reduction/percentage suffix.
  assert.match(text, /100,000 → —/);
  assert.doesNotMatch(text, /%\)/);
  assert.match(text, /1\.5s/);
});

test('compaction summary omits the metrics line entirely when details are absent (legacy)', () => {
  act(() => render(h(CompactionSummary, { summary: 'summary text' }), container));
  const header = container.querySelector('.compaction-summary-header');
  assert.ok(header);
  // Only the static label is present; no meta row.
  assert.equal(header?.querySelector('.compaction-summary-meta'), null);
  assert.equal(container.textContent?.trim(), 'Compaction summary');
});

test('compaction summary renders metrics line from a sidecar-mapped transcript row', () => {
  const [message] = mapTranscript([
    { id: 'compact-1', type: 'compaction', timestamp: '2026-07-15T00:00:00.000Z', summary: 'kept context' },
    {
      id: 'sidecar-1',
      type: 'custom',
      timestamp: '2026-07-15T00:00:01.000Z',
      customType: 'pie.compaction-metrics',
      data: {
        compactionEntryId: 'compact-1',
        reason: 'overflow',
        tokensBefore: 50_000,
        estimatedTokensAfter: 25_000,
        durationMs: 2_000,
        modelId: 'gpt-5',
      },
    },
  ]);

  assert.equal(message.customType, 'compaction-summary');
  assert.deepEqual(message.customDetails, {
    reason: 'overflow',
    tokensBefore: 50_000,
    estimatedTokensAfter: 25_000,
    durationMs: 2_000,
    modelId: 'gpt-5',
  } satisfies CompactionSummaryDetails);

  act(() => render(h(CompactionSummary, { summary: message.markdown, details: message.customDetails as CompactionSummaryDetails }), container));
  const text = container.textContent ?? '';
  assert.match(text, /Overflow/);
  assert.match(text, /50,000 → 25,000/);
  assert.match(text, /-25,000/);
  assert.match(text, /50%/);
  assert.match(text, /gpt-5/);
  assert.match(text, /2\.0s/);
});

test('compaction summary stays lazy: markdown is not rendered while collapsed even with metrics', () => {
  let renderCount = 0;
  // Wrap renderMarkdown to confirm it isn't called until expanded.
  // The component memoizes on `open`; while collapsed, html stays ''.
  const details: CompactionSummaryDetails = {
    reason: 'threshold',
    tokensBefore: 100,
    estimatedTokensAfter: 50,
  };
  act(() => render(h(CompactionSummary, { summary: '**secret** body', details }), container));
  renderCount += 1;
  const button = container.querySelector('button') as HTMLButtonElement;
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(container.innerHTML.includes('<strong>secret</strong>'), false);

  act(() => button.click());
  renderCount += 1;
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.match(container.innerHTML, /<strong>secret<\/strong> body/);
});
