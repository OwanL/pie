import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionService } from '../../../session-actions/service.js';
import { SessionServiceEvents } from '../../../session-actions/events.js';
import { createInitialArchState, type ArchState } from '../../../conversation-state/arch-state.js';
import { reducer } from '../../../conversation-state/reducer.js';
import { startSessionOperation } from '../../../conversation-state/operation-registry.js';
import type { SessionOpenedPayload } from '../../../../lib/protocol/sessions.js';
import type { SystemPromptEntry } from '../../../../../harness/agent-processes/lib/rpc/session-events.js';

test('retained open bridge preserves selection ownership and fences close, removal, and generation death', () => {
  const operation = startSessionOperation({ operationId: 'open', kind: 'session.open', source: { kind: 'host' },
    pendingPath: '/a', selectionToken: 'old-selection', backendGeneration: 7 });
  const initial = createInitialArchState();
  let arch: ArchState = { ...initial, operations: { open: operation },
    sessions: { ...initial.sessions, openTabPaths: ['/a', '/b'], activeSessionPath: '/b' } };
  let generation = 7;
  let epoch = 1;
  const request = { operationId: 'open', requestEpoch: 1, pendingPath: '/a',
    modelWriteFence: 0, modelHydrationRevision: 0, catalogHydrationRevision: 0 };
  const state = {
    getSelectionRequest: () => request,
    getSessionDataEpoch: () => epoch,
    getBackendGeneration: () => generation,
    isCurrentSelectionToken: () => false,
    markSessionSnapshotKnown: () => undefined,
    clearSessionRuntimeKnown: () => undefined,
    markSessionRuntimeKnown: () => undefined,
    touchSessionTranscript: () => undefined,
    evictInactiveTranscriptWindows: () => undefined,
    finishSelectionRequest: () => undefined,
    assertSelectionInvariant: () => undefined,
  };
  const dispatchArch = (event: Parameters<typeof reducer>[1]) => {
    arch = reducer(arch, event).state;
  };
  const runObserver = new Proxy({}, { get: () => () => undefined });
  const events = new SessionServiceEvents({
    platform: {} as never,
    scheduleRender: () => undefined,
    runObserver: runObserver as never,
    state: state as never,
    dispatchArch,
    getArchState: () => arch,
    triggers: {} as never,
    getBackendGeneration: () => generation,
  });
  let projectedCount = 0;
  const applyOpened = events.applySessionOpened.bind(events);
  events.applySessionOpened = (payload) => { projectedCount += 1; applyOpened(payload); };
  const host = { getArchState: () => arch, backend: { getGeneration: () => generation },
    state, events };
  const systemPrompts: SystemPromptEntry[] = [{ source: 'user', title: 'project', text: 'Project prompt',
    summary: 'Project prompt', availability: 'available', toggleable: true, disabled: false }];
  const snapshot: SessionOpenedPayload = { operationId: 'open', selectionToken: 'old-selection',
    runtimeReady: false, promptInventoryToken: 'inventory-token', busy: false,
    transcript: [], transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0,
      hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
    session: { path: '/a', name: 'A', cwd: '/', modifiedAt: '2026-10-17T00:00:00Z', messageCount: 0 } };
  const apply = () => SessionService.prototype.applyRetainedOpenSnapshot.call(host as unknown as SessionService, snapshot, 'open', 7);
  assert.equal(apply(), true);
  assert.deepEqual(arch.transcript.pendingPromptInventoryBySession?.['/a'], {
    token: 'inventory-token', backendGeneration: 7, modelWriteFence: arch.settings.modelWriteFence,
  }, 'retained snapshot is applied by the ordinary host SessionOpened projection');
  dispatchArch({ kind: 'SessionPromptInventory', backendGeneration: 7,
    payload: { sessionPath: '/a', token: 'inventory-token', systemPrompts } });
  assert.deepEqual(arch.transcript.systemPromptsBySession['/a'], systemPrompts,
    'later inventory carrying the retained snapshot token is accepted');
  assert.equal(arch.transcript.pendingPromptInventoryBySession?.['/a'], undefined);
  assert.equal(arch.sessions.activeSessionPath, '/b');
  arch = { ...arch, sessions: { ...arch.sessions, openTabPaths: ['/b'] } };
  assert.equal(apply(), false, 'removed tab is not resurrected');
  arch = { ...arch, sessions: { ...arch.sessions, openTabPaths: ['/a', '/b'] } };
  const close = startSessionOperation({ operationId: 'close', kind: 'session.close', source: { kind: 'host' },
    pendingPath: '/a', selectionToken: 'close-selection', backendGeneration: 7 });
  arch = { ...arch, operations: { ...arch.operations, close } };
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
  assert.equal(projectedCount, 1);
});
