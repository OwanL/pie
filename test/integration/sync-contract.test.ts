import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { assertProtocolVersion, PROTOCOL_VERSION } from '../../harness/agent-processes/lib/rpc/wire.js';
import {
  DEFAULT_CHAT_PREFS,
  DEFAULT_PRUNING_SETTINGS,
  DEFAULT_SESSION_TITLES_SETTINGS,
  DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
  resolveChatPrefs,
  type ChatMessage,
  type ComposerInput,
  type ContextUsageChangedPayload,
  type HostToWebviewMessage,
  type LiveSubagentDetailAddress,
  type ModelInfo,
  type SessionAnalyticsFactors,
  type SessionCapabilities,
  type SessionOpenedPayload,
  type SessionPromptInventoryPayload,
  type ToolFinishedPayload,
  type ViewState,
  type WebviewToHostMessage,
  EMPTY_AGGREGATE_STATS,
} from '../../application/lib/protocol/index.js';

test('session bucket choices retain full entries across preference snapshots', () => {
  assert.deepEqual(DEFAULT_CHAT_PREFS.subagentBucketTogglesBySession, {});
  const choices = { small: false, medium: true, frontier: false };
  const prefs = resolveChatPrefs({ subagentBucketTogglesBySession: { '/session/root.jsonl': choices } });
  assert.deepEqual(resolveChatPrefs(JSON.parse(JSON.stringify(prefs))).subagentBucketTogglesBySession, {
    '/session/root.jsonl': choices,
  });
});

test('open acknowledgement without snapshot retains bounded read-only recovery in the contract', async () => {
  const contract = await readFile('docs/contracts/STATE_CONTRACT.md', 'utf8');
  assert.match(contract, /successful acknowledgement alone cannot prove snapshot delivery/);
  assert.match(contract, /exhausted reconciliation retains bounded non-terminal uncertainty without replay/);
  const reducer = await readFile('application/backend/conversation-state/reducers/misc-handlers.ts', 'utf8');
  assert.match(reducer, /event\.ok && event\.successEvidence !== 'snapshot-applied'/);
  const runner = await readFile('application/backend/conversation-state/effects/effect-runner.ts', 'utf8');
  assert.match(runner, /successEvidence: 'snapshot-applied'/);
});

test('pending new-session preview uses creation authority without borrowing session catalogs', async () => {
  const contract = await readFile(new URL('../../docs/contracts/STATE_CONTRACT.md', import.meta.url), 'utf8');
  assert.match(contract, /existing runtime-free creation-model authority through `models.creationPreview`/u);
  assert.match(contract, /fenced by backend generation, creation operation\/attempt and configuration-write ownership/u);
  assert.match(contract, /durable session discovery replaces and revalidates the provisional choices/u);
  assert.match(contract, /an authoritative empty catalog remains empty/u);
  // Terminal catalog hydration failure: fenced, keeps the last good catalog,
  // offers retry; pre-ready unavailability defers instead of failing.
  assert.match(contract, /A durable catalog read that fails after backend readiness is terminal: it records an `error` catalog status/u);
  assert.match(contract, /the toolbar renders a retry affordance in the `error` state that re-requests hydration/u);
  assert.match(contract, /A catalog or settings read that fails before `backend\.ready` \(the `Backend is not running` host boundary\) is not a terminal failure: the host defers it and re-runs it on the next backend ready transition/u);
  const { createInitialArchState } = await import('../../application/backend/conversation-state/arch-state.js');
  const { reducer } = await import('../../application/backend/conversation-state/reducer.js');
  const { selectViewState } = await import('../../application/backend/conversation-state/projections/projection.js');
  const model = { id: 'm', name: 'M', provider: 'p', reasoning: false, inputKinds: ['text'] } satisfies ModelInfo;
  const sessionPath = '/catalog-failure.jsonl';
  const initial = { ...createInitialArchState(),
    settings: { ...createInitialArchState().settings, backendReady: true, modelWriteFence: 0, modelHydrationRevision: 2 },
    sessions: { ...createInitialArchState().sessions, activeSessionPath: sessionPath, openTabPaths: [sessionPath] } };
  // A terminal failure on a loading catalog surfaces the error status.
  const failed = reducer(initial, { kind: 'AvailableModelsHydrationFailed', sessionPath,
    error: 'catalog exploded', backendGeneration: 1, hydrationRevision: 2, modelWriteFence: 0 });
  assert.equal(selectViewState(failed.state).availableModelsStatus, 'error');
  // It keeps a last good catalog visible and never claims authoritative-empty.
  const good = { ...initial, settings: { ...initial.settings, availableModelsBySession: { [sessionPath]: [model] }, modelHydrationRevision: 2 } };
  const kept = reducer(good, { kind: 'AvailableModelsHydrationFailed', sessionPath,
    error: 'refresh failed', backendGeneration: 1, hydrationRevision: 2, modelWriteFence: 0 });
  assert.equal(selectViewState(kept.state).availableModelsStatus, 'authoritative');
  assert.deepEqual(selectViewState(kept.state).availableModels, [model]);
  // A stale failure (older revision) is rejected.
  const old = reducer(kept.state, { kind: 'AvailableModelsHydrationFailed', sessionPath,
    error: 'stale', backendGeneration: 1, hydrationRevision: 1, modelWriteFence: 0 });
  assert.equal(old.state, kept.state);
});

test('pending resolution identity survives both publication orders and summary refreshes', async () => {
  const contract = await readFile('docs/contracts/STATE_CONTRACT.md', 'utf8');
  assert.match(contract, /Path disappearance or a pending-to-real shape alone is never identity evidence/u);
  const { createInitialArchState, reducer } = await import('../../application/backend/conversation-state/reducer.js');
  const { selectViewState } = await import('../../application/backend/conversation-state/projections/projection.js');
  const pending = 'pending:identity-a';
  const durable = '/identity-a.jsonl';
  const unrelated = '/identity-b.jsonl';
  const summary = (path: string) => ({ path, name: path, cwd: '/', modifiedAt: '2024-01-01', messageCount: 0 });
  for (const eventFirst of [true, false]) {
    const initial = createInitialArchState();
    let state = { ...initial, sessions: { ...initial.sessions, activeSessionPath: pending,
      openTabPaths: [pending, unrelated], sessions: [summary(pending), summary(unrelated), ...(eventFirst ? [summary(durable)] : [])] } };
    state = reducer(state, { kind: 'PendingPathReplaced', oldPendingPath: pending, newSessionPath: durable }).state;
    assert.equal(selectViewState(state).activeSession?.resolvedPendingPath, pending);
    // The trailing opened/upsert and list refresh must not erase identity before
    // a renderer receives its next (possibly coalesced) full snapshot.
    state = reducer(state, { kind: 'SessionSummaryUpserted', summary: summary(durable) }).state;
    state = reducer(state, { kind: 'SessionListChanged', sessionSummaries: [summary(durable), summary(unrelated)] }).state;
    assert.equal(selectViewState(state).activeSession?.resolvedPendingPath, pending);
    assert.equal(selectViewState(state).sessions.find(s => s.path === unrelated)?.resolvedPendingPath, undefined);
    state = reducer(state, { kind: 'SessionClosed', sessionPath: durable }).state;
    state = reducer(state, { kind: 'SessionSummaryUpserted', summary: summary(durable) }).state;
    assert.equal(state.sessions.sessions.find(s => s.path === durable)?.resolvedPendingPath, undefined);
  }
});

test('local dictation owns only its captured draft span and never sends', async () => {
  const contract = await readFile(new URL('../../docs/contracts/STATE_CONTRACT.md', import.meta.url), 'utf8');
  assert.match(contract, /dictation never auto-sends/iu);
  assert.match(contract, /ten seconds of VAD silence/u);
  assert.match(contract, /pending-path rekeys cannot lose a Stop/u);
  const { createInitialArchState, reducer } = await import('../../application/backend/conversation-state/reducer.js');
  const { selectViewState } = await import('../../application/backend/conversation-state/projections/projection.js');
  const initial = createInitialArchState();
  const owner = { corrId: 'dictation-contract', recordingId: 'voice-contract', sessionPath: 'pending:voice', rendererId: 'local', rendererGeneration: 1 };
  let state: typeof initial = { ...initial,
    sessions: { ...initial.sessions, activeSessionPath: owner.sessionPath, openTabPaths: [owner.sessionPath] },
    composer: { ...initial.composer, draftTextBySession: { [owner.sessionPath]: 'before OLD after' } } };
  state = reducer(state, { kind: 'DictationAvailabilityChanged', available: true }).state;
  const start = reducer(state, { kind: 'Command', cmd: { ...owner, kind: 'DictationStart', draftText: 'before OLD after', selectionStart: 7, selectionEnd: 10 } });
  assert.deepEqual(start.effects, [{ kind: 'DictationControl', action: 'start', recordingId: owner.recordingId }]);
  state = reducer(start.state, { kind: 'DictationObserved', id: owner.recordingId, sequence: -0.5, observation: { kind: 'level', level: 0.5 } }).state;
  state = reducer(state, { kind: 'DictationObserved', id: owner.recordingId, sequence: 0, observation: { kind: 'status', phase: 'recording' } }).state;
  const activity = reducer(state, { kind: 'DictationObserved', id: owner.recordingId, sequence: 1, observation: { kind: 'level', level: 0.5 } });
  assert.equal(activity.state.dictation.audioLevel, 0.5);
  assert.equal(activity.state.composer, state.composer);
  assert.deepEqual(activity.effects, []);
  state = reducer(activity.state, { kind: 'DictationObserved', id: owner.recordingId, sequence: 2, observation: { kind: 'transcript', text: 'provisional', final: false } }).state;
  assert.equal(selectViewState(state).draftText, 'before provisional after');
  state = reducer(state, { kind: 'PendingPathReplaced', oldPendingPath: owner.sessionPath, newSessionPath: 'resolved:voice' }).state;
  const stop = reducer(state, { kind: 'Command', cmd: { ...owner, kind: 'DictationStop' } });
  assert.deepEqual(stop.effects, [{ kind: 'DictationControl', action: 'stop', recordingId: owner.recordingId }]);
  const final = reducer(stop.state, { kind: 'DictationObserved', id: owner.recordingId, sequence: 3, observation: { kind: 'transcript', text: 'revised', final: true } });
  assert.equal(selectViewState(final.state).draftText, 'before revised after');
  assert.equal(final.state.dictation.capture, null);
  assert.deepEqual(final.effects, []);
  assert.deepEqual(selectViewState(final.state).transcript, []);
});

test('provider management is host-global, credential-free and separate from chat activation', async () => {
  const contract = await readFile(new URL('../../docs/contracts/STATE_CONTRACT.md', import.meta.url), 'utf8');
  assert.match(contract, /## Provider Management State/u);
  assert.match(contract, /one-use opaque tickets/u);
  assert.match(contract, /does not activate chat catalogs/u);
  const { initialArchState, reducer } = await import('../../application/backend/conversation-state/reducer.js');
  const { selectViewState } = await import('../../application/backend/conversation-state/projections/projection.js');
  const { isProviderManagementSnapshot } = await import('../../harness/model-providers/management/validation.js');
  const state = { ...initialArchState, settings: { ...initialArchState.settings, backendReady: true },
    providerManagement: { ...initialArchState.providerManagement, generation: 1 } };
  const result = reducer(state, { kind: 'Command', cmd: { kind: 'ProviderManagement', corrId: 'provider-contract',
    operationId: 'provider-contract-open', generation: 1, command: { type: 'open' } } });
  assert.equal(selectViewState(result.state).providerManagement?.mode, 'management');
  assert.equal(result.state.sessions, state.sessions);
  assert.equal(result.state.settings, state.settings);
  assert.equal(result.effects[0]?.kind, 'ProviderManagementRpc');
  const snapshot = { revision: 0, configRevision: null, loaded: true, providers: [], definitions: [], protocols: [] };
  assert.equal(isProviderManagementSnapshot(snapshot), true);
  const authBrowser = { operationId: 'op', url: 'https://login.invalid', instructions: 'Continue' };
  const auth = { kind: 'input' as const, operationId: 'op', promptId: 'p', message: 'Code' };
  const updated = reducer(result.state, { kind: 'ProviderManagementSnapshotUpdated', generation: 1, snapshot: { ...snapshot, auth, authBrowser } });
  const owning = { ...updated.state, providerManagement: { ...updated.state.providerManagement, authOperationId: 'op' } };
  assert.deepEqual(selectViewState(owning).providerManagement?.authBrowser, authBrowser);
  assert.deepEqual(selectViewState(owning).providerManagement?.auth, auth);
  assert.equal(isProviderManagementSnapshot({ ...snapshot, auth, authBrowser }), true);
  assert.equal(isProviderManagementSnapshot({ ...snapshot, apiKey: 'synthetic-private-input' }), false);
  assert.equal(isProviderManagementSnapshot({ ...snapshot, auth: { kind: 'progress', operationId: 'op',
    message: 'Connecting…', access: 'synthetic-private-input' } }), false);
});

test('coordinator credential waits and ordered management projection have explicit contract boundaries', async () => {
  const contract = await readFile(new URL('../../docs/contracts/STATE_CONTRACT.md', import.meta.url), 'utf8');
  assert.match(contract, /each awaits a fresh batch of saved-credential IDs, then captures current service state/u);
  assert.match(contract, /response drafts and `configRevision` are projected at the same final current-state boundary, including inherited settings/u);
  assert.match(contract, /Projection never acquires the configuration mutation lane/u);
  assert.match(contract, /supported asynchronous native credential storage without synchronous fallback/u);
  assert.match(contract, /No authoritative credential inventory is cached across admissions/u);
  assert.match(contract, /synchronous SDK APIs and `runtime\/services\.ts::currentSaved\(\)` remain synchronous and can still contend on the native lock/u);
  assert.match(contract, /The native lock remains held across OAuth refresh/u);
  assert.match(contract, /credential persistence checks cancellation at the canonical write boundary/u);
});

test('explicit provider removal masks stale catalogs without rewriting selections or preferences', async () => {
  const contract = await readFile(new URL('../../docs/contracts/STATE_CONTRACT.md', import.meta.url), 'utf8');
  assert.match(contract, /Explicit provider removal is live policy for existing and new chats/u);
  assert.match(contract, /already-delivered worker leases and already-dispatched legacy requests finish normally/u);
  const { createInitialArchState, reducer } = await import('../../application/backend/conversation-state/reducer.js');
  const { selectViewState } = await import('../../application/backend/conversation-state/projections/projection.js');
  const { providerConfigRevision } = await import('../../harness/model-providers/catalog/provider-config.js');
  const { isProviderManagementSnapshot } = await import('../../harness/model-providers/management/validation.js');
  const sessionPath = '/provider-removal.jsonl';
  const model = { id: 'model', name: 'Model', provider: 'removed', reasoning: false, inputKinds: ['text'] } satisfies ModelInfo;
  const initial = createInitialArchState();
  initial.settings.backendReady = true;
  initial.settings.availableModelsBySession[sessionPath] = [model, { ...model, provider: 'retained' }];
  initial.sessions.activeSessionPath = sessionPath;
  initial.sessions.openTabPaths = [sessionPath];
  initial.providerManagement.generation = 1;
  initial.settings.prefs = { ...initial.settings.prefs, subagentProviderDefaults: { removed: true },
    subagentBuckets: { ...initial.settings.prefs.subagentBuckets, small: [{ model: 'removed/model', thinkingLevel: 'off' }] } };
  const snapshot = { ...initial.providerManagement.snapshot, loaded: true, revision: 1,
    configRevision: providerConfigRevision('removed'), removedProviderIds: ['removed'] };
  assert.equal(isProviderManagementSnapshot(snapshot), true);
  const removed = reducer(initial, { kind: 'ProviderManagementSnapshotUpdated', generation: 1, snapshot });
  const view = selectViewState(removed.state);
  assert.deepEqual(view.availableModels.map(entry => entry.provider), ['retained']);
  assert.deepEqual(view.providerManagement?.removedProviderIds, ['removed']);
  assert.equal(removed.state.settings.prefs, initial.settings.prefs);
  assert.equal(removed.state.sessions, initial.sessions);
  assert.equal(removed.state.transcript, initial.transcript);
  assert.deepEqual(removed.effects.filter(effect => effect.kind === 'HydrateModel').map(effect => effect.sessionPath), [sessionPath]);
  const readded = reducer(removed.state, { kind: 'ProviderManagementSnapshotUpdated', generation: 1,
    snapshot: { ...snapshot, revision: 2, configRevision: providerConfigRevision('readded'), removedProviderIds: [] } });
  assert.deepEqual(selectViewState(readded.state).availableModels.map(entry => entry.provider), ['removed', 'retained']);
  assert.equal(readded.state.settings.prefs, initial.settings.prefs);
});

test('notification sound contract broadcasts completion and question chimes without focus arbitration', async () => {
  const contract = await readFile(new URL('../../docs/contracts/STATE_CONTRACT.md', import.meta.url), 'utf8');
  assert.match(contract, /Notification sounds are host-owned broadcasts/u);
  assert.match(contract, /regardless of focus or visibility/u);
  assert.match(contract, /never queued for reconnect or replayed from snapshots/u);
  const completion: HostToWebviewMessage = { type: 'playCompletionSound', volume: 50 };
  const question: HostToWebviewMessage = { type: 'playQuestionSound', volume: 50 };
  assert.equal(completion.volume, question.volume);
});

// ---------------------------------------------------------------------------
// Protocol contract: PROTOCOL_VERSION is a positive integer that the host and
// backend must agree on. Bumps require a coordinated change.
// ---------------------------------------------------------------------------

test('capability refresh is host-owned one-shot intent and follow-up pruning defaults off', async () => {
  const contract = await readFile(new URL('../../docs/contracts/STATE_CONTRACT.md', import.meta.url), 'utf8');
  assert.match(contract, /`pruning.followUpEnabled` defaults to `false`/u);
  assert.match(contract, /Definitive pre-commit rejection restores the flag, while acknowledgement uncertainty never rearms it/u);
  assert.match(contract, /Agent-originated sends, busy queued messages, and empty Continue do not consume it/u);
  assert.equal(DEFAULT_PRUNING_SETTINGS.followUpEnabled, false);
  const { validateBrowserToHostMessage } = await import('../../application/lib/validation/browser-ingress.js');
  const { initialArchState, reducer } = await import('../../application/backend/conversation-state/reducer.js');
  const { selectViewState } = await import('../../application/backend/conversation-state/projections/projection.js');
  const sessionPath = '/refresh-contract.jsonl';
  const command = { type: 'setPruningRefreshPending', sessionPath, pending: true,
    clientCommandId: '123e4567-e89b-42d3-a456-426614174000', viewGeneration: 1 };
  const validated = validateBrowserToHostMessage(command, Buffer.byteLength(JSON.stringify(command)));
  assert.equal(validated.ok, true, validated.ok ? '' : validated.reason);
  const base = { ...initialArchState,
    settings: { ...initialArchState.settings, backendReady: true },
    sessions: { ...initialArchState.sessions, activeSessionPath: sessionPath, openTabPaths: [sessionPath] } };
  const armed = reducer(base, { kind: 'Command', cmd: {
    kind: 'SetPruningRefreshPending', corrId: 'arm', sessionPath, pending: true,
  } }).state;
  assert.equal(selectViewState(armed).pruningRefreshPending, true);
  const admitted = reducer(armed, { kind: 'Command', cmd: {
    kind: 'Send', corrId: 'send', operationId: 'refresh-op', operationAttempt: 1,
    operationSource: { kind: 'host' }, backendGeneration: 1, composerSend: true,
    sessionPath, text: 'Investigate the next task', inputs: [], composedText: 'Investigate the next task',
    localId: 'refresh-local', previousSummary: null, timestamp: 1,
  } });
  assert.equal(selectViewState(admitted.state).pruningRefreshPending, false);
  assert.equal(admitted.effects.find((effect) => effect.kind === 'SendRpc')?.refreshPruning, true);
  assert.equal(admitted.state.pending.ops.send.refreshPruning, true);
  const rejected = reducer(admitted.state, { kind: 'SendResult', corrId: 'send', ok: false, error: 'rejected' });
  assert.equal(selectViewState(rejected.state).pruningRefreshPending, true);
});

test('session snooze hides live membership and restores expired tabs without selecting them', async () => {
  const contract = await readFile(new URL('../../docs/contracts/STATE_CONTRACT.md', import.meta.url), 'utf8');
  assert.match(contract, /Snooze is idle-only/u);
  assert.match(contract, /Snoozes survive host restarts, including private sessions/u);
  const { validateBrowserToHostMessage } = await import('../../application/lib/validation/browser-ingress.js');
  const { createInitialArchState } = await import('../../application/backend/conversation-state/arch-state.js');
  const { reducer } = await import('../../application/backend/conversation-state/reducer.js');
  const { selectViewState } = await import('../../application/backend/conversation-state/projections/projection.js');
  const { projectHostLiveMembership } = await import('../../application/backend/agent-connection/live-session-membership.js');
  const sessionPath = '/snooze-contract.jsonl';
  const command = { type: 'snoozeSession', sessionPath, durationHours: 4,
    clientCommandId: '123e4567-e89b-42d3-a456-426614174000', viewGeneration: 1 };
  const validated = validateBrowserToHostMessage(command, Buffer.byteLength(JSON.stringify(command)));
  assert.equal(validated.ok, true, validated.ok ? '' : validated.reason);
  const initial = createInitialArchState();
  const base = { ...initial, sessions: { ...initial.sessions, activeSessionPath: sessionPath,
    openTabPaths: [sessionPath], sessions: [{ path: sessionPath, name: 'Friday work', cwd: '/work', modifiedAt: '', messageCount: 0 }] } };
  const requested = reducer(base, { kind: 'SessionSnoozeRequested', sessionPath, now: 1000, wakeAt: 2000, deferredTarget: false });
  assert.deepEqual(requested.state.sessions.openTabPaths, [sessionPath], 'tab stays visible until idle reservation confirmed');
  const reservationId = requested.state.sessions.pendingSnoozes[sessionPath]!.reservationId;
  const hidden = reducer(requested.state, { kind: 'SessionSnoozeReservationResult', sessionPath, reservationId, ok: true, now: 1001 }).state;
  assert.deepEqual(selectViewState(hidden).sessions, []);
  assert.deepEqual(selectViewState(hidden).openTabPaths, []);
  assert.equal(projectHostLiveMembership(hidden, {}).sessions.length, 0);
  assert.deepEqual(selectViewState(hidden).snoozedSessions, [{ path: sessionPath, name: 'Friday work', wakeAt: 2000 }]);
  const awake = reducer(hidden, { kind: 'SessionSnoozeTimerFired', now: 2000 }).state;
  assert.deepEqual(awake.sessions.openTabPaths, [sessionPath]);
  assert.equal(awake.sessions.activeSessionPath, null);
  assert.equal(projectHostLiveMembership(awake, {}).sessions.length, 1);
  assert.deepEqual(awake.sessions.snoozedBySession, {});
});

test('tool inspection retrieves captured model exchange without substituting display records', async () => {
  const contract = await readFile(new URL('../../docs/contracts/STATE_CONTRACT.md', import.meta.url), 'utf8');
  assert.match(contract, /durable `model-exchange` lazy detail, not display inputs\/results/u);
  assert.match(contract, /confirmed by a successful provider response/u);
  assert.match(contract, /explicitly unavailable, never reconstructed/u);
  const { captureModelExchangeEntries, findToolModelExchange, modelExchangeRef } = await import('../../harness/session-storage/transcripts/tool-model-exchange.js');
  const { validateWebviewToHostMessage } = await import('../../application/lib/validation/protocol-validation.js');
  const tool = { id: 'call', durableEntryId: 'result', name: 'display', input: 'display input', result: 'display output', status: 'completed' as const };
  const transcript: ChatMessage[] = [{ id: 'assistant', role: 'assistant', createdAt: '', markdown: '', status: 'completed', parts: [{ kind: 'toolCall', toolCall: tool }] }];
  const ref = modelExchangeRef('/session', tool);
  assert.equal(validateWebviewToHostMessage({ type: 'requestDetail', sessionPath: '/session', ref }).ok, true);
  assert.equal(findToolModelExchange(transcript, [], ref).status, 'unavailable');
  const captured = { produced: { name: 'read', arguments: { path: 'model.ts' } }, received: ['provider-visible content'] };
  const entries = captureModelExchangeEntries([
    { type: 'custom', customType: 'pie.tool-model-exchange', data: { version: 1, toolCallId: 'call', produced: captured.produced } },
    { type: 'message', id: 'assistant', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call' }] } },
    { type: 'message', id: 'result', message: { role: 'toolResult', toolCallId: 'call' } },
    { type: 'custom', customType: 'pie.tool-model-exchange', data: { version: 1, toolCallId: 'call', received: captured.received } },
  ]);
  const found = findToolModelExchange(transcript, entries, ref);
  assert.equal(found.status, 'loaded');
  if (found.status === 'loaded') assert.deepEqual(found.value, captured);
});

test('wakeup timers project durable response-relative starts and admit creator-owned cancellation', async () => {
  const contract = await readFile(new URL('../../docs/contracts/STATE_CONTRACT.md', import.meta.url), 'utf8');
  assert.match(contract, /`wakeupMode` defaults to `true`: timer delays start only after the creator finishes its response/u);
  assert.match(contract, /reloads never restart the delay/u);
  assert.match(contract, /`cancelDeferredTrigger` carries the creator `sessionPath` and optional `triggerId` through both renderer transports/u);
  const { replayTriggers } = await import('../../application/backend/deferred-triggers/store.js');
  const trigger = replayTriggers([
    { op: 'register', id: 'wake', sessionPath: '/creator.jsonl', targetSession: '/target.jsonl',
      triggers: [{ kind: 'timer', ms: 1000 }], wakeupMode: true, message: 'check', at: '2026-10-08T12:00:00.000Z' },
    { op: 'timer-started', id: 'wake', sessionPath: '/creator.jsonl', at: '2026-10-08T12:00:05.000Z' },
    { op: 'timer-started', id: 'wake', sessionPath: '/creator.jsonl', at: '2026-10-08T12:00:10.000Z' },
  ]).get('wake');
  assert.equal(trigger?.wakeupMode, true);
  assert.equal(trigger?.timerStartedAt, '2026-10-08T12:00:05.000Z');
  const { validateBrowserToHostMessage } = await import('../../application/lib/validation/browser-ingress.js');
  const cancellation = { type: 'cancelDeferredTrigger', sessionPath: '/creator.jsonl', triggerId: 'wake',
    clientCommandId: '123e4567-e89b-42d3-a456-426614174000', viewGeneration: 1 };
  const accepted = validateBrowserToHostMessage(cancellation, Buffer.byteLength(JSON.stringify(cancellation)));
  assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.reason);
  if (accepted.ok) assert.deepEqual(accepted.value, cancellation);
});

test('runtime lease release stays behind awaited production backend shutdown', async () => {
  // Bootstrap's executable delayed-deactivation tests cover lease retention.
  // Guard the production delegate too: Disposable.dispose() is fire-and-forget
  // and must not substitute for BackendClient.stop() at this lifecycle boundary.
  const host = await readFile(new URL('../../application/backend/composition/host-runtime.ts', import.meta.url), 'utf8');
  const entry = await readFile(new URL('../../application/hosts/vscode/activation/extension.ts', import.meta.url), 'utf8');
  // Analytics ingress remains open while the backend drains. Its transport is
  // fenced from the finally block even when stop rejects, and only then may
  // the backend/runtime leases be released.
  assert.match(host, /try\s*\{\s*await this\.backend\.stop\(\);\s*\}\s*finally\s*\{\s*await this\.analyticsTransport\?\.shutdown\(\);\s*\}/u);
  const backendStop = host.indexOf('await this.backend.stop();');
  const transportShutdown = host.indexOf('await this.analyticsTransport?.shutdown();', backendStop);
  const backendDispose = host.indexOf('this.backend.dispose();', transportShutdown);
  const runtimeStop = host.indexOf('await this.analyticsRuntime.stop();', backendDispose);
  assert.ok(backendStop >= 0, 'production shutdown must await backend stop');
  assert.ok(transportShutdown > backendStop, 'analytics ingress must settle after backend stop');
  assert.ok(backendDispose > transportShutdown, 'backend disposal must follow transport settlement');
  assert.ok(runtimeStop > backendDispose, 'analytics runtime stop must follow backend disposal');
  assert.match(entry, /await extension\?\.shutdown\(\)/u);
});

test('restored missing-tab recovery distinguishes filesystem absence from transient and lifecycle failures', async () => {
  const contract = await readFile(new URL('../../docs/contracts/STATE_CONTRACT.md', import.meta.url), 'utf8');
  assert.match(contract, /Startup omits restored paths confirmed absent or not regular files, while transient filesystem errors retain tabs/u);
  assert.match(contract, /fresh host confirmation of `ENOENT`\/`ENOTDIR` and current generation, data-epoch, and operation-ownership checks/u);
  assert.match(contract, /Running, hidden-running, closing, and other active-operation targets remain protected/u);
  assert.match(contract, /a prior authoritative open success wins over a late error/u);
  assert.match(contract, /without stopping a runtime or deleting session files/u);
});

test('host artifact delivery binds Pi to verified output and distinguishes standalone lifetimes', async () => {
  const contract = await readFile(new URL('../../docs/contracts/STATE_CONTRACT.md', import.meta.url), 'utf8');
  assert.match(contract, /Delivered Pi runtime packages, dependencies, and assets are contained in the verified `pi-runtime` artifact and share its lifetime/u);
  assert.match(contract, /selected backend Node executable's platform, architecture, and modules ABI/u);
  assert.match(contract, /missing, tampered, or incompatible artifacts fail setup without an external SDK pointer, cache, registry, or global-install fallback/u);
  assert.match(contract, /development launcher instead selects the compiled local Pi workspace with explicit development opt-in and retains its reader registration until teardown is confirmed/u);
  assert.match(contract, /acquiring before artifact\/runtime use and releasing only after confirmed owned teardown; uncertain teardown retains the lease/u);
  assert.match(contract, /Packaged flat output has package-install lifetime, not generation-GC lease protection/u);
  assert.match(contract, /Explicit standalone output is caller-owned and must remain immutable and available until confirmed shutdown/u);
  assert.match(contract, /Settings, credentials, sessions, and other user data remain outside runtime generations/u);
});

test('agent session-control docs track the split protocol, ownership, settings, and legacy compatibility', async () => {
  const agentContract = await readFile(new URL('../../docs/contracts/AGENT-SESSION-CONTROL.md', import.meta.url), 'utf8');
  const titleContract = await readFile(new URL('../../docs/contracts/SESSION-TITLES.md', import.meta.url), 'utf8');
  const stateContract = await readFile(new URL('../../docs/contracts/STATE_CONTRACT.md', import.meta.url), 'utf8');
  assert.match(agentContract, /`session_control` \| List\/create\/read sessions, inspect\/change settings, interrupt, close, clean up/u);
  assert.match(agentContract, /`session_send` \| Give information without starting an idle turn/u);
  assert.match(agentContract, /`session_assign` \| Assign work to an existing live session and start a turn/u);
  assert.match(agentContract, /`session_finish` \| Commit one result for the authenticated requester/u);
  assert.match(agentContract, /`session_wait` \| Inspect task evidence or wait without model polling/u);
  assert.match(agentContract, /`session_resources` \| Inspect memory samples and cooperative reservations/u);
  assert.match(agentContract, /Create without a prompt leaves a cold session/u);
  assert.match(agentContract, /optional initial assignment prompt is limited to 16 KiB UTF-8/u);
  assert.match(agentContract, /Settings inheritance and model buckets retain the user's provider and execution choices/u);
  assert.match(agentContract, /An assignment fixes requester and worker independently of who created them/u);
  assert.match(agentContract, /The coordinator commits the result before notifying its requester/u);
  assert.match(agentContract, /Close\/delete and settings changes require self or direct durable creator ownership/u);
  assert.match(agentContract, /Unknown never licenses automatic recreation or resend/u);
  assert.match(agentContract, /A configuration failure prevents that call's assignment while preserving already committed creation\/settings/u);
  assert.match(agentContract, /Read preserves character budgets, opaque history\/identity-bound cursors, and opt-in tool\/reasoning projections/u);
  assert.match(agentContract, /Notes never start an idle model turn/u);
  assert.match(agentContract, /Historical `pie-reply:v1:` reply references remain accepted/u);
  assert.match(agentContract, /Existing authenticated legacy messages remain readable for transcript compatibility/u);
  assert.match(agentContract, /`session_control message`, `expectReply`, and manual `fulfills` entry-ID collection are no longer advertised/u);
  assert.match(stateContract, /no open tab still starts stop-cleanup for an intentionally hidden running target/u);
  assert.match(stateContract, /retained session history alone reports unknown/u);
  assert.match(stateContract, /the SDK's initial user `message_start` retains the direct request identity and never consumes queued identities/u);
  assert.match(stateContract, /Optimistic Agent rows reconcile one-to-one with normalized durable echoes/u);
  assert.match(stateContract, /a completed close cannot be bypassed by a late initial prompt/u);
  assert.match(stateContract, /reopening the same path cannot resurrect pre-close delivery/u);
  assert.match(titleContract, /model output is never published or written as a final name by the generation seam/u);
  assert.match(titleContract, /1–25 characters after trimming; automatic collision suffixes are additional/u);
});

test('protocol v11 browser-server network state remains host-global and separates actual from configured intent', async () => {
  const contract = await readFile(new URL('../../docs/contracts/STATE_CONTRACT.md', import.meta.url), 'utf8');
  assert.match(contract, /Browser Server Network State/u);
  assert.match(contract, /host-global authority for the one shared browser listener/u);
  assert.match(contract, /`setBrowserServerLanEnabled` and `setBrowserServerEnabled` renderer commands/u);
  assert.match(contract, /`lanEnabled` and `lanUrls` describe the currently running server instance/u);
  assert.match(contract, /`configuredLanEnabled` is the persisted LAN preference/u);
  assert.match(contract, /`configuredEnabled` is the persisted automatic-start preference/u);
  assert.match(contract, /`pendingEnabled` exposes the requested start\/stop value/u);
  assert.match(contract, /`changePending` plus `pendingLanEnabled`\/`pendingEnabled`/u);
  assert.match(contract, /`changeError` is a safe user-facing failure summary/u);
  assert.match(contract, /`serverToggleAvailable`/u);
  assert.match(contract, /Standalone hosts[^.]*never set it[^.]*fail closed/u);
  assert.match(contract, /must never implicitly start the server/u);
});

test('renderer reload suppression is terminal until meaningful activity or a new renderer', async () => {
  const contract = await readFile(new URL('../../docs/contracts/STATE_CONTRACT.md', import.meta.url), 'utf8');
  assert.match(contract, /per-renderer reload circuit uses a rolling wall-clock window that transcript commits cannot reset/u);
  assert.match(contract, /Once that circuit opens, automatic reload escalation stays terminally suppressed/u);
  assert.match(contract, /commits, readiness handshakes, visibility changes, automatic retries, and elapsed time do not reopen it/u);
  assert.match(contract, /A deliberate renderer command or a genuinely new\/resolved renderer starts a fresh recovery episode/u);
});

test('agent session-control messages retain user-role provenance through queue delivery and reload', async () => {
  const stateContract = await readFile(new URL('../../docs/contracts/STATE_CONTRACT.md', import.meta.url), 'utf8');
  const agentContract = await readFile(new URL('../../docs/contracts/AGENT-SESSION-CONTROL.md', import.meta.url), 'utf8');
  assert.match(stateContract, /Historical agent-originated `session_control` messages remain readable as user-role rows/u);
  assert.match(stateContract, /New assignment prompts are persisted as SDK user rows with authenticated sender, task ID\/revision and the actual requester identity/u);
  assert.match(stateContract, /The append boundary stamps `deliveredAt`; enqueue time does not/u);
  assert.match(stateContract, /Legacy `session_control message` rows and `pie\.agent-message-provenance` sidecars remain readable/u);
  assert.match(stateContract, /only exact validated envelopes are removed from model-facing prompts/u);
  assert.match(stateContract, /Duplicate observations cannot downgrade a delivered row/u);
  assert.match(stateContract, /New notes and task results are coordinator-authenticated `pie\.session-note` custom messages/u);
  assert.match(stateContract, /Notes \(16 KiB\) and results \(32 KiB\) use `triggerTurn:false` and never start an idle model turn/u);
  assert.match(stateContract, /New task completion is an explicit authenticated `session_finish` recorded by the coordinator, not a legacy automatic creator handoff/u);
  assert.match(stateContract, /Legacy cross-session message envelopes and sender-only provenance remain readable/u);
  assert.match(agentContract, /The assigned worker calls session_finish with its task ID and accepted revision/u);
  assert.match(agentContract, /Completed is the worker's claim for the requester to verify/u);
  assert.match(stateContract, /The header retains user-role rows while rendering Agent identity and Task\/Note\/Result cues/u);
});

test('user append bindings reconcile optimistic rows without changing delivery ownership', async () => {
  const contract = await readFile(new URL('../../docs/contracts/STATE_CONTRACT.md', import.meta.url), 'utf8');
  assert.match(contract, /exact `localId`\/`durableEntryId` binding for direct or queued prompts of any origin/u);
  assert.match(contract, /never promotes, reorders, or settles an operation/u);
  assert.match(contract, /even without a shared partial-window prefix/u);
  assert.match(contract, /an older snapshot omitting that entry preserves the pending row/u);
  assert.match(contract, /missing or fenced append identities never manufacture durability/u);
});

test('PROTOCOL_VERSION is a positive integer', () => {
  assert.equal(typeof PROTOCOL_VERSION, 'number');
  assert.ok(Number.isInteger(PROTOCOL_VERSION));
  assert.ok(PROTOCOL_VERSION >= 1);
});

test('DEFAULT_CHAT_PREFS shape', () => {
  assert.equal(typeof DEFAULT_CHAT_PREFS.autoExpandReasoning, 'boolean');
  assert.equal(typeof DEFAULT_CHAT_PREFS.autoExpandToolCalls, 'boolean');
  assert.equal(typeof DEFAULT_CHAT_PREFS.autoExpandSubagentCalls, 'boolean');
  assert.equal(typeof DEFAULT_CHAT_PREFS.suppressCompletionNotifications, 'boolean');
  assert.equal(typeof DEFAULT_CHAT_PREFS.subagentAlwaysParentModel, 'boolean');
  assert.deepEqual(DEFAULT_CHAT_PREFS.subagentBucketCanSpawn, {
    small: true,
    medium: true,
    frontier: true,
  });
  assert.equal(typeof DEFAULT_CHAT_PREFS.uiBackground, 'string');
  assert.equal(typeof DEFAULT_CHAT_PREFS.uiForeground, 'string');
  assert.equal(typeof DEFAULT_CHAT_PREFS.uiBorder, 'string');
  assert.equal(typeof DEFAULT_CHAT_PREFS.uiCornerRadius, 'number');
  assert.equal(DEFAULT_CHAT_PREFS.uiCornerRadius, 4);
  assert.equal(typeof DEFAULT_CHAT_PREFS.uiDensity, 'string');
  assert.equal(DEFAULT_CHAT_PREFS.uiDensity, 'compact');
  // These values are the current customized appearance promoted to the
  // bundled baseline; color overrides remain empty so the palette stays in CSS.
  assert.equal(typeof DEFAULT_CHAT_PREFS.uiBaseFontSize, 'number');
  assert.equal(DEFAULT_CHAT_PREFS.uiBaseFontSize, 11);
  assert.equal(typeof DEFAULT_CHAT_PREFS.uiComposerFontSize, 'number');
  assert.equal(DEFAULT_CHAT_PREFS.uiComposerFontSize, 11);
  assert.equal(DEFAULT_CHAT_PREFS.expandedSectionFontSize, 10);
  assert.equal(DEFAULT_CHAT_PREFS.uiFontMono, '"JetBrains Mono", "Cascadia Code", Consolas, monospace');
  assert.equal(DEFAULT_CHAT_PREFS.activityTailLines, 5);
  assert.equal(typeof DEFAULT_CHAT_PREFS.composerInitialRows, 'number');
  assert.equal(DEFAULT_CHAT_PREFS.composerInitialRows, 1);
  assert.equal(typeof DEFAULT_CHAT_PREFS.uiMutedColor, 'string');
  assert.equal(DEFAULT_CHAT_PREFS.uiMutedColor, '');
  assert.equal(typeof DEFAULT_CHAT_PREFS.uiLinkColor, 'string');
  assert.equal(DEFAULT_CHAT_PREFS.uiLinkColor, '');
  assert.equal(DEFAULT_CHAT_PREFS.uiPathParentDepth, 0);
});

test('resolveChatPrefs promotes new appearance defaults without resetting stored overrides', () => {
  const stored = {
    uiBaseFontSize: 15,
    uiComposerFontSize: 17,
    expandedSectionFontSize: 12,
    uiFontMono: 'Consolas, monospace',
    uiBackground: '#101820',
    uiCornerRadius: 12,
    uiDensity: 'spacious',
    uiMessageWidth: 100,
  } as unknown as Partial<import('../../application/lib/protocol/index.js').ChatPrefs>;

  const resolved = resolveChatPrefs(stored);
  assert.equal(resolved.uiBaseFontSize, 15);
  assert.equal(resolved.uiComposerFontSize, 17);
  assert.equal(resolved.expandedSectionFontSize, 12);
  assert.equal(resolved.uiFontMono, 'Consolas, monospace');
  assert.equal(resolved.uiBackground, '#101820');
  assert.equal(resolved.uiCornerRadius, 12);
  assert.equal(resolved.uiDensity, 'spacious');
  assert.equal(Object.prototype.hasOwnProperty.call(resolved, 'uiMessageWidth'), false);
});

test('resolveChatPrefs defaults and validates autonomous mode', () => {
  assert.equal(resolveChatPrefs().autonomousMode, false);
  assert.equal(resolveChatPrefs({ autonomousMode: true }).autonomousMode, true);
  assert.equal(resolveChatPrefs({ autonomousMode: 'yes' as never }).autonomousMode, false);
});

test('resolveChatPrefs defaults and validates the MCP toggle', () => {
  assert.equal(resolveChatPrefs().mcpEnabled, true);
  assert.equal(resolveChatPrefs({ mcpEnabled: false }).mcpEnabled, false);
  assert.equal(resolveChatPrefs({ mcpEnabled: 'off' as never }).mcpEnabled, true);
});

test('resolveChatPrefs preserves valid composer rows and defaults malformed stored values to one', () => {
  assert.equal(resolveChatPrefs({ composerInitialRows: 6 }).composerInitialRows, 6);
  for (const invalid of [0, 7, 1.5, Number.NaN, '3']) {
    assert.equal(
      resolveChatPrefs({ composerInitialRows: invalid as never }).composerInitialRows,
      1,
      `invalid stored composer row count ${String(invalid)} should use the default`,
    );
  }
});

test('resolveChatPrefs preserves valid path depth and defaults malformed stored values', () => {
  assert.equal(resolveChatPrefs({ uiPathParentDepth: 0 }).uiPathParentDepth, 0);
  assert.equal(resolveChatPrefs({ uiPathParentDepth: 8 }).uiPathParentDepth, 8);
  for (const invalid of [-1, 9, 1.5, Number.NaN, '2']) {
    assert.equal(resolveChatPrefs({ uiPathParentDepth: invalid as never }).uiPathParentDepth, 0);
  }
});

test('resolveChatPrefs backfills subagent auto-expand from legacy tool-call prefs', () => {
  assert.equal(resolveChatPrefs({ autoExpandToolCalls: true }).autoExpandSubagentCalls, true);
  assert.equal(
    resolveChatPrefs({ autoExpandToolCalls: true, autoExpandSubagentCalls: false }).autoExpandSubagentCalls,
    false,
  );
});

test('assertProtocolVersion accepts matches and rejects mismatches', () => {
  assert.doesNotThrow(() => {
    assertProtocolVersion('backend.ready', PROTOCOL_VERSION);
  });

  assert.throws(() => {
    assertProtocolVersion('backend.ready', PROTOCOL_VERSION + 1);
  }, /protocol mismatch/i);

  assert.throws(() => {
    assertProtocolVersion('backend.ready', 'not-a-number');
  }, /valid integer protocolVersion/i);
});

test('ModelInfo carries explicit inputKinds capability metadata', () => {
  const model: ModelInfo = {
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    reasoning: true,
    inputKinds: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
  };

  assert.deepEqual(model.inputKinds, ['text', 'image']);
});

test('ChatMessage.userParts supports structured user image content', () => {
  const message: ChatMessage = {
    id: 'user-1',
    role: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: 'Please inspect this screenshot',
    userParts: [
      { kind: 'text', text: 'Please inspect this screenshot' },
      {
        kind: 'image',
        mimeType: 'image/png',
        dataBase64: 'ZmFrZQ==',
        name: 'screenshot.png',
        width: 100,
        height: 50,
      },
    ],
    status: 'completed',
  };

  assert.equal(message.userParts?.[1]?.kind, 'image');
});

// ---------------------------------------------------------------------------
// Snapshot envelope contract: every state envelope carries hostInstanceId +
// per-renderer identity (rendererId/rendererGeneration) + revision. The
// webview uses these to detect host-side counter resets; cross-renderer
// revision comparison is never meaningful.
// ---------------------------------------------------------------------------

test('HostToWebviewMessage state envelope carries hostInstanceId and revision', () => {
  const msg: HostToWebviewMessage = {
    type: 'state',
    protocolVersion: 2,
    buildId: 'test-build',
    hostInstanceId: 'abc',
    rendererId: 'renderer-1',
    rendererGeneration: 1,
    viewGeneration: 2,
    revision: 7,
    expectedTranscriptIdentity: 'identity-7',
    snapshotBytes: 0,
    state: {
      sessions: [],
      openTabPaths: [],
      pinnedTabPaths: [],
      pinnedTabGroups: [],
      runningSessionPaths: [],
      sessionCapabilitiesBySession: {
        '/workspace/session.jsonl': {
          billableActivity: false,
          canContinue: true,
          canInterrupt: false,
          canCompact: true,
        },
      },
      generatingTitleSessionPaths: [],
      startingModelSessionPaths: [],
      compactingSessionPaths: [],
      lastCompactionBySession: {},
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
      sessionUsage: {
        freshness: 'fresh',
        refreshStatus: 'idle',
        samples: [{
          sourceId: 'assistant:durable-1',
          kind: 'assistant',
          modelId: 'gpt-5.4',
          provider: 'openai-codex',
          inputTokens: 1_000,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 1_100,
          reportedCostUsd: 0.01,
        }],
        pendingSamples: [{
          sourceId: 'assistant:stream-1',
          canonicalInvocationId: 'canonical-1',
          provisionalMessageId: 'stream-1',
          kind: 'conversation',
          modelId: 'gpt-5.4',
          provider: 'openai-codex',
          inputTokens: 1_000,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 1_100,
        }],
      },
      transcriptLoaded: false,
      pendingComposerInputs: [],
      activeRunSummary: null,
      runSummariesBySession: {},
      tokenRateBySession: {},
      workingTimeBySession: {},
      aggregateStats: {
        ...EMPTY_AGGREGATE_STATS,
        providerGate: {
          enabled: true,
          providers: [{
            provider: 'openai',
            activeRequests: 0,
            queuedRequests: 0,
            maxConcurrentRequests: 0,
            maxConcurrentRequestsSource: 'saved-preference',
            afterburnSeconds: 0,
            paused: false,
            pausedUntilMs: 0,
            strikeCount: 0,
          }],
          subagentConcurrency: {
            scope: 'worker-process',
            configured: { value: 8, source: 'configured-default' },
            workerCount: 1,
            pendingWorkers: 0,
          },
        },
      },
      deferredTriggers: [],
      draftText: '',
      busy: false,
      retryStatus: null,
      liveTurnPhase: null,
      notice: null,
      backendReady: false,
      workspaceCwd: null,
      systemPrompts: [],
      modelSettings: null,
      availableModels: [],
  availableModelsStatus: 'authoritative',
      contextUsage: null,
      initialContextEstimate: null,
      prefs: DEFAULT_CHAT_PREFS,
      mcpServers: [],
      mcpPendingApply: false,
      mcpSessionServers: [],
      mcpSessionPendingApply: false,
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
      toolResultPruningSettings: { ...DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, rules: { ...DEFAULT_TOOL_RESULT_PRUNING_SETTINGS.rules } },
      sessionTitlesSettings: { ...DEFAULT_SESSION_TITLES_SETTINGS },
      pruningCatalog: {
        skills: [],
        tools: [],
      },
      editingMessageId: null,
      pendingExtensionUIRequestsBySession: {},
      pendingExtensionUIRequest: null,
    },
  };
  assert.equal(msg.type, 'state');
  if (msg.type === 'state') {
    assert.equal(msg.hostInstanceId, 'abc');
    assert.equal(msg.rendererId, 'renderer-1', 'per-renderer identity is host-assigned');
    assert.equal(msg.rendererGeneration, 1, 'renderer reload/reconnect fence');
    assert.equal(msg.revision, 7);
    assert.equal(msg.state.sessionCapabilitiesBySession['/workspace/session.jsonl']?.canContinue, true);
    assert.deepEqual(msg.state.pendingComposerInputs, []);
    assert.equal(msg.state.activeRunSummary, null);
    assert.deepEqual(msg.state.runSummariesBySession, {});
    assert.equal(msg.state.sessionUsage?.samples[0]?.reportedCostUsd, 0.01);
    assert.equal(msg.state.sessionUsage?.freshness, 'fresh');
    assert.equal(msg.state.sessionUsage?.refreshStatus, 'idle');
    assert.equal(msg.state.sessionUsage?.pendingSamples?.[0]?.canonicalInvocationId, 'canonical-1');
    assert.equal(msg.state.sessionUsage?.pendingSamples?.[0]?.provisionalMessageId, 'stream-1');
    const transported = JSON.parse(JSON.stringify(msg)) as HostToWebviewMessage;
    assert.equal(transported.type, 'state');
    if (transported.type !== 'state') return;
    assert.equal(transported.state.aggregateStats.providerGate.providers[0]?.maxConcurrentRequestsSource, 'saved-preference');
    assert.deepEqual(transported.state.aggregateStats.providerGate.subagentConcurrency, {
      scope: 'worker-process',
      configured: { value: 8, source: 'configured-default' },
      workerCount: 1,
      pendingWorkers: 0,
    });
  }
});

test('host-webview sync carries session.open/session.close and lifecycle transition phases', () => {
  const lifecycleOperations: NonNullable<SessionCapabilities['primaryOperation']>[] = [
    {
      operationId: 'open-operation', kind: 'session.open', phase: 'awaiting-acceptance',
      attempt: 1, committed: false, recovery: null,
    },
    {
      operationId: 'close-operation', kind: 'session.close', phase: 'awaiting-commit',
      attempt: 1, committed: true, recovery: 'reconcile',
    },
    {
      operationId: 'restart-operation', kind: 'backend.restart', phase: 'draining',
      attempt: 1, committed: false, recovery: null,
    },
    {
      operationId: 'restart-operation', kind: 'backend.restart', phase: 'awaiting-old-generation-death',
      attempt: 1, committed: false, recovery: null,
    },
  ];

  const sessionCapabilitiesBySession: ViewState['sessionCapabilitiesBySession'] = Object.fromEntries(
    lifecycleOperations.map((primaryOperation, index) => [`/session-${index}.jsonl`, {
      billableActivity: false,
      canContinue: false,
      canInterrupt: false,
      canCompact: false,
      primaryOperation,
    }]),
  );
  assert.deepEqual(
    Object.values(sessionCapabilitiesBySession).map((capabilities) => capabilities.primaryOperation?.phase),
    ['awaiting-acceptance', 'awaiting-commit', 'draining', 'awaiting-old-generation-death'],
  );
  assert.deepEqual(
    Object.values(sessionCapabilitiesBySession).slice(0, 2).map((capabilities) => capabilities.primaryOperation?.kind),
    ['session.open', 'session.close'],
  );
});

test('typed agent close bridge: stop-cleanup mode, coordinator-side fence, typed host acknowledgement, and host membership stay in contract', async () => {
  const contract = await readFile(new URL('../../docs/contracts/STATE_CONTRACT.md', import.meta.url), 'utf8');
  // Running-session close removes the tab and stops work; intentional hide is
  // a separate renderer-recovery mechanism, not the close behavior.
  assert.match(contract, /Closing a \*\*running\*\* session removes and persists its tab immediately/u);
  assert.match(contract, /UI ×, tool, and private closes stop active and queued work rather than hiding a running session/u);
  assert.match(contract, /intentional-hide intent/u);
  assert.match(contract, /typed agent close \(`agent-session-control` source\)/u);
  assert.match(contract, /is fenced by the coordinator against new execution admission/u);
  assert.match(contract, /coordinator emits `session\.close\.requested`/u);
  assert.match(contract, /bounded `session\.closeAcknowledgement` RPC/u);
  assert.match(contract, /reported as close requested, never as already closed/u);
  assert.match(contract, /The accepted acknowledgement is an ingress-fixed reducer effect/u);
  assert.match(contract, /For self-close, the caller receives `close requested`, then `session\.close\.responseDelivered` releases host-owned stop\/cleanup/u);
  assert.match(contract, /Closing a pending create\/duplicate cancels queued sends/u);
  assert.match(contract, /late durable creation is cleaned up rather than reopened/u);
  // Host open-tab membership is the single live authority, projected through
  // the ordered snapshot; the coordinator never consults closed history.
  assert.match(contract, /open-tab list plus its non-terminal close operations are the only live-membership authority/u);
  assert.match(contract, /ordered `session\.liveMembership` snapshot/u);
  assert.match(contract, /closed history is never revived \(ordinary user reopen restores admission\)/u);
  assert.match(contract, /a non-terminal close reservation remains visible for close joining but fences other new requests/u);
  // Close modes stay ingress-fixed; stop-cleanup joins the existing reducer
  // barrier instead of a parallel ledger.
  assert.match(contract, /`session\.close` fixes its mode at ingress/u);
  assert.match(contract, /joins an already-active reducer interrupt or starts one/u);
  assert.match(contract, /typed host close bridge acknowledgement effect exactly once/u);
  assert.match(contract, /restores the surviving tab without stealing focus or reissuing the close, while committed deletions are never restored/u);
});

test('all idle conversation tails project explicit continuation capability without creating user input', async () => {
  const { buildIdleSessionCapabilities } = await import('../../harness/agent-processes/workers/session-activity.js');
  for (const stopReason of ['stop', 'length', 'aborted', 'error', 'toolUse']) {
    const capabilities: SessionCapabilities = buildIdleSessionCapabilities([
      { role: 'user', content: 'work' },
      { role: 'assistant', stopReason, content: [{ type: 'text', text: 'answer' }] },
    ]);
    assert.equal(capabilities.canContinue, true);
    assert.equal(capabilities.billableActivity, false);
  }
  assert.equal(buildIdleSessionCapabilities([
    { role: 'user', content: 'work' },
    { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'tool-1', name: 'read' }] },
  ]).canContinue, true);
  assert.equal(buildIdleSessionCapabilities([
    { role: 'user', content: 'work' }, { role: 'custom', customType: 'note', content: 'extension context' },
  ]).canContinue, true);
  assert.equal(buildIdleSessionCapabilities([]).canContinue, false);
  const contract = await readFile(new URL('../../docs/contracts/STATE_CONTRACT.md', import.meta.url), 'utf8');
  assert.match(contract, /completed assistant reply preserves that reply in provider context/u);
  assert.match(contract, /any idle session with nonempty conversation context/u);
  assert.match(contract, /first prompt requires text or an attachment/u);
  assert.match(contract, /without adding a user message/u);
});

test('ContextUsageChangedPayload carries nullable live usage per session', () => {
  const update: ContextUsageChangedPayload = {
    sessionPath: '/workspace/session.jsonl',
    contextUsage: { tokens: 1234, contextWindow: 200000, percent: 0.617 },
  };
  const cleared: ContextUsageChangedPayload = {
    sessionPath: '/workspace/session.jsonl',
    contextUsage: null,
  };

  assert.equal(update.contextUsage?.tokens, 1234);
  assert.equal(cleared.contextUsage, null);
});

test('SessionOpenedPayload can carry structured analytics factors', () => {
  const analyticsFactors: SessionAnalyticsFactors = {
    promptFamily: 'harness+customPrompt',
    promptHash: 'prompt-hash',
  promptCapturedAt: '2025-06-15T10:30:00.000Z',
    harnessPromptHash: 'harness-hash',
    customPromptHash: 'custom-hash',
    appendSystemPromptHash: null,
    promptGuidelineHashes: ['guideline-hash'],
    contextFiles: [{ path: '/workspace/context.md', hash: 'context-hash' }],
    selectedToolIds: ['read', 'bash'],
    toolSnippetHashes: [{ toolId: 'bash', hash: 'tool-snippet-hash' }],
    toolSetHash: 'tool-set-hash',
    skills: [{
      name: 'frontend-design',
      contentHash: 'skill-hash',
      sourceHash: 'skill-source-hash',
      disableModelInvocation: false,
      lastModifiedAt: null,
    }],
    skillSetHash: 'skill-set-hash',
    activeExtensions: ['subagent'],
  };

  const payload: SessionOpenedPayload = {
    session: {
      path: '/workspace/session.jsonl',
      name: 'Session',
      cwd: '/workspace',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 2,
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
    capabilities: {
      billableActivity: false,
      canContinue: true,
      canInterrupt: false,
      canCompact: true,
    },
    analyticsFactors,
  };

  assert.equal(payload.capabilities?.canContinue, true);
  assert.equal(payload.analyticsFactors?.promptHash, 'prompt-hash');
  assert.equal(payload.analyticsFactors?.selectedToolIds[0], 'read');
});

test('cold opens publish the conversation independently of token-fenced prompt inventory', async () => {
  const contract = await readFile(new URL('../../docs/contracts/STATE_CONTRACT.md', import.meta.url), 'utf8');
  assert.match(contract, /publishes the durable conversation and acknowledges without waiting for prompt\/tool inventory/u);
  assert.match(contract, /Background `session.preload` loads the durable snapshot without inventory/u);
  const { isSessionPromptInventoryPayload, isSessionOpenedPayload } = await import('../../harness/agent-processes/lib/rpc/event-payload-validation.js');
  const opened: SessionOpenedPayload = {
    session: { path: '/cold.jsonl', name: 'Cold', cwd: '/workspace', modifiedAt: '', messageCount: 0 },
    transcript: [],
    transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
    busy: false, runtimeReady: false,
    capabilities: { billableActivity: false, canContinue: false, canInterrupt: false, canCompact: true },
    promptInventoryToken: 'inventory:1',
  };
  assert.equal(isSessionOpenedPayload(opened), true);
  assert.equal(opened.systemPrompts, undefined);
  const inventory: SessionPromptInventoryPayload = {
    sessionPath: opened.session.path, token: opened.promptInventoryToken!,
    systemPrompts: [{ source: 'harness', availability: 'available', title: 'Harness',
      text: 'Complete prompt text.', summary: 'Complete prompt text.', disabled: true }],
    initialContextEstimate: { tokens: 123, contextWindow: 200_000 },
  };
  assert.equal(isSessionPromptInventoryPayload(inventory), true);
  assert.equal(isSessionPromptInventoryPayload({ ...inventory, token: '' }), false);
  assert.equal(isSessionPromptInventoryPayload({ ...inventory, systemPrompts: [{ title: 'Incomplete' }] }), false);
  assert.equal(isSessionPromptInventoryPayload({ ...inventory, initialContextEstimate: { tokens: -1, contextWindow: 200_000 } }), false);
});

test('cold mutation SessionOpenedPayload carries complete prompt catalog, disabled state, and optional estimate together', () => {
  const payload: SessionOpenedPayload = {
    session: {
      path: '/workspace/session.jsonl', name: 'Session', cwd: '/workspace',
      modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 0,
    },
    transcript: [],
    transcriptWindow: {
      totalCount: 0, loadedStart: 0, loadedEnd: 0,
      hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false,
    },
    busy: false,
    capabilities: { billableActivity: false, canContinue: false, canInterrupt: false, canCompact: true },
    runtimeReady: false,
    systemPrompts: [{
      source: 'harness', id: 'harness', title: 'Harness system prompt',
      text: 'Complete discovered prompt.', summary: 'Complete discovered prompt.',
      availability: 'available', disabled: true,
    }],
    systemPromptDisabledEntries: ['harness'],
    initialContextEstimate: { tokens: 123, contextWindow: 200_000 },
  };

  assert.equal(payload.systemPrompts?.[0]?.text, 'Complete discovered prompt.');
  assert.equal(payload.systemPrompts?.[0]?.disabled, true);
  assert.deepEqual(payload.systemPromptDisabledEntries, ['harness']);
  assert.equal(payload.initialContextEstimate?.tokens, 123);
});

test('ToolFinishedPayload carries normalized failure status', () => {
  const payload: ToolFinishedPayload = {
    requestId: 'request-1',
    sessionPath: '/workspace/session.jsonl',
    messageId: 'message-1',
    toolCallId: 'tool-1',
    result: { ok: false },
    status: 'failed',
  };

  assert.equal(payload.status, 'failed');
});

// ---------------------------------------------------------------------------
// Webview-to-host setPrefs envelope: prefs now live on the host (globalState)
// and changes flow as a typed RPC, replacing the old localStorage path.
// ---------------------------------------------------------------------------

test('WebviewToHostMessage.setPrefs accepts partial pref updates', () => {
  const msg: WebviewToHostMessage = {
    type: 'setPrefs',
    prefs: {
      autoExpandReasoning: true,
      autoExpandSubagentCalls: true,
      suppressCompletionNotifications: true,
      subagentBucketCanSpawn: { small: false, medium: false, frontier: true },
    },
  };
  assert.equal(msg.type, 'setPrefs');
  if (msg.type === 'setPrefs') {
    assert.equal(msg.prefs.autoExpandReasoning, true);
    assert.equal(msg.prefs.autoExpandSubagentCalls, true);
    assert.equal(msg.prefs.suppressCompletionNotifications, true);
    assert.deepEqual(msg.prefs.subagentBucketCanSpawn, { small: false, medium: false, frontier: true });
  }
});

test('WebviewToHostMessage.setModel can target an explicit session path', () => {
  const msg: WebviewToHostMessage = {
    type: 'setModel',
    sessionPath: '/workspace/session.jsonl',
    defaultModel: 'claude-sonnet-4-5',
    defaultThinkingLevel: 'medium',
  };
  assert.equal(msg.type, 'setModel');
  if (msg.type === 'setModel') {
    assert.equal(msg.sessionPath, '/workspace/session.jsonl');
    assert.equal(msg.defaultModel, 'claude-sonnet-4-5');
    assert.equal(msg.defaultThinkingLevel, 'medium');
  }
});

test('WebviewToHostMessage.addComposerInput accepts a raw input without an id', () => {
  const input: ComposerInput = {
    id: 'input-1',
    kind: 'filesystemPathRef',
    path: '/workspace/a.ts',
    name: 'a.ts',
    source: 'picker',
  };

  const msg: WebviewToHostMessage = {
    type: 'addComposerInput',
    sessionPath: '/workspace/session.jsonl',
    input: {
      kind: input.kind,
      path: input.path,
      name: input.name,
      source: input.source,
    },
  };

  assert.equal(msg.type, 'addComposerInput');
  if (msg.type === 'addComposerInput') {
    assert.equal(msg.sessionPath, '/workspace/session.jsonl');
    assert.ok(!('id' in msg.input));
    assert.equal(msg.input.kind, 'filesystemPathRef');
  }
});

test('WebviewToHostMessage.removeComposerInput targets an assigned input id', () => {
  const msg: WebviewToHostMessage = {
    type: 'removeComposerInput',
    sessionPath: '/workspace/session.jsonl',
    inputId: 'input-1',
  };

  assert.equal(msg.type, 'removeComposerInput');
  if (msg.type === 'removeComposerInput') {
    assert.equal(msg.sessionPath, '/workspace/session.jsonl');
    assert.equal(msg.inputId, 'input-1');
  }
});

test('WebviewToHostMessage.send carries an explicit sessionPath', () => {
  const msg: WebviewToHostMessage = {
    type: 'send',
    sessionPath: '/workspace/session.jsonl',
    text: 'hello',
  };
  assert.equal(msg.type, 'send');
  if (msg.type === 'send') {
    assert.equal(msg.sessionPath, '/workspace/session.jsonl');
    assert.equal(msg.text, 'hello');
  }
});

test('WebviewToHostMessage.truncateAfter is explicitly session-addressed (no active-session fallback)', () => {
  const msg: WebviewToHostMessage = {
    type: 'truncateAfter',
    sessionPath: '/workspace/session.jsonl',
    messageId: 'durable-entry-1',
  };
  assert.equal(msg.type, 'truncateAfter');
  if (msg.type === 'truncateAfter') {
    assert.equal(msg.sessionPath, '/workspace/session.jsonl');
    assert.equal(msg.messageId, 'durable-entry-1');
    // Destructive truncations must name their session; there is no implicit
    // fallback to the viewed/active session (see STATE_CONTRACT session
    // mutations bullet).
    assert.ok('sessionPath' in msg);
    assert.ok('messageId' in msg);
  }
});

test('HostToWebviewMessage.sendRejected carries the text draft payload and optional composer inputs', () => {
  // Minimal shape: sendRejected can be constructed with only the text draft
  // payload (a text-only send rejection carries no inputs).
  const msg: HostToWebviewMessage = {
    type: 'sendRejected',
    sessionPath: '/workspace/a.ts',
    text: 'hello',
  };
  assert.equal(msg.type, 'sendRejected');
  if (msg.type === 'sendRejected') {
    assert.equal(msg.sessionPath, '/workspace/a.ts');
    assert.equal(msg.text, 'hello');
    // inputs is optional — absent for a text-only rejection.
    assert.equal(msg.inputs, undefined);
  }

  // Full shape: a send rejection carrying pasted/dropped attachments so the
  // webview can restore them to the composer (no data loss on rollback).
  const withInputs: HostToWebviewMessage = {
    type: 'sendRejected',
    sessionPath: '/workspace/a.ts',
    text: 'hello',
    inputs: [{ id: 'in1', kind: 'filesystemPathRef', path: '/f', name: 'f', source: 'picker' }],
  };
  if (withInputs.type === 'sendRejected') {
    assert.equal(withInputs.inputs?.length, 1);
    assert.equal(withInputs.inputs?.[0]?.id, 'in1');
  }
});

test('detail.subscribe/unsubscribe/fetchPages carry the required renderer owner identity', () => {
  // `viewGeneration`, `detailKey`, and `detailAttempt` are REQUIRED (not
  // optional wrapper fields): the host records the exact renderer owner before
  // forwarding stream content. The webview mints the attempt; the host returns
  // its subscription ID inside `detail.start`.
  const subscribe: WebviewToHostMessage = {
    type: 'detail.subscribe',
    viewGeneration: 7,
    detailKey: 'subagent:msg-1:tool-1',
    detailAttempt: 4,
    address: {
      sessionPath: '/workspace/session.jsonl',
      turnId: 'turn-1',
      rootToolCallId: 'tool-1',
      rootAttemptId: 'attempt-1',
      lineage: [{ childId: 'child-1', spawningToolCallId: 'tool-1', attemptId: 'attempt-1' }],
    },
    cursor: { revision: 3, pageIndex: 0 },
  };
  assert.equal(subscribe.type, 'detail.subscribe');
  if (subscribe.type === 'detail.subscribe') {
    assert.equal(subscribe.viewGeneration, 7);
    assert.equal(subscribe.detailKey, 'subagent:msg-1:tool-1');
    assert.equal(subscribe.detailAttempt, 4);
    assert.equal(subscribe.address.rootToolCallId, 'tool-1');
    assert.deepEqual(subscribe.cursor, { revision: 3, pageIndex: 0 });
  }

  const unsubscribe: WebviewToHostMessage = {
    type: 'detail.unsubscribe',
    viewGeneration: 7,
    detailKey: 'subagent:msg-1:tool-1',
    detailAttempt: 4,
    reason: 'collapse',
  };
  assert.equal(unsubscribe.type, 'detail.unsubscribe');
  if (unsubscribe.type === 'detail.unsubscribe') {
    assert.equal(unsubscribe.detailAttempt, 4);
    assert.equal(unsubscribe.reason, 'collapse');
  }

  const fetchPages: WebviewToHostMessage = {
    type: 'detail.fetchPages',
    viewGeneration: 7,
    detailKey: 'subagent:msg-1:tool-1',
    detailAttempt: 4,
    ref: { baselineRevision: 5, pageIndex: 3, pageCount: 8 },
  };
  assert.equal(fetchPages.type, 'detail.fetchPages');
  if (fetchPages.type === 'detail.fetchPages') {
    assert.equal(fetchPages.detailAttempt, 4);
    assert.deepEqual(fetchPages.ref, { baselineRevision: 5, pageIndex: 3, pageCount: 8 });
  }
});

test('HostToWebviewMessage detail stream variants carry the full HostDetailRoute', () => {
  // The six stream variants are the ONLY stream content: every message
  // carries the full route so a stale or cross-key message can never be
  // applied to the wrong expanded subtree. Pages/deltas never enter
  // `ViewState`; they cross only as these imperatives. v7: the route carries
  // trusted renderer identity plus the webview owner attempt; the complete
  // ownership key is `{hostInstanceId, viewGeneration, rendererId,
  // rendererGeneration, detailKey, detailAttempt}`.
  const route = {
    hostInstanceId: 'host-instance-1',
    hostGeneration: 0,
    viewGeneration: 7,
    rendererId: 'renderer-1',
    rendererGeneration: 2,
    backendGeneration: 3,
    coordinatorGeneration: 1,
    workerId: 'worker-1',
    workerGeneration: 1,
    detailKey: 'subagent:msg-1:tool-1',
    detailAttempt: 4,
    subscriptionId: 'subscription-1',
  };

  const start: HostToWebviewMessage = {
    type: 'detail.start',
    ...route,
    address: {
      sessionPath: '/workspace/session.jsonl',
      turnId: 'turn-1',
      rootToolCallId: 'tool-1',
      rootAttemptId: 'attempt-1',
      lineage: [{ childId: 'child-1', spawningToolCallId: 'tool-1', attemptId: 'attempt-1' }],
    },
    source: 'live',
    baselineRevision: 1,
    pageCount: 1,
    totalBytes: 4,
    totalCodePoints: 4,
  };
  assert.equal(start.type, 'detail.start');
  if (start.type === 'detail.start') {
    assert.equal(start.source, 'live');
    assert.equal(start.subscriptionId, 'subscription-1');
    assert.equal(start.totalCodePoints, 4);
    assert.equal(start.backendGeneration, 3);
  }

  const page: HostToWebviewMessage = {
    type: 'detail.page',
    ...route,
    ref: { baselineRevision: 1, pageIndex: 0, pageCount: 1 },
    payload: {
      kind: 'json-segment', encoding: 'utf8-json', segmentId: 'segment-1', semanticPath: [],
      startByte: 0, endByte: 4, totalBytes: 4, startCodePoint: 0, endCodePoint: 4, totalCodePoints: 4,
      text: 'null',
    },
    payloadBytes: 4,
    checksum: 'c'.repeat(64),
  };
  assert.equal(page.type, 'detail.page');
  if (page.type === 'detail.page') {
    assert.equal(page.ref.pageIndex, 0);
    assert.equal(page.workerGeneration, 1);
  }

  const delta: HostToWebviewMessage = {
    type: 'detail.delta',
    ...route,
    baseRevision: 1,
    revision: 2,
    operations: [{ op: 'set', path: ['exitCode'], value: 0 }],
  };
  assert.equal(delta.type, 'detail.delta');
  if (delta.type === 'detail.delta') {
    assert.deepEqual(delta.operations, [{ op: 'set', path: ['exitCode'], value: 0 }]);
  }

  const rebase: HostToWebviewMessage = { type: 'detail.rebase', ...route, currentRevision: 4, reason: 'gap' };
  assert.equal(rebase.type, 'detail.rebase');
  if (rebase.type === 'detail.rebase') {
    assert.equal(rebase.reason, 'gap');
    assert.equal(rebase.currentRevision, 4);
  }

  const terminal: HostToWebviewMessage = {
    type: 'detail.terminal',
    ...route,
    revision: 5,
    durableRef: {
      sessionPath: '/workspace/session.jsonl',
      messageId: 'msg-1',
      key: 'durable:tool:msg-1:tool-1',
      kind: 'tool-result',
      source: 'durable',
      sizeBytes: 1024,
      summary: 'exit code 0',
      available: true,
    },
  };
  assert.equal(terminal.type, 'detail.terminal');
  if (terminal.type === 'detail.terminal') {
    assert.equal(terminal.durableRef.key, 'durable:tool:msg-1:tool-1');
    assert.equal(terminal.revision, 5);
  }

  const error: HostToWebviewMessage = {
    type: 'detail.error',
    ...route,
    code: 'NOT_FOUND',
    message: 'The subagent detail is no longer addressable.',
    retryable: false,
  };
  assert.equal(error.type, 'detail.error');
  if (error.type === 'detail.error') {
    assert.equal(error.retryable, false);
    assert.equal(error.subscriptionId, 'subscription-1');
  }
});

test('webview behavior contract: collapsed cards never subscribe; expansion subscribes once; collapse unsubscribes', () => {
  // STATE_CONTRACT § Ordinary state transport: a collapsed subagent card
  // renders only its bounded compact preview and sends NO detail.subscribe;
  // expansion sends exactly one subscribe carrying the current
  // viewGeneration/detailKey/detailAttempt/address; collapse — including during the close
  // animation — immediately unsubscribes. This is the webview-side half of
  // the Phase 5 contract (the host half is covered by the detail stream
  // route tests above).
  const {
    clearDetailSubscriptionStore,
    closeDetailSubscription,
    openDetailSubscription,
    setDetailStoreContext,
  } = require('../../application/frontend/transcript/detail-subscription-store') as typeof import('../../application/frontend/transcript/detail-subscription-store');
  clearDetailSubscriptionStore();
  const posts: WebviewToHostMessage[] = [];
  setDetailStoreContext({ hostInstanceId: 'h1', viewGeneration: 9, rendererId: 'renderer-1', rendererGeneration: 1, postMessage: (message) => posts.push(message) });

  const address: LiveSubagentDetailAddress = {
    sessionPath: '/workspace/session.jsonl',
    turnId: 'turn-1',
    rootToolCallId: 'tool-1',
    rootAttemptId: 'attempt-1',
    lineage: [{ childId: 'child-1', spawningToolCallId: 'tool-1', attemptId: 'attempt-1' }],
  };

  // Collapsed: nothing posted.
  assert.equal(posts.length, 0, 'collapsed state is subscription-free');

  // Expansion: exactly one subscribe with the current generation + key + address.
  openDetailSubscription({ detailKey: 'subagent:msg-1:tool-1', address });
  openDetailSubscription({ detailKey: 'subagent:msg-1:tool-1', address });
  assert.equal(posts.length, 1, 're-expansion of the same owner is idempotent');
  const subscribe = posts[0];
  assert.equal(subscribe.type, 'detail.subscribe');
  if (subscribe.type === 'detail.subscribe') {
    assert.equal(subscribe.viewGeneration, 9);
    assert.equal(subscribe.detailKey, 'subagent:msg-1:tool-1');
    assert.equal(subscribe.detailAttempt, 1);
    assert.equal(subscribe.address.rootToolCallId, 'tool-1');
  }

  // Collapse: immediate unsubscribe (also during the close animation).
  closeDetailSubscription('subagent:msg-1:tool-1', 'collapse');
  assert.equal(posts.length, 2);
  const unsubscribe = posts[1];
  assert.equal(unsubscribe.type, 'detail.unsubscribe');
  if (unsubscribe.type === 'detail.unsubscribe') {
    assert.equal(unsubscribe.viewGeneration, 9);
    assert.equal(unsubscribe.detailAttempt, 1);
    assert.equal(unsubscribe.reason, 'collapse');
  }
  closeDetailSubscription('subagent:msg-1:tool-1', 'unmount');
  assert.equal(posts.length, 2, 'unmount after collapse does not double-post');
});

test('image viewer actions are targeted platform effects with actual host capabilities', async () => {
  const contract = await readFile(new URL('../../docs/contracts/STATE_CONTRACT.md', import.meta.url), 'utf8');
  assert.match(contract, /type:'performImageAction'/u);
  assert.match(contract, /type:'imageActionResult'/u);
  assert.match(contract, /ViewState.imageActionCapabilities/u);
  assert.match(contract, /checked before execution and after completion/u);
  assert.match(contract, /results never fall back to broadcast/u);
  assert.match(contract, /browser transport does not invent native clipboard or file-shell support/u);
});

test('local file open serves capability-scoped folders on one verified host report listener', async () => {
  const contract = await readFile(new URL('../../docs/contracts/STATE_CONTRACT.md', import.meta.url), 'utf8');
  assert.match(contract, /type:'prepareLocalFileOpen', requestId, path, reference\?, workingDirectory\?/u);
  assert.match(contract, /type:'localFileOpenResult', requestId, status:'ready'\|'unavailable'/u);
  assert.match(contract, /Results answer the initiating renderer only/u);
  assert.match(contract, /isolation goal is per host listener, not per report/u);
  assert.match(contract, /exactly one report HTTP listener/u);
  assert.match(contract, /mints a random capability prefix under that listener/u);
  assert.match(contract, /files canonically contained in its parent directory/u);
  assert.match(contract, /exact `Host` header/u);
  assert.match(contract, /a local `\[::1\]` report host is normalized to `127\.0\.0\.1` so the URL matches the IPv4-only report binding/u);
  assert.match(contract, /self-verifies a successful entry response/u);
  assert.match(contract, /answered `unavailable` without preparing anything/u);
  assert.match(contract, /Capabilities expire after two minutes without an accepted request/u);
  assert.match(contract, /revoking the final capability closes the report listener/u);
  assert.match(contract, /never outlives host shutdown, a browser-server stop, or a LAN policy change/u);
  assert.match(contract, /image chips keep the image viewer and image actions, non-HTML files keep the normal editor open/u);
});

test('renderer-local image previews extend only to bounded inline Markdown raster presentation', async () => {
  const contract = await readFile(new URL('../../docs/contracts/STATE_CONTRACT.md', import.meta.url), 'utf8');
  assert.match(contract, /same narrow allowance covers inline presentation of local Markdown raster images/u);
  assert.match(contract, /targeted, bounded `imagePreviewResult` imperative/u);
  assert.match(contract, /Markdown parsing and content caches remain pure and retain only the reference\/placeholder/u);
  assert.match(contract, /cancelled or discarded when the session, cwd, renderer root, or connection changes/u);
  assert.match(contract, /Loading is bounded; unavailable, timed-out, or invalid images retain a readable text fallback/u);
  assert.match(contract, /never copied into `ViewState`, snapshots, or durable state/u);
});

test('changed-files peek/hover overlay is webview-local, not host state', () => {
  // STATE_CONTRACT § Webview-Local State: the changed-files rail's transient
  // peek/hover overlay is webview-local (analogous to contextMenu) and must
  // not cross the host↔webview boundary. Only the durable pin
  // (ViewState.fileChangesExpanded) is host state. This type-level assertion
  // fails to compile if a peek field is ever promoted into ViewState — the
  // signal to update STATE_CONTRACT and reconsider the boundary.
  type PeekField = Extract<keyof ViewState, `fileChangesPeek${string}`>;
  const isWebviewLocal: [PeekField] extends [never] ? true : false = true;
  assert.equal(isWebviewLocal, true);
});
