import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { produce } from 'immer';

import { createInitialArchState, type ArchState } from '../../src/host/core/arch-state';
import { StatsService } from '../../src/host/stats-service/service';
import { isAuxiliaryLlmUsagePayload } from '../../src/shared/protocol/event-payloads';

function stateFor(sessionPath: string, privacyMode = false): ArchState {
  return produce(createInitialArchState(), (draft) => {
    draft.sessions.sessions = [{
      path: sessionPath,
      name: 'Accounting fixture',
      cwd: '/workspace',
      modifiedAt: '2026-09-04T10:00:00.000Z',
      messageCount: 1,
      sessionId: 'session-accounting',
      modelId: 'model-a',
      provider: 'provider-a',
    }];
    draft.sessions.privacyModeBySession[sessionPath] = privacyMode;
  });
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
      invocationLedger: { append: (...args: unknown[]) => unknown };
    }).invocationLedger;
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
    await stats.shutdown();
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
    assert.equal(first.getBillableInvocationRecords().length, 2);
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
