import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialArchState } from '../../../../src/host/core/arch-state';
import type { ArchState } from '../../../../src/host/core/arch-state';
import { selectViewState } from '../../../../src/host/core/projection';
import type { ModelInfo, SessionSummary } from '../../../../src/shared/protocol';

const ACTIVE = '/workspace/loading.jsonl';
const KNOWN = '/workspace/ready.jsonl';
const PENDING = '__pending__:1';

const KNOWN_MODEL: ModelInfo = {
  id: 'claude-sonnet',
  name: 'Claude Sonnet',
  provider: 'anthropic',
  reasoning: true,
  thinkingLevels: ['off', 'low', 'high'],
  inputKinds: ['text'],
};

function summary(path: string): SessionSummary {
  return {
    path,
    name: path,
    cwd: '/workspace',
    modifiedAt: '2024-01-01T00:00:00.000Z',
    messageCount: 0,
  };
}

function stateWith(
  activePath: string,
  availableModelsBySession: Record<string, ModelInfo[]>,
  availableModelsStatusBySession: Record<string, 'provisional' | 'loading' | 'authoritative'>,
): ArchState {
  const state = createInitialArchState();
  return {
    ...state,
    settings: {
      ...state.settings,
      backendReady: true,
      availableModelsBySession,
      availableModelsStatusBySession,
    },
    sessions: {
      ...state.sessions,
      sessions: [summary(ACTIVE), summary(KNOWN)],
      openTabPaths: [ACTIVE, KNOWN],
      activeSessionPath: activePath,
    },
  };
}

test('borrowed-catalog projection keeps the picker supplied while the active catalog is provisional and empty', () => {
  // The host opened the active tab before any catalog for it existed; another
  // real open tab already has the only usable catalog the host knows.
  const borrowed = selectViewState(stateWith(
    ACTIVE,
    { [KNOWN]: [KNOWN_MODEL], [ACTIVE]: [] },
    { [KNOWN]: 'authoritative', [ACTIVE]: 'provisional' },
  ));

  assert.equal(borrowed.availableModels.length, 1);
  assert.equal(borrowed.availableModels[0]!.id, KNOWN_MODEL.id);
  assert.equal(borrowed.availableModels[0]!.provider, KNOWN_MODEL.provider);
  // The status still describes the active session's own catalog freshness.
  assert.equal(borrowed.availableModelsStatus, 'provisional');
});

test('borrowed-catalog projection prefers an open real tab and serves a loading session', () => {
  const view = selectViewState(stateWith(
    ACTIVE,
    { [KNOWN]: [KNOWN_MODEL] },
    { [KNOWN]: 'authoritative' },
  ));

  // No own entry at all → 'loading'; borrowing keeps the picker interactive
  // instead of collapsing to a non-interactive chip while hydration runs.
  assert.equal(view.availableModelsStatus, 'loading');
  assert.deepEqual(view.availableModels, [KNOWN_MODEL]);
});

test('borrowed-catalog projection never overrides an authoritative empty catalog', () => {
  // A successful hydration proved the active session has no usable models.
  // This authoritative result must not be replaced by someone else's catalog.
  const view = selectViewState(stateWith(
    ACTIVE,
    { [KNOWN]: [KNOWN_MODEL], [ACTIVE]: [] },
    { [KNOWN]: 'authoritative', [ACTIVE]: 'authoritative' },
  ));

  assert.deepEqual(view.availableModels, []);
  assert.equal(view.availableModelsStatus, 'authoritative');
});

test('borrowed-catalog projection returns empty when the host knows no usable catalog', () => {
  const view = selectViewState(stateWith(
    ACTIVE,
    {},
    {},
  ));

  assert.deepEqual(view.availableModels, []);
  assert.equal(view.availableModelsStatus, 'loading');
});

test('borrowed-catalog projection ignores pending pseudo-path catalogs as sources', () => {
  const view = selectViewState(stateWith(
    ACTIVE,
    { [PENDING]: [KNOWN_MODEL], [ACTIVE]: [] },
    { [PENDING]: 'provisional', [ACTIVE]: 'provisional' },
  ));

  assert.deepEqual(view.availableModels, []);
});