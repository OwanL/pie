import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchHostMessage } from '../../../src/webview/panel/hooks/use-host-sync';
import { PIE_BUILD_ID, WEBVIEW_PROTOCOL_VERSION, type HostToWebviewMessage, type ViewState } from '../../../src/shared/protocol';

test('a queued background draft survives a same-host session switch', () => {
  const queuedDrafts = new Map<string, string>();
  let restoredDraft: string | null = null;
  let clearQueuedCalls = 0;
  let transientClears = 0;
  let inputRestoreCalls = 0;

  const ctx = {
    hydrateViewState: (state: ViewState) => state,
    resetPerSessionState: () => undefined,
    hostInstanceIdRef: { current: 'host-1' },
    viewGenerationRef: { current: 1 },
    lastRevisionRef: { current: 1 },
    activeSessionPathRef: { current: '/session/a' },
    committedSessionPathRef: { current: '/session/a' },
    compatibilityFailedRef: { current: false },
    onCompatibilityMismatch: () => undefined,
    clearTransientUi: () => { transientClears += 1; },
    optimisticOps: {
      clear: () => undefined,
      reconcileWithHostIds: () => undefined,
      removeByLocalId: () => undefined,
      removeBySessionPath: () => undefined,
    },
    draftOps: {
      applyQueued: (sessionPath: string) => {
        const draft = queuedDrafts.get(sessionPath);
        if (draft === undefined) return false;
        queuedDrafts.delete(sessionPath);
        restoredDraft = draft;
        return true;
      },
      clearQueued: () => {
        clearQueuedCalls += 1;
        queuedDrafts.clear();
      },
      queueForSession: (sessionPath: string, text: string) => queuedDrafts.set(sessionPath, text),
      restoreNow: (text: string) => { restoredDraft = text; },
    },
    inputsOps: {
      restoreNow: () => { inputRestoreCalls += 1; },
      clear: () => undefined,
    },
    setViewState: () => undefined,
    setCommitTarget: () => undefined,
    setInlineConfirm: () => undefined,
    postMessage: () => undefined,
  };

  dispatchHostMessage({
    type: 'sendRejected',
    sessionPath: '/session/b',
    localId: 'local:background',
    text: 'background draft',
    inputs: [{
      id: 'background-input',
      kind: 'filesystemPathRef',
      path: '/background-file',
      name: 'background-file',
      source: 'picker',
    }],
  }, ctx);

  assert.equal(restoredDraft, null, 'the active session draft is untouched');
  assert.equal(inputRestoreCalls, 0, 'background inputs are not projected into the active composer');
  assert.equal(queuedDrafts.get('/session/b'), 'background draft');

  const nextState = {
    activeSession: {
      path: '/session/b',
      name: 'Session B',
      cwd: '/workspace',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 0,
    },
    openTabPaths: ['/session/a', '/session/b'],
    transcript: [],
    transcriptWindow: { start: 0, end: 0, total: 0, hasOlder: false, hasNewer: false },
  } as unknown as ViewState;
  const stateMessage: HostToWebviewMessage = {
    type: 'state',
    protocolVersion: WEBVIEW_PROTOCOL_VERSION,
    buildId: PIE_BUILD_ID,
    hostInstanceId: 'host-1',
    rendererId: 'renderer-1',
    rendererGeneration: 1,
    viewGeneration: 1,
    revision: 2,
    expectedTranscriptIdentity: 'empty-session-b',
    snapshotBytes: 100,
    state: nextState,
  };

  dispatchHostMessage(stateMessage, ctx);

  assert.equal(transientClears, 1, 'session-local transient UI is reset');
  assert.equal(clearQueuedCalls, 0, 'same-host navigation preserves queued background drafts');
  assert.equal(restoredDraft, 'background draft');
  assert.equal(queuedDrafts.has('/session/b'), false);
});

test('protocol or build skew latches before hydration, evidence, revision, or later imperatives', () => {
  for (const mismatch of [
    { protocolVersion: WEBVIEW_PROTOCOL_VERSION + 1, buildId: PIE_BUILD_ID },
    { protocolVersion: WEBVIEW_PROTOCOL_VERSION, buildId: 'stale-build' },
  ]) {
    let hydrated = 0;
    let compatibilityFailures = 0;
    let stateUpdates = 0;
    let posted = 0;
    let restoredDrafts = 0;
    const compatibilityFailedRef = { current: false };
    const lastRevisionRef = { current: 4 };
    const ctx = {
      hydrateViewState: (state: ViewState) => { hydrated += 1; return state; },
      resetPerSessionState: () => undefined,
      hostInstanceIdRef: { current: 'host-1' },
      viewGenerationRef: { current: 1 },
      lastRevisionRef,
      activeSessionPathRef: { current: '/session/a' },
      committedSessionPathRef: { current: '/session/a' },
      compatibilityFailedRef,
      onCompatibilityMismatch: () => { compatibilityFailures += 1; },
      clearTransientUi: () => undefined,
      optimisticOps: {
        clear: () => undefined,
        reconcileWithHostIds: () => undefined,
        removeByLocalId: () => undefined,
        removeBySessionPath: () => undefined,
      },
      draftOps: {
        applyQueued: () => false,
        clearQueued: () => undefined,
        queueForSession: () => undefined,
        restoreNow: () => { restoredDrafts += 1; },
      },
      inputsOps: { restoreNow: () => undefined, clear: () => undefined },
      setViewState: () => { stateUpdates += 1; },
      setCommitTarget: () => undefined,
      setInlineConfirm: () => undefined,
      postMessage: () => { posted += 1; },
    };
    const state = {
      activeSession: null,
      openTabPaths: [],
      transcript: [],
      transcriptWindow: { start: 0, end: 0, total: 0, hasOlder: false, hasNewer: false },
    } as unknown as ViewState;

    dispatchHostMessage({
      type: 'state',
      ...mismatch,
      hostInstanceId: 'host-1',
      rendererId: 'renderer-1',
      rendererGeneration: 1,
      viewGeneration: 1,
      revision: 5,
      expectedTranscriptIdentity: 'incompatible',
      snapshotBytes: 100,
      state,
    }, ctx);
    dispatchHostMessage({ type: 'sendRejected', sessionPath: '/session/a', text: 'must not apply' }, ctx);

    assert.equal(compatibilityFailedRef.current, true);
    assert.equal(compatibilityFailures, 1);
    assert.equal(hydrated, 0);
    assert.equal(stateUpdates, 0, 'the last compatible UI state is preserved');
    assert.equal(posted, 0, 'no stateReceived evidence acknowledges incompatible state');
    assert.equal(lastRevisionRef.current, 4);
    assert.equal(restoredDrafts, 0, 'later imperatives are ignored after the terminal fence');
  }
});
