import test from 'node:test';
import assert from 'node:assert/strict';
import { initialArchState, reducer, type ArchState } from '../../../conversation-state/reducer';
import { dispatchSessionBackendEvent } from '../../../conversation-state/event-dispatch';
import type { SystemPromptEntry } from '../../../../lib/protocol/index.js';

const sessionPath = '/cold.jsonl';
const estimate = { tokens: 123, contextWindow: 32_000 };
const prompts: SystemPromptEntry[] = [
  {
    id: 'provider', source: 'provider', title: 'Provider prompt', text: 'Full provider prompt text',
    summary: 'Provider summary', availability: 'available', disabled: false, toggleable: false,
  },
  {
    id: 'skills', source: 'harness', title: 'Skills', text: 'Full skills prompt text',
    summary: 'Skills summary', availability: 'available', disabled: true, toggleable: true,
  },
];

function opened(state: ArchState = initialArchState, token: string | undefined = 'a', runtimeReady = false) {
  return reducer(state, { kind: 'SessionOpened', sessionPath, backendGeneration: 0, modelWriteFence: 0,
    modelHydrationRevision: 0, catalogHydrationRevision: 0, payload: {
      session: { path: sessionPath, cwd: '/workspace', name: 'Cold', modifiedAt: '', messageCount: 0 },
      transcript: [], transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
      busy: false, runtimeReady, promptInventoryToken: token,
    } }).state;
}
function receive(state: ArchState, token = 'a', systemPrompts = prompts, backendGeneration = 0) {
  return reducer(state, { kind: 'SessionPromptInventory', backendGeneration,
    payload: { sessionPath, token, systemPrompts, initialContextEstimate: estimate } }).state;
}
test('cold inline opened estimate emits history lookup but hot snapshots do not', () => {
  for (const runtimeReady of [false, true]) {
    const result = reducer(cold(), { kind: 'SessionOpened', sessionPath, backendGeneration: 0, modelWriteFence: 0,
      modelHydrationRevision: 0, catalogHydrationRevision: 0, payload: {
        session: { path: sessionPath, cwd: '/workspace', name: 'Cold', modifiedAt: '', messageCount: 0 },
        transcript: [], busy: false, runtimeReady,
        initialContextEstimate: { ...estimate, cohortKey: 'inline' },
      } });
    assert.equal(result.effects.some((effect) => effect.kind === 'ReadInitialContextHistory'), !runtimeReady);
    if (runtimeReady) assert.equal(result.state.settings.initialContextEstimateBySession[sessionPath], null);
  }
});

test('history lookup emits fresh cohort ownership and rejects stale results', () => {
  const result = reducer(cold(), { kind: 'SessionPromptInventory', backendGeneration: 0,
    payload: { sessionPath, token: 'a', systemPrompts: prompts, initialContextEstimate: { ...estimate, cohortKey: 'cohort' } } });
  assert.deepEqual(result.effects, [{ kind: 'ReadInitialContextHistory', sessionPath, cohortKey: 'cohort', backendGeneration: 0, modelWriteFence: 0 }]);
  const stats = { medianTokens: 90, p25Tokens: 80, p75Tokens: 100 };
  const event = { kind: 'InitialContextHistoryResult' as const, sessionPath, cohortKey: 'cohort', backendGeneration: 0, modelWriteFence: 0, stats };
  assert.deepEqual(reducer(result.state, event).state.settings.initialContextEstimateBySession[sessionPath]?.afterPruning, stats);
  assert.equal(reducer(result.state, { ...event, stats: undefined }).state, result.state);
  for (const state of [
    { ...result.state, settings: { ...result.state.settings, modelWriteFence: 1 } },
    { ...result.state, settings: { ...result.state.settings, modelBackendGeneration: 1 } },
    { ...result.state, settings: { ...result.state.settings, initialContextEstimateBySession: { [sessionPath]: null } } },
    { ...result.state, settings: { ...result.state.settings, initialContextEstimateBySession: { [sessionPath]: { ...estimate, cohortKey: 'new' } } } },
    { ...result.state, sessions: { ...result.state.sessions, openTabPaths: [] } },
    { ...result.state, sessions: { ...result.state.sessions, runningSessionPaths: [sessionPath] } },
    { ...result.state, settings: { ...result.state.settings, contextUsageBySession: { [sessionPath]: { tokens: 1, contextWindow: 100, percent: 1 } } } },
  ]) assert.equal(reducer(state, event).state, state);
});

function cold() {
  const state = opened();
  return { ...state, sessions: { ...state.sessions, openTabPaths: [sessionPath] } };
}

test('inventory is one-shot and preserves transcript/window/live/session identity', () => {
  const state = cold();
  const next = receive(state);
  assert.equal(next.transcript.bySession, state.transcript.bySession);
  assert.equal(next.transcript.windowBySession, state.transcript.windowBySession);
  assert.equal(next.livePipeline, state.livePipeline);
  assert.equal(next.sessions, state.sessions);
  assert.deepEqual(next.transcript.systemPromptsBySession[sessionPath], prompts);
  assert.deepEqual(next.settings.initialContextEstimateBySession[sessionPath], estimate);
  assert.equal(receive(next), next);
});

test('an authoritative empty inventory clears stale prompt entries', () => {
  const state = {
    ...cold(),
    transcript: { ...cold().transcript, systemPromptsBySession: { [sessionPath]: prompts } },
  };
  const next = reducer(state, { kind: 'SessionPromptInventory', backendGeneration: 0,
    payload: { sessionPath, token: 'a', systemPrompts: [] } }).state;
  assert.deepEqual(next.transcript.systemPromptsBySession[sessionPath], []);
  assert.equal(next.settings.initialContextEstimateBySession[sessionPath], null);
});

test('initial estimate is suppressed by any user history or observed usage', () => {
  const base = cold();
  const states: ArchState[] = [
    { ...base, transcript: { ...base.transcript, bySession: { [sessionPath]: [{ id: 'user', role: 'user' } as never] } } },
    { ...base, transcript: { ...base.transcript, windowBySession: { [sessionPath]: { ...base.transcript.windowBySession[sessionPath]!, hasUserMessages: true } } } },
    { ...base, settings: { ...base.settings, contextUsageBySession: { [sessionPath]: { tokens: 1, contextWindow: 100, percent: 1 } } } },
    { ...base, transcript: { ...base.transcript, sessionUsageBySession: { [sessionPath]: { samples: [{}] } as never } } },
  ];
  for (const state of states) {
    assert.equal(receive(state).settings.initialContextEstimateBySession[sessionPath], null);
  }
});

test('stalled/reordered inventories cannot replace newer ownership', () => {
  const state = opened(cold(), 'b');
  assert.equal(receive(state, 'a'), state);
  assert.equal(state.transcript.pendingPromptInventoryBySession?.[sessionPath]?.token, 'b');
  assert.equal(receive(state, 'b').transcript.pendingPromptInventoryBySession?.[sessionPath], undefined);
});

test('hot opened and tokenless reopened snapshots retire old ownership', () => {
  for (const state of [opened(cold(), ''), opened(cold(), '', true)]) {
    assert.equal(receive(state), state);
  }
});

test('closed, running, model-changed and optimistic-send sessions reject inventory', () => {
  const base = cold();
  const states: ArchState[] = [
    { ...base, sessions: { ...base.sessions, openTabPaths: [] } },
    { ...base, sessions: { ...base.sessions, runningSessionPaths: [sessionPath] } },
    { ...base, settings: { ...base.settings, modelWriteFence: 1 } },
    { ...base, settings: { ...base.settings, modelBackendGeneration: 1 } },
    reducer(base, { kind: 'Command', cmd: { kind: 'Send', corrId: 'send', sessionPath, text: 'Hi', inputs: [], composedText: 'Hi', localId: 'local:send', previousSummary: null, timestamp: 1000 } }).state,
    reducer(base, { kind: 'Command', cmd: { kind: 'SetSystemPromptToggles', corrId: 'toggle', sessionPath, disabledEntries: [] } }).state,
  ];
  for (const state of states) {
    const next = receive(state);
    assert.equal(next.transcript.systemPromptsBySession, state.transcript.systemPromptsBySession);
    assert.equal(next.transcript.pendingPromptInventoryBySession?.[sessionPath], undefined);
  }
});

test('old backend generations are rejected', () => {
  const state = { ...cold(), settings: { ...cold().settings, modelBackendGeneration: 1 } };
  assert.equal(receive(state, 'a', prompts, 0).transcript.systemPromptsBySession, state.transcript.systemPromptsBySession);
});

test('close cleanup and reopen invalidate results from the previous scope', () => {
  const pending = cold();
  const closed = reducer(pending, { kind: 'SessionClosed', sessionPath }).state;
  assert.equal(closed.transcript.pendingPromptInventoryBySession?.[sessionPath], undefined);
  let reopened = opened(closed, 'new-token');
  reopened = { ...reopened, sessions: { ...reopened.sessions, openTabPaths: [sessionPath] } };
  assert.equal(receive(reopened, 'a'), reopened);
  assert.equal(reopened.transcript.pendingPromptInventoryBySession?.[sessionPath]?.token, 'new-token');
});

test('guarded backend dispatch sends valid inventory to reducer and drops malformed payloads', () => {
  let state = cold();
  const handlers = {
    onSessionPromptInventory: (payload: { sessionPath: string; token: string; systemPrompts: SystemPromptEntry[]; initialContextEstimate?: typeof estimate }) => {
      state = reducer(state, { kind: 'SessionPromptInventory', backendGeneration: 0, payload }).state;
    },
  };
  const dispatch = (payload: unknown) => dispatchSessionBackendEvent(
    { event: 'session.promptInventory', payload } as Parameters<typeof dispatchSessionBackendEvent>[0],
    handlers as Parameters<typeof dispatchSessionBackendEvent>[1],
  );
  dispatch({ sessionPath, token: 'a', systemPrompts: prompts, initialContextEstimate: estimate });
  assert.deepEqual(state.transcript.systemPromptsBySession[sessionPath], prompts);
  const afterValid = state;
  dispatch({ sessionPath, token: 'a', systemPrompts: [{ ...prompts[0], disabled: 'yes' }] });
  assert.equal(state, afterValid);
});

test('snapshotUnavailable with a pending inventory token preserves the previous catalog', () => {
  const base = cold();
  const withOldCatalog = {
    ...base,
    transcript: { ...base.transcript, systemPromptsBySession: { [sessionPath]: prompts } },
  };
  const result = reducer(withOldCatalog, {
    kind: 'SessionOpened', sessionPath, backendGeneration: 0, modelWriteFence: 0,
    modelHydrationRevision: 0, catalogHydrationRevision: 0,
    payload: {
      session: { path: sessionPath, cwd: '/workspace', name: 'Cold', modifiedAt: '', messageCount: 0 },
      transcript: [], transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
      busy: false, runtimeReady: false, promptInventoryToken: 'new-token',
      snapshotUnavailable: { code: 'SESSION_SNAPSHOT_TOO_LARGE', message: 'Lossless snapshot unavailable.' },
    },
  }).state;
  assert.deepEqual(result.transcript.systemPromptsBySession[sessionPath], prompts);
  assert.equal(result.transcript.pendingPromptInventoryBySession?.[sessionPath], undefined);
});
