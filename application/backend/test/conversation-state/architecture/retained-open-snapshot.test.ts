import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionService } from '../../../session-actions/service.js';
import { createInitialArchState } from '../../../conversation-state/arch-state.js';
import { startSessionOperation } from '../../../conversation-state/operation-registry.js';
import type { SessionOpenedPayload } from '../../../../lib/protocol/sessions.js';

test('retained open bridge preserves selection ownership and fences close, removal, and generation death', () => {
  const operation = startSessionOperation({ operationId: 'open', kind: 'session.open', source: { kind: 'host' },
    pendingPath: '/a', selectionToken: 'old-selection', backendGeneration: 7 });
  const initial = createInitialArchState();
  let arch = { ...initial, operations: { open: operation },
    sessions: { ...initial.sessions, openTabPaths: ['/a', '/b'], activeSessionPath: '/b' } };
  let generation = 7;
  let epoch = 1;
  const projected: SessionOpenedPayload[] = [];
  const host = { getArchState: () => arch, backend: { getGeneration: () => generation },
    state: { getSelectionRequest: () => ({ operationId: 'open', requestEpoch: 1 }),
      getSessionDataEpoch: () => epoch },
    events: { applySessionOpened: (payload: SessionOpenedPayload) => projected.push(payload) } };
  const snapshot = { operationId: 'open', operationAttempt: 1, selectionToken: 'old-selection',
    session: { path: '/a' } } as SessionOpenedPayload;
  const apply = () => SessionService.prototype.applyRetainedOpenSnapshot.call(host as unknown as SessionService, snapshot, 'open', 7);
  assert.equal(apply(), true);
  assert.equal(projected[0], snapshot, 'ordinary projection receives unchanged original correlation');
  assert.equal(arch.sessions.activeSessionPath, '/b');
  arch = { ...arch, sessions: { ...arch.sessions, openTabPaths: ['/b'] } };
  assert.equal(apply(), false, 'removed tab is not resurrected');
  arch = { ...arch, sessions: { ...arch.sessions, openTabPaths: ['/a', '/b'] } };
  const close = startSessionOperation({ operationId: 'close', kind: 'session.close', source: { kind: 'host' },
    pendingPath: '/a', selectionToken: 'close-selection', backendGeneration: 7 });
  arch = { ...arch, operations: { ...arch.operations, close } } as typeof arch;
  assert.equal(apply(), false, 'close reservation wins before tab removal');
  arch = { ...arch, operations: { open: operation } };
  epoch = 2;
  assert.equal(apply(), false, 'close/reopen cannot consume the old retained snapshot');
  epoch = 1;
  generation = 8;
  assert.equal(apply(), false);
  generation = 7;
  arch = { ...arch, operations: { open: { ...operation, backendGeneration: 8 } } };
  assert.equal(apply(), false);
  assert.equal(projected.length, 1);
});
