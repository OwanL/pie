/**
 * Capability projection overlay suppression (STATE_CONTRACT § Authoritative
 * Session Activity and Capabilities): the backend never originates the host
 * operation phase. RPC event validation accepts only the four inert backend
 * facts; an application-owned `primaryOperation` overlay is rejected at the
 * wire boundary and is added only by the host projection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { produce } from 'immer';

import { createInitialArchState } from '../../../../../application/backend/conversation-state/arch-state';
import { reducer } from '../../../../../application/backend/conversation-state/reducer';
import {
  settleSessionOperationSucceeded,
  startSessionOperation,
} from '../../../../../application/backend/conversation-state/operation-registry';
import { projectSessionCapabilities } from '../../../../../application/backend/conversation-state/projections/projection';
import { isAgentSettledPayload, isBusyChangedPayload } from '../../../../../harness/agent-processes/lib/rpc/event-payload-validation.js';
import type { SessionCapabilities } from '../../../../../application/lib/protocol/session-operation-projection.js';
import type { SessionCapabilityFacts } from '../../../../../harness/agent-processes/lib/rpc/session-capability-facts.js';

const SESSION = '/sessions/capability-overlay.jsonl';

const FACTS: SessionCapabilityFacts = {
  billableActivity: false,
  canContinue: true,
  canInterrupt: false,
  canCompact: true,
};

/** An application projection that must never be accepted as backend facts. */
const INJECTED_OVERLAY: SessionCapabilities = {
  ...FACTS,
  primaryOperation: {
    operationId: 'backend-injected',
    kind: 'message.send',
    phase: 'awaiting-commit',
    attempt: 1,
    committed: true,
    recovery: null,
  },
};

function startSendOperation(operationId: string) {
  return startSessionOperation({
    operationId,
    kind: 'message.send',
    source: { kind: 'host' },
    pendingPath: SESSION,
    selectionToken: operationId,
    backendGeneration: 5,
  });
}

function storedBackendCapabilities() {
  assert.equal(isBusyChangedPayload({ sessionPath: SESSION, busy: false, capabilities: INJECTED_OVERLAY }), false);
  assert.equal(isAgentSettledPayload({ sessionPath: SESSION, capabilities: INJECTED_OVERLAY }), false);
  assert.equal(isBusyChangedPayload({ sessionPath: SESSION, busy: false, capabilities: FACTS }), true);
  assert.equal(isAgentSettledPayload({ sessionPath: SESSION, capabilities: FACTS }), true);
  const state = reducer(createInitialArchState(), {
    kind: 'BusyChanged', sessionPath: SESSION, running: false,
    capabilities: FACTS,
  }).state;
  assert.deepEqual(state.sessions.capabilitiesBySession[SESSION], FACTS);
  return state;
}

test('wire validation accepts only capability facts and the projection keeps them unchanged', () => {
  const state = storedBackendCapabilities();

  // Only the four canonical backend facts survive; the injected overlay must
  // not appear as a reducer-owned UI operation.
  assert.deepEqual(projectSessionCapabilities(state)[SESSION], FACTS);
});

test('projection adds only the canonical reducer operation to backend capability facts', () => {
  const state = produce(storedBackendCapabilities(), (draft) => {
    draft.operations['host-op'] = startSendOperation('host-op');
  });

  const projected = projectSessionCapabilities(state)[SESSION];
  assert.equal(projected?.primaryOperation?.operationId, 'host-op');
  assert.equal(projected?.primaryOperation?.kind, 'message.send');
  assert.equal(projected?.primaryOperation?.phase, 'awaiting-acceptance');
  assert.equal(projected?.primaryOperation?.committed, false);
  assert.equal(projected?.primaryOperation?.recovery, null);
  // Backend facts are preserved under the operation overlay; the message
  // execution overlay still classifies the billable interrupt surface.
  assert.equal(projected?.billableActivity, true);
  assert.equal(projected?.canInterrupt, true);
});

test('a settled reducer operation is not restored from stored backend facts', () => {
  const settled = settleSessionOperationSucceeded(startSendOperation('host-op'), {
    pendingPath: SESSION,
    backendGeneration: 5,
  });
  assert.ok(settled, 'setup: the operation must settle');
  const state = produce(storedBackendCapabilities(), (draft) => {
    draft.operations['host-op'] = settled;
  });

  // Terminal operations are excluded from the overlay; only backend facts
  // remain in the projected payload.
  assert.deepEqual(projectSessionCapabilities(state)[SESSION], FACTS);
});
