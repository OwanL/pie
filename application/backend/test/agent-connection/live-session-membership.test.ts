import assert from 'node:assert/strict';
import test from 'node:test';

import type { ArchState } from '../../conversation-state/arch-state';
import type { SessionSummary } from '../../../lib/protocol/index.js';
import type { CloseSessionCommand } from '../../conversation-state/commands';
import type { SessionOperationSource } from '../../conversation-state/operation-types';
import { handleCloseSession } from '../../conversation-state/reducers/command-session-handlers';
import { createInitialArchState } from '../../conversation-state/arch-state';
import type { LiveSessionClosingEntry } from '../../../../harness/agent-processes/lib/rpc/live-session-control';
import {
  HostLiveMembershipSync,
  hostLiveMembershipFingerprint,
  projectHostLiveMembership,
} from '../../agent-connection/live-session-membership';
import { isPendingTabPath } from '../../../../lib/session-path';

const LIVE = '/workspace/live.jsonl';
const IDLE = '/workspace/idle.jsonl';
const CLOSING = '/workspace/closing.jsonl';

function sessionSummary(path: string, overrides: Record<string, unknown> = {}): SessionSummary {
  return {
    path,
    name: `${path}`,
    cwd: '/workspace',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 3,
    sessionId: 'session-id-1',
    ...overrides,
  };
}

function baseState(...tabPaths: string[]): ArchState {
  const state = createInitialArchState();
  return {
    ...state,
    sessions: {
      ...state.sessions,
      sessions: tabPaths.map((path) => sessionSummary(path)),
      openTabPaths: [...tabPaths],
      activeSessionPath: tabPaths[0] ?? null,
      workspaceCwd: '/workspace',
    },
  };
}

const flush = async (times = 4): Promise<void> => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

test('projection exposes activity, request timing, usage, and assigned titles with explicit availability', () => {
  const state = baseState(LIVE);
  (state.sessions.sessions[0] as unknown as Record<string, unknown>).isAssignedTitle = true;
  (state.sessions as { runningSessionPaths: string[] }).runningSessionPaths = [LIVE];
  // Transcript projection deliberately disagrees with the stats authority:
  // the live membership must not substitute this renderer cache.
  state.transcript.sessionUsageBySession = {
    [LIVE]: { samples: [{ reportedCostUsd: 999 }], freshness: 'fresh' } as never,
  };
  state.livePipeline.turnsBySession[LIVE] = {
    turnId: 'turn-1', attemptId: 'attempt-1', requestId: 'request-1', sessionPath: LIVE,
    canonicalMessageId: 'message-1', seq: 1, checkpointSeq: 1, phase: 'streaming',
    startedAt: 500, phaseSince: 900, lastSemanticProgressAt: 900,
    parts: [], textBytes: 0, reasoningBytes: 0, aggregatePreviewBytes: 0, activeToolPreviewBytes: 0,
  } as never;
  state.livePipeline.toolsByExecutionId = {
    'exec-1': {
      executionId: 'exec-1', parentExecutionId: null, rootExecutionId: 'exec-1', turnId: 'turn-1',
      transcriptToolCallId: 'call-1', attemptId: 'attempt-1', seq: 1, phase: 'running', name: 'bash',
      immutableInput: {}, startedAt: 600, phaseSince: 600, lastProgressAt: 600, previewBytes: 0,
    } as never,
    'exec-2': {
      executionId: 'exec-2', parentExecutionId: 'exec-1', rootExecutionId: 'exec-1', turnId: 'turn-1',
      transcriptToolCallId: 'call-2', attemptId: 'attempt-1', seq: 2, phase: 'running', name: 'subagent',
      immutableInput: {}, startedAt: 610, phaseSince: 610, lastProgressAt: 610, previewBytes: 0,
    } as never,
    'exec-3': {
      executionId: 'exec-3', parentExecutionId: null, rootExecutionId: 'exec-3', turnId: 'turn-1',
      transcriptToolCallId: 'call-3', attemptId: 'attempt-1', seq: 3, phase: 'running', name: 'subagent',
      immutableInput: {}, startedAt: 620, phaseSince: 620, lastProgressAt: 620,
      previewBytes: 0, executionEnd: { status: 'completed', at: 630 },
    } as never,
  } as never;
  state.pending.promoted['send-owner'] = {
    sessionPath: LIVE, requestId: 'request-1', startedAt: 400, queued: false,
  } as never;

  const snapshot = projectHostLiveMembership(state, {
    getWorkingTime: () => ({ accumulatedMs: 4200, activeSince: 700 }),
    getSessionUsage: () => ({
      authority: 'canonical',
      samples: [
        { sourceId: 'reported', reportedCostUsd: 0.5 },
        { sourceId: 'estimated', calculatedCostUsd: 0.1 },
      ],
      freshness: 'stale',
      unpricedInvocationCount: 1,
      incompleteInvocationCount: 2,
    } as never),
  });
  assert.equal(snapshot.sessions.length, 1);
  const entry = snapshot.sessions[0];
  assert.equal(entry.path, LIVE);
  assert.equal(entry.name, LIVE);
  // Assigned titles resolve directly through the existing durable assignment.
  assert.equal(entry.title, LIVE);
  assert.equal(entry.activity, 'running');
  // Use the current request owner timestamp, not assistant-turn start.
  assert.equal(entry.requestStartedAt, 400);
  // Live nested tool and subagent calls overlap; settled executions do not count.
  assert.equal(entry.runningTools, 2);
  assert.equal(entry.runningSubagents, 1);
  assert.ok(entry.usage);
  assert.equal(entry.usage.freshness, 'stale');
  assert.equal(entry.usage.unpricedInvocations, 1);
  assert.equal(entry.usage.incompleteInvocations, 2);
  assert.equal(entry.usage.costProvenance, 'estimated');
  assert.equal(Math.round((entry.usage.costUsd ?? 0) * 1000) / 1000, 0.6);
  // Working time spans the settled interval plus the open active interval.
  assert.ok((entry.usage.workingTimeMs ?? 0) >= 4200);
  assert.ok(Math.abs((entry.usage.workingTimeMs ?? 0) - Math.round(4200 + Math.max(0, Date.now() - 700))) < 500);
  const runOnlyState: ArchState = {
    ...state,
    pending: { ...state.pending, promoted: {} },
  };
  const runOnly = projectHostLiveMembership(runOnlyState, {
    getOpenRuns: () => [{ sessionPath: LIVE, startedAt: new Date(350).toISOString() } as never],
  });
  assert.equal(runOnly.sessions[0]?.requestStartedAt, 350);
  assert.ok(hostLiveMembershipFingerprint(snapshot).length > 0);
});

test('idle sessions project no request timing and absent usage stays explicitly unavailable', () => {
  const state = baseState(IDLE);
  const snapshot = projectHostLiveMembership(state, {});
  const entry = snapshot.sessions[0];
  assert.equal(entry.activity, 'idle');
  assert.equal(entry.requestStartedAt, undefined);
  assert.equal(entry.usage, undefined);
  // Waiting-for-user-input is distinct from idle and running.
  const uiState: ArchState = {
    ...state,
    settings: { ...state.settings, pendingExtensionUIRequestsBySession: { [IDLE]: { req1: {} as never } } },
  };
  const waiting = projectHostLiveMembership(uiState, {});
  assert.equal(waiting.sessions[0]?.activity, 'waiting-user-input');
  // No working-time provider: working time stays absent even when usage cost exists.
  const usageOnlyState: ArchState = {
    ...state,
    transcript: {
      ...state.transcript,
      sessionUsageBySession: { [IDLE]: { samples: [{ reportedCostUsd: 999 }], freshness: 'fresh' } as never },
    },
  };
  const usageOnly = projectHostLiveMembership(usageOnlyState, {
    getSessionUsage: () => ({
      authority: 'unknown', samples: [], freshness: 'unknown',
      unpricedInvocationCount: 9, incompleteInvocationCount: 8,
    } as never),
  });
  assert.equal(usageOnly.sessions[0]?.usage?.workingTimeMs, undefined);
  assert.equal(usageOnly.sessions[0]?.usage?.costUsd, undefined);
  assert.equal(usageOnly.sessions[0]?.usage?.unpricedInvocations, undefined);
  assert.equal(usageOnly.sessions[0]?.usage?.incompleteInvocations, undefined);
  assert.equal(usageOnly.sessions[0]?.usage?.freshness, 'unknown');
  assert.equal(
    hostLiveMembershipFingerprint(projectHostLiveMembership(usageOnlyState, {})),
    hostLiveMembershipFingerprint(snapshot),
  );
  assert.notEqual(hostLiveMembershipFingerprint(usageOnly), hostLiveMembershipFingerprint(snapshot));
});

test('hidden running sessions project with the hidden marker; intentional-hide is not close', () => {
  const state = baseState(LIVE);
  (state.sessions as { runningSessionPaths: string[] }).runningSessionPaths = [LIVE];
  (state.sessions as { intentionallyHiddenRunningPaths: string[] }).intentionallyHiddenRunningPaths = [LIVE];
  const snapshot = projectHostLiveMembership(state, {});
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0]?.hidden, true);
  assert.deepEqual(snapshot.closing, []);
});

function closeOperation(
  sessionPath: string,
  overrides: Record<string, unknown> = {},
  source: unknown = { kind: 'renderer' },
): Record<string, unknown> {
  return {
    operationId: `close-${sessionPath}`,
    kind: 'session.close',
    source: source as SessionOperationSource,
    session: { pendingPath: sessionPath },
    causal: { parentOperationId: null, selectionToken: 'close' },
    backendGeneration: 1,
    attempt: 1,
    phase: 'awaiting-commit',
    acceptance: 'accepted',
    commit: {} as never,
    recovery: null,
    closeMode: 'stop-cleanup',
    acknowledgements: {},
    ...overrides,
  };
}

test('nonterminal close operations project as closing reservations; pending-create closes stay off the bridge', () => {
  const withClosing = baseState();
  const state: ArchState = {
    ...withClosing,
    sessions: { ...withClosing.sessions, openTabPaths: [], runningSessionPaths: [CLOSING] },
    operations: { 'close-1': closeOperation(CLOSING) } as never,
  };
  const snapshot = projectHostLiveMembership(state, {});
  assert.deepEqual(snapshot.sessions, []);
  assert.deepEqual(snapshot.closing, [{
    path: CLOSING,
    operationId: `close-${CLOSING}`,
    source: 'host',
  } satisfies LiveSessionClosingEntry]);
  const agentState: ArchState = {
    ...state,
    operations: { 'close-1': closeOperation(CLOSING, {}, { kind: 'agent-session-control' }) } as never,
  };
  assert.equal(projectHostLiveMembership(agentState, {}).closing[0]?.source, 'agent');

  // Pending create close: waitForCreate plus a pending tab path never reserves.
  const pendingPath = '__pending__:create-1.jsonl';
  assert.ok(isPendingTabPath(pendingPath));
  const pendingState: ArchState = {
    ...withClosing,
    sessions: { ...withClosing.sessions, openTabPaths: [pendingPath] },
    operations: {
      'close-1': closeOperation(pendingPath, {
        session: { pendingPath },
        closeWaitForCreate: true,
        closeMode: 'idle-cleanup',
      }),
    } as never,
  };
  const pendingSnapshot = projectHostLiveMembership(pendingState, {});
  assert.deepEqual(pendingSnapshot.sessions, []);
  assert.deepEqual(pendingSnapshot.closing, []);
});

test('ui-close membership reservation syncs before later host mutations (close-ingress ordering)', () => {
  const ordered: string[] = [];
  const sessionPath = LIVE;
  const bridge = new HostLiveMembershipSync(createInitialArchState(), {
    request: async (params) => {
      ordered.push(`membership@${params.revision}:${params.sessions.length}+${params.closing.length}`);
      return { ok: true, appliedRevision: params.revision };
    },
    getBackendGeneration: () => 1,
  });
  const closeCommand: CloseSessionCommand = {
    kind: 'CloseSession',
    corrId: 'corr',
    operationId: 'close-op-1',
    operationAttempt: 1,
    operationSource: { kind: 'renderer' } as never,
    backendGeneration: 1,
    sessionPath,
    privacyMode: false,
  };
  const before = baseState(sessionPath);
  const result = handleCloseSession(before, closeCommand);
  const laterMutation = () => ordered.push('host-mutation');
  // Membership is projected between the reducer transition and its effects;
  // any later host mutation (here simulated directly) is ordered after it.
  bridge.afterDispatch(result.state);
  laterMutation();
  // Constructor-sent initial membership plus the close-transition membership.
  const closeSync = ordered.find((entry) => entry.includes('0+1'));
  assert.ok(closeSync?.startsWith('membership@'), `closing reservation synced: ${closeSync}`);
  assert.equal(ordered[ordered.lastIndexOf(closeSync!) + 1], 'host-mutation');
  assert.ok(ordered.every((entry) => !entry.includes('1+'))); // no live entry after close
});

test('bridge retries a failed send on the next transition and stays silent for unchanged state', async () => {
  const ordered: string[] = [];
  let failNext = true;
  const bridge = new HostLiveMembershipSync(createInitialArchState(), {
    request: async (params) => {
      ordered.push(`membership@${params.revision}`);
      if (failNext) { failNext = false; throw new Error('transport unavailable'); }
      return { ok: true, appliedRevision: params.revision };
    },
    getBackendGeneration: () => 1,
  });
  // Initial state has empty membership and the first send failed.
  await flush();
  bridge.afterDispatch(baseState(LIVE));
  await flush();
  assert.equal(ordered.length, 2); // failed initial + successful resend
  assert.ok(ordered[0] !== ordered[1]);
  const before = [...ordered];
  bridge.afterDispatch(baseState(LIVE));
  await flush();
  assert.deepEqual(ordered.length, before.length); // unchanged membership stays silent
});

test('bridge generation change resyncs membership even when the reduced state is unchanged', async () => {
  let generation = 1;
  const revisions: number[] = [];
  const bridge = new HostLiveMembershipSync(createInitialArchState(), {
    request: async (params) => {
      revisions.push(params.revision);
      return { ok: true, appliedRevision: params.revision };
    },
    getBackendGeneration: () => generation,
  });
  await flush();
  bridge.afterDispatch(baseState(LIVE));
  await flush();
  const before = revisions.length;
  generation = 2; // backend restart: same reduced state, new generation
  bridge.afterDispatch(baseState(LIVE));
  await flush();
  assert.equal(revisions.length, before + 1);
});