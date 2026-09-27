import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchHostMessage } from '../../lib/hooks/use-host-sync';
import type { HostToWebviewMessage, LazyDetailRef, ViewState, WebviewToHostMessage } from '../../../lib/protocol/index.js';
import { PIE_BUILD_ID } from '../../../../lib/build-identity.js';
import { WEBVIEW_PROTOCOL_VERSION } from '../../../lib/protocol/envelopes.js';
import {
  clearLazyDetailCache,
  receiveLazyDetailResult,
  requestLazyDetail,
  setLazyDetailPostMessage,
} from '../../transcript/lazy-detail-store';

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
    rendererIdentityRef: { current: { rendererId: 'renderer-1', rendererGeneration: 1 } },
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
    sessions: [],
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

test('protocol skew latches before hydration, evidence, revision, or later imperatives', () => {
  const mismatch = { protocolVersion: WEBVIEW_PROTOCOL_VERSION + 1, buildId: PIE_BUILD_ID };
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
    rendererIdentityRef: { current: { rendererId: 'renderer-1', rendererGeneration: 1 } },
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
    sessions: [],
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
});

test('session removal evicts lazy details and rejects late responses without tab-switch eviction', () => {
  clearLazyDetailCache();
  const posts: WebviewToHostMessage[] = [];
  setLazyDetailPostMessage((message) => {
    posts.push(message);
    return true;
  });
  const detailRef = (key: string): LazyDetailRef => ({
    key,
    kind: 'tool-result',
    source: 'durable',
    sessionPath: '/session/private.jsonl',
    messageId: `message-${key}`,
    toolCallId: `tool-${key}`,
    sizeBytes: 1,
    summary: key,
    available: true,
  });
  const session = (path: string) => ({
    path,
    name: path,
    cwd: '/workspace',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 1,
  });
  const makeState = (revision: number, activePath: string | null, sessionPaths: string[]): HostToWebviewMessage => ({
    type: 'state',
    protocolVersion: WEBVIEW_PROTOCOL_VERSION,
    buildId: PIE_BUILD_ID,
    hostInstanceId: 'host-1',
    rendererId: 'renderer-1',
    rendererGeneration: 1,
    viewGeneration: 1,
    revision,
    expectedTranscriptIdentity: `identity-${revision}`,
    snapshotBytes: 100,
    state: {
      sessions: sessionPaths.map(session),
      activeSession: activePath ? session(activePath) : null,
      openTabPaths: sessionPaths,
      transcript: [],
      transcriptWindow: { start: 0, end: 0, total: 0, hasOlder: false, hasNewer: false },
    } as unknown as ViewState,
  });
  const ctx = {
    hydrateViewState: (state: ViewState) => state,
    resetPerSessionState: () => undefined,
    hostInstanceIdRef: { current: 'host-1' },
    rendererIdentityRef: { current: { rendererId: 'renderer-1', rendererGeneration: 1 } },
    viewGenerationRef: { current: 1 },
    lastRevisionRef: { current: 0 },
    activeSessionPathRef: { current: null as string | null },
    committedSessionPathRef: { current: null as string | null },
    compatibilityFailedRef: { current: false },
    onCompatibilityMismatch: () => undefined,
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
      restoreNow: () => undefined,
    },
    inputsOps: { restoreNow: () => undefined, clear: () => undefined },
    setViewState: () => undefined,
    setCommitTarget: () => undefined,
    setInlineConfirm: () => undefined,
    postMessage: () => undefined,
  };

  try {
    const privateDetail = detailRef('cached');
    const pendingDetail = detailRef('pending');
    dispatchHostMessage(makeState(1, privateDetail.sessionPath, [privateDetail.sessionPath, '/session/other.jsonl']), ctx);

    requestLazyDetail(privateDetail.sessionPath, privateDetail);
    receiveLazyDetailResult({
      sessionPath: privateDetail.sessionPath,
      key: privateDetail.key,
      status: 'loaded',
      value: 'private body',
      sizeBytes: 1,
    });

    // Hiding/switching tabs is not ownership destruction: cached details stay
    // available when returning to an ordinary session.
    dispatchHostMessage(makeState(2, '/session/other.jsonl', [privateDetail.sessionPath, '/session/other.jsonl']), ctx);
    requestLazyDetail(privateDetail.sessionPath, privateDetail);
    assert.equal(posts.length, 1, 'ordinary tab switches retain the session-owned cache');

    requestLazyDetail(pendingDetail.sessionPath, pendingDetail);
    assert.equal(posts.length, 2, 'a second detail request is in flight before removal');
    dispatchHostMessage(makeState(3, '/session/other.jsonl', ['/session/other.jsonl']), ctx);
    requestLazyDetail(privateDetail.sessionPath, privateDetail);
    assert.equal(posts.length, 2, 'removed sessions cannot start another detail request');
    receiveLazyDetailResult({
      sessionPath: pendingDetail.sessionPath,
      key: pendingDetail.key,
      status: 'loaded',
      value: 'late private body',
      sizeBytes: 1,
    });

    // Reopening the same path (for example after a failed close) must not
    // resurrect either the loaded cache or a late response from its old owner.
    dispatchHostMessage(makeState(4, privateDetail.sessionPath, [privateDetail.sessionPath, '/session/other.jsonl']), ctx);
    requestLazyDetail(privateDetail.sessionPath, privateDetail);
    assert.equal(posts.length, 3, 'the evicted loaded detail is fetched again');
    receiveLazyDetailResult({
      sessionPath: privateDetail.sessionPath,
      key: privateDetail.key,
      status: 'loaded',
      value: 'fresh body',
      sizeBytes: 1,
    });
    requestLazyDetail(pendingDetail.sessionPath, pendingDetail);
    assert.equal(posts.length, 4, 'the response from the removed session was rejected');
  } finally {
    clearLazyDetailCache();
  }
});

test('build skew is accepted when the webview protocol still matches', () => {
  let hydrated = 0;
  let compatibilityFailures = 0;
  let stateUpdates = 0;
  let posted = 0;
  const compatibilityFailedRef = { current: false };
  const lastRevisionRef = { current: 4 };
  const ctx = {
    hydrateViewState: (state: ViewState) => { hydrated += 1; return state; },
    resetPerSessionState: () => undefined,
    hostInstanceIdRef: { current: 'host-1' },
    rendererIdentityRef: { current: { rendererId: 'renderer-1', rendererGeneration: 1 } },
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
      restoreNow: () => undefined,
    },
    inputsOps: { restoreNow: () => undefined, clear: () => undefined },
    setViewState: () => { stateUpdates += 1; },
    setCommitTarget: () => undefined,
    setInlineConfirm: () => undefined,
    postMessage: () => { posted += 1; },
  };
  const state = {
    sessions: [],
    activeSession: null,
    openTabPaths: [],
    transcript: [],
    transcriptWindow: { start: 0, end: 0, total: 0, hasOlder: false, hasNewer: false },
  } as unknown as ViewState;

  dispatchHostMessage({
    type: 'state',
    protocolVersion: WEBVIEW_PROTOCOL_VERSION,
    buildId: 'stale-build',
    hostInstanceId: 'host-1',
    rendererId: 'renderer-1',
    rendererGeneration: 1,
    viewGeneration: 1,
    revision: 5,
    expectedTranscriptIdentity: 'compatible',
    snapshotBytes: 100,
    state,
  }, ctx);

  assert.equal(compatibilityFailedRef.current, false);
  assert.equal(compatibilityFailures, 0);
  assert.equal(hydrated, 1);
  assert.equal(stateUpdates, 1);
  assert.equal(posted, 1, 'compatible state still receives receipt evidence');
  assert.equal(lastRevisionRef.current, 5);
});
