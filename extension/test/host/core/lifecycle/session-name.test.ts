import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialArchState } from '../../../../src/host/core/arch-state';
import { selectViewState } from '../../../../src/host/core/projection';
import { reducer } from '../../../../src/host/core/reducer';
import {
  deriveSessionNameFromText,
  MAX_SESSION_NAME_LENGTH,
  NEW_SESSION_NAME,
} from '../../../../src/shared/session-name';

const SESSION_PATH = '/ws/session.jsonl';

function stateWithPlaceholder() {
  const state = createInitialArchState();
  state.sessions.sessions.push({
    path: SESSION_PATH,
    name: NEW_SESSION_NAME,
    cwd: '/ws',
    modifiedAt: '2026-08-30T00:00:00.000Z',
    messageCount: 0,
    isPlaceholder: true,
  });
  return state;
}

test('blank input remains New Session', () => {
  assert.deepEqual(deriveSessionNameFromText('   \n\t  '), {
    name: NEW_SESSION_NAME,
    isPlaceholder: true,
  });
});

test('uses a normalized literal snippet instead of a semantic heuristic', () => {
  assert.deepEqual(deriveSessionNameFromText('  please   investigate\nwhy auth fails  '), {
    name: 'please investigate why auth fails',
    isPlaceholder: true,
  });
});

test('truncates long prompt snippets to the tab-name budget', () => {
  const result = deriveSessionNameFromText(
    'I wonder if we could improve the title sessions get assigned to easily, what do you think?',
  );
  assert.equal(result.name, 'I wonder if we could improve the title…');
  assert.ok(result.name.length <= MAX_SESSION_NAME_LENGTH);
  assert.equal(result.isPlaceholder, true);
});

test('SessionNameDerived arms LLM generation while keeping the snippet replaceable', () => {
  const result = reducer(stateWithPlaceholder(), {
    kind: 'SessionNameDerived',
    sessionPath: SESSION_PATH,
    name: 'Investigate intermittent login failures…',
    isPlaceholder: true,
    sourcePrompt: 'Investigate intermittent login failures for invited users.',
  });
  const summary = result.state.sessions.sessions[0];
  assert.equal(summary.name, 'Investigate intermittent login failures…');
  assert.equal(summary.isPlaceholder, true);
  assert.deepEqual(result.state.sessions.titleGenerationBySession[SESSION_PATH], {
    status: 'armed',
    prompt: 'Investigate intermittent login failures for invited users.',
  });
});

test('disabled LLM titles leave only the prompt snippet', () => {
  const state = stateWithPlaceholder();
  state.settings.sessionTitlesSettings.enabled = false;
  const result = reducer(state, {
    kind: 'SessionNameDerived',
    sessionPath: SESSION_PATH,
    name: 'Explain OAuth2 refresh token rotation',
    isPlaceholder: true,
    sourcePrompt: 'Explain OAuth2 refresh token rotation.',
  });
  assert.equal(result.state.sessions.sessions[0].name, 'Explain OAuth2 refresh token rotation');
  assert.equal(result.state.sessions.titleGenerationBySession[SESSION_PATH], undefined);
});

test('the first assistant start launches title generation and projects a spinner', () => {
  const state = stateWithPlaceholder();
  state.sessions.activeSessionPath = SESSION_PATH;
  state.sessions.openTabPaths = [SESSION_PATH];
  state.sessions.titleGenerationBySession[SESSION_PATH] = {
    status: 'armed',
    prompt: 'Investigate why invited users cannot log in.',
  };
  assert.deepEqual(selectViewState(state).generatingTitleSessionPaths, [SESSION_PATH]);

  const result = reducer(state, {
    kind: 'MessageStarted',
    sessionPath: SESSION_PATH,
    messageId: 'assistant-1',
    requestId: 'request-1',
    timestamp: 1,
  });
  assert.deepEqual(result.state.sessions.titleGenerationBySession[SESSION_PATH], {
    status: 'pending',
    prompt: 'Investigate why invited users cannot log in.',
    corrId: 'request-1',
  });
  assert.deepEqual(result.effects.find((effect) => effect.kind === 'GenerateSessionTitle'), {
    kind: 'GenerateSessionTitle',
    corrId: 'request-1',
    sessionPath: SESSION_PATH,
    prompt: 'Investigate why invited users cannot log in.',
    provider: 'ollama',
    model: 'deepseek-v4-flash:0731-cloud',
    thinkingLevel: 'off',
    timeoutSec: 15,
  });
});

test('the sequenced live turn commit also launches title generation exactly once', () => {
  const state = stateWithPlaceholder();
  state.sessions.titleGenerationBySession[SESSION_PATH] = {
    status: 'armed',
    prompt: 'Investigate why invited users cannot log in.',
  };
  const result = reducer(state, {
    kind: 'TurnSemanticEventReceived',
    envelope: {
      protocolVersion: 7,
      sessionPath: SESSION_PATH,
      requestId: 'request-live',
      turnId: 'turn-live',
      attemptId: 'attempt-live',
      occurredAt: 100,
      checkpointBytes: 30 * 1024 * 1024,
      kind: 'turn.started',
      seq: 1,
      canonicalMessageId: 'assistant-live',
      modelId: 'provider/model',
      thinkingLevel: 'high',
      startedAt: 90,
    },
  });
  assert.equal(result.state.sessions.titleGenerationBySession[SESSION_PATH]?.status, 'pending');
  assert.equal(result.effects.filter((effect) => effect.kind === 'GenerateSessionTitle').length, 1);
});

test('a generated title replaces the snippet and clears its spinner', () => {
  const state = stateWithPlaceholder();
  state.sessions.activeSessionPath = SESSION_PATH;
  state.sessions.openTabPaths = [SESSION_PATH];
  state.sessions.titleGenerationBySession[SESSION_PATH] = {
    status: 'pending',
    prompt: 'Investigate why invited users cannot log in.',
    corrId: 'request-1',
  };
  const result = reducer(state, {
    kind: 'SessionTitleResult',
    sessionPath: SESSION_PATH,
    corrId: 'request-1',
    ok: true,
    generated: true,
    name: 'Investigate Invited User Login',
  });
  assert.equal(result.state.sessions.sessions[0].name, 'Investigate Invited User Login');
  assert.equal(result.state.sessions.sessions[0].isPlaceholder, false);
  assert.equal(result.state.sessions.titleGenerationBySession[SESSION_PATH], undefined);
  assert.deepEqual(selectViewState(result.state).generatingTitleSessionPaths, []);
});

test('a late generated result cannot overwrite an explicit/manual name', () => {
  const state = stateWithPlaceholder();
  state.sessions.sessions[0].name = 'Manual Incident Name';
  state.sessions.sessions[0].isPlaceholder = false;
  state.sessions.titleGenerationBySession[SESSION_PATH] = {
    status: 'pending',
    prompt: 'Investigate why invited users cannot log in.',
    corrId: 'request-1',
  };
  const result = reducer(state, {
    kind: 'SessionTitleResult',
    sessionPath: SESSION_PATH,
    corrId: 'request-1',
    ok: true,
    generated: true,
    name: 'Investigate Invited User Login',
  });
  assert.equal(result.state.sessions.sessions[0].name, 'Manual Incident Name');
  assert.equal(result.state.sessions.titleGenerationBySession[SESSION_PATH], undefined);
});

test('a stale title result with a retired correlation is ignored', () => {
  const state = stateWithPlaceholder();
  state.sessions.titleGenerationBySession[SESSION_PATH] = {
    status: 'pending',
    prompt: 'Use the newest attempt.',
    corrId: 'request-2',
  };
  const result = reducer(state, {
    kind: 'SessionTitleResult',
    sessionPath: SESSION_PATH,
    corrId: 'request-1',
    ok: true,
    generated: true,
    name: 'Stale Generated Title',
  });
  assert.equal(result.state.sessions.sessions[0].name, NEW_SESSION_NAME);
  assert.equal(result.state.sessions.titleGenerationBySession[SESSION_PATH]?.corrId, 'request-2');
});

test('a title failure keeps the snippet and stops its spinner', () => {
  const state = stateWithPlaceholder();
  state.sessions.activeSessionPath = SESSION_PATH;
  state.sessions.openTabPaths = [SESSION_PATH];
  state.sessions.sessions[0].name = 'Investigate why invited users cannot…';
  state.sessions.titleGenerationBySession[SESSION_PATH] = {
    status: 'pending',
    prompt: 'Investigate why invited users cannot log in.',
    corrId: 'request-1',
  };
  const result = reducer(state, {
    kind: 'SessionTitleResult',
    sessionPath: SESSION_PATH,
    corrId: 'request-1',
    ok: false,
    error: 'timeout',
  });
  assert.equal(result.state.sessions.sessions[0].name, 'Investigate why invited users cannot…');
  assert.equal(result.state.sessions.titleGenerationBySession[SESSION_PATH]?.status, 'failed');
  assert.deepEqual(selectViewState(result.state).generatingTitleSessionPaths, []);
});
