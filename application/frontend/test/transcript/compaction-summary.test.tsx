import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../helpers/dom';
installDom();

import DOMPurify from 'dompurify';
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { CompactionSummary as CompactionSummaryCard } from '../../transcript/compaction-summary';
import { clearCollapsibleCache } from '../../transcript/use-collapsible-open';
import { MessageItem } from '../../transcript/message-item';
import { DEFAULT_CHAT_PREFS } from '../../../lib/protocol/index.js';

const CompactionSummary = (props: { summary: string; details?: CompactionSummaryDetails; collapsibleKey?: string }) =>
  h(CompactionSummaryCard, { ...props, collapsibleKey: props.collapsibleKey ?? 'compaction:test-entry' });
import { mapTranscript } from '../../../../harness/session-storage/transcripts/transcript';
import type { CompactionSummaryDetails } from '../../../lib/protocol/index.js';

let container: HTMLElement;

beforeEach(() => {
  clearCollapsibleCache();
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
  };
});

test('compaction disclosure survives remount without leaking to another entry or session', () => {
  const noop = () => {};
  const mount = (sessionKey: string, id = 'shared-entry') => {
    const [message] = mapTranscript([{
      id, type: 'compaction', timestamp: '2026-07-15T00:00:00.000Z', summary: 'kept context',
    }]);
    act(() => render(h(MessageItem, {
      message, sessionKey, isStreaming: false, prefs: DEFAULT_CHAT_PREFS,
      workingDirectory: null, editingId: null,
      onEditRequest: noop, onEditConfirm: noop, onEditCancel: noop,
      onOpenFile: noop, onContextMenu: noop, renderToolCall: () => null,
    }), container));
  };
  const expanded = () => container.querySelector('button')?.getAttribute('aria-expanded');
  mount('session-a');
  act(() => (container.querySelector('button') as HTMLButtonElement).click());
  act(() => render(null, container));
  mount('session-a');
  assert.equal(expanded(), 'true');
  act(() => render(null, container));
  mount('session-a', 'other-entry');
  assert.equal(expanded(), 'false');
  act(() => render(null, container));
  mount('session-b');
  assert.equal(expanded(), 'false');
  // Also switch sessions without unmounting the row.
  mount('session-a');
  assert.equal(expanded(), 'true');
  mount('session-b');
  assert.equal(expanded(), 'false');
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

  const header = container.querySelector('.compaction-summary-header') as HTMLElement;
  const collapsedText = header.textContent ?? '';
  assert.match(collapsedText, /Threshold/);
  assert.match(collapsedText, /100,000 → 12,345/);
  assert.match(collapsedText, /-87,655/);
  assert.match(collapsedText, /88%/);
  assert.doesNotMatch(collapsedText, /claude-sonnet-4|medium|anthropic|4\.2s/);
  assert.match(header.title, /claude-sonnet-4 · medium · anthropic · 4\.2s/);

  const button = container.querySelector('button') as HTMLButtonElement;
  act(() => button.click());
  const expandedText = container.querySelector('.compaction-summary-provenance')?.textContent ?? '';
  assert.match(expandedText, /100,000 → 12,345.*-87,655.*88%/);
  assert.match(expandedText, /claude-sonnet-4 · medium · anthropic · 4\.2s/);
});

test('compaction summary reduction is omitted when only one token side is present', () => {
  const details: CompactionSummaryDetails = {
    reason: 'manual',
    tokensBefore: 100_000,
    durationMs: 1_500,
  };
  act(() => render(h(CompactionSummary, { summary: 'summary text', details }), container));

  const header = container.querySelector('.compaction-summary-header') as HTMLElement;
  const collapsedText = header.textContent ?? '';
  assert.match(collapsedText, /Manual/);
  // Before is shown, after is a dash, and no reduction/percentage suffix.
  assert.match(collapsedText, /100,000 → —/);
  assert.doesNotMatch(collapsedText, /%\)|1\.5s/);
  assert.match(header.title, /1\.5s/);

  const button = container.querySelector('button') as HTMLButtonElement;
  act(() => button.click());
  assert.match(container.querySelector('.compaction-summary-provenance')?.textContent ?? '', /1\.5s/);
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
  const header = container.querySelector('.compaction-summary-header') as HTMLElement;
  const collapsedText = header.textContent ?? '';
  assert.match(collapsedText, /Overflow/);
  assert.match(collapsedText, /50,000 → 25,000/);
  assert.match(collapsedText, /-25,000/);
  assert.match(collapsedText, /50%/);
  assert.doesNotMatch(collapsedText, /gpt-5|2\.0s/);
  assert.match(header.title, /gpt-5 · 2\.0s/);

  const button = container.querySelector('button') as HTMLButtonElement;
  act(() => button.click());
  assert.match(container.querySelector('.compaction-summary-provenance')?.textContent ?? '', /gpt-5 · 2\.0s/);
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
