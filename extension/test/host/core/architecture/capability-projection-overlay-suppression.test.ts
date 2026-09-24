/**
 * Capability projection overlay suppression (STATE_CONTRACT § Authoritative
 * Session Activity and Capabilities): the backend never originates the host
 * operation phase, yet event validation accepts an optional `primaryOperation`
 * overlay on capability payloads and the reducer stores those payloads
 * verbatim. The pure projection must strip any backend-supplied overlay and
 * expose `primaryOperation` only from the reducer-owned non-terminal
 * operation — never from stored facts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { produce } from 'immer';

import { createInitialArchState } from '../../../../src/host/core/arch-state';
import { reducer } from '../../../../src/host/core/reducer';
import {
  settleSessionOperationSucceeded,
  startSessionOperation,
} from '../../../../src/host/core/operation-registry';
import { projectSessionCapabilities } from '../../../../src/host/core/projection';
import { isAgentSettledPayload, isBusyChangedPayload } from '../../../../src/shared/protocol/event-payloads';
import type { SessionCapabilities, SessionCapabilityFacts } from '../../../../src/shared/protocol';

const SESSION = '/sessions/capability-overlay.jsonl';

const FACTS: SessionCapabilityFacts = {
  billableActivity: false,
  canContinue: true,
  canInterrupt: false,
  canCompact: true,
};

/** A backend capability payload whose optional operation overlay passed wire
 *  validation and was stored verbatim by the reducer. Distinguishing fields
 *  (operation id, kind, phase, committed) make a leak unambiguous. */
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

function storedInjectedCapabilities() {
  // Wire validation accepts the capability payload; the reducer then stores it
  // verbatim. Projection, not ingress, strips the injected operation field.
  assert.equal(isBusyChangedPayload({ sessionPath: SESSION, busy: false, capabilities: INJECTED_OVERLAY }), true);
  assert.equal(isAgentSettledPayload({ sessionPath: SESSION, capabilities: INJECTED_OVERLAY }), true);
  const state = reducer(createInitialArchState(), {
    kind: 'BusyChanged', sessionPath: SESSION, running: false,
    capabilities: INJECTED_OVERLAY,
  }).state;
  assert.deepEqual(state.sessions.capabilitiesBySession[SESSION], INJECTED_OVERLAY);
  return state;
}

test('projection suppresses a backend-injected primaryOperation when no reducer operation exists', () => {
  const state = storedInjectedCapabilities();

  // Only the four canonical backend facts survive; the injected overlay must
  // not appear as a reducer-owned UI operation.
  assert.deepEqual(projectSessionCapabilities(state)[SESSION], FACTS);
});

test('projection keeps the canonical reducer operation authoritative over an injected overlay', () => {
  const state = produce(storedInjectedCapabilities(), (draft) => {
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

test('a settled reducer operation does not leak an injected backend overlay', () => {
  const settled = settleSessionOperationSucceeded(startSendOperation('host-op'), {
    pendingPath: SESSION,
    backendGeneration: 5,
  });
  assert.ok(settled, 'setup: the operation must settle');
  const state = produce(storedInjectedCapabilities(), (draft) => {
    draft.operations['host-op'] = settled;
  });

  // Terminal operations are excluded from the overlay, and the stored facts
  // must not resurrect the injected overlay in their place.
  assert.deepEqual(projectSessionCapabilities(state)[SESSION], FACTS);
});
