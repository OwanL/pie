import assert from 'node:assert/strict';
import test from 'node:test';

import { initialArchState, reducer, type ArchState } from '../../../../src/host/core/reducer';
import type { SessionOpenedPayload, SystemPromptEntry } from '../../../../src/shared/protocol';

const SESSION = '/sessions/cold.jsonl';

function prompt(id: string, disabled: boolean, toggleable = true): SystemPromptEntry {
  return {
    id,
    source: toggleable ? 'harness' : 'provider',
    title: id,
    text: id,
    summary: id,
    availability: 'available',
    disabled,
    toggleable,
  };
}

test('a cold SessionOpened toggle confirmation updates existing prompt entries without a runtime catalog', () => {
  const before: ArchState = {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: [{
        path: SESSION,
        cwd: '/repo',
        name: 'Cold',
        modifiedAt: '2026-08-25T00:00:00.000Z',
        messageCount: 0,
      }],
      openTabPaths: [SESSION],
      activeSessionPath: SESSION,
    },
    transcript: {
      ...initialArchState.transcript,
      systemPromptsBySession: {
        [SESSION]: [
          prompt('provider', false, false),
          prompt('skills', false),
          prompt('tools', true),
        ],
      },
    },
  };
  const payload: SessionOpenedPayload = {
    session: before.sessions.sessions[0]!,
    transcript: [],
    transcriptWindow: {
      totalCount: 0,
      loadedStart: 0,
      loadedEnd: 0,
      hasOlder: false,
      hasNewer: false,
      isPartial: false,
      hasUserMessages: false,
    },
    busy: false,
    runtimeReady: false,
    initialContextEstimate: { tokens: 12_345, contextWindow: 200_000 },
    systemPromptDisabledEntries: ['skills'],
  };

  const out = reducer(before, {
    kind: 'SessionOpened',
    backendGeneration: 0,
    modelWriteFence: 0,
    modelHydrationRevision: 0,
    catalogHydrationRevision: 0,
    sessionPath: SESSION,
    payload,
  });

  assert.deepEqual(out.state.settings.initialContextEstimateBySession[SESSION], {
    tokens: 12_345,
    contextWindow: 200_000,
  });
  assert.deepEqual(
    out.state.transcript.systemPromptsBySession[SESSION]?.map((entry) => ({
      id: entry.id,
      disabled: entry.disabled,
    })),
    [
      { id: 'provider', disabled: false },
      { id: 'skills', disabled: true },
      { id: 'tools', disabled: false },
    ],
  );
});

test('progressive catalog rows cannot erase hydrated model metadata in either arrival order', () => {
  const hydratedSummary = {
    path: SESSION,
    cwd: '/repo',
    name: 'Cold',
    modifiedAt: '2026-08-25T00:00:00.000Z',
    messageCount: 1,
    modelId: 'model-b',
    provider: 'mock',
    thinkingLevel: 'high' as const,
  };
  const catalogSummary = {
    path: SESSION,
    cwd: '/repo',
    name: 'Cold',
    modifiedAt: '2026-08-25T00:00:01.000Z',
    messageCount: 1,
  };
  const openedPayload: SessionOpenedPayload = {
    session: hydratedSummary,
    transcript: [],
    transcriptWindow: {
      totalCount: 0, loadedStart: 0, loadedEnd: 0,
      hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false,
    },
    busy: false,
    runtimeReady: false,
  };
  const openedEvent = {
    kind: 'SessionOpened' as const,
    backendGeneration: 0,
    modelWriteFence: 0,
    modelHydrationRevision: 0,
    catalogHydrationRevision: 0,
    sessionPath: SESSION,
    payload: openedPayload,
  };
  const catalogEvent = {
    kind: 'SessionListChanged' as const,
    sessionSummaries: [catalogSummary],
  };

  const openedThenCatalog = reducer(reducer(initialArchState, openedEvent).state, catalogEvent).state;
  const preserved = openedThenCatalog.sessions.sessions.find((session) => session.path === SESSION);
  assert.equal(preserved?.modifiedAt, catalogSummary.modifiedAt);
  assert.equal(preserved?.modelId, 'model-b');
  assert.equal(preserved?.provider, 'mock');
  assert.equal(preserved?.thinkingLevel, 'high');

  const catalogThenOpened = reducer(reducer(initialArchState, catalogEvent).state, openedEvent).state;
  assert.equal(catalogThenOpened.sessions.sessions[0]?.modelId, 'model-b');
  assert.equal(catalogThenOpened.sessions.sessions[0]?.provider, 'mock');
  assert.equal(catalogThenOpened.sessions.sessions[0]?.thinkingLevel, 'high');
});
