import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDisplayTranscriptCache,
  buildPagedTranscriptWindow,
  buildTailTranscriptWindow,
  isDisplayTranscriptCacheStale,
  type DisplayTranscriptCache,
} from '../../../src/backend/transcript-window';
import type { ChatMessage } from '../../../src/shared/protocol';

function buildMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `msg-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: `message ${index}`,
    status: 'completed',
  }));
}

function buildCache(count: number): DisplayTranscriptCache {
  return {
    transcript: buildMessages(count),
    sessionUsage: { samples: [] },
    hasUserMessages: true,
    branchEntryCount: count,
    branchLastEntryId: `entry-${count - 1}`,
  };
}

test('buildPagedTranscriptWindow older paging advances once max window budget is reached', () => {
  const cache = buildCache(500);

  const olderPage = buildPagedTranscriptWindow(cache, {
    direction: 'older',
    loadedStart: 260,
    loadedEnd: 500,
    pageSize: 40,
    maxLoadedCount: 240,
  }).transcriptWindow;

  assert.deepEqual({ start: olderPage.loadedStart, end: olderPage.loadedEnd }, { start: 220, end: 460 });

  const olderPageAgain = buildPagedTranscriptWindow(cache, {
    direction: 'older',
    loadedStart: olderPage.loadedStart,
    loadedEnd: olderPage.loadedEnd,
    pageSize: 40,
    maxLoadedCount: 240,
  }).transcriptWindow;

  assert.deepEqual({ start: olderPageAgain.loadedStart, end: olderPageAgain.loadedEnd }, { start: 180, end: 420 });
});

test('buildPagedTranscriptWindow newer paging advances once max window budget is reached', () => {
  const cache = buildCache(500);

  const newerPage = buildPagedTranscriptWindow(cache, {
    direction: 'newer',
    loadedStart: 180,
    loadedEnd: 420,
    pageSize: 40,
    maxLoadedCount: 240,
  }).transcriptWindow;

  assert.deepEqual({ start: newerPage.loadedStart, end: newerPage.loadedEnd }, { start: 220, end: 460 });
});

test('default transcript budgets keep the longest observed session fully reachable in at most 18 page actions', () => {
  const cache = buildCache(2_182);
  let window = buildTailTranscriptWindow(cache).transcriptWindow;
  let olderActions = 0;

  while (window.hasOlder) {
    window = buildPagedTranscriptWindow(cache, {
      direction: 'older',
      loadedStart: window.loadedStart,
      loadedEnd: window.loadedEnd,
    }).transcriptWindow;
    olderActions += 1;
    assert.ok(window.loadedEnd - window.loadedStart <= 240);
    assert.ok(olderActions <= 18, 'older history should not require more than 18 page actions');
  }

  assert.equal(window.loadedStart, 0);

  let newerActions = 0;
  while (window.hasNewer) {
    window = buildPagedTranscriptWindow(cache, {
      direction: 'newer',
      loadedStart: window.loadedStart,
      loadedEnd: window.loadedEnd,
    }).transcriptWindow;
    newerActions += 1;
    assert.ok(window.loadedEnd - window.loadedStart <= 240);
    assert.ok(newerActions <= 18, 'latest history should not require more than 18 page actions');
  }

  assert.equal(window.loadedEnd, 2_182);
});

test('buildDisplayTranscriptCache records transcript fingerprints and stale detection', () => {
  const entries = [
    {
      id: 'entry-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'message',
      message: { role: 'user', content: 'hello' },
    },
    {
      id: 'entry-2',
      timestamp: '2026-01-01T00:00:01.000Z',
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
    },
  ] as any[];

  const cache = buildDisplayTranscriptCache(entries as any);

  assert.equal(cache.branchEntryCount, 2);
  assert.equal(cache.branchLastEntryId, 'entry-2');
  assert.equal(cache.hasUserMessages, true);
  assert.equal(cache.transcript.length, 2);
  assert.deepEqual(cache.sessionUsage.samples, []);
  assert.equal(isDisplayTranscriptCacheStale(cache, entries as any), false);
  assert.equal(isDisplayTranscriptCacheStale(cache, [...entries, { id: 'entry-3' }] as any), true);
});

test('session-opened tails and transcript pages use compact transport rows while retaining durable nested details', () => {
  const recursiveTranscript = 'nested transcript '.repeat(64 * 1024);
  const entries = [
    {
      id: 'entry-assistant',
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'message',
      message: {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'subagent-call',
          name: 'subagent',
          arguments: { agent: 'worker', task: 'inspect' },
        }],
        stopReason: 'toolUse',
      },
    },
    {
      id: 'entry-tool-result',
      timestamp: '2026-01-01T00:00:01.000Z',
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'subagent-call',
        toolName: 'subagent',
        content: [{ type: 'text', text: 'done' }],
        details: {
          mode: 'single',
          results: [{
            agent: 'worker',
            task: 'inspect',
            exitCode: 0,
            messages: [{ role: 'assistant', content: [{ type: 'text', text: recursiveTranscript }] }],
          }],
        },
      },
    },
  ] as any[];

  const cache = buildDisplayTranscriptCache(entries as any, '/workspace/session.jsonl');
  assert.ok(cache.transportTranscript);
  const durableBytes = Buffer.byteLength(JSON.stringify(cache.transcript), 'utf8');
  const transportBytes = Buffer.byteLength(JSON.stringify(cache.transportTranscript), 'utf8');
  assert.ok(durableBytes > 1_000_000, 'backend detail source retains the complete recursive transcript');
  assert.ok(transportBytes < durableBytes / 4, 'ordinary transcript transport uses the lazy-detail projection');

  const tail = buildTailTranscriptWindow(cache);
  const page = buildPagedTranscriptWindow(cache, { direction: 'latest' });
  assert.strictEqual(tail.transcript[0], cache.transportTranscript[0]);
  assert.strictEqual(page.transcript[0], cache.transportTranscript[0]);
});

test('buildTailTranscriptWindow keeps pinned streaming messages visible outside the tail window', () => {
  const cache = buildCache(20);

  const tail = buildTailTranscriptWindow(cache, {
    tailCount: 5,
    maxLoadedCount: 5,
    pinnedMessageId: 'msg-2',
  }).transcriptWindow;

  assert.deepEqual({ start: tail.loadedStart, end: tail.loadedEnd }, { start: 2, end: 7 });
  assert.equal(tail.hasOlder, true);
  assert.equal(tail.hasNewer, true);
});

test('buildPagedTranscriptWindow latest falls back to tail settings and clamps invalid ranges', () => {
  const cache = buildCache(50);

  const latest = buildPagedTranscriptWindow(cache, {
    direction: 'latest',
    tailCount: 4,
    maxLoadedCount: 4,
    pinnedMessageId: 'missing',
  }).transcriptWindow;

  assert.deepEqual({ start: latest.loadedStart, end: latest.loadedEnd }, { start: 46, end: 50 });

  const clamped = buildPagedTranscriptWindow(cache, {
    direction: 'older',
    loadedStart: -10,
    loadedEnd: 2,
    pageSize: 10,
    maxLoadedCount: 8,
  }).transcriptWindow;

  assert.deepEqual({ start: clamped.loadedStart, end: clamped.loadedEnd }, { start: 0, end: 2 });
});
