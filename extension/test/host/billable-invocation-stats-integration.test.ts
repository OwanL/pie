import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { produce } from 'immer';

import { createInitialArchState, type ArchState } from '../../src/host/core/arch-state';
import { BillableInvocationLedger } from '../../src/host/billable-invocation-ledger/service';
import { StatsService } from '../../src/host/stats-service/service';
import { isAuxiliaryLlmUsagePayload } from '../../src/shared/protocol/event-payloads';
import { boundToolFinishedPayload } from '../../src/backend/session-event-handler';
import { buildSubagentUsageSamples } from '../../src/shared/session-usage';
import type { BillableInvocationRecord } from '../../src/shared/billable-invocation';

function stateFor(sessionPath: string, privacyMode = false, sessionId = 'session-accounting'): ArchState {
  return produce(createInitialArchState(), (draft) => {
    draft.sessions.sessions = [{
      path: sessionPath,
      name: 'Accounting fixture',
      cwd: '/workspace',
      modifiedAt: '2026-09-04T10:00:00.000Z',
      messageCount: 1,
      sessionId,
      modelId: 'model-a',
      provider: 'provider-a',
    }];
    draft.sessions.privacyModeBySession[sessionPath] = privacyMode;
  });
}

function invocation(id: string, overrides: Partial<BillableInvocationRecord> = {}): BillableInvocationRecord {
  return {
    schemaVersion: 1,
    invocationId: id,
    sourceId: id,
    sessionId: 'session-accounting',
    sessionPath: '/workspace/accounting.jsonl',
    branchId: null,
    parentOperationId: null,
    parentRunId: null,
    parentToolId: null,
    kind: 'conversation',
    provider: 'provider-a',
    model: 'model-a',
    provenance: 'unknown',
    evidenceOrigin: 'live',
    startedAt: '2026-09-05T10:00:00.000Z',
    endedAt: '2026-09-05T10:00:01.000Z',
    outcome: 'unknown',
    instrumentationGap: true,
    instrumentationGapReason: 'test',
    ...overrides,
  } as BillableInvocationRecord;
}

test('auxiliary protocol accepts session-title settlements and gap metadata', () => {
  assert.equal(isAuxiliaryLlmUsagePayload({
    sessionPath: '/workspace/title.jsonl',
    kind: 'session_title',
    sourceId: 'session-title:1',
    occurredAt: '2026-09-04T10:00:00.000Z',
    startedAt: '2026-09-04T09:59:59.000Z',
    modelId: 'title-model',
    provider: 'title-provider',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outcome: 'unknown',
    instrumentationGap: true,
    instrumentationGapReason: 'Usage omitted.',
  }), true);
});

test('compacted terminal subagent results preserve each invocation and explicit no-usage gaps', () => {
  const payload = boundToolFinishedPayload({
    requestId: 'request-a',
    sessionPath: '/workspace/subagent.jsonl',
    messageId: 'message-a',
    toolCallId: 'tool-a',
    name: 'subagent',
    status: 'completed',
    result: {
      mode: 'single',
      results: [{
        agent: 'worker',
        task: 'task',
        exitCode: 0,
        messages: [],
        model: 'child-model',
        provider: 'child-provider',
        usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.1 },
        providerInvocations: [
          {
            invocationId: 'attempt-a:provider:1',
            attemptId: 'attempt-a',
            model: 'child-model',
            provider: 'child-provider',
            usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.1 },
            startedAt: 1_000,
            completedAt: 2_000,
            outcome: 'success',
          },
          {
            invocationId: 'attempt-a:provider:2',
            attemptId: 'attempt-a',
            model: 'child-model',
            provider: 'child-provider',
            startedAt: 2_100,
            completedAt: 2_200,
            outcome: 'failure',
          },
        ],
        attemptRecords: [],
      }],
    },
  });

  const samples = buildSubagentUsageSamples({
    id: payload.toolCallId,
    status: payload.status,
    result: payload.result,
  });
  assert.equal(samples.length, 2);
  assert.equal(samples[0]?.totalTokens, 6);
  assert.equal(samples[1]?.instrumentationGap, true);
  assert.equal(samples[1]?.outcome, 'failed');
});

test('dispatched subagent attempt with aggregate zeroes but no provider response emits a gap', () => {
  const samples = buildSubagentUsageSamples({
    id: 'tool-dispatched-gap',
    status: 'failed',
    result: {
      mode: 'single',
      results: [{
        agent: 'worker', task: 'task', exitCode: 1, messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        attemptRecords: [{
          attemptId: 'dispatched',
          providerResponseObserved: false,
          outcome: 'failure',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        }],
      }],
    },
  });
  assert.equal(samples.length, 1);
  assert.equal(samples[0]?.instrumentationGap, true);
});

test('bounded subagent sideband emits one explicit gap for every omitted provider response', () => {
  const providerInvocations = Array.from({ length: 130 }, (_, index) => ({
    invocationId: `provider-${index}`,
    attemptId: 'attempt-a',
    provider: 'provider-a',
    model: 'model-a',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
    startedAt: 1_000 + index,
    completedAt: 2_000 + index,
    outcome: 'success',
  }));
  const samples = buildSubagentUsageSamples({
    id: 'tool-overflow',
    status: 'completed',
    result: {
      mode: 'single',
      results: [{ agent: 'worker', task: 'task', exitCode: 0, messages: [], providerInvocations }],
    },
  });
  assert.equal(samples.length, 130);
  assert.equal(samples.filter((sample) => sample.instrumentationGap).length, 66);
});

test('oversized parallel terminal transport retains exact-plus-gap accounting for every response', () => {
  const results = Array.from({ length: 8 }, (_, child) => ({
    agent: `worker-${child}`,
    task: `task-${child}`,
    exitCode: 0,
    messages: [],
    providerInvocations: Array.from({ length: 130 }, (_, index) => ({
      invocationId: `child-${child}:provider-${index}`,
      attemptId: `attempt-${child}`,
      provider: 'provider-a',
      model: 'model-a',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
      startedAt: 1_000 + index,
      completedAt: 2_000 + index,
      outcome: 'success',
    })),
  }));
  const payload = boundToolFinishedPayload({
    requestId: 'request-overflow',
    sessionPath: '/workspace/subagent-overflow.jsonl',
    messageId: 'message-overflow',
    toolCallId: 'tool-overflow-parallel',
    name: 'subagent',
    status: 'completed',
    result: { mode: 'parallel', results },
  });
  const samples = buildSubagentUsageSamples({
    id: payload.toolCallId,
    status: payload.status,
    result: payload.result,
  });
  assert.equal(samples.length, 8 * 130);
  assert.ok(samples.some((sample) => sample.instrumentationGap));
});

test('terminal subagent result without usage or attempts emits an instrumentation gap', () => {
  const samples = buildSubagentUsageSamples({
    id: 'tool-gap',
    status: 'failed',
    result: {
      mode: 'single',
      results: [{ agent: 'worker', task: 'task', exitCode: 1, messages: [] }],
    },
  });
  assert.equal(samples.length, 1);
  assert.equal(samples[0]?.instrumentationGap, true);
  assert.equal(samples[0]?.totalTokens, 0);
});

test('a metered failed response does not also create a retry gap', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-ledger-retry-conservation-'));
  const sessionPath = '/workspace/retry-conservation.jsonl';
  const state = stateFor(sessionPath);
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(tempDir, 'outcomes'),
    legacyUsageDataRootPath: tempDir,
    workspaceId: 'workspace-retry-conservation',
    getArchState: () => state,
  });
  try {
    await stats.start();
    stats.prepareForSend(sessionPath, []);
    stats.onAssistantTurnStarted(sessionPath, 'turn-retry');
    stats.onAuxiliaryLlmUsage(sessionPath, {
      kind: 'assistant_message',
      sourceId: 'assistant:failed-response',
      occurredAt: '2026-09-04T10:00:01.000Z',
      inputTokens: 5,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outcome: 'failed',
    });
    stats.onAutoRetry(sessionPath, {
      sourceId: 'retry-1',
      occurredAt: '2026-09-04T10:00:01.100Z',
      attempt: 1,
      scheduledDelayMs: 100,
    });
    assert.equal(stats.getBillableInvocationRecords().length, 1);
    stats.onAuxiliaryLlmUsage(sessionPath, {
      kind: 'assistant_message',
      sourceId: 'assistant:successful-retry',
      occurredAt: '2026-09-04T10:00:02.000Z',
      inputTokens: 6,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    assert.deepEqual(stats.getBillableInvocationRecords().map((record) => record.kind), ['conversation', 'retry']);
    await stats.shutdown();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('StatsService retries a failed durable ledger append by stable invocation identity', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-ledger-retry-integration-'));
  const sessionPath = '/workspace/retry-accounting.jsonl';
  const state = stateFor(sessionPath);
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(tempDir, 'outcomes'),
    legacyUsageDataRootPath: tempDir,
    workspaceId: 'workspace-ledger-retry',
    getArchState: () => state,
  });
  try {
    await stats.start();
    stats.prepareForSend(sessionPath, []);
    const ledger = (stats as unknown as {
      accounting: { invocationLedger: { append: (...args: unknown[]) => unknown } };
    }).accounting.invocationLedger;
    const append = ledger.append.bind(ledger);
    let fail = true;
    ledger.append = (...args: unknown[]) => {
      if (fail) throw new Error('injected ledger append failure');
      return append(...args);
    };
    stats.onAssistantTurnEnded(sessionPath, 'retry-turn', 10, {
      inputTokens: 7,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 9,
    }, 'completed');
    assert.equal(stats.getBillableInvocationRecords().length, 0);

    fail = false;
    await stats.flush();
    assert.equal(stats.getBillableInvocationRecords().length, 1);
    assert.equal(stats.getActivityIntervals().filter((row) => row.invocationId).length, 1);
    await stats.shutdown();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('retry heals a crash boundary after ledger commit but before activity commit', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-activity-heal-'));
  const sessionPath = '/workspace/activity-heal.jsonl';
  const state = stateFor(sessionPath);
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(tempDir, 'outcomes'),
    legacyUsageDataRootPath: tempDir,
    workspaceId: 'workspace-activity-heal',
    getArchState: () => state,
  });
  try {
    await stats.start();
    stats.prepareForSend(sessionPath, []);
    const timeline = (stats as unknown as {
      accounting: { activityTimeline: { record: (...args: unknown[]) => unknown } };
    }).accounting.activityTimeline;
    const record = timeline.record.bind(timeline);
    let fail = true;
    timeline.record = (...args: unknown[]) => {
      if (fail) throw new Error('injected activity append failure');
      return record(...args);
    };
    stats.onAssistantTurnEnded(sessionPath, 'activity-heal', 1, {
      inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3,
    }, 'completed');
    assert.equal(stats.getBillableInvocationRecords().length, 1);
    assert.equal(stats.getActivityIntervals().length, 0);

    fail = false;
    await stats.flush();
    assert.equal(stats.getBillableInvocationRecords().length, 1);
    assert.equal(stats.getActivityIntervals().filter((row) => row.invocationId).length, 1);
    await stats.shutdown();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('two StatsService hosts preserve both checkpoints and privacy-safe exports', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-ledger-multi-host-'));
  const analyticsRoot = path.join(tempDir, 'outcomes');
  let stateA = stateFor('/workspace/a.jsonl', false, 'session-a');
  const stateB = stateFor('/workspace/b.jsonl', false, 'session-b');
  const common = {
    dataOutcomesRootPath: analyticsRoot,
    legacyUsageDataRootPath: tempDir,
    workspaceId: 'workspace-multi-host',
  };
  const first = new StatsService({ ...common, getArchState: () => stateA, createId: () => 'run-a' });
  const second = new StatsService({ ...common, getArchState: () => stateB, createId: () => 'run-b' });
  try {
    await Promise.all([first.start(), second.start()]);
    first.prepareForSend('/workspace/a.jsonl', []);
    second.prepareForSend('/workspace/b.jsonl', []);
    first.onBusyChanged('/workspace/a.jsonl', true);
    second.onBusyChanged('/workspace/b.jsonl', true);
    await Promise.all([first.flush(), second.flush()]);

    const reader = new StatsService({ ...common, getArchState: () => stateB, createId: () => 'reader' });
    await reader.start();
    assert.equal((await reader.queryRunAnalytics()).openRuns.length, 2, 'checkpoint merge retains both host sessions');
    await reader.shutdown();

    first.onAuxiliaryLlmUsage('/workspace/a.jsonl', {
      kind: 'other',
      sourceId: 'private-call',
      occurredAt: '2026-09-05T10:00:00.000Z',
      instrumentationGap: true,
      instrumentationGapReason: 'test gap',
      outcome: 'unknown',
    });
    stateA = stateFor('/workspace/a.jsonl', true, 'session-a');
    await first.setSessionPrivacy('/workspace/a.jsonl', true);
    const firstLedger = (first as unknown as {
      accounting: { invocationLedger: { filePath: string } };
    }).accounting.invocationLedger;
    const staleLedger = new BillableInvocationLedger(firstLedger.filePath);
    staleLedger.append(invocation('stale-null-id', {
      sessionId: null,
      sessionPath: '/workspace/a.jsonl',
    }), { visibility: 'ordinary' });
    const exportPath = path.join(tempDir, 'multi-host-export.json');
    const exported = await second.exportRunAnalytics(exportPath);
    assert.equal(exported.billableInvocations?.some((row) => row.sessionId === 'session-a'), false);
    assert.equal(exported.openRuns.some((run) => run.sessionId === 'session-a'), false);
    assert.equal(exported.activityIntervals?.some((row) => row.sessionId === 'session-a'), false);
  } finally {
    await Promise.allSettled([first.shutdown(), second.shutdown()]);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('restart recovers one open correlated busy interval without double counting', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-activity-restart-'));
  const sessionPath = '/workspace/activity-restart.jsonl';
  const state = stateFor(sessionPath);
  let nowMs = Date.parse('2026-09-05T10:00:00.000Z');
  const options = () => ({
    dataOutcomesRootPath: path.join(tempDir, 'outcomes'),
    legacyUsageDataRootPath: tempDir,
    workspaceId: 'workspace-activity-restart',
    getArchState: () => state,
    now: () => new Date(nowMs),
    createId: () => 'run-activity',
  });
  try {
    const first = new StatsService(options());
    await first.start();
    first.prepareForSend(sessionPath, []);
    first.onBusyChanged(sessionPath, true);
    nowMs += 2_000;
    await first.flush();

    const second = new StatsService(options());
    await second.start();
    assert.equal(second.getWorkingTimeBySession()[sessionPath]?.activeSince,
      Date.parse('2026-09-05T10:00:00.000Z'));
    nowMs += 3_000;
    second.onBusyChanged(sessionPath, false);
    assert.equal(second.getWorkingTimeBySession()[sessionPath]?.accumulatedMs, 5_000);
    await second.flush();

    const third = new StatsService(options());
    await third.start();
    assert.equal(third.getWorkingTimeBySession()[sessionPath]?.accumulatedMs, 5_000);
    assert.equal(third.getWorkingTimeBySession()[sessionPath]?.activeSince, null);
    await Promise.all([first.shutdown(), second.shutdown(), third.shutdown()]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('StatsService persists/replays ordinary settlements idempotently and scrubs private sessions', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-ledger-stats-integration-'));
  const sessionPath = '/workspace/accounting.jsonl';
  const analyticsRoot = path.join(tempDir, 'outcomes');
  let state = stateFor(sessionPath);
  let nowMs = Date.parse('2026-09-04T10:00:00.000Z');
  const options = () => ({
    dataOutcomesRootPath: analyticsRoot,
    legacyUsageDataRootPath: tempDir,
    workspaceId: 'workspace-accounting',
    getArchState: () => state,
    now: () => new Date(nowMs),
    createId: () => 'run-accounting',
  });

  try {
    const first = new StatsService(options());
    await first.start();
    first.prepareForSend(sessionPath, []);
    first.onAssistantTurnStarted(sessionPath, 'durable-turn-a');
    nowMs += 1_000;
    const usage = {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      totalTokens: 125,
      reportedCostUsd: 0.25,
    };
    first.onAuxiliaryLlmUsage(sessionPath, {
      kind: 'assistant_message',
      sourceId: 'assistant:durable-turn-intermediate',
      occurredAt: new Date(nowMs - 100).toISOString(),
      modelId: 'model-a',
      provider: 'provider-a',
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reportedCostUsd: 0.05,
      durationMs: 100,
    });
    first.onAuxiliaryLlmUsage(sessionPath, {
      kind: 'assistant_message',
      sourceId: 'assistant:durable-turn-a',
      occurredAt: new Date(nowMs).toISOString(),
      modelId: 'model-a',
      provider: 'provider-a',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      reportedCostUsd: usage.reportedCostUsd,
      durationMs: 1_000,
    });
    first.onAssistantTurnEnded(sessionPath, 'durable-turn-a', 1_000, usage, 'completed', undefined, {
      modelId: 'model-a',
      provider: 'provider-a',
      occurredAt: new Date(nowMs).toISOString(),
      operationId: 'operation-a',
    });
    first.onAssistantTurnEnded(sessionPath, 'durable-turn-a', 1_000, usage, 'completed', undefined, {
      modelId: 'model-a',
      provider: 'provider-a',
      occurredAt: new Date(nowMs).toISOString(),
      operationId: 'operation-a',
    });
    first.onSessionUsageSnapshot(sessionPath, 'session-accounting', {
      branchId: 'branch-a',
      branchEntryIds: ['durable-turn-intermediate', 'durable-turn-a', 'branch-a'],
      samples: [{
        sourceId: 'assistant:durable-turn-a',
        kind: 'assistant',
        modelId: 'model-a',
        provider: 'provider-a',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        totalTokens: 125,
        reportedCostUsd: 0.25,
      }],
    });
    assert.equal(first.getSessionUsage(sessionPath).samples.length, 2);
    const invocationRows = first.getBillableInvocationRecords();
    assert.equal(invocationRows.length, 2);
    const activityInvocationIds = new Set(first.getActivityIntervals().map((interval) => interval.invocationId));
    assert.ok(invocationRows.every((row) => activityInvocationIds.has(row.invocationId)),
      'every invocation ledger identity has one correlated activity interval');
    await first.flush();
    await first.shutdown();
    const automaticExport = JSON.parse(await fs.readFile(
      path.join(first.getStorageDir(), 'run-analytics.json'),
      'utf8',
    )) as { billableInvocations?: unknown[] };
    assert.equal(automaticExport.billableInvocations?.length, 2);

    const restarted = new StatsService(options());
    await restarted.start();
    assert.equal(restarted.getSessionUsage(sessionPath).samples.length, 2, 'restart replay must not duplicate or drop folded responses');
    assert.deepEqual(
      restarted.getSessionUsage(sessionPath).samples.map((sample) => sample.reportedCostUsd).sort(),
      [0.05, 0.25],
    );
    const explicitExportPath = path.join(tempDir, 'explicit-export.json');
    const explicitExport = await restarted.exportRunAnalytics(explicitExportPath);
    assert.equal(explicitExport.billableInvocations?.length, 2);
    assert.equal(explicitExport.billableInvocationSummary?.effectiveCostUsd.value, 0.3);

    state = stateFor(sessionPath, true);
    await restarted.setSessionPrivacy(sessionPath, true);
    assert.equal(restarted.getBillableInvocationRecords().length, 0, 'private rows are excluded from export');
    assert.equal(restarted.getSessionUsage(sessionPath).samples.length, 2, 'live private usage stays process-local');
    restarted.onSessionClosed(sessionPath);
    assert.equal(restarted.getSessionUsage(sessionPath).samples.length, 0);
    await assert.rejects(
      fs.access(path.join(restarted.getStorageDir(), 'accounting-private-sessions.json')),
      { code: 'ENOENT' },
    );
    await restarted.shutdown();

    state = stateFor(sessionPath);
    const afterPrivacyRestart = new StatsService(options());
    await afterPrivacyRestart.start();
    assert.equal(afterPrivacyRestart.getSessionUsage(sessionPath).samples.length, 0, 'scrubbed rows cannot resurrect');
    await afterPrivacyRestart.shutdown();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
