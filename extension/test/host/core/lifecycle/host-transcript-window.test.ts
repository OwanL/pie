import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFullTranscriptWindow,
  buildTranscriptPageRequest,
  cullTranscriptWindowAroundActiveTurn,
  normalizeTranscriptWindow,
  withDecrementedWindowCounts,
  withIncrementedWindowCounts,
} from '../../../../src/host/core/transcript-window';
import type { ChatMessage, TranscriptWindow } from '../../../../src/shared/protocol';

function message(id: string, role: 'user' | 'assistant' = 'assistant'): ChatMessage {
  return {
    id,
    role,
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: id,
    status: 'completed',
  };
}

const baseWindow: TranscriptWindow = {
  totalCount: 5,
  loadedStart: 1,
  loadedEnd: 4,
  hasOlder: true,
  hasNewer: true,
  isPartial: true,
  hasUserMessages: true,
};

test('buildFullTranscriptWindow and normalizeTranscriptWindow derive full-window defaults', () => {
  const transcript = [message('u1', 'user'), message('a1')];
  assert.deepEqual(buildFullTranscriptWindow(transcript), {
    totalCount: 2,
    loadedStart: 0,
    loadedEnd: 2,
    hasOlder: false,
    hasNewer: false,
    isPartial: false,
    hasUserMessages: true,
  });

  assert.deepEqual(normalizeTranscriptWindow(transcript, undefined), buildFullTranscriptWindow(transcript));
  assert.deepEqual(normalizeTranscriptWindow(transcript, {
    totalCount: 1,
    loadedStart: -5,
    loadedEnd: 99,
    hasOlder: false,
    hasNewer: false,
    isPartial: false,
    hasUserMessages: false,
  }), {
    totalCount: 2,
    loadedStart: 0,
    loadedEnd: 2,
    hasOlder: false,
    hasNewer: false,
    isPartial: false,
    hasUserMessages: false,
  });
});

test('window count helpers handle undefined and preserve partial-window flags', () => {
  assert.deepEqual(withIncrementedWindowCounts(undefined), {
    totalCount: 1,
    loadedStart: 0,
    loadedEnd: 1,
    hasOlder: false,
    hasNewer: false,
    isPartial: false,
    hasUserMessages: false,
  });

  assert.deepEqual(withIncrementedWindowCounts(baseWindow), {
    ...baseWindow,
    totalCount: 6,
    loadedEnd: 5,
    hasOlder: true,
    hasNewer: true,
    isPartial: true,
  });

  assert.equal(withDecrementedWindowCounts(undefined), undefined);
  assert.deepEqual(withDecrementedWindowCounts(baseWindow), {
    ...baseWindow,
    totalCount: 4,
    loadedEnd: 3,
    hasOlder: true,
    hasNewer: true,
    isPartial: true,
  });
});

test('cullTranscriptWindowAroundActiveTurn preserves active messages outside the default tail', () => {
  const transcript = Array.from({ length: 6 }, (_, index) => message(`msg-${index}`));
  const transcriptWindow: TranscriptWindow = {
    totalCount: 6,
    loadedStart: 0,
    loadedEnd: 6,
    hasOlder: false,
    hasNewer: false,
    isPartial: false,
    hasUserMessages: false,
  };

  const unchanged = cullTranscriptWindowAroundActiveTurn({
    transcript,
    transcriptWindow,
    maxLoadedCount: 10,
  });
  assert.strictEqual(unchanged.transcript, transcript);
  assert.strictEqual(unchanged.transcriptWindow, transcriptWindow);

  const culled = cullTranscriptWindowAroundActiveTurn({
    transcript,
    transcriptWindow,
    activeTurnMessageId: 'msg-1',
    maxLoadedCount: 5,
  });
  assert.deepEqual(culled.transcript.map((entry) => entry.id), ['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5']);
  assert.deepEqual(culled.transcriptWindow, {
    totalCount: 6,
    loadedStart: 1,
    loadedEnd: 6,
    hasOlder: true,
    hasNewer: false,
    isPartial: true,
    hasUserMessages: false,
  });
});

test('buildTranscriptPageRequest forwards window boundaries and direction', () => {
  assert.deepEqual(buildTranscriptPageRequest(baseWindow, 'older'), {
    direction: 'older',
    loadedStart: 1,
    loadedEnd: 4,
  });
});
