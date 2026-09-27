import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, createInitialArchState } from '../../../conversation-state/reducer';

const SESSION = '/workspace/session.jsonl';
const LOCAL_ID = 'local:agent-session:request-1';

function dispatch(state: ReturnType<typeof createInitialArchState>, event: Parameters<typeof reducer>[1]) {
  return reducer(state, event).state;
}

test('agent-originated idle prompts become tagged user transcript rows', () => {
  const state = dispatch(createInitialArchState(), {
    kind: 'AgentMessageReceived',
    sessionPath: SESSION,
    localId: LOCAL_ID,
    text: 'please inspect this session',
    status: 'completed',
    timestamp: 1_800_000_000_000,
  });
  const [row] = state.transcript.bySession[SESSION] ?? [];

  assert.equal(row?.id, LOCAL_ID);
  assert.equal(row?.role, 'user');
  assert.equal(row?.markdown, 'please inspect this session');
  assert.equal(row?.customType, 'agent-message');
  assert.equal(row?.status, 'completed');
});

test('an idle session-open snapshot cannot erase an agent row awaiting SDK persistence', () => {
  const state = dispatch(createInitialArchState(), {
    kind: 'AgentMessageReceived',
    sessionPath: SESSION,
    localId: LOCAL_ID,
    text: 'wake the cold session',
    status: 'completed',
    timestamp: 1_800_000_000_000,
  });
  const opened = reducer(state, {
    kind: 'SessionOpened',
    sessionPath: SESSION,
    backendGeneration: 0,
    modelWriteFence: 0,
    modelHydrationRevision: 0,
    catalogHydrationRevision: 0,
    payload: {
      session: { path: SESSION, name: 'Session', cwd: '/workspace', modifiedAt: '', messageCount: 0 },
      transcript: [],
      transcriptWindow: {
        totalCount: 0, loadedStart: 0, loadedEnd: 0,
        hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false,
      },
      busy: false,
    },
  }).state;

  assert.equal(opened.transcript.bySession[SESSION]?.[0]?.id, LOCAL_ID);
  assert.equal(opened.transcript.bySession[SESSION]?.[0]?.customType, 'agent-message');
});

test('direct send acceptance reconciles an optimistic queued agent row to completed', () => {
  let state = dispatch(createInitialArchState(), {
    kind: 'AgentMessageReceived',
    sessionPath: SESSION,
    localId: LOCAL_ID,
    text: 'direct instruction',
    status: 'queued',
    timestamp: 1_800_000_000_000,
  });
  state = dispatch(state, {
    kind: 'AgentMessageReceived',
    sessionPath: SESSION,
    localId: LOCAL_ID,
    text: 'direct instruction',
    status: 'completed',
    timestamp: 1_800_000_000_001,
  });

  const rows = state.transcript.bySession[SESSION] ?? [];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, 'completed');
  assert.equal(rows[0]?.customType, 'agent-message');
});

test('queued agent rows are promoted by exact delivery identity and duplicate events do not downgrade them', () => {
  let state = dispatch(createInitialArchState(), {
    kind: 'AgentMessageReceived',
    sessionPath: SESSION,
    localId: LOCAL_ID,
    text: 'queued instruction',
    status: 'queued',
    timestamp: 1_800_000_000_000,
  });
  state = dispatch(state, {
    kind: 'QueuedDelivered', sessionPath: SESSION, localId: LOCAL_ID, text: 'queued instruction',
  });
  state = dispatch(state, {
    kind: 'AgentMessageReceived',
    sessionPath: SESSION,
    localId: LOCAL_ID,
    text: 'queued instruction',
    status: 'queued',
    timestamp: 1_800_000_000_001,
  });

  const rows = state.transcript.bySession[SESSION] ?? [];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, 'completed');
  assert.equal(rows[0]?.customType, 'agent-message');

  state = dispatch(state, { kind: 'AgentMessageRejected', sessionPath: SESSION, localId: LOCAL_ID });
  assert.deepEqual(state.transcript.bySession[SESSION], []);
});
