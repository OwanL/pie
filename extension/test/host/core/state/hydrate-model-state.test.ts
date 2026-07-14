/**
 * Pin the host-side HydrateModel behavior. `hydrateModelState` fetches the
 * backend settings + available models and syncs the global `modelSettings`
 * read-only via `ModelSettingsHydrated` when they differ from ArchState. It
 * must NOT dispatch `SetModel` (a user model-switch that persists + switches
 * the session's live model) — that previously tripped the backend's
 * busy-session guard with a spurious REQUEST_IN_PROGRESS error whenever a
 * session ran a non-default model, and would have clobbered the per-session
 * model. The per-session model badge is owned by the session summary, not by
 * hydrate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialArchState } from '../../../../src/host/core/arch-state';
import type { ArchState } from '../../../../src/host/core/arch-state';
import { reducer } from '../../../../src/host/core/reducer';
import { SessionServiceState } from '../../../../src/host/session-service/state';
import { SessionMessageActions } from '../../../../src/host/session-service/message-actions';
import type { ModelInfo, ModelSettings, SessionSummary } from '../../../../src/shared/protocol';
import type { Event } from '../../../../src/host/core/events';

function createExtensionContext(): any {
  return {
    globalState: { update: async () => undefined },
    workspaceState: { update: async () => undefined },
  };
}

function fakeBackend(responses: Record<string, unknown>) {
  return {
    request: async (method: string, _params?: unknown) => {
      if (method in responses) {
        return responses[method];
      }
      throw new Error(`unexpected backend request: ${method}`);
    },
  } as any;
}

function setupArchState(modelSettings: ModelSettings, summary: SessionSummary): ArchState {
  return {
    ...createInitialArchState(),
    settings: {
      ...createInitialArchState().settings,
      modelSettings,
    },
    sessions: {
      ...createInitialArchState().sessions,
      sessions: [summary],
      openTabPaths: [summary.path],
      activeSessionPath: summary.path,
    },
  };
}

test('hydrateModelState skips ModelSettingsHydrated when backend settings already match ArchState', async () => {
  const SESSION = '/workspace/session.jsonl';
  const modelSettings: ModelSettings = { defaultModel: 'umans-kimi-k2.7', defaultThinkingLevel: 'medium' };
  const summary: SessionSummary = {
    path: SESSION,
    name: 'Session',
    cwd: '/workspace',
    modifiedAt: '2024-01-01T00:00:00.000Z',
    messageCount: 1,
    modelId: 'umans-kimi-k2.7',
    thinkingLevel: 'medium',
  };

  let archState = setupArchState(modelSettings, summary);
  const getArchState = () => archState;
  const dispatched: Event[] = [];
  const dispatchArch = (event: Event) => {
    dispatched.push(event);
    archState = reducer(archState, event).state;
  };

  const context = createExtensionContext();
  const models: ModelInfo[] = [{ id: 'umans-kimi-k2.7', provider: 'umans', name: 'Kimi K2.7', reasoning: true, inputKinds: ['text'] }];
  const backend = fakeBackend({ 'settings.get': modelSettings, 'models.list': models });
  const state = new SessionServiceState(context, backend, () => undefined, getArchState, dispatchArch, 0);
  const messages = new SessionMessageActions({
    context,
    backend,
    scheduleRender: () => undefined,
    state,
    createNewSession: () => '',
    getArchState,
    dispatchArch,
  });

  await messages.hydrateModelState(SESSION);

  const setModelCmd = dispatched.find((e) => e.kind === 'Command' && e.cmd.kind === 'SetModel');
  assert.equal(setModelCmd, undefined, 'SetModel should never be dispatched by hydrate');

  const hydrated = dispatched.find((e) => e.kind === 'ModelSettingsHydrated');
  assert.equal(hydrated, undefined, 'ModelSettingsHydrated should be skipped when already in sync');

  const availableModelsEvent = dispatched.find(
    (e) => e.kind === 'AvailableModelsChanged' && e.sessionPath === SESSION,
  );
  assert.ok(availableModelsEvent, 'AvailableModelsChanged should still be dispatched');
});

test('hydrateModelState dispatches ModelSettingsHydrated (not SetModel) when global default differs from ArchState', async () => {
  const SESSION = '/workspace/session.jsonl';
  const currentSettings: ModelSettings = { defaultModel: 'umans-glm-5.2', defaultThinkingLevel: 'low' };
  const backendSettings: ModelSettings = { defaultModel: 'umans-kimi-k2.7', defaultThinkingLevel: 'medium' };
  // The session runs a per-session model (glm-5.2) that differs from the new
  // global default (kimi-k2.7). Hydrate must sync the global default without
  // forcing the session to switch models.
  const summary: SessionSummary = {
    path: SESSION,
    name: 'Session',
    cwd: '/workspace',
    modifiedAt: '2024-01-01T00:00:00.000Z',
    messageCount: 1,
    modelId: 'umans-glm-5.2',
    thinkingLevel: 'low',
  };

  let archState = setupArchState(currentSettings, summary);
  const getArchState = () => archState;
  const dispatched: Event[] = [];
  const dispatchArch = (event: Event) => {
    dispatched.push(event);
    archState = reducer(archState, event).state;
  };

  const context = createExtensionContext();
  const models: ModelInfo[] = [{ id: 'umans-kimi-k2.7', provider: 'umans', name: 'Kimi K2.7', reasoning: true, inputKinds: ['text'] }];
  const backend = fakeBackend({ 'settings.get': backendSettings, 'models.list': models });
  const state = new SessionServiceState(context, backend, () => undefined, getArchState, dispatchArch, 0);
  const messages = new SessionMessageActions({
    context,
    backend,
    scheduleRender: () => undefined,
    state,
    createNewSession: () => '',
    getArchState,
    dispatchArch,
  });

  await messages.hydrateModelState(SESSION);

  const setModelCmd = dispatched.find((e) => e.kind === 'Command' && e.cmd.kind === 'SetModel');
  assert.equal(setModelCmd, undefined, 'SetModel should never be dispatched by hydrate (would clobber per-session model)');

  const hydrated = dispatched.find((e) => e.kind === 'ModelSettingsHydrated');
  assert.ok(hydrated && hydrated.kind === 'ModelSettingsHydrated', 'ModelSettingsHydrated should be dispatched when global default differs');
  if (hydrated && hydrated.kind === 'ModelSettingsHydrated') {
    assert.equal(hydrated.modelSettings.defaultModel, 'umans-kimi-k2.7');
    assert.equal(hydrated.modelSettings.defaultThinkingLevel, 'medium');
  }

  // The per-session model badge must be left untouched.
  const updatedSummary = getArchState().sessions.sessions.find((s) => s.path === SESSION);
  assert.equal(updatedSummary?.modelId, 'umans-glm-5.2', 'per-session model badge must not be clobbered by hydrate');
});

test('hydrateModelState skips ModelSettingsHydrated when summary has no per-session model yet but global settings match', async () => {
  const SESSION = '/workspace/session.jsonl';
  const modelSettings: ModelSettings = { defaultModel: 'umans-kimi-k2.7', defaultThinkingLevel: 'medium' };
  const summary: SessionSummary = {
    path: SESSION,
    name: 'Session',
    cwd: '/workspace',
    modifiedAt: '2024-01-01T00:00:00.000Z',
    messageCount: 1,
  };

  let archState = setupArchState(modelSettings, summary);
  const getArchState = () => archState;
  const dispatched: Event[] = [];
  const dispatchArch = (event: Event) => {
    dispatched.push(event);
    archState = reducer(archState, event).state;
  };

  const context = createExtensionContext();
  const models: ModelInfo[] = [{ id: 'umans-kimi-k2.7', provider: 'umans', name: 'Kimi K2.7', reasoning: true, inputKinds: ['text'] }];
  const backend = fakeBackend({ 'settings.get': modelSettings, 'models.list': models });
  const state = new SessionServiceState(context, backend, () => undefined, getArchState, dispatchArch, 0);
  const messages = new SessionMessageActions({
    context,
    backend,
    scheduleRender: () => undefined,
    state,
    createNewSession: () => '',
    getArchState,
    dispatchArch,
  });

  await messages.hydrateModelState(SESSION);

  const setModelCmd = dispatched.find((e) => e.kind === 'Command' && e.cmd.kind === 'SetModel');
  assert.equal(setModelCmd, undefined, 'SetModel should never be dispatched by hydrate');

  const hydrated = dispatched.find((e) => e.kind === 'ModelSettingsHydrated');
  assert.equal(hydrated, undefined, 'ModelSettingsHydrated should be skipped when global settings already match');
});
