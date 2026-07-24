import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateAndMaterializeComposerInput,
  modelSupportsInputKind,
  type GetArchState,
  type DispatchArchEvent,
} from '../../../../src/host/core/composer';
import { createInitialArchState } from '../../../../src/host/core/arch-state';
import type { ArchState } from '../../../../src/host/core/arch-state';
import { reducer } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';

const NOOP_RENDER = () => {};
const NOOP_OBSERVER = {
  onAssistantTurnStarted: () => {},
  onBusyChanged: () => {},
  onContextUsageChanged: () => {},
  onInterrupted: () => {},
  onBackendError: () => {},
  onTruncatedAfter: () => {},
  onMessageEdited: () => {},
  onModelConfigChanged: () => {},
  prepareForSend: () => {},
  onSessionClosed: () => {},
  onUnsupportedInputAttempt: () => {},
  onSessionCompleted: () => {},
  startNewTask: () => {},
  continueTask: () => {},
} as any;

function makeGetArchState(state: ArchState): GetArchState {
  return () => state;
}

function makeDispatchArchEvent(stateRef: { current: ArchState }): DispatchArchEvent {
  return (event: Event) => {
    const result = reducer(stateRef.current, event);
    stateRef.current = result.state;
  };
}

test('validateAndMaterializeComposerInput accepts imageBlob when model supports images', () => {
  let state = createInitialArchState();
  state = {
    ...state,
    sessions: {
      ...state.sessions,
      sessions: [
        { path: '/s', name: 'S', cwd: '/', modifiedAt: '', messageCount: 0, modelId: 'gpt-4o' },
      ],
    },
    settings: {
      ...state.settings,
      availableModelsBySession: {
        '/s': [{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', reasoning: false, inputKinds: ['text', 'image'] }],
      },
    },
  };

  const stateRef = { current: state };
  const getArchState = makeGetArchState(state);
  const dispatchArchEvent = makeDispatchArchEvent(stateRef);

  const input = validateAndMaterializeComposerInput(
    '/s',
    {
      kind: 'imageBlob',
      mimeType: 'image/png',
      name: 'test.png',
      sizeBytes: 1024,
      dataBase64: 'iVBORw0KGgo=',
      source: 'paste',
    },
    () => 'input-1',
    NOOP_RENDER,
    NOOP_OBSERVER,
    getArchState,
    dispatchArchEvent,
  );

  assert.ok(input, 'imageBlob should be accepted when model supports images');
  assert.equal(input?.kind, 'imageBlob');
});

test('host rejects an attachment immediately when aggregate raw image bytes exceed 20 MiB', () => {
  let state = createInitialArchState();
  const image = (name: string) => ({
    kind: 'imageBlob' as const, mimeType: 'image/png', name, sizeBytes: 7 * 1024 * 1024,
    dataBase64: 'abc', source: 'paste' as const,
  });
  for (const [index, name] of ['one.png', 'two.png', 'three.png'].entries()) {
    state = reducer(state, {
      kind: 'Command',
      cmd: { kind: 'AddComposerInput', corrId: `c${index}`, sessionPath: '/s', input: image(name) },
    }).state;
  }
  assert.equal(state.composer.pendingComposerInputsBySession['/s']?.length, 2);
  assert.match(state.settings.notice ?? '', /aggregate image size exceeds/);
});

test('validateAndMaterializeComposerInput rejects imageBlob when model does not support images', () => {
  let state = createInitialArchState();
  state = {
    ...state,
    sessions: {
      ...state.sessions,
      sessions: [
        { path: '/s', name: 'S', cwd: '/', modifiedAt: '', messageCount: 0, modelId: 'text-only' },
      ],
    },
    settings: {
      ...state.settings,
      availableModelsBySession: {
        '/s': [{ id: 'text-only', name: 'TextOnly', provider: 'openai', reasoning: false, inputKinds: ['text'] }],
      },
    },
  };

  const stateRef = { current: state };
  const getArchState = makeGetArchState(state);
  const dispatchArchEvent = makeDispatchArchEvent(stateRef);

  const input = validateAndMaterializeComposerInput(
    '/s',
    {
      kind: 'imageBlob',
      mimeType: 'image/png',
      name: 'test.png',
      sizeBytes: 1024,
      dataBase64: 'iVBORw0KGgo=',
      source: 'paste',
    },
    () => 'input-1',
    NOOP_RENDER,
    NOOP_OBSERVER,
    getArchState,
    dispatchArchEvent,
  );

  assert.equal(input, null);
  assert.equal(stateRef.current.settings.notice, 'The selected model does not support image inputs.');
});
