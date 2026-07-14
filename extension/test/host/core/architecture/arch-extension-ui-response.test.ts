import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';
import type { ExtensionUIRequestPayload, ExtensionUIResponsePayload } from '../../../../src/shared/protocol';

/**
 * A pending extension UI request seeded into state. Keyed under the session
 * path with the request's own id, mirroring how `RequestExtensionUI` events
 * populate `pendingExtensionUIRequestsBySession`.
 */
const pendingRequest: ExtensionUIRequestPayload = {
  id: 'req-1',
  sessionPath: '/session/a',
  method: 'confirm',
  title: 'Proceed?',
  message: 'Allow the extension to continue?',
};

/** State with a single pending extension UI request for `/session/a`. */
function stateWithPendingRequest(): ArchState {
  return {
    ...initialArchState,
    settings: {
      ...initialArchState.settings,
      pendingExtensionUIRequestsBySession: {
        '/session/a': { 'req-1': pendingRequest },
      },
    },
  };
}

function dispatchRespond(approved: boolean): Event {
  const response: ExtensionUIResponsePayload = {
    id: 'req-1',
    confirmed: approved,
  };
  return {
    kind: 'Command',
    cmd: {
      kind: 'RespondExtensionUI',
      corrId: 'c-eui',
      sessionPath: '/session/a',
      requestId: 'req-1',
      approved,
      response,
    },
  };
}

test('reducer: RespondExtensionUI with approved=true emits only ExtensionUiResponseRpc (no PostImperative)', () => {
  const result = reducer(stateWithPendingRequest(), dispatchRespond(true));

  assert.equal(result.effects.length, 1, 'exactly one effect should be emitted');
  assert.deepEqual(result.effects[0], {
    kind: 'ExtensionUiResponseRpc',
    corrId: 'c-eui',
    sessionPath: '/session/a',
    response: { id: 'req-1', confirmed: true },
  });
  assert.notEqual(result.effects[0]?.kind, 'PostImperative');
});

test('reducer: RespondExtensionUI with approved=false emits only ExtensionUiResponseRpc (no PostImperative)', () => {
  const result = reducer(stateWithPendingRequest(), dispatchRespond(false));

  assert.equal(result.effects.length, 1, 'exactly one effect should be emitted');
  assert.deepEqual(result.effects[0], {
    kind: 'ExtensionUiResponseRpc',
    corrId: 'c-eui',
    sessionPath: '/session/a',
    response: { id: 'req-1', confirmed: false },
  });
  assert.notEqual(result.effects[0]?.kind, 'PostImperative');
});

test('reducer: RespondExtensionUI (approved) removes the pending request from state', () => {
  const result = reducer(stateWithPendingRequest(), dispatchRespond(true));

  assert.deepEqual(result.state.settings.pendingExtensionUIRequestsBySession, {});
});

test('reducer: RespondExtensionUI (denied) removes the pending request from state', () => {
  const result = reducer(stateWithPendingRequest(), dispatchRespond(false));

  assert.deepEqual(result.state.settings.pendingExtensionUIRequestsBySession, {});
});

test('reducer: failed ExtensionUiResponseResult restores the exact pending request', () => {
  const optimistic = reducer(stateWithPendingRequest(), dispatchRespond(true));
  assert.equal(optimistic.state.pending.extensionUiResponseByCorrId['c-eui']?.request.id, 'req-1');
  const failed = reducer(optimistic.state, {
    kind: 'ExtensionUiResponseResult', corrId: 'c-eui', sessionPath: '/session/a', ok: false, error: 'backend unavailable',
  });
  assert.deepEqual(failed.state.settings.pendingExtensionUIRequestsBySession['/session/a']?.['req-1'], pendingRequest);
  assert.equal(failed.state.pending.extensionUiResponseByCorrId['c-eui'], undefined);
  assert.equal(failed.effects[0]?.kind, 'Log');
});

test('reducer: successful ExtensionUiResponseResult clears the rollback snapshot', () => {
  const optimistic = reducer(stateWithPendingRequest(), dispatchRespond(true));
  const succeeded = reducer(optimistic.state, {
    kind: 'ExtensionUiResponseResult', corrId: 'c-eui', sessionPath: '/session/a', ok: true,
  });
  assert.equal(succeeded.state.pending.extensionUiResponseByCorrId['c-eui'], undefined);
});

test('reducer: RespondExtensionUI keeps the session entry while other pending requests remain', () => {
  // Two distinct requests on the same session; respond to one, the other stays.
  const state: ArchState = {
    ...initialArchState,
    settings: {
      ...initialArchState.settings,
      pendingExtensionUIRequestsBySession: {
        '/session/a': {
          'req-1': pendingRequest,
          'req-2': { ...pendingRequest, id: 'req-2', title: 'Another?' },
        },
      },
    },
  };

  const result = reducer(state, dispatchRespond(true));

  const sessionMap = result.state.settings.pendingExtensionUIRequestsBySession['/session/a'];
  assert.ok(sessionMap, 'session entry should remain while other requests live');
  assert.deepEqual(Object.keys(sessionMap), ['req-2']);
});
