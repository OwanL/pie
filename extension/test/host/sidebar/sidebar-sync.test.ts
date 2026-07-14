import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStateEnvelope, createSidebarSyncState } from '../../../src/host/sidebar/sync';
import { setStreamDiagEnabled } from '../../../src/host/util/stream-telemetry';
import { transcriptRenderSignature } from '../../../src/shared/transcript-render-signature';
import {
  DEFAULT_CHAT_PREFS,
  DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
  EMPTY_AGGREGATE_STATS,
  WEBVIEW_PROTOCOL_VERSION,
  type ViewState,
} from '../../../src/shared/protocol';

const baseViewState: ViewState = {
  sessions: [], openTabPaths: [], pinnedTabPaths: [], runningSessionPaths: [], startingModelSessionPaths: [], unreadFinishedSessionPaths: [],
  activeSession: null, transcript: [],
  transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
  transcriptLoaded: false, pendingComposerInputs: [], activeRunSummary: null, runSummariesBySession: {}, tokenRateBySession: {},
  aggregateStats: EMPTY_AGGREGATE_STATS, deferredTriggers: [], draftText: '', busy: false, retryStatus: null, liveTurnPhase: null, notice: null,
  backendReady: true, workspaceCwd: '/workspace', systemPrompts: [], modelSettings: null, availableModels: [], contextUsage: null,
  prefs: DEFAULT_CHAT_PREFS, availableExtensions: [], fileChanges: [], fileChangesExpanded: false, readFilePaths: [], pruningResult: null,
  prepassPhase: 'idle', prepassStartedAt: null,
  pruningSettings: { mode: 'auto', skillCeiling: 8, toolCeiling: 10, skillAlwaysKeep: [], toolAlwaysKeep: [], model: 'gpt-5.4-mini', provider: 'github-copilot', thinkingLevel: 'minimal' },
  toolResultPruningSettings: { ...DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, rules: { ...DEFAULT_TOOL_RESULT_PRUNING_SETTINGS.rules } },
  pruningCatalog: { skills: [], tools: [] }, editingMessageId: null, showOutcomeDialog: false,
  pendingExtensionUIRequestsBySession: {}, pendingExtensionUIRequest: null,
};

test('buildStateEnvelope emits protocol v4 generation and bounded expected transcript identity', () => {
  setStreamDiagEnabled(false);
  const sync = createSidebarSyncState('host-1');
  const result = buildStateEnvelope(sync, baseViewState, { revision: 1, viewGeneration: 7 });

  assert.equal(result.message.type, 'state');
  assert.equal(result.message.protocolVersion, WEBVIEW_PROTOCOL_VERSION);
  assert.equal(result.message.hostInstanceId, 'host-1');
  assert.equal(result.message.revision, 1);
  assert.equal(result.message.viewGeneration, 7);
  assert.equal(result.message.expectedTranscriptIdentity, transcriptRenderSignature(baseViewState));
  assert.equal(result.message.snapshotBytes, 0, 'disabled diagnostics do not serialize snapshots');
  assert.equal(result.expectedTranscriptIdentity, result.message.expectedTranscriptIdentity);
  assert.equal(result.nextSyncState.globalRevision, 1);
});

test('snapshot bytes are measured by the host only while diagnostics are enabled', () => {
  setStreamDiagEnabled(true);
  try {
    const result = buildStateEnvelope(createSidebarSyncState('host-1'), baseViewState, { revision: 1, viewGeneration: 2 });
    assert.equal(result.message.snapshotBytes, Buffer.byteLength(JSON.stringify(result.message), 'utf8'));
  } finally {
    setStreamDiagEnabled(false);
  }
});

test('full snapshots remain the sole envelope authority and revisions must be monotonic', () => {
  let sync = createSidebarSyncState('host-1');
  for (let revision = 1; revision <= 5; revision += 1) {
    const result = buildStateEnvelope(sync, baseViewState, { revision, viewGeneration: 2 });
    assert.equal(result.message.state, baseViewState);
    assert.equal(result.message.revision, revision);
    sync = result.nextSyncState;
  }
  assert.throws(
    () => buildStateEnvelope(sync, baseViewState, { revision: 5, viewGeneration: 2 }),
    /increase monotonically/,
  );
});
