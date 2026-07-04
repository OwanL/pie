import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStateEnvelope,
  canPostSnapshotToWebview,
  createSidebarSyncState,
  flushDirtySnapshot,
  reconcilePostedMessageDelivery,
} from '../src/host/sidebar/sync';
import { DEFAULT_CHAT_PREFS, DEFAULT_PROXY_SETTINGS, type ViewState, type HostToWebviewMessage } from '../src/shared/protocol';

const baseViewState: ViewState = {
  sessions: [],
  openTabPaths: [],
  pinnedTabPaths: [],
  runningSessionPaths: [],
  unreadFinishedSessionPaths: [],
  activeSession: null,
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
  transcriptLoaded: false,
  pendingComposerInputs: [],
  activeRunSummary: null,
  runSummariesBySession: {},
  tokenRateBySession: {},
  draftText: '',
  busy: false,
  notice: null,
  backendReady: true,
  workspaceCwd: '/workspace',
  systemPrompts: [],
  modelSettings: null,
  availableModels: [],
  contextUsage: null,
  prefs: DEFAULT_CHAT_PREFS,
  availableExtensions: [],
  fileChanges: [],
  fileChangesExpanded: false,
  readFilePaths: [],
  pruningResult: null,
  prepassPhase: 'idle',
  prepassStartedAt: null,
  pruningSettings: {
    mode: 'auto' as const,
    skillCeiling: 8,
    toolCeiling: 10,
    skillAlwaysKeep: [],
    toolAlwaysKeep: [],
    model: 'gpt-5.4-mini',
    provider: 'github-copilot',
    thinkingLevel: 'minimal' as const,
  },
  proxySettings: DEFAULT_PROXY_SETTINGS,
  pruningCatalog: {
    skills: [],
    tools: [],
  },
  editingMessageId: null,
  showOutcomeDialog: false,
  pendingExtensionUIRequestsBySession: {},
  pendingExtensionUIRequest: null,
};

test('flushDirtySnapshot posts a full state snapshot once the view is visible again', () => {
  const syncState = { ...createSidebarSyncState('host-1'), globalDirty: true };

  const result = flushDirtySnapshot(syncState, baseViewState, true);

  assert.equal(result.message?.type, 'state');
  if (result.message?.type === 'state') {
    assert.equal(result.message.revision, 1);
  }
  assert.equal(result.nextSyncState.globalDirty, false);
  assert.equal(result.nextSyncState.globalRevision, 1);
});

test('buildStateEnvelope clears dirty state and advances revision when posted', () => {
  const syncState = {
    ...createSidebarSyncState('host-1'),
    globalDirty: true,
    globalRevision: 3,
  };

  const result = buildStateEnvelope(syncState, baseViewState, true);

  assert.equal(result.message?.type, 'state');
  if (result.message?.type === 'state') {
    assert.equal(result.message.revision, 4);
  }
  assert.equal(result.nextSyncState.globalDirty, false);
  assert.equal(result.nextSyncState.globalRevision, 4);
});

test('canPostSnapshotToWebview requires both a view and webviewReady', () => {
  assert.equal(canPostSnapshotToWebview(true, true), true);
  assert.equal(canPostSnapshotToWebview(true, false), false);
  assert.equal(canPostSnapshotToWebview(false, true), false);
  assert.equal(canPostSnapshotToWebview(false, false), false);
});

test('reconcilePostedMessageDelivery marks global snapshots dirty when delivery fails', () => {
  const syncState = createSidebarSyncState('host-1');

  const next = reconcilePostedMessageDelivery(syncState, {
    type: 'state',
    protocolVersion: 1,
    hostInstanceId: 'host-1',
    revision: 1,
    state: baseViewState,
  }, false);

  assert.equal(next.globalDirty, true);
});

test('reconcilePostedMessageDelivery marks globalDirty for sendRejected when delivery fails', () => {
  const syncState = createSidebarSyncState('host-1');

  const next = reconcilePostedMessageDelivery(syncState, {
    type: 'sendRejected',
    sessionPath: '/workspace/a.ts',
    text: 'hello',
    localId: 'local-1',
  }, false);

  assert.equal(next.globalDirty, true, 'sendRejected failure should mark globalDirty');
});

test('reconcilePostedMessageDelivery does NOT mark globalDirty for playCompletionSound when delivery fails', () => {
  const syncState = createSidebarSyncState('host-1');

  const next = reconcilePostedMessageDelivery(syncState, {
    type: 'playCompletionSound',
    volume: 50,
  }, false);

  assert.equal(next.globalDirty, false, 'fire-and-forget imperative failure should NOT mark globalDirty');
});

// ─── Brief D: resnapshot self-heal produces a strictly-higher revision ────────
// The webview revision guard discards envelopes with revision <= lastApplied.
// The watchdog's resnapshot self-heals ONLY because buildStateEnvelope always
// does globalRevision + 1. A future change that re-posted the same revision on
// a resnapshot/dirty-flush would be discarded by the guard and silently break
// self-healing (the "old + new message at once" symptom would return). These
// lock in the invariant.

/** Narrow a state-envelope message to its revision (undefined for non-state / absent). */
function revisionOf(msg: HostToWebviewMessage | undefined): number | undefined {
  return msg?.type === 'state' ? msg.revision : undefined;
}

test('Brief D: a resnapshot (missed-ack self-heal) produces a STRICTLY-HIGHER revision', () => {
  let sync = createSidebarSyncState('host-1');
  // Post revision 1 (delivered) — globalRevision starts at 0.
  const r = buildStateEnvelope(sync, baseViewState, true);
  assert.equal(revisionOf(r.message), 1);
  sync = r.nextSyncState;
  assert.equal(sync.globalRevision, 1);
  assert.equal(sync.globalDirty, false);

  // The post is reported NOT delivered (missed ack) — globalDirty is set, but
  // the revision counter does NOT advance (the snapshot is re-queued, not
  // re-minted). This is the state the watchdog's resnapshot recovers from.
  assert.equal(r.message?.type, 'state');
  sync = reconcilePostedMessageDelivery(sync, r.message!, false);
  assert.equal(sync.globalRevision, 1, 'revision unchanged after a missed ack');
  assert.equal(sync.globalDirty, true, 'global dirty after a missed ack');

  // Resnapshot (the watchdog's onResnapshot → flushDirtySnapshot) must mint a
  // STRICTLY-HIGHER revision so the webview's revision guard accepts it (a
  // re-post of revision 1 would be discarded as a duplicate).
  const resnap = flushDirtySnapshot(sync, baseViewState, true);
  assert.ok(resnap.message, 'resnapshot posts a snapshot');
  assert.ok((revisionOf(resnap.message) ?? 0) > 1, 'resnapshot revision is strictly higher than the dropped one');
  assert.equal(revisionOf(resnap.message), 2);
  assert.equal(resnap.nextSyncState.globalDirty, false, 'resnapshot clears the dirty flag');
});

test('Brief D: buildStateEnvelope mints a strictly-increasing revision on every post (self-heal underpin)', () => {
  // The invariant underpinning the self-heal: every successful buildStateEnvelope
  // mints a strictly-increasing revision — including a dirty-flush (resnapshot).
  let sync = createSidebarSyncState('host-1');
  let prev = 0;
  for (let i = 0; i < 5; i++) {
    const r = buildStateEnvelope(sync, baseViewState, true);
    assert.ok(r.message, `iteration ${i}: posts a snapshot`);
    const rev = revisionOf(r.message)!;
    assert.ok(rev > prev, `iteration ${i}: revision ${rev} strictly > prev ${prev}`);
    prev = rev;
    sync = r.nextSyncState;
  }
  // A dirty-flush (resnapshot) also mints a strictly-higher revision than the
  // last post — the property the watchdog's self-heal relies on.
  sync = { ...sync, globalDirty: true };
  const flush = flushDirtySnapshot(sync, baseViewState, true);
  assert.ok((revisionOf(flush.message) ?? 0) > prev, 'dirty-flush revision strictly higher than the last post');
});
