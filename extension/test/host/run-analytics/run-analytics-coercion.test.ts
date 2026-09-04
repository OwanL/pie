import assert from 'node:assert/strict';
import test from 'node:test';

import { coerceSessionAnalyticsFactors } from '../../../src/host/run-analytics/coercion-factors';
import { coerceFunctionalSettings } from '../../../src/host/run-analytics/coercion-functional-settings';
import { coerceRunSnapshot } from '../../../src/host/run-analytics/coercion-snapshots';
import {
  coerceFileExtensionRollup,
  coerceFileMutationRollup,
  coerceToolUsageRollup,
  coerceTreatmentChangeKinds,
  coerceVerificationRollup,
  createEmptyFileExtensionRollup,
  createEmptyFileMutationRollup,
  createEmptyToolUsageRollup,
  createEmptyVerificationRollup,
} from '../../../src/host/run-analytics/coercion-rollups';
import {
  areStringArraysEqual,
  summarizeInputs,
  toActiveRunSummary,
  toPersistedSessionState,
  workspaceHash,
} from '../../../src/host/stats-service/helpers';
import { parseCheckpoint } from '../../../src/host/shared/checkpoint-io';
import type { ComposerInput } from '../../../src/shared/protocol';
import {
  MAX_USER_INPUT_SAMPLE_CHARS,
  type RunSnapshot,
  type TurnThroughputSample,
} from '../../../src/host/run-analytics';

function makeRunSnapshot(): RunSnapshot {
  return {
    sessionPath: '/workspace/session.jsonl',
    runId: 'run-1',
    taskGroupId: 'task-1',
    status: 'open',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    mixedModelConfig: false,
    mixedTreatmentConfig: false,
    treatmentChangeKinds: [],
    experimentAssignment: null,
    analyticsFactors: null,
    functionalSettings: null,
    sendCount: 0,
    assistantTurnCount: 0,
    assistantTurnDurationMs: 0,
    busyDurationMs: 0,
    busyPeriodCount: 0,
    interruptedCount: 0,
    messageEditCount: 0,
    truncatedAfterCount: 0,
    backendErrorCodes: [],
    contextTokens: null,
    contextLimit: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    auxiliaryLlmUsage: [],
    tokenReportedTurnCount: 0,
    lastTurnUsage: null,
    turnThroughputSamples: [],
    filesystemPathRefCount: 0,
    imageInputCount: 0,
    imageInputBytes: 0,
    unsupportedInputCount: 0,
    inputKindsUsed: [],
    toolUsage: createEmptyToolUsageRollup(),
    fileMutation: createEmptyFileMutationRollup(),
    fileExtensions: createEmptyFileExtensionRollup(),
    verification: createEmptyVerificationRollup(),
  };
}

test('coerceRunSnapshot preserves harness revision and fingerprint', () => {
  const base = makeRunSnapshot();

  const stamped = coerceRunSnapshot({
    ...base,
    harnessRevision: 'pie-harness-2026-08',
    harnessFingerprint: 'ab'.repeat(32),
  });
  assert.ok(stamped);
  assert.equal(stamped?.harnessRevision, 'pie-harness-2026-08');
  assert.equal(stamped?.harnessFingerprint, 'ab'.repeat(32));

  // Historical snapshots without the fields coerce cleanly (absent, not null).
  const legacy = coerceRunSnapshot(base);
  assert.ok(legacy);
  assert.equal(legacy?.harnessRevision, undefined);
  assert.equal(legacy?.harnessFingerprint, undefined);

  // Non-string values are dropped, not accepted.
  const malformed = coerceRunSnapshot({
    ...base,
    harnessRevision: 42,
    harnessFingerprint: {},
  });
  assert.ok(malformed);
  assert.equal(malformed?.harnessRevision, undefined);
  assert.equal(malformed?.harnessFingerprint, undefined);
});

test('coerceSessionAnalyticsFactors accepts only supported shapes and values', () => {
  assert.equal(coerceSessionAnalyticsFactors(null), null);
  assert.equal(coerceSessionAnalyticsFactors('invalid'), null);

  const coerced = coerceSessionAnalyticsFactors({
    promptFamily: 'harness+skills',
    promptHash: 123,
    harnessPromptHash: null,
    customPromptHash: 'custom-hash',
    appendSystemPromptHash: undefined,
    promptGuidelineHashes: ['a', 2, 'b'],
    contextFiles: [
      { path: '/repo/AGENTS.md', hash: 'ctx-1' },
      { path: '/repo/EMPTY.md', hash: 1 },
      null,
    ],
    selectedToolIds: ['read', null, 'bash'],
    toolSnippetHashes: [
      { toolId: 'read', hash: 'snippet-1' },
      { toolId: 'edit', hash: 1 },
    ],
    toolSetHash: 'tool-set-hash',
    skills: [
      { name: 'code-review', contentHash: 'content-hash', sourceHash: 7, disableModelInvocation: true, lastModifiedAt: '2026-01-01T00:00:00.000Z' },
      { name: '', contentHash: 'ignored', sourceHash: 'ignored' },
    ],
    skillSetHash: null,
    activeExtensions: ['subagent', 5, 'skill-pruner'],
  });

  assert.deepEqual(coerced, {
    promptFamily: 'harness+skills',
    promptHash: null,
    promptCapturedAt: null,
    harnessPromptHash: null,
    customPromptHash: 'custom-hash',
    appendSystemPromptHash: null,
    promptGuidelineHashes: ['a', 'b'],
    contextFiles: [{ path: '/repo/AGENTS.md', hash: 'ctx-1' }],
    selectedToolIds: ['read', 'bash'],
    toolSnippetHashes: [{ toolId: 'read', hash: 'snippet-1' }],
    toolSetHash: 'tool-set-hash',
    skills: [{
      name: 'code-review',
      contentHash: 'content-hash',
      sourceHash: null,
      disableModelInvocation: true,
      lastModifiedAt: '2026-01-01T00:00:00.000Z',
    }],
    skillSetHash: null,
    activeExtensions: ['subagent', 'skill-pruner'],
  });
});

test('rollup coercers normalize invalid nested records and preserve valid values', () => {
  assert.deepEqual(coerceTreatmentChangeKinds(['model', 'invalid', 'model', 'extensions']), ['model', 'extensions']);

  const toolUsage = coerceToolUsageRollup({
    totalCount: 3.9,
    failureCount: -1,
    executionFailureCount: 2.2,
    verificationProjectFailureCount: 1.1,
    probeFailureCount: 0.4,
    countsByName: { bash: 2.2, read: -1, invalid: 'x' },
    failureCountsByName: { bash: 1.8, edit: null },
    failureCountsByKind: { timeout: 2.6, unknown: 1.2 },
    failureCountsByNameAndKind: {
      bash: { timeout: 1.9, unknown: 0.6 },
      read: 'invalid',
    },
    failureSamples: [
      { toolName: 'bash', failureKind: 'timeout', exitCode: 7.9, errorExcerpt: 9, verificationKinds: ['test', 'bogus'], occurredAt: '2026-01-01T00:00:00.000Z' },
      { toolName: 9, failureKind: 'timeout', occurredAt: '2026-01-01T00:00:00.000Z' },
    ],
    totalDurationMs: 1234.9,
    timedCallCount: 2.6,
    durationMsByName: { bash: 900.7, read: -5, invalid: 'x' },
    subagentCallCount: 1,
    subagentTaskCount: 2,
    subagentAgentNames: ['worker', 3],
  });

  assert.equal(toolUsage.totalCount, 3);
  assert.equal(toolUsage.failureCount, 2);
  assert.equal(toolUsage.executionFailureCount, 2);
  assert.equal(toolUsage.verificationProjectFailureCount, 1);
  assert.equal(toolUsage.probeFailureCount, 0);
  assert.equal(toolUsage.resultIssueCount, 1);
  assert.deepEqual(toolUsage.countsByName, { bash: 2 });
  assert.deepEqual(toolUsage.failureCountsByName, { bash: 1 });
  assert.equal(toolUsage.failureCountsByKind.timeout, 2);
  assert.equal(toolUsage.failureCountsByNameAndKind.bash?.timeout, 1);
  assert.equal(toolUsage.failureSamples.length, 1);
  assert.equal(toolUsage.failureSamples[0]?.exitCode, 7);
  assert.equal(toolUsage.failureSamples[0]?.errorExcerpt, '');
  assert.deepEqual(toolUsage.failureSamples[0]?.verificationKinds, ['test']);
  assert.deepEqual(toolUsage.subagentAgentNames, ['worker']);
  assert.equal(toolUsage.totalDurationMs, 1234);
  assert.equal(toolUsage.timedCallCount, 2);
  assert.deepEqual(toolUsage.durationMsByName, { bash: 900 });
  assert.deepEqual(toolUsage.timedCallCountsByName, {});

  assert.deepEqual(coerceFileMutationRollup({ writeCount: 1.9, editCount: 2.1, deleteCount: 'x', renameCount: -1, touchedFileCount: 3.8, lineAdditions: 4.4, lineDeletions: 5.2, lineModifications: 6.7, readCountsByFile: { aaa: 2.5, bbb: -1 } }), {
    writeCount: 1,
    editCount: 2,
    deleteCount: 0,
    renameCount: 0,
    touchedFileCount: 3,
    lineAdditions: 4,
    lineDeletions: 5,
    lineModifications: 6,
    editCountsByFile: {},
    readCountsByFile: { aaa: 2 },
  });
  assert.deepEqual(coerceFileMutationRollup(null), createEmptyFileMutationRollup());

  assert.deepEqual(coerceFileExtensionRollup({
    readCountsByExtension: { '.ts': 2.4, '.md': -1 },
    writeCountsByExtension: null,
    editCountsByExtension: { '.json': 1.8 },
  }), {
    readCountsByExtension: { '.ts': 2 },
    writeCountsByExtension: {},
    editCountsByExtension: { '.json': 1 },
  });
  assert.deepEqual(coerceFileExtensionRollup(undefined), createEmptyFileExtensionRollup());

  assert.deepEqual(coerceVerificationRollup({
    totalCount: 5.9,
    failureCount: -1,
    countsByKind: { test: 2.2, build: 1.1, lint: -1, typecheck: 3.9 },
  }), {
    totalCount: 5,
    failureCount: 0,
    countsByKind: {
      test: 2,
      build: 1,
      lint: 0,
      typecheck: 3,
      format: 0,
      other: 0,
    },
  });
  assert.deepEqual(coerceVerificationRollup('invalid'), createEmptyVerificationRollup());
});

test('stats-service helpers summarize inputs, checkpoint parsing, and utility helpers', () => {
  const run = makeRunSnapshot();
  const inputs: ComposerInput[] = [
    { id: 'file-1', kind: 'filesystemPathRef', path: '/repo/a.ts', name: 'a.ts', source: 'picker' },
    { id: 'image-1', kind: 'imageBlob', mimeType: 'image/png', name: 'diagram.png', sizeBytes: 2048, dataBase64: 'ZmFrZQ==', source: 'paste' },
    { id: 'blob-1', kind: 'fileBlob', mimeType: 'application/pdf', name: 'spec.pdf', sizeBytes: 512, dataBase64: 'ZmFrZQ==', source: 'drop' },
    { id: 'file-2', kind: 'filesystemPathRef', path: '/repo/b.ts', name: 'b.ts', source: 'picker' },
  ];

  summarizeInputs(run, inputs);
  assert.equal(run.filesystemPathRefCount, 2);
  assert.equal(run.imageInputCount, 1);
  assert.equal(run.imageInputBytes, 2048);
  assert.equal(run.unsupportedInputCount, 1);
  assert.deepEqual(run.inputKindsUsed.sort(), ['fileBlob', 'filesystemPathRef', 'imageBlob']);

  assert.equal(workspaceHash('workspace-a'), workspaceHash('workspace-a'));
  assert.notEqual(workspaceHash('workspace-a'), workspaceHash('workspace-b'));

  assert.equal(toActiveRunSummary(null), null);
  assert.deepEqual(toActiveRunSummary(run), { runId: 'run-1', status: 'open' });
  assert.deepEqual(toActiveRunSummary(run, true), { runId: 'run-1', status: 'open', nextSendStartsNewTask: true });

  const persisted = toPersistedSessionState({
    currentRun: run,
    lastRun: null,
    nextTaskIntent: 'new_task',
    queuedUnsupportedInputCount: 2,
    busyStartedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(persisted.currentRun?.runId, 'run-1');
  assert.equal(persisted.nextTaskIntent, 'new_task');

  const checkpoint = parseCheckpoint(JSON.stringify({
    schemaVersion: 1,
    seq: 5,
    sessions: {
      '/repo/session.jsonl': {
        currentRun: run,
        lastRun: null,
        nextTaskIntent: 'continue_task',
        queuedUnsupportedInputCount: 3.9,
        busyStartedAt: '2026-01-01T00:00:00.000Z',
      },
      '/repo/ignored.jsonl': null,
    },
  }));
  assert.equal(checkpoint?.seq, 5);
  assert.equal(checkpoint?.sessions['/repo/session.jsonl']?.nextTaskIntent, 'continue_task');
  assert.equal(checkpoint?.sessions['/repo/session.jsonl']?.queuedUnsupportedInputCount, 3);
  assert.equal(checkpoint?.sessions['/repo/ignored.jsonl'], undefined);

  assert.equal(parseCheckpoint('{not json}'), null);
  assert.equal(parseCheckpoint(JSON.stringify({ schemaVersion: 999, seq: 1, sessions: {} })), null);
  assert.equal(parseCheckpoint(JSON.stringify({ schemaVersion: 1, seq: 'bad', sessions: {} })), null);
  assert.equal(parseCheckpoint(JSON.stringify({ schemaVersion: 1, seq: 1, sessions: null })), null);

  assert.equal(areStringArraysEqual(undefined, []), true);
  assert.equal(areStringArraysEqual(['a', 'b'], ['a', 'b']), true);
  assert.equal(areStringArraysEqual(['a'], ['b']), false);
  assert.equal(areStringArraysEqual(['a'], ['a', 'b']), false);
});

test('coerceFunctionalSettings accepts valid snapshots and drops malformed ones', () => {
  assert.equal(coerceFunctionalSettings(null), null);
  assert.equal(coerceFunctionalSettings('invalid'), null);
  assert.equal(coerceFunctionalSettings({ subagentAlwaysParentModel: true }), null); // missing pruningMode
  assert.equal(coerceFunctionalSettings({ pruningMode: 'bogus' }), null); // invalid pruningMode

  const coerced = coerceFunctionalSettings({
    subagentAlwaysParentModel: 'truthy',
    pruningMode: 'shadow',
    extensionToggles: { subagent: true, safeguard: 'no', cwd: false },
    toolResultPruningEnabled: true,
    toolResultPruningProfile: 'security',
  });
  assert.deepEqual(coerced, {
    subagentAlwaysParentModel: false,
    pruningMode: 'shadow',
    extensionToggles: { subagent: true, cwd: false },
    toolResultPruningEnabled: true,
    toolResultPruningProfile: 'security',
  });
});

test('coerceFunctionalSettings defaults tool-result-pruning fields to null when absent or invalid', () => {
  const coerced = coerceFunctionalSettings({
    pruningMode: 'auto',
    toolResultPruningEnabled: 'truthy',
    toolResultPruningProfile: 'bogus',
  });
  assert.deepEqual(coerced, {
    subagentAlwaysParentModel: false,
    pruningMode: 'auto',
    extensionToggles: {},
    toolResultPruningEnabled: null,
    toolResultPruningProfile: null,
  });
});

test('coerceRunSnapshot preserves per-turn provider on throughput samples', () => {
  const snapshot = makeRunSnapshot();
  snapshot.turnThroughputSamples = [
    {
      endedAt: '2026-01-01T00:00:00.000Z',
      outputTokens: 10,
      generationDurationMs: 500,
      concurrentBusySessions: 1,
      status: 'completed',
      provider: 'openai',
    } as unknown as TurnThroughputSample,
    {
      endedAt: '2026-01-01T00:00:01.000Z',
      outputTokens: 4,
      generationDurationMs: 200,
      concurrentBusySessions: 1,
      status: 'completed',
    } as unknown as TurnThroughputSample,
  ];

  const coerced = coerceRunSnapshot(snapshot);
  assert.equal(coerced?.turnThroughputSamples[0]?.provider, 'openai');
  assert.equal(coerced?.turnThroughputSamples[1]?.provider, undefined);
});

test('coerceRunSnapshot rejects removed scoring-era statuses', () => {
  for (const value of [
    { ...makeRunSnapshot(), status: 'scored', finalizationReason: 'scored' },
    { ...makeRunSnapshot(), status: 'closed_unscored', finalizationReason: 'closed_unscored' },
  ]) {
    assert.equal(coerceRunSnapshot(value as unknown as RunSnapshot), null);
  }
});

test('coerceRunSnapshot coerces turn-latency fields on throughput samples, defaulting missing/malformed ones to null', () => {
  const snapshot = makeRunSnapshot();
  snapshot.turnThroughputSamples = [
    {
      endedAt: '2026-01-01T00:00:00.000Z',
      outputTokens: 10,
      generationDurationMs: 500,
      concurrentBusySessions: 1,
      status: 'completed',
      turnLatencyMs: 800,
      overheadMs: 100,
      providerLatencyMs: 700,
      providerQueueMs: 0,
      providerQueueAttemptCount: 1,
    },
    {
      // Legacy sample recorded before latency tracking existed.
      endedAt: '2026-01-01T00:00:01.000Z',
      outputTokens: 4,
      generationDurationMs: 200,
      concurrentBusySessions: 1,
      status: 'completed',
    } as unknown as TurnThroughputSample,
    {
      // Errored turn with malformed (negative / string) latency values.
      endedAt: '2026-01-01T00:00:02.000Z',
      outputTokens: 0,
      generationDurationMs: 0,
      concurrentBusySessions: 1,
      status: 'error',
      turnLatencyMs: -5,
      overheadMs: 'fast',
      providerLatencyMs: null,
    } as unknown as TurnThroughputSample,
  ];

  const coerced = coerceRunSnapshot(snapshot);
  assert.equal(coerced?.turnThroughputSamples.length, 3);

  const [a, b, c] = coerced!.turnThroughputSamples;
  assert.equal(a.turnLatencyMs, 800);
  assert.equal(a.overheadMs, 100);
  assert.equal(a.providerLatencyMs, 700);
  assert.equal(a.providerQueueMs, 0, 'observed immediate grant remains explicit zero');
  assert.equal(a.providerQueueAttemptCount, 1);

  assert.equal(b.turnLatencyMs, null, 'missing latency coerces to null');
  assert.equal(b.overheadMs, null);
  assert.equal(b.providerLatencyMs, null);
  assert.equal(b.providerQueueMs, null, 'legacy missing queue timing remains unknown');
  assert.equal(b.providerQueueAttemptCount, 0);

  assert.equal(c.turnLatencyMs, null, 'negative coerces to null');
  assert.equal(c.overheadMs, null, 'non-number coerces to null');
  assert.equal(c.providerLatencyMs, null);
});

test('coerceRunSnapshot preserves a stable session ID compatibly', () => {
  const legacy = makeRunSnapshot();
  delete legacy.sessionId;
  assert.equal(coerceRunSnapshot(legacy)?.sessionId, undefined);

  const current = makeRunSnapshot();
  current.sessionId = '  stable-session-id  ';
  assert.equal(coerceRunSnapshot(current)?.sessionId, 'stable-session-id');
});

test('coerceRunSnapshot preserves privacy-safe initial message size compatibly', () => {
  const legacy = makeRunSnapshot();
  delete legacy.initialUserMessageChars;
  assert.equal(coerceRunSnapshot(legacy)?.initialUserMessageChars, undefined);

  const current = makeRunSnapshot();
  current.initialUserMessageChars = 123;
  assert.equal(coerceRunSnapshot(current)?.initialUserMessageChars, 123);

  current.initialUserMessageChars = -10;
  assert.equal(coerceRunSnapshot(current)?.initialUserMessageChars, 0);
});

test('coerceRunSnapshot preserves bounded timestamped user-input samples and legacy absence', () => {
  const legacy = makeRunSnapshot();
  delete legacy.userInputCharSamples;
  assert.equal(coerceRunSnapshot(legacy)?.userInputCharSamples, undefined, 'legacy absence stays unavailable');

  const at = '2026-01-01T00:00:00.000Z';
  const current = makeRunSnapshot();
  current.userInputCharSamples = [
    { occurredAt: at, chars: 12 },
    { occurredAt: at, chars: null },
    { occurredAt: at, chars: 4.9 },
    { occurredAt: at, chars: MAX_USER_INPUT_SAMPLE_CHARS + 500 },
  ];
  assert.deepEqual(coerceRunSnapshot(current)?.userInputCharSamples, [
    { occurredAt: at, chars: 12 },
    { occurredAt: at, chars: null },
    { occurredAt: at, chars: 4 },
    { occurredAt: at, chars: MAX_USER_INPUT_SAMPLE_CHARS },
  ]);

  current.userInputCharSamples = [
    { occurredAt: at, chars: 8 },
    { occurredAt: 'not-a-date', chars: 5 },
    { occurredAt: at, chars: -1 },
    { occurredAt: at, chars: Number.POSITIVE_INFINITY },
    { occurredAt: at, chars: 'answer text' },
    {},
  ] as never;
  assert.deepEqual(coerceRunSnapshot(current)?.userInputCharSamples, [
    { occurredAt: at, chars: 8 },
    { occurredAt: at, chars: null },
    { occurredAt: at, chars: null },
    { occurredAt: at, chars: null },
  ], 'invalid timestamps are dropped, while timestamp-valid malformed lengths remain explicit coverage gaps');

  current.userInputCharSamples = { malformed: true } as never;
  assert.equal(coerceRunSnapshot(current)?.userInputCharSamples, undefined, 'malformed collection stays unavailable');

  current.userInputCharSamples = [];
  assert.deepEqual(coerceRunSnapshot(current)?.userInputCharSamples, [], 'explicit empty tracking evidence is preserved');
});

test('coerceRunSnapshot preserves the estimated prompt-token size compatibly', () => {
  const legacy = makeRunSnapshot();
  delete legacy.initialUserMessageTokens;
  assert.equal(coerceRunSnapshot(legacy)?.initialUserMessageTokens, undefined, 'absent stays untracked');

  const current = makeRunSnapshot();
  current.initialUserMessageTokens = 41;
  assert.equal(coerceRunSnapshot(current)?.initialUserMessageTokens, 41);

  current.initialUserMessageTokens = -3;
  assert.equal(coerceRunSnapshot(current)?.initialUserMessageTokens, 0);
});

test('coerceRunSnapshot preserves optional ask_user outcome counters compatibly', () => {
  const legacy = makeRunSnapshot();
  delete legacy.askUserAnsweredCount;
  delete legacy.askUserCancelledCount;
  const coercedLegacy = coerceRunSnapshot(legacy);
  assert.equal(coercedLegacy?.askUserAnsweredCount, undefined, 'absent counters stay untracked, not zero');
  assert.equal(coercedLegacy?.askUserCancelledCount, undefined);

  const current = makeRunSnapshot();
  current.askUserAnsweredCount = 2;
  current.askUserCancelledCount = 1;
  assert.equal(coerceRunSnapshot(current)?.askUserAnsweredCount, 2);
  assert.equal(coerceRunSnapshot(current)?.askUserCancelledCount, 1);

  current.askUserAnsweredCount = -1;
  current.askUserCancelledCount = 2.7;
  const coerced = coerceRunSnapshot(current);
  assert.equal(coerced?.askUserAnsweredCount, 0);
  assert.equal(coerced?.askUserCancelledCount, 2);
});

test('coerceRunSnapshot defaults and validates auxiliary LLM usage samples compatibly', () => {
  const legacy = makeRunSnapshot();
  delete legacy.auxiliaryLlmUsage;
  assert.deepEqual(coerceRunSnapshot(legacy)?.auxiliaryLlmUsage, []);

  const snapshot = makeRunSnapshot();
  snapshot.auxiliaryLlmUsage = [
    {
      kind: 'skill_pruning_prepass',
      sourceId: 'prune-1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      modelId: 'openai/pruner',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      durationMs: 250,
    },
    { kind: 'subagent', sourceId: '', occurredAt: '', inputTokens: 10 } as never,
    { kind: 'unknown', sourceId: 'bad', occurredAt: '2026-01-01T00:00:00.000Z' } as never,
  ];
  const coerced = coerceRunSnapshot(snapshot);
  assert.deepEqual(coerced?.auxiliaryLlmUsage, [snapshot.auxiliaryLlmUsage[0]]);
});

test('coerceRunSnapshot defaults retry timing and preserves null measured boundaries', () => {
  const legacy = makeRunSnapshot();
  delete legacy.retryTimingSamples;
  assert.deepEqual(coerceRunSnapshot(legacy)?.retryTimingSamples, []);

  const snapshot = makeRunSnapshot();
  snapshot.retryTimingSamples = [{
    sourceId: 'req:1',
    occurredAt: '2026-01-01T00:00:00.000Z',
    attempt: 1,
    scheduledDelayMs: 1_000,
    measuredDelayMs: null,
    durationMs: 1_500,
  }];
  assert.deepEqual(coerceRunSnapshot(snapshot)?.retryTimingSamples, snapshot.retryTimingSamples);
});

test('coerceToolUsageRollup preserves per-tool timed call counts and unknown critical-path coverage', () => {
  const toolUsage = coerceToolUsageRollup({
    totalCount: 3,
    totalDurationMs: 1200,
    timedCallCount: 2,
    durationMsByName: { bash: 500, read: 700 },
    timedCallCountsByName: { bash: 1, read: 1, edit: 0, invalid: 'x' },
  } as unknown as Parameters<typeof coerceToolUsageRollup>[0]);
  assert.deepEqual(toolUsage.timedCallCountsByName, { bash: 1, read: 1, edit: 0 });
  assert.equal(toolUsage.criticalPathDurationMs, undefined);

  const measured = coerceToolUsageRollup({
    totalCount: 1,
    totalDurationMs: 0,
    criticalPathDurationMs: 0,
    timedCallCount: 1,
  } as unknown as Parameters<typeof coerceToolUsageRollup>[0]);
  assert.equal(measured.criticalPathDurationMs, 0, 'an explicit measured zero remains distinct from legacy absence');
});

test('coerceToolUsageRollup preserves verification-pending result issues without failure counters', () => {
  const toolUsage = coerceToolUsageRollup({
    failureCount: 0,
    executionFailureCount: 0,
    verificationProjectFailureCount: 0,
    probeFailureCount: 0,
    resultIssueCount: 1,
    resultIssueCountsByKind: { verification_pending: 1 },
    resultIssueCountsByName: { bash: 1 },
    resultIssueCountsByNameAndKind: { bash: { verification_pending: 1 } },
    resultIssueSamples: [{
      toolName: 'bash',
      resultIssueKind: 'verification_pending',
      exitCode: 8,
      errorExcerpt: '',
      verificationKinds: ['other'],
      occurredAt: '2026-01-03T00:00:00.000Z',
    }],
  });

  assert.equal(toolUsage.failureCount, 0);
  assert.equal(toolUsage.executionFailureCount, 0);
  assert.equal(toolUsage.verificationProjectFailureCount, 0);
  assert.equal(toolUsage.probeFailureCount, 0);
  assert.equal(toolUsage.resultIssueCount, 1);
  assert.equal(toolUsage.resultIssueCountsByKind.verification_pending, 1);
  assert.equal(toolUsage.resultIssueCountsByNameAndKind.bash?.verification_pending, 1);
  assert.equal(toolUsage.resultIssueSamples[0]?.resultIssueKind, 'verification_pending');
});

test('coerceToolUsageRollup remaps legacy failure kinds into result-issue rollups', () => {
  // Pre-split data: verification_project_failure and probe_no_match were counted
  // under the failure rollups, and no resultIssue* fields existed.
  const legacy = {
    totalCount: 5,
    failureCount: 4,
    executionFailureCount: 2,
    verificationProjectFailureCount: 1,
    probeFailureCount: 1,
    countsByName: { bash: 3, read: 2 },
    failureCountsByName: { bash: 3, read: 1 },
    failureCountsByKind: {
      timeout: 1,
      nonzero_exit: 1,
      verification_project_failure: 1,
      probe_no_match: 1,
    },
    failureCountsByNameAndKind: {
      bash: { timeout: 1, verification_project_failure: 1, probe_no_match: 1 },
      read: { nonzero_exit: 1 },
    },
    failureSamples: [
      { toolName: 'bash', failureKind: 'timeout', exitCode: 124, errorExcerpt: 'timed out', verificationKinds: [], occurredAt: '2026-01-01T00:00:00.000Z' },
      { toolName: 'bash', failureKind: 'verification_project_failure', exitCode: 1, errorExcerpt: 'tests failed', verificationKinds: ['test'], occurredAt: '2026-01-02T00:00:00.000Z' },
      { toolName: 'bash', failureKind: 'probe_no_match', exitCode: 1, errorExcerpt: '', verificationKinds: [], occurredAt: '2026-01-03T00:00:00.000Z' },
    ],
  } as unknown as Parameters<typeof coerceToolUsageRollup>[0];

  const toolUsage = coerceToolUsageRollup(legacy);

  // Execution-only failure counts (verification/probe no longer counted as failures).
  assert.equal(toolUsage.failureCount, 2);
  assert.equal(toolUsage.executionFailureCount, 2);
  assert.equal(toolUsage.verificationProjectFailureCount, 1);
  assert.equal(toolUsage.probeFailureCount, 1);
  assert.equal(toolUsage.resultIssueCount, 2);

  // Legacy kinds removed from the failure by-kind rollup...
  assert.equal(toolUsage.failureCountsByKind.timeout, 1);
  assert.equal(toolUsage.failureCountsByKind.nonzero_exit, 1);
  assert.equal(('verification_project_failure' in toolUsage.failureCountsByKind), false);
  assert.equal(('probe_no_match' in toolUsage.failureCountsByKind), false);

  // ...and remapped into the result-issue by-kind rollup.
  assert.equal(toolUsage.resultIssueCountsByKind.verification_failure, 1);
  assert.equal(toolUsage.resultIssueCountsByKind.probe_no_match, 1);

  // Per-tool split: bash keeps execution kinds, gains result-issue kinds.
  assert.equal(toolUsage.failureCountsByNameAndKind.bash?.timeout, 1);
  // bash's embedded legacy result-issue counts (1 + 1) are subtracted from
  // failureCountsByName (3 -> 1) to keep the per-tool totals execution-only.
  assert.deepEqual(toolUsage.failureCountsByName, { bash: 1, read: 1 });
  assert.equal(('verification_project_failure' in (toolUsage.failureCountsByNameAndKind.bash ?? {})), false);
  assert.equal(toolUsage.resultIssueCountsByNameAndKind.bash?.verification_failure, 1);
  assert.equal(toolUsage.resultIssueCountsByNameAndKind.bash?.probe_no_match, 1);

  // Samples split: execution sample stays; verification/probe move to result-issue samples.
  assert.equal(toolUsage.failureSamples.length, 1);
  assert.equal(toolUsage.failureSamples[0]?.failureKind, 'timeout');
  assert.equal(toolUsage.resultIssueSamples.length, 2);
  assert.equal(toolUsage.resultIssueSamples[0]?.resultIssueKind, 'verification_failure');
  assert.deepEqual(toolUsage.resultIssueSamples[0]?.verificationKinds, ['test']);
  assert.equal(toolUsage.resultIssueSamples[1]?.resultIssueKind, 'probe_no_match');
});

test('coerceRunSnapshot preserves lifecycle unknowns and rejects malformed attempt samples', () => {
  const legacy = makeRunSnapshot();
  assert.equal(coerceRunSnapshot(legacy)?.subagentAttemptSamples, undefined, 'legacy absence stays unavailable');

  const snapshot = makeRunSnapshot();
  snapshot.unknownSubagentAttemptRecordSourceIds = ['tool-missing', 'tool-missing'];
  snapshot.subagentAttemptSamples = [
    {
      sourceId: 'tool:0:attempt', attemptId: 'attempt', retryIndex: 1, outcome: 'success',
      durationMs: 0, durationSource: 'measured', backoffMs: 0, backoffSource: 'reported',
      phaseDurationsMs: { preparing: 0 }, phaseDurationsSource: 'measured',
      attemptSettlementOutcome: 'completed', attemptSettlementSource: 'reported', parentSettlementSource: 'unknown', cleanupOutcome: null, cleanupSource: 'unknown',
    },
    {
      sourceId: 'bad', attemptId: 'bad', retryIndex: 0, outcome: 'wat',
      durationMs: 20, durationSource: 'measured', backoffMs: 0, backoffSource: 'reported',
      phaseDurationsMs: null, phaseDurationsSource: 'unknown',
      attemptSettlementOutcome: null, attemptSettlementSource: 'unknown', parentSettlementSource: 'unknown', cleanupOutcome: null, cleanupSource: 'unknown',
    } as never,
  ];
  const coerced = coerceRunSnapshot(snapshot)?.subagentAttemptSamples;
  assert.equal(coerced?.length, 1);
  assert.deepEqual(coerceRunSnapshot(snapshot)?.unknownSubagentAttemptRecordSourceIds, ['tool-missing'],
    'explicit mixed-run unknown coverage persists idempotently through coercion');
  assert.equal(coerced?.[0]?.durationMs, 0, 'measured zero remains a measurement');
  assert.deepEqual(coerced?.[0]?.phaseDurationsMs, { preparing: 0 }, 'measured phase zero remains evidence');
  assert.equal(coerced?.[0]?.cleanupSource, 'unknown', 'unset current cleanup is not fabricated');

  snapshot.subagentAttemptSamples = { malformed: true } as never;
  assert.equal(coerceRunSnapshot(snapshot)?.subagentAttemptSamples, undefined, 'malformed collection stays unavailable');
});
