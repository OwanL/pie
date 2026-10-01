import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialArchState } from '../../../conversation-state/arch-state';
import { reducer } from '../../../conversation-state/reducer';
import { evictSession } from '../../../conversation-state/reducers/helpers';
import { resolveChatPrefs } from '../../../../lib/protocol/settings.js';

test('session-control settings requests are reducer-owned and correlated through the acknowledgement effect', () => {
  const base = createInitialArchState();
  const request = {
    requestId: 'settings-request-1',
    sessionPath: '/sessions/root.jsonl',
    action: 'apply' as const,
    settings: { autonomousMode: true, subagentProviderChoices: { anthropic: false } },
  };
  const initial = {
    ...base,
    sessions: { ...base.sessions, sessions: [{ path: request.sessionPath } as any] },
  };
  const requested = reducer(initial, {
    kind: 'Command',
    cmd: { kind: 'SessionControlSettingsRequest', corrId: request.requestId, request },
  });
  assert.deepEqual(requested.effects, [{
    kind: 'SessionControlSettingsRpc',
    corrId: request.requestId,
    request,
  }]);

  const completed = reducer(requested.state, {
    kind: 'SessionControlSettingsResult',
    corrId: request.requestId,
    request,
    acknowledgement: {
      requestId: request.requestId,
      sessionPath: request.sessionPath,
      action: 'apply',
      outcome: 'succeeded',
      settings: { autonomousMode: true, subagentProviderChoices: { anthropic: false } },
      application: 'applied',
    },
    persistedPrefs: {
      autonomousModeBySession: { [request.sessionPath]: true },
      subagentProviderTogglesBySession: { [request.sessionPath]: { anthropic: false } },
    },
  });
  assert.equal(completed.state.settings.prefs.autonomousModeBySession?.[request.sessionPath], true);
  assert.equal(completed.state.settings.prefs.subagentProviderTogglesBySession[request.sessionPath]?.anthropic, false);
  assert.deepEqual(completed.effects, [{
    kind: 'SessionControlSettingsBridgeAck',
    corrId: request.requestId,
    acknowledgement: {
      requestId: request.requestId,
      sessionPath: request.sessionPath,
      action: 'apply',
      outcome: 'succeeded',
      settings: { autonomousMode: true, subagentProviderChoices: { anthropic: false } },
      application: 'applied',
    },
  }]);
});

test('session-control settings requests are rejected while their live session is closing', () => {
  const base = createInitialArchState();
  const sessionPath = '/sessions/closing.jsonl';
  const state = {
    ...base,
    sessions: { ...base.sessions, sessions: [{ path: sessionPath } as any] },
    operations: {
      'close-operation': {
        operationId: 'close-operation',
        kind: 'session.close' as const,
        session: { pendingPath: sessionPath },
      },
    },
  } as unknown as typeof base;
  const result = reducer(state, {
    kind: 'Command',
    cmd: {
      kind: 'SessionControlSettingsRequest',
      corrId: 'settings-request-2',
      request: { requestId: 'settings-request-2', sessionPath, action: 'capture' },
    },
  });
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'SessionControlSettingsBridgeAck');
  assert.equal(result.effects[0]?.kind === 'SessionControlSettingsBridgeAck'
    ? result.effects[0].acknowledgement.outcome
    : undefined, 'failed');
});

test('session-control settings requests are rejected for sessions absent from the live host session list', () => {
  const result = reducer(createInitialArchState(), {
    kind: 'Command',
    cmd: {
      kind: 'SessionControlSettingsRequest',
      corrId: 'settings-request-not-live',
      request: {
        requestId: 'settings-request-not-live',
        sessionPath: '/sessions/not-live.jsonl',
        action: 'capture',
      },
    },
  });
  assert.equal(result.effects[0]?.kind, 'SessionControlSettingsBridgeAck');
  assert.equal(result.effects[0]?.kind === 'SessionControlSettingsBridgeAck'
    ? result.effects[0].acknowledgement.error
    : undefined, 'The target session is not live.');
});

test('private session eviction removes durable autonomous and subagent overrides', () => {
  const base = createInitialArchState();
  const sessionPath = '/sessions/private.jsonl';
  const state = {
    ...base,
    settings: {
      ...base.settings,
      prefs: resolveChatPrefs({
        autonomousModeBySession: { [sessionPath]: true },
        subagentProviderTogglesBySession: { [sessionPath]: { openai: false } },
      }),
    },
  };
  const result = evictSession(state, sessionPath, { removeSummary: true, removeTabs: true });
  assert.equal(result.state.settings.prefs.autonomousModeBySession?.[sessionPath], undefined);
  assert.equal(result.state.settings.prefs.subagentProviderTogglesBySession[sessionPath], undefined);
  const clear = result.effects.find((effect) => effect.kind === 'SetPrefsRpc');
  assert.ok(clear);
  assert.equal(clear?.kind === 'SetPrefsRpc'
    ? Object.hasOwn(clear.prefs.autonomousModeBySession ?? {}, sessionPath)
    : false, true);
  assert.equal(clear?.kind === 'SetPrefsRpc'
    ? Object.hasOwn(clear.prefs.subagentProviderTogglesBySession ?? {}, sessionPath)
    : false, true);
});
