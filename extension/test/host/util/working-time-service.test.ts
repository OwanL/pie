import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkingTimeService } from '../../../src/host/working-time-service';
import type { RunSnapshot } from '../../../src/host/run-analytics';
import type { SubagentAttemptSample } from '../../../../shared/run-analytics-contracts';

function run(runId: string, sessionPath: string, busyDurationMs: number): RunSnapshot {
  return { runId, sessionPath, busyDurationMs } as RunSnapshot;
}

function subagentAttempt(
  sourceId: string,
  durationMs: number | null,
  overrides: Partial<SubagentAttemptSample> = {},
): SubagentAttemptSample {
  return {
    sourceId,
    attemptId: sourceId,
    retryIndex: 0,
    outcome: 'success',
    durationMs,
    durationSource: durationMs === null ? 'unknown' : 'measured',
    backoffMs: 0,
    backoffSource: 'reported',
    phaseDurationsMs: null,
    phaseDurationsSource: 'unknown',
    attemptSettlementOutcome: null,
    attemptSettlementSource: 'unknown',
    parentSettlementSource: 'unknown',
    cleanupOutcome: null,
    cleanupSource: 'unknown',
    ...overrides,
  };
}

function attributedRun(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    ...run('run-attributed', '/session/a.jsonl', 10_000),
    assistantTurnDurationMs: 4_000,
    auxiliaryLlmUsage: [{
      kind: 'skill_pruning_prepass',
      sourceId: 'prepass-1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs: 500,
    }],
    retryTimingSamples: [{
      sourceId: 'retry-1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      attempt: 1,
      scheduledDelayMs: 1_000,
      measuredDelayMs: 1_500,
      durationMs: 2_000,
    }],
    toolUsage: {
      totalDurationMs: 7_000,
      criticalPathDurationMs: 3_000,
      durationMsByName: { bash: 5_000, read: 2_000 },
      timedCallCountsByName: { bash: 2, read: 1 },
    },
    ...overrides,
  } as RunSnapshot;
}

test('working time restores durable runs once and advances only across busy intervals', () => {
  let nowMs = 10_000;
  let changed = 0;
  const service = new WorkingTimeService({
    now: () => new Date(nowMs),
    onChanged: () => { changed += 1; },
  });

  service.restoreRuns([
    run('run-1', '/session/a.jsonl', 2_000),
    run('run-1', '/session/a.jsonl', 2_000),
    run('run-2', '/session/a.jsonl', 3_000),
  ]);
  assert.deepEqual(service.getStates()['/session/a.jsonl'], {
    accumulatedMs: 5_000,
    activeSince: null,
  });

  service.onBusyChanged('/session/a.jsonl', true);
  nowMs += 4_000;
  assert.deepEqual(service.getStates()['/session/a.jsonl'], {
    accumulatedMs: 5_000,
    activeSince: 10_000,
  }, 'the renderer receives the live interval start instead of host-side ticking');

  service.onBusyChanged('/session/a.jsonl', false);
  nowMs += 20_000;
  assert.deepEqual(service.getStates()['/session/a.jsonl'], {
    accumulatedMs: 9_000,
    activeSince: null,
  }, 'idle wall time is excluded');
  assert.equal(changed, 3);
});

test('working time restores an open persisted busy interval exactly once', () => {
  let nowMs = 10_000;
  const service = new WorkingTimeService({
    now: () => new Date(nowMs),
    onChanged: () => {},
  });
  const sessionPath = '/session/restarted.jsonl';

  service.restoreRuns(
    [run('open-run', sessionPath, 2_000)],
    [{ sessionPath, busyStartedAt: new Date(0).toISOString() }],
  );
  assert.deepEqual(service.getStates()[sessionPath], {
    accumulatedMs: 2_000,
    activeSince: 0,
  });

  service.onBusyChanged(sessionPath, false);
  assert.deepEqual(service.getStates()[sessionPath], {
    accumulatedMs: 12_000,
    activeSince: null,
  });
  nowMs += 5_000;
  service.onBusyChanged(sessionPath, false);
  assert.equal(service.getStates()[sessionPath]?.accumulatedMs, 12_000);
});

test('working time attributes generation, retry, auxiliary, and overlapping tools without duplicate runs', () => {
  const service = new WorkingTimeService({
    now: () => new Date(0),
    onChanged: () => {},
  });

  service.restoreRuns([attributedRun(), attributedRun()]);
  assert.deepEqual(service.getStates()['/session/a.jsonl'], {
    accumulatedMs: 10_500,
    activeSince: null,
    breakdown: {
      generationMs: 4_000,
      toolExecutionMs: 3_000,
      estimatedToolExecutionMs: 0,
      retryWaitMs: 1_500,
      estimatedRetryWaitMs: 0,
      auxiliaryGenerationMs: 500,
      toolDurationMsByName: { bash: 5_000, read: 2_000 },
      toolCallCountByName: { bash: 2, read: 1 },
    },
  });

  service.observeRun(attributedRun({
    assistantTurnDurationMs: 5_000,
    toolUsage: {
      ...attributedRun().toolUsage,
      totalDurationMs: 8_000,
      criticalPathDurationMs: 3_500,
      durationMsByName: { bash: 6_000, read: 2_000 },
    },
  }));
  assert.equal(service.getStates()['/session/a.jsonl']?.accumulatedMs, 10_500, 'a refreshed open run does not duplicate busy or preflight time');
  assert.equal(service.getStates()['/session/a.jsonl']?.breakdown?.generationMs, 5_000);
  assert.equal(service.getStates()['/session/a.jsonl']?.breakdown?.toolExecutionMs, 3_500);
  assert.deepEqual(service.getStates()['/session/a.jsonl']?.breakdown?.toolDurationMsByName, { bash: 6_000, read: 2_000 });
});

test('working time reconciles mocked folded parent turns and keeps MCP in tool execution', () => {
  const service = new WorkingTimeService({
    now: () => new Date(0),
    onChanged: () => {},
  });
  const parentSample = {
    kind: 'assistant_message' as const,
    sourceId: 'parent-1',
    occurredAt: '2026-01-01T00:00:00.000Z',
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    durationMs: 4_000,
  };
  service.restoreRuns([attributedRun({
    busyDurationMs: 15_000,
    assistantTurnDurationMs: 0,
    auxiliaryLlmUsage: [
      parentSample,
      parentSample,
      { ...parentSample, sourceId: 'parent-2', durationMs: 3_000 },
      { ...parentSample, kind: 'history_compaction', sourceId: 'compact-1', durationMs: 1_000 },
    ],
    retryTimingSamples: [],
    toolUsage: {
      ...attributedRun().toolUsage,
      totalDurationMs: 5_000,
      criticalPathDurationMs: 5_000,
      durationMsByName: { mcp: 5_000 },
      timedCallCountsByName: { mcp: 2 },
    },
  })]);

  const breakdown = service.getStates()['/session/a.jsonl']?.breakdown;
  assert.equal(breakdown?.generationMs, 7_000, 'all unique durable parent turns contribute before a folded terminal exists');
  assert.equal(breakdown?.auxiliaryGenerationMs, 1_000, 'parent samples are not mislabeled as auxiliary calls');
  assert.equal(breakdown?.toolExecutionMs, 5_000);
  assert.deepEqual(breakdown?.toolDurationMsByName, { mcp: 5_000 });
});

test('working time exposes mocked live parallel tools as one wall-time interval', () => {
  let nowMs = 1_000;
  const service = new WorkingTimeService({
    now: () => new Date(nowMs),
    onChanged: () => {},
  });

  service.onBusyChanged('/session/a.jsonl', true);
  nowMs = 2_000;
  service.onToolStarted('/session/a.jsonl', { id: 'mcp-1', name: 'mcp', startedAt: nowMs });
  nowMs = 4_000;
  service.onToolStarted('/session/a.jsonl', { id: 'mcp-2', name: 'McpScript', startedAt: nowMs });
  nowMs = 9_000;
  service.onToolFinished('/session/a.jsonl', { id: 'mcp-1', startedAt: 2_000, durationMs: 5_000 });

  let state = service.getStates()['/session/a.jsonl'];
  assert.equal(state?.breakdown?.toolExecutionMs, 5_000);
  assert.equal(state?.activeToolSince, 7_000);
  assert.deepEqual(state?.activeTools, [{ id: 'mcp-2', name: 'mcpscript', startedAt: 4_000 }]);

  nowMs = 12_000;
  service.onToolFinished('/session/a.jsonl', { id: 'mcp-2', startedAt: 4_000, durationMs: 6_000 });
  state = service.getStates()['/session/a.jsonl'];
  assert.equal(state?.breakdown?.toolExecutionMs, 8_000, 'parallel calls contribute their union, not their cumulative 11 seconds');
  assert.equal(state?.activeToolSince, undefined);
  assert.equal(state?.activeTools, undefined);
});

test('working time sums parallel, nested, and retry subagent attempts as cumulative agent time', () => {
  const service = new WorkingTimeService({
    now: () => new Date(0),
    onChanged: () => {},
  });
  const attempts = [
    subagentAttempt('parallel-a', 4_000),
    subagentAttempt('parallel-b', 3_000),
    subagentAttempt('nested', 2_000),
    subagentAttempt('retry', 1_000, {
      retryIndex: 1,
      durationSource: 'estimated',
      backoffMs: 500,
      backoffSource: 'estimated',
    }),
    subagentAttempt('unknown', null),
  ];

  service.restoreRuns([attributedRun({
    subagentAttemptSamples: attempts,
    unknownSubagentAttemptRecordSourceIds: ['untracked-call'],
  })]);
  let breakdown = service.getStates()['/session/a.jsonl']?.breakdown;
  assert.equal(breakdown?.subagentDurationMs, 10_500);
  assert.equal(breakdown?.estimatedSubagentDurationMs, 1_500);
  assert.equal(breakdown?.subagentAttemptCount, 5);
  assert.equal(breakdown?.unknownSubagentDurationCount, 2);

  service.observeRun(attributedRun({ subagentAttemptSamples: attempts.slice(0, 2) }));
  breakdown = service.getStates()['/session/a.jsonl']?.breakdown;
  assert.equal(breakdown?.subagentDurationMs, 7_000, 'refresh replaces the prior run contribution');
  assert.equal(breakdown?.subagentAttemptCount, 2);
  assert.equal(breakdown?.unknownSubagentDurationCount, undefined);
});

test('working time estimates mocked legacy tool timing even before busy duration settles', () => {
  const service = new WorkingTimeService({
    now: () => new Date(0),
    onChanged: () => {},
  });
  service.restoreRuns([attributedRun({
    busyDurationMs: 0,
    assistantTurnDurationMs: 0,
    auxiliaryLlmUsage: [],
    retryTimingSamples: [],
    toolUsage: {
      ...attributedRun().toolUsage,
      totalDurationMs: 90_000,
      criticalPathDurationMs: undefined,
      durationMsByName: { mcp: 90_000 },
      timedCallCountsByName: { mcp: 1 },
    },
  })]);

  const breakdown = service.getStates()['/session/a.jsonl']?.breakdown;
  assert.equal(breakdown?.toolExecutionMs, 90_000);
  assert.equal(breakdown?.estimatedToolExecutionMs, 90_000);
  assert.deepEqual(breakdown?.toolDurationMsByName, { mcp: 90_000 });
});

test('working time marks legacy tool and unmeasured retry attribution as estimated', () => {
  const service = new WorkingTimeService({
    now: () => new Date(0),
    onChanged: () => {},
  });
  service.restoreRuns([attributedRun({
    busyDurationMs: 6_000,
    toolUsage: {
      ...attributedRun().toolUsage,
      totalDurationMs: 7_000,
      criticalPathDurationMs: undefined,
    },
    retryTimingSamples: [{
      sourceId: 'retry-legacy',
      occurredAt: '2026-01-01T00:00:00.000Z',
      attempt: 1,
      scheduledDelayMs: 1_000,
      measuredDelayMs: null,
      durationMs: null,
    }],
  })]);
  const breakdown = service.getStates()['/session/a.jsonl']?.breakdown;
  assert.equal(breakdown?.toolExecutionMs, 500, 'legacy cumulative tool time is capped to busy time not already attributed to other phases');
  assert.equal(breakdown?.estimatedToolExecutionMs, 500);
  assert.equal(breakdown?.retryWaitMs, 1_000);
  assert.equal(breakdown?.estimatedRetryWaitMs, 1_000);
});

test('working time preserves mocked durable and live-only tool time across path replacement', () => {
  let nowMs = 0;
  const service = new WorkingTimeService({
    now: () => new Date(nowMs),
    onChanged: () => {},
  });
  service.restoreRuns([
    attributedRun({
      runId: 'old-path-run',
      sessionPath: 'pending:1',
      assistantTurnDurationMs: 0,
      auxiliaryLlmUsage: [],
      retryTimingSamples: [],
      toolUsage: {
        ...attributedRun().toolUsage,
        totalDurationMs: 3_000,
        criticalPathDurationMs: 3_000,
        durationMsByName: { mcp: 3_000 },
        timedCallCountsByName: { mcp: 1 },
      },
    }),
    attributedRun({
      runId: 'new-path-run',
      sessionPath: '/session/new.jsonl',
      assistantTurnDurationMs: 0,
      auxiliaryLlmUsage: [],
      retryTimingSamples: [],
      toolUsage: {
        ...attributedRun().toolUsage,
        totalDurationMs: 2_000,
        criticalPathDurationMs: 2_000,
        durationMsByName: { bash: 2_000 },
        timedCallCountsByName: { bash: 1 },
      },
    }),
  ]);

  service.onToolStarted('pending:1', { id: 'old-live', name: 'mcp', startedAt: 100 });
  nowMs = 9_000;
  service.onToolFinished('pending:1', { id: 'old-live', startedAt: 100, durationMs: 2_000 });
  service.onToolStarted('/session/new.jsonl', { id: 'new-live', name: 'bash', startedAt: 200 });
  service.onToolFinished('/session/new.jsonl', { id: 'new-live', startedAt: 200, durationMs: 3_000 });

  service.replaceSessionPath('pending:1', '/session/new.jsonl');
  const state = service.getStates()['/session/new.jsonl'];
  assert.equal(state?.breakdown?.toolExecutionMs, 10_000, 'merged durable base and both live-only floors are retained');
  assert.deepEqual(state?.breakdown?.toolDurationMsByName, { mcp: 3_000, bash: 2_000 });
});

test('working time follows pending-path replacement and privacy reset', () => {
  let nowMs = 1_000;
  const service = new WorkingTimeService({
    now: () => new Date(nowMs),
    onChanged: () => {},
  });

  service.onBusyChanged('pending:1', true);
  nowMs = 2_000;
  service.replaceSessionPath('pending:1', '/session/new.jsonl');
  assert.deepEqual(service.getStates()['/session/new.jsonl'], {
    accumulatedMs: 0,
    activeSince: 1_000,
  });
  assert.equal(service.getStates()['pending:1'], undefined);

  service.resetSession('/session/new.jsonl', true);
  assert.deepEqual(service.getStates()['/session/new.jsonl'], {
    accumulatedMs: 0,
    activeSince: 2_000,
  });
  service.resetSession('/session/new.jsonl', false);
  assert.equal(service.getStates()['/session/new.jsonl'], undefined);
});
