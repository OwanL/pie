import assert from 'node:assert/strict';
import test from 'node:test';

import { createInitialArchState } from '../../../src/host/core/arch-state';
import { reducer } from '../../../src/host/core/reducer';
import type { ArchState } from '../../../src/host/core/arch-state';
import type { Event } from '../../../src/host/core/events';
import type { RunObserver } from '../../../src/host/stats-service';
import type { SessionSummary, ThinkingLevel } from '../../../src/shared/protocol';
import type { TurnSemanticEnvelope } from '../../../src/shared/live-pipeline-protocol';

// The shared serving-identity reconciliation mirroring legacy `message.started`
// behavior onto the live semantic `turn.started` path (session-service/events.ts
// → handlers/streaming.ts `reconcileServingModelConfig`).
import { reconcileServingModelConfig } from '../../../src/host/session-service/handlers/streaming';

const SESSION = '/workspace/live.jsonl';

function baseState(): ArchState {
  const state = createInitialArchState();
  const summary: SessionSummary = {
    path: SESSION,
    name: SESSION,
    cwd: '/workspace',
    modifiedAt: '2024-01-01T00:00:00.000Z',
    messageCount: 1,
  };
  return {
    ...state,
    settings: {
      ...state.settings,
      backendReady: true,
      // Stale global default the composer would fall back to without summary
      // reconciliation. A provider shares the model id with another provider
      // to prove the exact provider is reconciled, not just the id.
      modelSettings: { defaultModel: 'stale-default', defaultProvider: 'other-provider', defaultThinkingLevel: 'off' },
    },
    sessions: {
      ...state.sessions,
      sessions: [summary],
      openTabPaths: [SESSION],
      activeSessionPath: SESSION,
    },
  };
}

function turnStartedEnvelope(): Extract<TurnSemanticEnvelope, { kind: 'turn.started' }> {
  return {
    protocolVersion: 7,
    sessionPath: SESSION,
    requestId: 'request-1',
    turnId: 'turn-1',
    attemptId: 'attempt-1',
    seq: 1,
    occurredAt: 1_000,
    checkpointBytes: 64,
    kind: 'turn.started',
    canonicalMessageId: 'request-1:1',
    modelId: 'gpt-4o',
    provider: 'azure-openai',
    thinkingLevel: 'high',
    startedAt: 900,
  };
}

type RecordedModelConfig = {
  sessionPath: string;
  modelId: string | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  provider: string | undefined;
};

function reconcilerDeps(stateRef: { current: ArchState }) {
  const modelConfigChanges: RecordedModelConfig[] = [];
  const dispatched: Event[] = [];
  const runObserver = {
    onModelConfigChanged: (
      sessionPath: string,
      modelId: string | undefined,
      thinkingLevel: ThinkingLevel | undefined,
      provider?: string,
    ) => {
      modelConfigChanges.push({ sessionPath, modelId, thinkingLevel, provider });
    },
  } as unknown as RunObserver;
  const deps = {
    runObserver,
    getArchState: () => stateRef.current,
    dispatchArch: (event: Event) => {
      dispatched.push(event);
      // Mutate the shared ref exactly like ExtensionHost.dispatchArchEvent
      // (effects are not executed; the exercised paths emit none).
      stateRef.current = reducer(stateRef.current, event).state;
    },
  };
  return { deps, modelConfigChanges, dispatched };
}

test('applied live turn.started reconciles the exact serving identity into the session summary', () => {
  const stateRef = { current: baseState() };
  const { deps, modelConfigChanges, dispatched } = reconcilerDeps(stateRef);

  // The reducer owns the UI badge and applies it atomically with the accepted
  // live owner; the session service then mirrors that identity to analytics.
  stateRef.current = reducer(stateRef.current, {
    kind: 'TurnSemanticEventReceived',
    envelope: turnStartedEnvelope(),
  }).state;
  const summaryAfterApply = stateRef.current.sessions.sessions.find((s) => s.path === SESSION);
  assert.equal(summaryAfterApply?.modelId, 'gpt-4o');
  assert.equal(summaryAfterApply?.provider, 'azure-openai');
  assert.equal(summaryAfterApply?.thinkingLevel, 'high');

  reconcileServingModelConfig(
    turnStartedEnvelope().sessionPath,
    'gpt-4o',
    'high',
    'azure-openai',
    deps,
  );

  // Run-observer model config receives the exact serving provider, model id,
  // and thinking level from the turn (billing identity for this exact turn).
  assert.equal(modelConfigChanges.length, 1);
  assert.equal(modelConfigChanges[0]!.sessionPath, SESSION);
  assert.equal(modelConfigChanges[0]!.modelId, 'gpt-4o');
  assert.equal(modelConfigChanges[0]!.provider, 'azure-openai');
  assert.equal(modelConfigChanges[0]!.thinkingLevel, 'high');

  // The session summary now carries the serving identity, so the composer
  // resolves this model instead of falling back to the stale global default.
  const summary = stateRef.current.sessions.sessions.find((s) => s.path === SESSION);
  assert.equal(summary?.modelId, 'gpt-4o');
  assert.equal(summary?.provider, 'azure-openai');
  assert.equal(summary?.thinkingLevel, 'high');

  assert.equal(
    dispatched.filter((event) => event.kind === 'SessionMetadataChanged').length,
    0,
    'the service does not need a second badge write after reducer reconciliation',
  );
});

test('a rejected conflicting turn.started cannot replace the accepted serving identity', () => {
  let state = baseState();
  state = reducer(state, { kind: 'TurnSemanticEventReceived', envelope: turnStartedEnvelope() }).state;
  state = reducer(state, {
    kind: 'TurnSemanticEventReceived',
    envelope: {
      ...turnStartedEnvelope(),
      requestId: 'request-conflict',
      turnId: 'turn-conflict',
      attemptId: 'attempt-conflict',
      canonicalMessageId: 'request-conflict:1',
      modelId: 'claude-opus-5',
      provider: 'github-copilot',
      thinkingLevel: 'xhigh',
    },
  }).state;

  const summary = state.sessions.sessions.find((session) => session.path === SESSION);
  assert.equal(summary?.modelId, 'gpt-4o');
  assert.equal(summary?.provider, 'azure-openai');
  assert.equal(summary?.thinkingLevel, 'high');
});

test('serving-identity reconciliation is idempotent for replayed turn.started events', () => {
  const stateRef = { current: baseState() };
  const { deps, modelConfigChanges, dispatched } = reconcilerDeps(stateRef);

  reconcileServingModelConfig(SESSION, 'gpt-4o', 'high', 'azure-openai', deps);
  reconcileServingModelConfig(SESSION, 'gpt-4o', 'high', 'azure-openai', deps);

  assert.equal(modelConfigChanges.length, 2, 'observer update mirrors every start (legacy parity)');
  const metadataEvents = dispatched.filter((event) => event.kind === 'SessionMetadataChanged');
  assert.equal(metadataEvents.length, 1, 'a matching summary is not written again');
});

test('reconciliation without a serving model id never dispatches summary metadata', () => {
  const stateRef = { current: baseState() };
  const { deps, modelConfigChanges, dispatched } = reconcilerDeps(stateRef);

  reconcileServingModelConfig(SESSION, undefined, undefined, undefined, deps);

  assert.equal(modelConfigChanges.length, 1);
  assert.equal(dispatched.filter((event) => event.kind === 'SessionMetadataChanged').length, 0);
  const summary = stateRef.current.sessions.sessions.find((s) => s.path === SESSION);
  assert.equal(summary?.modelId, undefined, 'no invented model badge');
  assert.equal(summary?.provider, undefined);
});