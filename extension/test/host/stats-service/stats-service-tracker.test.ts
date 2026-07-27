import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionRunTracker } from '../../../src/host/stats-service/tracker';
import { createInitialArchState } from '../../../src/host/core/arch-state';
import { reducer } from '../../../src/host/core/reducer';
import type { Event } from '../../../src/host/core/events';
import type { ArchState, SettingsState } from '../../../src/host/core/arch-state';
import type { AssistantUsage, ComposerInput, SessionAnalyticsFactors, ToolCall } from '../../../src/shared/protocol';
import { produce } from 'immer';

function createHarness() {
  const sessionPath = '/workspace/session.jsonl';
  const persistCalls: Array<{ snapshot?: unknown }> = [];
  let renderCount = 0;
  let idCounter = 0;
  let nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  let experimentAssignment: string | null = 'control';

  let archState = createInitialArchState();
  // Seed session and model info
  archState = produce(archState, (draft) => {
    draft.sessions.sessions.push({
      path: sessionPath,
      name: 'Session',
      cwd: '/workspace',
      modifiedAt: new Date(nowMs).toISOString(),
      messageCount: 0,
      modelId: 'claude-test',
    });
    draft.settings.modelSettings = {
      defaultModel: 'claude-test',
      defaultThinkingLevel: 'medium',
    };
  });

  const getArchState = () => archState;
  const dispatchArchEvent = (event: Event) => {
    const result = reducer(archState, event);
    archState = result.state;
  };

  const tracker = new SessionRunTracker({
    getArchState,
    dispatchArchEvent,
    scheduleRender: () => {
      renderCount += 1;
    },
    schedulePersist: (snapshot) => {
      persistCalls.push({ snapshot });
    },
    now: () => new Date(nowMs),
    createId: () => `id-${++idCounter}`,
    getExperimentAssignment: () => experimentAssignment,
  });

  return {
    tracker,
    get archState() { return archState; },
    getArchState,
    sessionPath,
    persistCalls,
    get renderCount() {
      return renderCount;
    },
    advance(ms: number) {
      nowMs += ms;
    },
    setExperimentAssignment(value: string | null) {
      experimentAssignment = value;
    },
    setAnalyticsFactors(sessionPath: string, factors: SessionAnalyticsFactors) {
      archState = produce(archState, (draft) => {
        draft.sessions.analyticsFactorsBySession[sessionPath] = factors;
      });
    },
    mutateSettings(mutator: (settings: SettingsState) => void) {
      archState = produce(archState, (draft) => mutator(draft.settings));
    },
  };
}

const filesystemInput: ComposerInput = {
  id: 'input-1',
  kind: 'filesystemPathRef',
  path: '/workspace/src/index.ts',
  name: 'index.ts',
  source: 'picker',
};

const sampleFactors: SessionAnalyticsFactors = {
  promptFamily: 'harness+skills',
  promptHash: 'prompt-hash',
  promptCapturedAt: '2025-06-15T10:30:00.000Z',
  harnessPromptHash: 'harness-hash',
  customPromptHash: null,
  appendSystemPromptHash: null,
  promptGuidelineHashes: ['guideline-hash'],
  contextFiles: [{ path: '/workspace/AGENTS.md', hash: 'context-hash' }],
  selectedToolIds: ['read'],
  toolSnippetHashes: [{ toolId: 'read', hash: 'snippet-hash' }],
  toolSetHash: 'tool-set-hash',
  skills: [{ name: 'code-review', contentHash: 'content-hash', sourceHash: 'source-hash', disableModelInvocation: false, lastModifiedAt: null }],
  skillSetHash: 'skill-set-hash',
  activeExtensions: ['subagent'],
};

test('prepareForSend carries queued unsupported inputs and startNewTask closes the previous run', () => {
  const harness = createHarness();

  harness.tracker.onUnsupportedInputAttempt(harness.sessionPath);
  const firstRunId = harness.tracker.prepareForSend(harness.sessionPath, [filesystemInput], ' A🙂 ');
  harness.tracker.startNewTask(harness.sessionPath);
  const secondRunId = harness.tracker.prepareForSend(harness.sessionPath, [], 'next');

  const sessions = harness.tracker.serializeSessions();
  const currentRun = sessions[harness.sessionPath]?.currentRun;
  const lastRun = sessions[harness.sessionPath]?.lastRun;

  assert.equal(firstRunId, 'id-1');
  assert.equal(secondRunId, 'id-3');
  assert.equal(lastRun?.runId, 'id-1');
  assert.equal(lastRun?.finalizationReason, 'new_task');
  assert.equal(lastRun?.unsupportedInputCount, 1);
  assert.equal(lastRun?.initialUserMessageChars, 2, 'stores a privacy-safe Unicode code-point count, not message content');
  assert.equal(currentRun?.runId, 'id-3');
  assert.equal(currentRun?.initialUserMessageChars, 4);
  assert.equal(currentRun?.sendCount, 1);
  assert.equal(currentRun?.filesystemPathRefCount, 0);
  assert.equal(harness.archState.composer.activeRunSummaryBySession[harness.sessionPath]?.runId, 'id-3');
  assert.ok(harness.renderCount >= 3);
});

test('prepareForSend captures functional settings from ArchState.settings at run start', () => {
  const harness = createHarness();
  harness.mutateSettings((settings) => {
    settings.pruningSettings.mode = 'shadow';
    settings.prefs.subagentAlwaysParentModel = true;
    settings.prefs.extensionToggles = { subagent: true, safeguard: false };
  });

  harness.tracker.prepareForSend(harness.sessionPath, []);
  const currentRun = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun;

  assert.deepEqual(currentRun?.functionalSettings, {
    subagentAlwaysParentModel: true,
    pruningMode: 'shadow',
    extensionToggles: { subagent: true, safeguard: false },
    toolResultPruningEnabled: true,
    toolResultPruningProfile: 'default',
  });

  // The snapshot must not alias reducer state: later changes to prefs must not leak into the captured copy.
  harness.mutateSettings((settings) => {
    settings.prefs.extensionToggles.cwd = true;
    settings.prefs.subagentAlwaysParentModel = false;
  });
  const refetched = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun;
  assert.equal(refetched?.functionalSettings?.extensionToggles.cwd, undefined);
  assert.deepEqual(refetched?.functionalSettings, {
    subagentAlwaysParentModel: true,
    pruningMode: 'shadow',
    extensionToggles: { subagent: true, safeguard: false },
    toolResultPruningEnabled: true,
    toolResultPruningProfile: 'default',
  });
});

test('assistant turns, busy windows, unsupported inputs, and experiment assignment changes update the active run', () => {
  const harness = createHarness();
  harness.setAnalyticsFactors(harness.sessionPath, sampleFactors);

  const runId = harness.tracker.prepareForSend(harness.sessionPath, []);
  harness.tracker.onAssistantTurnStarted(harness.sessionPath, 'turn-1');
  harness.tracker.onAssistantTurnStarted(harness.sessionPath, 'turn-1');
  harness.advance(250);
  harness.tracker.onAssistantTurnEnded(harness.sessionPath, 'turn-1', 400, {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 5,
    cacheWriteTokens: 1,
    totalTokens: 36,
  });
  harness.tracker.onBusyChanged(harness.sessionPath, true);
  harness.advance(500);
  harness.tracker.onBusyChanged(harness.sessionPath, false);
  harness.tracker.onUnsupportedInputAttempt(harness.sessionPath);
  harness.setExperimentAssignment('variant-a');
  harness.tracker.onExperimentAssignmentChanged('variant-a');

  const currentRun = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun;
  assert.equal(runId, currentRun?.runId);
  assert.equal(currentRun?.assistantTurnCount, 1);
  assert.equal(currentRun?.assistantTurnDurationMs, 400);
  assert.equal(currentRun?.inputTokens, 10);
  assert.equal(currentRun?.outputTokens, 20);
  assert.equal(currentRun?.turnThroughputSamples.length, 1);
  assert.equal(currentRun?.turnThroughputSamples[0]?.outputTokens, 20);
  assert.equal(currentRun?.turnThroughputSamples[0]?.generationDurationMs, 400);
  assert.equal(currentRun?.turnThroughputSamples[0]?.concurrentBusySessions, 0);
  assert.equal(currentRun?.turnThroughputSamples[0]?.status, 'completed');
  assert.equal(currentRun?.busyPeriodCount, 1);
  assert.equal(currentRun?.busyDurationMs, 500);
  assert.equal(currentRun?.unsupportedInputCount, 1);
  assert.equal(currentRun?.experimentAssignment, 'control');
  assert.equal(currentRun?.mixedTreatmentConfig, true);
  assert.deepEqual(currentRun?.treatmentChangeKinds, ['experimentAssignment']);

  const persistCountBefore = harness.persistCalls.length;
  harness.tracker.onExperimentAssignmentChanged('control');
  assert.equal(harness.persistCalls.length, persistCountBefore, 'unchanged assignments should not persist again');
});

test('turn throughput samples stamp concurrency, accumulate per turn, and capture errored turns', () => {
  const harness = createHarness();
  const secondSession = '/workspace/other-session.jsonl';
  harness.tracker.prepareForSend(harness.sessionPath, []);

  // A second concurrent session becomes busy mid-run.
  harness.tracker.onBusyChanged(secondSession, true);
  // This run's own session is also busy.
  harness.tracker.onBusyChanged(harness.sessionPath, true);

  harness.tracker.onAssistantTurnStarted(harness.sessionPath, 'turn-a');
  harness.advance(100);
  harness.tracker.onAssistantTurnEnded(
    harness.sessionPath,
    'turn-a',
    1000,
    { inputTokens: 50, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 350 },
    'completed',
  );

  // Errored turn still produces a sample (rate-limit / failure signal) even
  // with no reported usage, and keeps its error status.
  harness.tracker.onAssistantTurnStarted(harness.sessionPath, 'turn-b');
  harness.advance(50);
  harness.tracker.onAssistantTurnEnded(harness.sessionPath, 'turn-b', 250, undefined, 'error');

  harness.tracker.onBusyChanged(secondSession, false);
  harness.tracker.onBusyChanged(harness.sessionPath, false);

  const run = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun;
  assert.equal(run?.turnThroughputSamples.length, 2);

  const completed = run?.turnThroughputSamples[0];
  assert.equal(completed?.outputTokens, 300);
  assert.equal(completed?.generationDurationMs, 1000);
  assert.equal(completed?.status, 'completed');
  assert.equal(completed?.concurrentBusySessions, 2, 'both sessions were busy when the turn ended');

  const errored = run?.turnThroughputSamples[1];
  assert.equal(errored?.status, 'error');
  assert.equal(errored?.outputTokens, 0);
  assert.equal(errored?.generationDurationMs, 250);
  assert.equal(errored?.concurrentBusySessions, 2);
});

test('duplicate onAssistantTurnEnded calls for the same turn do not double-count', () => {
  const harness = createHarness();
  harness.tracker.prepareForSend(harness.sessionPath, []);

  const usage = { inputTokens: 10, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 50 };
  harness.tracker.onAssistantTurnEnded(harness.sessionPath, 'dup-turn', 1000, usage, 'completed');
  // A duplicate `message.finished` for the same turn must be ignored.
  harness.tracker.onAssistantTurnEnded(harness.sessionPath, 'dup-turn', 1000, usage, 'completed');

  const run = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun;
  assert.equal(run?.assistantTurnDurationMs, 1000, 'duration not double-counted');
  assert.equal(run?.outputTokens, 40, 'tokens not double-counted');
  assert.equal(run?.tokenReportedTurnCount, 1, 'reported-turn count not double-counted');
  assert.equal(run?.turnThroughputSamples.length, 1, 'only one throughput sample recorded');
});

test('tracker no-op guards and metadata updates behave correctly across inactive and active runs', () => {
  const harness = createHarness();

  harness.tracker.onAssistantTurnStarted(harness.sessionPath, 'no-run');
  harness.tracker.onAssistantTurnEnded(harness.sessionPath, 'no-run', 123);
  harness.tracker.onToolStarted(harness.sessionPath, { id: 'tool-1', name: 'bash', input: { command: 'echo ok' }, status: 'running' });
  harness.tracker.onToolFinished(harness.sessionPath, { id: 'tool-1', name: 'bash', input: { command: 'echo ok' }, status: 'completed' });
  harness.tracker.onInterrupted(harness.sessionPath);
  harness.tracker.onMessageEdited(harness.sessionPath);
  harness.tracker.onTruncatedAfter(harness.sessionPath);
  harness.tracker.onBackendError(undefined, 'MISSING_SESSION');
  harness.tracker.onContextUsageChanged(harness.sessionPath, 10, 100);
  harness.tracker.onBusyChanged(harness.sessionPath, false);
  assert.equal(harness.persistCalls.length, 0, 'no current run means no persistence side effects');

  harness.setAnalyticsFactors(harness.sessionPath, sampleFactors);
  const runId = harness.tracker.prepareForSend(harness.sessionPath, []);
  harness.tracker.onBackendError(harness.sessionPath, 'MESSAGE_SEND_FAILED');
  harness.tracker.onContextUsageChanged(harness.sessionPath, 50, 200);
  harness.tracker.onInterrupted(harness.sessionPath);
  harness.tracker.onMessageEdited(harness.sessionPath);
  harness.tracker.onTruncatedAfter(harness.sessionPath);
  harness.tracker.onModelConfigChanged(harness.sessionPath, 'claude-test', 'medium');
  harness.tracker.onModelConfigChanged(harness.sessionPath, 'model-b', 'high', 'openai-codex');

  const currentRun = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun;
  assert.equal(currentRun?.runId, runId);
  assert.deepEqual(currentRun?.backendErrorCodes, ['MESSAGE_SEND_FAILED']);
  assert.equal(currentRun?.contextTokens, 50);
  assert.equal(currentRun?.contextLimit, 200);
  assert.equal(currentRun?.interruptedCount, 1);
  assert.equal(currentRun?.messageEditCount, 1);
  assert.equal(currentRun?.truncatedAfterCount, 1);
  assert.equal(currentRun?.mixedModelConfig, true);
  assert.equal(currentRun?.provider, 'openai-codex');
  assert.deepEqual(currentRun?.treatmentChangeKinds, ['model', 'thinking']);
});

test('onSessionClosed and finalizeOpenRunsForShutdown close active runs and clear summaries', () => {
  const harness = createHarness();

  harness.tracker.prepareForSend(harness.sessionPath, []);
  harness.tracker.onSessionClosed(harness.sessionPath);
  assert.equal(harness.tracker.serializeSessions()[harness.sessionPath], undefined);
  assert.equal(harness.archState.composer.activeRunSummaryBySession[harness.sessionPath], null);

  const second = createHarness();
  second.tracker.prepareForSend(second.sessionPath, []);
  second.tracker.finalizeOpenRunsForShutdown();

  const finalized = second.tracker.serializeSessions()[second.sessionPath]?.lastRun;
  assert.equal(finalized?.status, 'closed');
  assert.equal(finalized?.finalizationReason, 'closed');
});

test('turn latency breakdown is recorded on throughput samples', () => {
  const harness = createHarness();
  harness.tracker.prepareForSend(harness.sessionPath, []);
  harness.tracker.onAssistantTurnStarted(harness.sessionPath, 'turn-lat');
  harness.tracker.onAssistantTurnEnded(
    harness.sessionPath,
    'turn-lat',
    500,
    { inputTokens: 5, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 55 },
    'completed',
    { turnLatencyMs: 800, overheadMs: 100, providerLatencyMs: 700 },
  );

  const sample = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun?.turnThroughputSamples[0];
  assert.equal(sample?.turnLatencyMs, 800);
  assert.equal(sample?.overheadMs, 100);
  assert.equal(sample?.providerLatencyMs, 700);
});

test('throughput samples default latency fields to null when unmeasured', () => {
  const harness = createHarness();
  harness.tracker.prepareForSend(harness.sessionPath, []);
  harness.tracker.onAssistantTurnStarted(harness.sessionPath, 'turn-nolat');
  harness.tracker.onAssistantTurnEnded(harness.sessionPath, 'turn-nolat', 500, undefined, 'completed');

  const sample = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun?.turnThroughputSamples[0];
  assert.equal(sample?.turnLatencyMs, null);
  assert.equal(sample?.overheadMs, null);
  assert.equal(sample?.providerLatencyMs, null);
});

test('turn throughput samples preserve per-turn provider attribution', () => {
  const harness = createHarness();
  harness.tracker.prepareForSend(harness.sessionPath, []);
  harness.tracker.onModelConfigChanged(harness.sessionPath, 'claude-test', 'medium', 'openai');
  harness.tracker.onAssistantTurnStarted(harness.sessionPath, 'turn-prov');
  harness.tracker.onAssistantTurnEnded(
    harness.sessionPath,
    'turn-prov',
    500,
    { inputTokens: 5, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 55 },
    'completed',
  );

  const run = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun;
  assert.equal(run?.provider, 'openai');
  assert.equal(run?.turnThroughputSamples[0]?.provider, 'openai');
});

test('a turn with measurable latency still records a sample even with negligible generation', () => {
  const harness = createHarness();
  harness.tracker.prepareForSend(harness.sessionPath, []);
  harness.tracker.onAssistantTurnStarted(harness.sessionPath, 'turn-latonly');
  // generationDurationMs=0, outputTokens=0, status completed — would normally be
  // skipped, but a measurable turn latency keeps the sample.
  harness.tracker.onAssistantTurnEnded(
    harness.sessionPath,
    'turn-latonly',
    0,
    undefined,
    'completed',
    { turnLatencyMs: 250, overheadMs: 30, providerLatencyMs: 220 },
  );

  const samples = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun?.turnThroughputSamples ?? [];
  assert.equal(samples.length, 1);
  assert.equal(samples[0]?.turnLatencyMs, 250);
  assert.equal(samples[0]?.generationDurationMs, 0);
});

test('an explicit immediate provider-gate grant is preserved as zero with attempt coverage', () => {
  const harness = createHarness();
  harness.tracker.prepareForSend(harness.sessionPath, []);
  harness.tracker.onAssistantTurnEnded(
    harness.sessionPath,
    'turn-immediate-provider-grant',
    0,
    undefined,
    'completed',
    { providerQueueMs: 0, providerQueueAttemptCount: 1 },
  );

  const sample = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun?.turnThroughputSamples[0];
  assert.equal(sample?.providerQueueMs, 0);
  assert.equal(sample?.providerQueueAttemptCount, 1);
});

test('an overhead-only turn (no content delta) still records its measured overhead', () => {
  const harness = createHarness();
  harness.tracker.prepareForSend(harness.sessionPath, []);
  harness.tracker.onAssistantTurnStarted(harness.sessionPath, 'turn-overhead-only');
  // A degenerate turn that observed `turn_start` (so overhead is measurable) but
  // produced no content delta (so turn/provider latency are undefined). The
  // measured overhead must still be captured rather than dropped.
  harness.tracker.onAssistantTurnEnded(
    harness.sessionPath,
    'turn-overhead-only',
    0,
    undefined,
    'completed',
    { overheadMs: 120 },
  );

  const samples = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun?.turnThroughputSamples ?? [];
  assert.equal(samples.length, 1);
  assert.equal(samples[0]?.overheadMs, 120);
  assert.equal(samples[0]?.turnLatencyMs, null);
  assert.equal(samples[0]?.providerLatencyMs, null);
});

test('duplicate tool.started and tool.finished events do not double-count', () => {
  const harness = createHarness();
  harness.tracker.prepareForSend(harness.sessionPath, []);

  const toolCall: ToolCall = {
    id: 'tool-dup-1',
    name: 'bash',
    input: { command: 'echo ok' },
    status: 'running',
  };

  harness.tracker.onToolStarted(harness.sessionPath, toolCall);
  harness.tracker.onToolStarted(harness.sessionPath, toolCall); // duplicate
  harness.tracker.onToolFinished(harness.sessionPath, { ...toolCall, status: 'completed', durationMs: 100 });
  harness.tracker.onToolFinished(harness.sessionPath, { ...toolCall, status: 'completed', durationMs: 100 }); // duplicate

  const run = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun;
  assert.equal(run?.toolUsage.totalCount, 1, 'duplicate tool.started must not double-count totalCount');
  assert.equal(run?.toolUsage.countsByName['bash'], 1, 'duplicate tool.started must not double-count per-name count');
  assert.equal(run?.toolUsage.timedCallCount, 1, 'duplicate tool.finished must not double-count timedCallCount');
  assert.equal(run?.toolUsage.totalDurationMs, 100, 'duplicate tool.finished must not double-count duration');
  assert.equal(run?.toolUsage.timedCallCountsByName['bash'], 1, 'per-tool timed call count is recorded');
});

test('untimed tools leave critical-path coverage unknown and reconcile a terminal tool name', () => {
  const harness = createHarness();
  harness.tracker.prepareForSend(harness.sessionPath, []);
  harness.tracker.onToolStarted(harness.sessionPath, { id: 'late-name', name: '', input: {}, status: 'running' });

  let usage = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun?.toolUsage;
  assert.equal(usage?.criticalPathDurationMs, undefined);
  assert.equal(usage?.countsByName['(unknown)'], 1);

  harness.tracker.onToolFinished(harness.sessionPath, {
    id: 'late-name', name: 'bash', input: {}, status: 'completed',
  });
  usage = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun?.toolUsage;
  assert.equal(usage?.criticalPathDurationMs, undefined);
  assert.equal(usage?.countsByName['(unknown)'], undefined);
  assert.equal(usage?.countsByName['bash'], 1);
});

test('tool critical path is the union of execution intervals and missing timing stays unknown', () => {
  const harness = createHarness();
  harness.tracker.prepareForSend(harness.sessionPath, []);

  const calls: ToolCall[] = [
    { id: 'a', name: 'bash', input: {}, status: 'completed', startedAt: 1_000, durationMs: 100 },
    { id: 'b', name: 'read', input: {}, status: 'completed', startedAt: 1_050, durationMs: 100 },
    { id: 'c', name: '', input: {}, status: 'completed', startedAt: 1_200, durationMs: 20 },
  ];
  for (const call of calls) {
    harness.tracker.onToolStarted(harness.sessionPath, { ...call, status: 'running' });
    harness.tracker.onToolFinished(harness.sessionPath, call);
  }
  harness.tracker.onToolStarted(harness.sessionPath, { id: 'missing-start', name: '', input: {}, status: 'running' });
  harness.tracker.onToolFinished(harness.sessionPath, {
    id: 'missing-start', name: '', input: {}, status: 'completed',
  });

  const usage = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun?.toolUsage;
  assert.equal(usage?.totalDurationMs, 220);
  assert.equal(usage?.criticalPathDurationMs, 170);
  assert.equal(usage?.timedCallCount, 3, 'missing timing must not become a zero-duration call');
  assert.equal(usage?.countsByName['(unknown)'], 2, 'missing names retain explicit unknown attribution');
  assert.equal(usage?.durationMsByName['(unknown)'], 20);
});

test('assistant turn usage with NaN or negative values does not corrupt counters', () => {
  const harness = createHarness();
  harness.tracker.prepareForSend(harness.sessionPath, []);

  const invalidUsage: AssistantUsage = {
    inputTokens: NaN,
    outputTokens: -10,
    cacheReadTokens: -5,
    cacheWriteTokens: Infinity,
    totalTokens: NaN,
  };

  harness.tracker.onAssistantTurnStarted(harness.sessionPath, 'turn-invalid');
  harness.tracker.onAssistantTurnEnded(
    harness.sessionPath,
    'turn-invalid',
    100,
    invalidUsage,
    'completed',
    { turnLatencyMs: NaN, overheadMs: Infinity, providerLatencyMs: -Infinity },
  );

  const run = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun;
  assert.equal(run?.inputTokens, 0);
  assert.equal(run?.outputTokens, 0);
  assert.equal(run?.cacheReadTokens, 0);
  assert.equal(run?.cacheWriteTokens, 0);
  assert.equal(run?.tokenReportedTurnCount, 1);
  assert.equal(run?.turnThroughputSamples.length, 1);
  const sample = run?.turnThroughputSamples[0];
  assert.equal(sample?.outputTokens, 0);
  assert.equal(sample?.turnLatencyMs, null);
  assert.equal(sample?.overheadMs, null);
  assert.equal(sample?.providerLatencyMs, null);
});

test('subagent tool call forwards turnThroughputSamples into the parent run', () => {
  const harness = createHarness();
  harness.tracker.prepareForSend(harness.sessionPath, []);

  const subagentToolCall: ToolCall = {
    id: 'subagent-1',
    name: 'subagent',
    input: { agent: 'worker', task: 'do work' },
    status: 'completed',
    durationMs: 100,
    result: {
      details: {
        mode: 'single',
        results: [
          {
            agent: 'worker',
            task: 'do work',
            exitCode: 0,
            messages: [],
            model: 'openai/gpt-sub',
            usage: { input: 200, output: 100, cacheRead: 20, cacheWrite: 10 },
            turnThroughputSamples: [
              { endedAt: '2026-01-01T00:00:00.000Z', outputTokens: 100, generationDurationMs: 1000, status: 'completed', modelId: 'openai/gpt-sub' },
            ],
          },
        ],
      },
    },
  };

  harness.tracker.onToolStarted(harness.sessionPath, subagentToolCall);
  harness.tracker.onToolFinished(harness.sessionPath, subagentToolCall);

  const run = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun;
  assert.equal(run?.toolUsage.subagentCallCount, 1);
  assert.equal(run?.turnThroughputSamples.length, 1);
  const sample = run?.turnThroughputSamples[0];
  assert.equal(sample?.outputTokens, 100);
  assert.equal(sample?.generationDurationMs, 1000);
  assert.equal(sample?.status, 'completed');
  assert.equal(sample?.modelId, 'openai/gpt-sub');
  assert.equal(run?.toolUsage.subagentInputTokens, 200);
  assert.equal(run?.toolUsage.subagentOutputTokens, 100);
  assert.deepEqual(run?.auxiliaryLlmUsage, [{
    kind: 'subagent',
    sourceId: 'subagent-1:0',
    occurredAt: '2026-01-01T00:00:00.000Z',
    modelId: 'openai/gpt-sub',
    inputTokens: 200,
    outputTokens: 100,
    cacheReadTokens: 20,
    cacheWriteTokens: 10,
  }]);
});

test('subagent retry usage remains attributed to each attempt provider', () => {
  const harness = createHarness();
  harness.tracker.prepareForSend(harness.sessionPath, []);
  const toolCall: ToolCall = {
    id: 'subagent-retry',
    name: 'subagent',
    input: { agent: 'worker', task: 'retry' },
    status: 'completed',
    result: { details: { mode: 'single', results: [{
      agent: 'worker', task: 'retry', exitCode: 0, messages: [],
      model: 'shared-model', provider: 'github-copilot',
      usage: { input: 30, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.03 },
      attemptRecords: [
        { attemptId: 'a', provider: 'openai-codex', model: 'shared-model', usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01 } },
        { attemptId: 'b', provider: 'github-copilot', model: 'shared-model', usage: { input: 20, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.02 } },
      ],
    }] } },
  };

  harness.tracker.onToolStarted(harness.sessionPath, toolCall);
  harness.tracker.onToolFinished(harness.sessionPath, toolCall);
  const samples = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun?.auxiliaryLlmUsage ?? [];
  assert.deepEqual(samples.map((sample) => ({
    provider: sample.provider,
    modelId: sample.modelId,
    inputTokens: sample.inputTokens,
    reportedCostUsd: sample.reportedCostUsd,
  })), [
    { provider: 'openai-codex', modelId: 'shared-model', inputTokens: 10, reportedCostUsd: 0.01 },
    { provider: 'github-copilot', modelId: 'shared-model', inputTokens: 20, reportedCostUsd: 0.02 },
  ]);
});

test('skill-pruning usage records the actual model and ignores duplicate CustomMessage delivery', () => {
  const harness = createHarness();
  harness.tracker.prepareForSend(harness.sessionPath, []);
  const details = {
    prepassModel: 'openai/pruner',
    prepassInputTokens: 123,
    prepassOutputTokens: 45,
    prepassCacheReadTokens: 6,
    prepassCacheWriteTokens: 7,
  };

  harness.tracker.onSkillPruningUsage(
    harness.sessionPath,
    'pruning-message-1',
    '2026-01-01T00:00:00.250Z',
    details,
  );
  harness.tracker.onSkillPruningUsage(
    harness.sessionPath,
    'pruning-message-1',
    '2026-01-01T00:00:00.250Z',
    details,
  );

  const run = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun;
  assert.deepEqual(run?.auxiliaryLlmUsage, [{
    kind: 'skill_pruning_prepass',
    sourceId: 'pruning-message-1',
    occurredAt: '2026-01-01T00:00:00.250Z',
    modelId: 'openai/pruner',
    inputTokens: 123,
    outputTokens: 45,
    cacheReadTokens: 6,
    cacheWriteTokens: 7,
  }]);
});

test('skill-pruning duration is retained even when the provider reports no tokens', () => {
  const harness = createHarness();
  harness.tracker.prepareForSend(harness.sessionPath, []);
  harness.tracker.onSkillPruningUsage(
    harness.sessionPath,
    'pruning-duration-only',
    '2026-01-01T00:00:00.250Z',
    { prepassModel: 'openai/pruner', prepassLatencyMs: 321 },
  );

  assert.deepEqual(
    harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun?.auxiliaryLlmUsage,
    [{
      kind: 'skill_pruning_prepass',
      sourceId: 'pruning-duration-only',
      occurredAt: '2026-01-01T00:00:00.250Z',
      modelId: 'openai/pruner',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs: 321,
    }],
  );
});

test('retry timing keeps scheduled delay and updates measured delay/duration idempotently', () => {
  const harness = createHarness();
  harness.tracker.prepareForSend(harness.sessionPath, []);
  const timing = {
    sourceId: 'request-1:2',
    occurredAt: '2026-01-01T00:00:00.500Z',
    attempt: 2,
    scheduledDelayMs: 4_000,
  };
  harness.tracker.onAutoRetry(harness.sessionPath, timing);
  harness.tracker.onAutoRetry(harness.sessionPath, timing);
  harness.tracker.onAutoRetryMeasured(harness.sessionPath, timing.sourceId, 4_025, 5_200);

  const run = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun;
  assert.equal(run?.autoRetryCount, 1);
  assert.deepEqual(run?.retryTimingSamples, [{
    ...timing,
    measuredDelayMs: 4_025,
    durationMs: 5_200,
  }]);
});

test('subagent tool call stamps modelId from result.model when sample lacks modelId', () => {
  const harness = createHarness();
  harness.tracker.prepareForSend(harness.sessionPath, []);

  const subagentToolCall: ToolCall = {
    id: 'subagent-2',
    name: 'subagent',
    input: { agent: 'worker', task: 'do work' },
    status: 'completed',
    durationMs: 100,
    result: {
      details: {
        mode: 'single',
        results: [
          {
            agent: 'worker',
            task: 'do work',
            exitCode: 0,
            messages: [],
            model: 'anthropic/claude-sub',
            turnThroughputSamples: [
              { endedAt: '2026-01-01T00:00:01.000Z', outputTokens: 50, generationDurationMs: 500, status: 'completed' },
            ],
          },
        ],
      },
    },
  };

  harness.tracker.onToolStarted(harness.sessionPath, subagentToolCall);
  harness.tracker.onToolFinished(harness.sessionPath, subagentToolCall);

  const run = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun;
  assert.equal(run?.turnThroughputSamples.length, 1);
  assert.equal(run?.turnThroughputSamples[0]?.modelId, 'anthropic/claude-sub');
});

test('terminal subagent attempt records are parsed safely and remain idempotent', () => {
  const harness = createHarness();
  harness.tracker.prepareForSend(harness.sessionPath, []);
  const tool: ToolCall = {
    id: 'subagent-attempts', name: 'subagent', input: { agent: 'worker', task: 'work' }, status: 'completed',
    result: { details: { results: [{
      agent: 'worker', task: 'work', exitCode: 0, messages: [],
      attemptRecords: [
        { attemptId: 'first', outcome: 'failure', startedAt: 100, completedAt: 250, backoffMs: 0, phaseDurationsMs: { preparing: 50, waiting_provider: 100 }, attemptSettlementOutcome: 'error' },
        { attemptId: 'retry', outcome: 'success', startedAt: 500, completedAt: 900, backoffMs: 250, phaseDurationsMs: { waiting_provider: 400 }, attemptSettlementOutcome: 'completed' },
        { attemptId: '', outcome: 'success' },
        { attemptId: 'bad-outcome', outcome: 'maybe' },
      ],
    }] } },
  };
  harness.tracker.onToolStarted(harness.sessionPath, { ...tool, status: 'running' });
  harness.tracker.onToolFinished(harness.sessionPath, tool);
  harness.tracker.onToolFinished(harness.sessionPath, tool);

  const samples = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun?.subagentAttemptSamples;
  assert.equal(samples?.length, 2, 'duplicate terminal delivery and malformed records must not inflate samples');
  assert.deepEqual(samples?.map((sample) => ({
    sourceId: sample.sourceId, durationMs: sample.durationMs, durationSource: sample.durationSource,
    backoffMs: sample.backoffMs, phaseDurationsMs: sample.phaseDurationsMs, phaseDurationsSource: sample.phaseDurationsSource, cleanupSource: sample.cleanupSource,
  })), [
    { sourceId: 'subagent-attempts:0:first', durationMs: 150, durationSource: 'measured', backoffMs: 0, phaseDurationsMs: { preparing: 50, waiting_provider: 100 }, phaseDurationsSource: 'measured', cleanupSource: 'unknown' },
    { sourceId: 'subagent-attempts:0:retry', durationMs: 400, durationSource: 'measured', backoffMs: 250, phaseDurationsMs: { waiting_provider: 400 }, phaseDurationsSource: 'measured', cleanupSource: 'unknown' },
  ]);
  assert.deepEqual(harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun?.unknownSubagentAttemptRecordSourceIds,
    ['subagent-attempts'], 'partially malformed child records leave this call explicitly incomplete');
});

test('subagent lifecycle retains explicit unknown coverage for a malformed terminal call in a mixed run', () => {
  const harness = createHarness();
  harness.tracker.prepareForSend(harness.sessionPath, []);
  const valid: ToolCall = {
    id: 'subagent-valid', name: 'subagent', input: { agent: 'worker', task: 'work' }, status: 'completed',
    result: { details: { results: [{ agent: 'worker', task: 'work', exitCode: 0, messages: [],
      attemptRecords: [{ attemptId: 'ok', outcome: 'success', phaseDurationsMs: { preparing: 1 }, attemptSettlementOutcome: 'completed' }],
    }] } },
  };
  const malformed: ToolCall = {
    id: 'subagent-malformed', name: 'subagent', input: { agent: 'worker', task: 'work' }, status: 'completed',
    result: { details: { results: [{ agent: 'worker', task: 'work', exitCode: 1, messages: [], attemptRecords: [{ attemptId: '', outcome: 'wat' }] }] } },
  };
  for (const terminal of [valid, malformed]) {
    harness.tracker.onToolStarted(harness.sessionPath, { ...terminal, status: 'running' });
    harness.tracker.onToolFinished(harness.sessionPath, terminal);
  }
  const run = harness.tracker.serializeSessions()[harness.sessionPath]?.currentRun;
  assert.equal(run?.subagentAttemptSamples?.length, 1);
  assert.deepEqual(run?.unknownSubagentAttemptRecordSourceIds, ['subagent-malformed'],
    'one malformed call remains explicitly unknown beside one parsed call');

  const restored = createHarness();
  restored.tracker.restore(harness.tracker.serializeSessions());
  restored.tracker.onToolFinished(restored.sessionPath, malformed);
  assert.deepEqual(
    restored.tracker.serializeSessions()[restored.sessionPath]?.currentRun?.unknownSubagentAttemptRecordSourceIds,
    ['subagent-malformed'],
    'checkpoint restore plus terminal replay remains idempotent',
  );
});