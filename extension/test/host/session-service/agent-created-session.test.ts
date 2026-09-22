import assert from 'node:assert/strict';
import test from 'node:test';

import { createInitialArchState } from '../../../src/host/core/arch-state';
import { computeOpeningFlags } from '../../../src/host/session-service/handlers/attach';
import type { SessionOpenedPayload } from '../../../src/shared/protocol';

const AGENT_PATH = '/workspace/agent-created.jsonl';

function payload(overrides: Partial<SessionOpenedPayload> = {}): SessionOpenedPayload {
  return {
    session: {
      path: AGENT_PATH,
      name: 'New Session',
      cwd: '/workspace',
      modifiedAt: new Date(0).toISOString(),
      messageCount: 0,
      agentCreated: true,
    },
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
    ...overrides,
  };
}

test('agent-created creation event inserts a tab without changing selection', () => {
  const archState = createInitialArchState();
  archState.sessions.activeSessionPath = '/workspace/current.jsonl';
  archState.sessions.openTabPaths = ['/workspace/current.jsonl'];
  const state = {
    getSelectionRequest: () => undefined,
    getBackendGeneration: () => 1,
    isCurrentSelectionToken: () => false,
  };
  const flags = computeOpeningFlags(payload({ agentCreated: true }), {
    getArchState: () => archState,
    state,
  } as any);

  assert.equal(flags.shouldOpenTab, true);
  assert.equal(flags.shouldActivate, false);
});

test('explicit selection of an agent-created session follows normal activation', () => {
  const archState = createInitialArchState();
  archState.sessions.activeSessionPath = '/workspace/current.jsonl';
  archState.sessions.openTabPaths = ['/workspace/current.jsonl'];
  const state = {
    getSelectionRequest: () => ({ pendingPath: AGENT_PATH }),
    getBackendGeneration: () => 1,
    isCurrentSelectionToken: (token?: string) => token === 'select-agent',
  };
  const flags = computeOpeningFlags(payload({ selectionToken: 'select-agent' }), {
    getArchState: () => archState,
    state,
  } as any);

  assert.equal(flags.shouldOpenTab, true);
  assert.equal(flags.shouldActivate, true);
});

test('non-create session events do not reopen a closed agent-created tab', () => {
  const archState = createInitialArchState();
  const state = {
    getSelectionRequest: () => undefined,
    getBackendGeneration: () => 1,
    isCurrentSelectionToken: () => false,
  };
  const flags = computeOpeningFlags(payload(), {
    getArchState: () => archState,
    state,
  } as any);

  assert.equal(flags.shouldOpenTab, false);
  assert.equal(flags.shouldActivate, false);
});
