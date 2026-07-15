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
