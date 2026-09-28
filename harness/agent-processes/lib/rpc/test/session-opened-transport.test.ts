import assert from 'node:assert/strict';
import test from 'node:test';

import {
  sessionOpenedMetadataForWorkerIpc,
  sessionOpenedUnavailableForWorkerIpc,
} from '../session-opened-transport.js';
import type { SessionOpenedPayload } from '../session-events.js';
import { SESSION_SNAPSHOT_TOO_LARGE_CODE } from '../wire.js';

function makePayload(overrides: Partial<SessionOpenedPayload> = {}): SessionOpenedPayload {
  return {
    session: {
      path: '/sessions/history.jsonl',
      name: 'History',
      cwd: '/',
      modifiedAt: new Date(0).toISOString(),
      messageCount: 8,
    },
    transcript: [],
    transcriptWindow: {
      totalCount: 8,
      loadedStart: 4,
      loadedEnd: 8,
      hasOlder: true,
      hasNewer: false,
      isPartial: true,
      hasUserMessages: true,
    },
    busy: false,
    ...overrides,
  };
}

test('metadata projection marks ordinary session.opened history non-authoritative and retains model context', () => {
  const contextUsage = { tokens: 1_234, contextWindow: 32_000, percent: 0.0385 };
  const modelSettings = { defaultModel: 'provider/model', defaultThinkingLevel: 'high' } as SessionOpenedPayload['modelSettings'];
  const availableModels = [{ id: 'provider/model', provider: 'provider', name: 'Model' }] as SessionOpenedPayload['availableModels'];
  const systemPrompts = [{ source: 'harness', title: 'Harness', text: 'Keep this context.', summary: 'Harness context', availability: 'available' }] as SessionOpenedPayload['systemPrompts'];
  const payload = makePayload({ contextUsage, modelSettings, availableModels, systemPrompts });

  const projected = sessionOpenedMetadataForWorkerIpc(payload);

  assert.deepEqual(projected.transcript, []);
  assert.equal(projected.transcriptSkipped, true);
  assert.deepEqual(projected.transcriptWindow, {
    ...payload.transcriptWindow,
    loadedStart: 0,
    loadedEnd: 0,
    hasOlder: false,
    hasNewer: true,
    isPartial: true,
  });
  assert.deepEqual(projected.contextUsage, contextUsage);
  assert.deepEqual(projected.modelSettings, modelSettings);
  assert.deepEqual(projected.availableModels, availableModels);
  assert.deepEqual(projected.systemPrompts, systemPrompts);
  assert.strictEqual(payload.transcriptWindow.loadedStart, 4, 'projection does not mutate the source window');
});

test('promotion metadata projection preserves an existing snapshotUnavailable page gap', () => {
  const unavailableWindow = {
    totalCount: 8,
    loadedStart: 8,
    loadedEnd: 8,
    hasOlder: true,
    hasNewer: false,
    isPartial: true,
    hasUserMessages: true,
  };
  const unavailable = {
    code: SESSION_SNAPSHOT_TOO_LARGE_CODE,
    message: 'The lossless snapshot did not fit.',
  } as const;
  const payload = makePayload({
    transcript: [],
    transcriptWindow: unavailableWindow,
    snapshotUnavailable: unavailable,
  });

  const projected = sessionOpenedMetadataForWorkerIpc(payload);

  assert.deepEqual(projected.transcript, []);
  assert.deepEqual(projected.transcriptWindow, unavailableWindow);
  assert.deepEqual(projected.snapshotUnavailable, unavailable);
  assert.equal(projected.transcriptSkipped, undefined);
});

test('public structural fallback reports an unavailable snapshot with a valid paging edge', () => {
  const contextUsage = { tokens: 4_000, contextWindow: 16_000, percent: 0.25 };
  const payload = makePayload({ contextUsage });

  const projected = sessionOpenedUnavailableForWorkerIpc(payload);

  assert.deepEqual(projected.transcript, []);
  assert.equal(projected.transcriptSkipped, undefined);
  assert.deepEqual(projected.snapshotUnavailable, {
    code: SESSION_SNAPSHOT_TOO_LARGE_CODE,
    message: 'The session transcript could not fit the worker IPC structural limit. Existing transcript state was preserved where available.',
  });
  assert.deepEqual(projected.transcriptWindow, {
    ...payload.transcriptWindow,
    loadedStart: 8,
    loadedEnd: 8,
    hasOlder: true,
    hasNewer: false,
    isPartial: true,
  });
  assert.deepEqual(projected.contextUsage, contextUsage);
});
