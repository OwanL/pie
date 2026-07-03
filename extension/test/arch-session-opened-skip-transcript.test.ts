/**
 * Regression tests for the `transcript: 'skip'` optimization on `session.open`.
 *
 * Bug this locks down: when the host already has a session's transcript loaded
 * and the session is idle, switching to that tab re-shipped the full tail
 * window (~100 messages, potentially multi-MB) over stdout on every
 * `session.opened`, costing ~2s per switch for long sessions. The fix adds a
 * `transcriptSkipped` flag to `SessionOpenedPayload`; the reducer must KEEP the
 * existing `bySession`/`windowBySession` entries (not replace them with the
 * empty incoming snapshot) while still applying the metadata refresh (session
 * summary, busy, modelSettings, availableModels, contextUsage).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../src/host/core/reducer';
import type { Event } from '../src/host/core/events';
import type {
  ChatMessage,
  ModelInfo,
  ModelSettings,
  SessionOpenedPayload,
  SessionSummary,
  TranscriptWindow,
} from '../src/shared/protocol';

const sessionPath = '/s';
const sessionSummary: SessionSummary = {
  path: sessionPath,
  name: 'Session',
  cwd: '/workspace',
  modifiedAt: '2026-01-01T00:00:00.000Z',
  messageCount: 2,
  isPlaceholder: false,
};

const existingWindow: TranscriptWindow = {
  totalCount: 2,
  loadedStart: 0,
  loadedEnd: 2,
  hasOlder: false,
  hasNewer: false,
  isPartial: false,
  hasUserMessages: true,
};

const existingTranscript: ChatMessage[] = [
  { id: 'user-1', role: 'user', createdAt: '2026-01-01T00:00:00.000Z', markdown: 'Hello', status: 'completed' },
  { id: 'asst-1', role: 'assistant', createdAt: '2026-01-01T00:00:00.000Z', markdown: 'Hi there', status: 'completed' },
];

const refreshedModelSettings: ModelSettings = { /* minimal */ } as unknown as ModelSettings;
const refreshedAvailableModels: ModelInfo[] = [{ id: 'm-new', label: 'New' } as unknown as ModelInfo];

function buildBaseState(): ArchState {
  return {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: [sessionSummary],
      openTabPaths: [sessionPath],
      activeSessionPath: sessionPath,
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: { [sessionPath]: existingTranscript },
      windowBySession: { [sessionPath]: { ...existingWindow } },
    },
  };
}

function skipOpenedEvent(): Event {
  const payload: SessionOpenedPayload = {
    session: { ...sessionSummary, name: 'Session (refreshed)' },
    transcript: [],
    transcriptWindow: {
      totalCount: 2,
      loadedStart: 0,
      loadedEnd: 0,
      hasOlder: false,
      hasNewer: true,
      isPartial: true,
      hasUserMessages: true,
    },
    busy: false,
    transcriptSkipped: true,
    modelSettings: refreshedModelSettings,
    availableModels: refreshedAvailableModels,
  };
  return { kind: 'SessionOpened', sessionPath, payload };
}

test('SessionOpened with transcriptSkipped keeps the existing transcript + window and applies metadata', () => {
  const before = buildBaseState();
  const { state } = reducer(before, skipOpenedEvent());

  // Transcript + window preserved (not wiped to the empty incoming snapshot).
  assert.deepEqual(state.transcript.bySession[sessionPath], existingTranscript);
  assert.deepEqual(state.transcript.windowBySession[sessionPath], existingWindow);

  // Metadata refresh still applied.
  assert.equal(state.sessions.sessions.find((s) => s.path === sessionPath)?.name, 'Session (refreshed)');
  assert.equal(state.settings.modelSettings, refreshedModelSettings);
  assert.deepEqual(state.settings.availableModelsBySession[sessionPath], refreshedAvailableModels);
});

test('SessionOpened without transcriptSkipped replaces the transcript with the incoming snapshot (regression guard)', () => {
  const before = buildBaseState();
  const incoming: ChatMessage[] = [
    { id: 'user-99', role: 'user', createdAt: '2026-01-02T00:00:00.000Z', markdown: 'Fresh', status: 'completed' },
  ];
  const payload: SessionOpenedPayload = {
    session: sessionSummary,
    transcript: incoming,
    transcriptWindow: { ...existingWindow, totalCount: 1, loadedEnd: 1 },
    busy: false,
  };
  const { state } = reducer(before, { kind: 'SessionOpened', sessionPath, payload });

  // No skip flag → authoritative incoming snapshot replaces the local one.
  assert.deepEqual(state.transcript.bySession[sessionPath], incoming);
  assert.equal(state.transcript.windowBySession[sessionPath].totalCount, 1);
});