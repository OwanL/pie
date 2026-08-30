import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../../_helpers/dom';
installDom();

import type { ChatMessage } from '../../../../src/shared/protocol';
import {
  isReusableTranscriptMeasurementElement,
  TranscriptMeasurementCache,
} from '../../../../src/webview/panel/transcript/transcript-measurement-cache';
import type { TranscriptRow } from '../../../../src/webview/panel/transcript/virtual-list-rows';

function messageRow(key: string, overrides: Partial<ChatMessage> = {}): TranscriptRow {
  return {
    kind: 'message',
    key,
    message: {
      id: key,
      role: 'assistant',
      createdAt: '2026-08-29T00:00:00.000Z',
      markdown: 'stable completed response',
      status: 'completed',
      ...overrides,
    },
  };
}

test('reuses a stable scoped row only at the measured width', () => {
  const cache = new TranscriptMeasurementCache();
  const row = messageRow('/session-a:message:1');
  cache.remember(row, 600, 321);

  const initial = cache.createInitialMeasurements([row]);
  assert.equal(initial.reusedCount, 1);
  assert.equal(initial.widthBucket, 600);
  assert.equal(initial.measurements[0]?.key, row.key);
  assert.equal(initial.measurements[0]?.size, 321);

  // A measurement at a new pane width changes the active width bucket. Old
  // entries remain bounded in the LRU but are not reused for this layout.
  cache.remember(messageRow('/session-b:message:2'), 720, 222);
  assert.equal(cache.createInitialMeasurements([row]).reusedCount, 0);
});

test('content and estimator changes invalidate a cached row', () => {
  const cache = new TranscriptMeasurementCache();
  const original = messageRow('/session:message:1', { markdown: 'short response' });
  cache.remember(original, 640, 180);

  const changed = messageRow('/session:message:1', {
    markdown: 'a materially longer response\nwith another visual line',
  });
  assert.equal(cache.createInitialMeasurements([changed]).reusedCount, 0);
});

test('streaming and non-terminal tool rows are never reused', () => {
  const cache = new TranscriptMeasurementCache();
  const streaming = messageRow('/session:streaming', { status: 'streaming' });
  const runningTool = messageRow('/session:tool', {
    toolCalls: [{ id: 'tool-1', name: 'bash', input: {}, status: 'running' }],
  });
  cache.remember(streaming, 640, 250);
  cache.remember(runningTool, 640, 280);

  assert.equal(cache.createInitialMeasurements([streaming, runningTool]).reusedCount, 0);
});

test('cache is bounded by least-recently-used row count', () => {
  const cache = new TranscriptMeasurementCache(2);
  const first = messageRow('/session:first');
  const second = messageRow('/session:second');
  const third = messageRow('/session:third');
  cache.remember(first, 640, 101);
  cache.remember(second, 640, 102);
  cache.remember(third, 640, 103);

  const initial = cache.createInitialMeasurements([first, second, third]);
  assert.equal(initial.reusedCount, 2);
  assert.equal(initial.measurements[0], undefined);
  assert.equal(initial.measurements[1]?.size, 102);
  assert.equal(initial.measurements[2]?.size, 103);
});

test('expanded and editable DOM states cannot overwrite collapsed measurements', () => {
  const row = document.createElement('div');
  assert.equal(isReusableTranscriptMeasurementElement(row), true);

  const disclosure = document.createElement('button');
  disclosure.setAttribute('aria-expanded', 'true');
  row.appendChild(disclosure);
  assert.equal(isReusableTranscriptMeasurementElement(row), false);

  disclosure.remove();
  row.appendChild(document.createElement('textarea'));
  assert.equal(isReusableTranscriptMeasurementElement(row), false);
});
