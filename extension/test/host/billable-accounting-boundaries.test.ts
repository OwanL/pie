import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { produce } from 'immer';

import { createInitialArchState, type ArchState } from '../../src/host/core/arch-state';
import { StatsService } from '../../src/host/stats-service/service';
import type { ToolCall } from '../../src/shared/protocol';
import type { SessionUsageSample, SessionUsageSnapshot } from '../../src/shared/session-usage';

const hostSourceDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/host',
);

async function readHostSource(fileName: string): Promise<string> {
  return await fs.readFile(path.join(hostSourceDir, fileName), 'utf8');
}

function importStatements(source: string): string[] {
  return [...source.matchAll(/import[^'"]*['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

function stateFor(sessionPath: string, sessionId = 'session-parity'): ArchState {
  return produce(createInitialArchState(), (draft) => {
    draft.sessions.sessions = [{
      path: sessionPath,
      name: 'Parity fixture',
      cwd: '/workspace',
      modifiedAt: '2026-09-05T10:00:00.000Z',
      messageCount: 1,
      sessionId,
      modelId: 'model-a',
      provider: 'provider-a',
    }];
  });
}

function tempOptions(tempDir: string, getArchState: () => ArchState, workspaceId: string) {
  return {
    dataOutcomesRootPath: path.join(tempDir, 'outcomes'),
    legacyUsageDataRootPath: tempDir,
    workspaceId,
    getArchState,
    now: () => new Date(Date.parse('2026-09-05T10:00:00.000Z')),
    createId: () => 'run-parity',
  };
}

const OCCURRED_BASE = Date.parse('2026-09-05T10:00:00.000Z');
function at(offsetMs: number): string {
  return new Date(OCCURRED_BASE + offsetMs).toISOString();
}

function subagentToolCall(): ToolCall {
  return {
    id: 'tool-subagent-parity',
    name: 'subagent',
    status: 'completed',
    result: {
      mode: 'single',
      results: [{
        agent: 'worker',
        task: 'task',
        exitCode: 0,
        messages: [],
        providerInvocations: [{
          invocationId: 'child-provider-1',
          attemptId: 'attempt-1',
          provider: 'provider-a',
          model: 'model-a',
          usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
          startedAt: 1_000,
          completedAt: 2_000,
          outcome: 'success',
        }],
      }],
    },
  } as unknown as ToolCall;
}

function gapSnapshotSample(): SessionUsageSample {
  return {
    sourceId: 'legacy-snapshot-gap',
    kind: 'conversation',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    provenance: 'unknown',
    instrumentationGap: true,
    instrumentationGapReason: 'parity fixture gap',
    outcome: 'succeeded',
  } as SessionUsageSample;
}

const SESSION_PATH = '/workspace/parity.jsonl';
const USAGE = { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 7 };
const BILLING = {
  modelId: 'model-a',
  provider: 'provider-a',
  occurredAt: new Date(OCCURRED_BASE + 100).toISOString(),
  operationId: 'op-1',
};
const COMPACT_SAMPLE = {
  kind: 'history_compaction',
  sourceId: 'compact-1',
  occurredAt: new Date(OCCURRED_BASE + 200).toISOString(),
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  parentOperationId: 'op-1',
  outcome: 'succeeded',
};
const RETRY_TIMING = { sourceId: 'retry-1', occurredAt: new Date(OCCURRED_BASE + 300).toISOString(), attempt: 1, scheduledDelayMs: 50 };
const FAILED_ASSISTANT_SAMPLE = {
  kind: 'assistant_message',
  sourceId: 'assistant:turn-2',
  occurredAt: new Date(OCCURRED_BASE + 300).toISOString(),
  inputTokens: 2,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outcome: 'failed',
};
const PRUNING_DETAILS = {
  prepassModel: 'model-a',
  prepassProvider: 'provider-a',
  prepassInputTokens: 3,
  prepassOutputTokens: 0,
  prepassCacheReadTokens: 0,
  prepassCacheWriteTokens: 0,
};
const SNAPSHOT = {
  branchId: 'branch-parity',
  branchEntryIds: ['entry-1'],
  samples: [gapSnapshotSample()],
};

test('accounting adaptation lives in the billable-accounting module, not the StatsService façade', async () => {
  const [facade, accounting] = await Promise.all([
    readHostSource('stats-service/service.ts'),
    readHostSource('billable-accounting/service.ts'),
  ]);

  // The façade delegates accounting and keeps the RunObserver/query surface.
  assert.match(facade, /from '\.\.\/billable-accounting\/service'/);
  assert.match(facade, /this\.accounting\./);
  // Ownership: the adaptation logic lives in BillableAccounting, not the façade.
  assert.doesNotMatch(facade, /private (?:async )?(?:appendUsageSample|migrateHistoricalRunUsage|pricingFor|recordInvocationActivity|persistInvocationRecord)\b/);
  assert.doesNotMatch(facade, /function (?:pruningUsageSamples|stableInvocationId|calculatedCost)\b/);
  assert.doesNotMatch(facade, /pendingInvocationWrites/);
  assert.doesNotMatch(facade, /loadModelPricing/);
  for (const kept of [
    'queryRunAnalytics',
    'queryPersistedRunAnalytics',
    'getSessionUsage',
    'getBillableInvocationRecords',
    'getPendingCompletedRuns',
    'getWorkingTimeBySession',
    'setSessionPrivacy',
  ]) {
    assert.match(facade, new RegExp(kept), `façade must keep ${kept}`);
  }

  // The accounting module owns the durable ledger/timeline and stays acyclic.
  assert.match(accounting, /new BillableInvocationLedger/);
  assert.match(accounting, /new ActivityTimeline/);
  const accountingImports = importStatements(accounting);
  assert.ok(accountingImports.some((target) => target.endsWith('billable-invocation-ledger/service')));
  assert.ok(accountingImports.every((target) => !target.includes('stats-service')),
    'billable accounting must not import the run-observation façade');
  assert.ok(accountingImports.every((target) => !target.includes('aggregate-stats-service')));
});

test('completed history and pricing caches are owned by focused aggregate modules', async () => {
  const [service, cache, pricing] = await Promise.all([
    readHostSource('aggregate-stats-service.ts'),
    readHostSource('completed-history-cache.ts'),
    readHostSource('aggregate-pricing-cache.ts'),
  ]);

  assert.match(service, /new CompletedHistoryCache/);
  assert.match(service, /new AggregatePricingCache/);
  for (const moved of [
    'runAccumulators',
    'loadPricingCached',
    'parseSnapshotLines',
    'completedRunsCache',
    'lastDataSignature',
    'readDataSignature',
    'loadModelPricing',
    'private .*completedLayer',
  ]) {
    assert.doesNotMatch(service, new RegExp(moved), `AggregateStatsService must not own ${moved}`);
  }
  // Refresh cadence, open-run layer, rolling rate, and ledger projection stay.
  for (const kept of ['refreshLive', 'observeRollingRate', 'buildOpenAccumulator', 'projectLedgerIfAvailable', 'RECOMPUTE_MS']) {
    assert.match(service, new RegExp(kept), `AggregateStatsService must keep ${kept}`);
  }

  assert.match(cache, /incrementalAppendCompletedRuns/);
  assert.match(cache, /fullReloadCompletedRuns/);
  assert.match(cache, /ensureLayer/);
  assert.match(pricing, /loadModelPricing/);
  for (const [source, name] of [[cache, 'completed-history-cache'], [pricing, 'aggregate-pricing-cache']] as const) {
    const imports = importStatements(source);
    assert.ok(
      imports.every((target) => !target.includes('aggregate-stats-service') && !target.includes('stats-service/service')),
      `${name} must not import the façades it was extracted from`,
    );
  }
});

test('StatsService façade forwards accounting events with the same evidence as direct adaptation', async () => {
  const tempDirA = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-accounting-facade-a-'));
  const tempDirB = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-accounting-facade-b-'));
  const facadeStats = new StatsService(tempOptions(tempDirA, () => stateFor(SESSION_PATH), 'workspace-parity-a'));
  const directStats = new StatsService(tempOptions(tempDirB, () => stateFor(SESSION_PATH), 'workspace-parity-b'));
  try {
    await Promise.all([facadeStats.start(), directStats.start()]);
    facadeStats.prepareForSend(SESSION_PATH, []);
    directStats.prepareForSend(SESSION_PATH, []);
    const accounting = (directStats as unknown as {
      accounting: {
        observeAssistantTurnStarted(sessionPath: string): void;
        observeAssistantTurnEnded(
          sessionPath: string,
          turnId: string,
          durationMs: number,
          usage?: typeof USAGE,
          status?: string,
          billing?: typeof BILLING,
        ): void;
        observeAuxiliaryLlmUsage(
          sessionPath: string,
          sample: {
            kind: string;
            sourceId: string;
            occurredAt: string;
            inputTokens?: number;
            outputTokens?: number;
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
            parentOperationId?: string;
            outcome?: string;
          },
        ): void;
        observeAutoRetry(sessionPath: string, timing?: typeof RETRY_TIMING): void;
        observeSkillPruningUsage(sessionPath: string, messageId: string, occurredAt: string, details: unknown): void;
        observeSubagentToolResult(sessionPath: string, toolCall: ToolCall): void;
        observeSessionUsageSnapshot(
          sessionPath: string,
          sessionId: string | undefined,
          snapshot: typeof SNAPSHOT,
        ): void;
      };
    }).accounting;

    // Façade path.
    facadeStats.onAssistantTurnStarted(SESSION_PATH, 'turn-1');
    facadeStats.onAssistantTurnEnded(SESSION_PATH, 'turn-1', 1_000, USAGE, 'completed', undefined, BILLING);
    facadeStats.onAuxiliaryLlmUsage(SESSION_PATH, COMPACT_SAMPLE as never);
    facadeStats.onAutoRetry(SESSION_PATH, RETRY_TIMING);
    facadeStats.onAuxiliaryLlmUsage(SESSION_PATH, FAILED_ASSISTANT_SAMPLE as never);
    facadeStats.onSkillPruningUsage(SESSION_PATH, 'message-p', new Date(OCCURRED_BASE + 400).toISOString(), PRUNING_DETAILS);
    facadeStats.onToolFinished(SESSION_PATH, subagentToolCall());
    facadeStats.onSessionUsageSnapshot(SESSION_PATH, 'session-parity', SNAPSHOT as unknown as SessionUsageSnapshot);

    // Direct accounting path over identical inputs.
    accounting.observeAssistantTurnStarted(SESSION_PATH);
    accounting.observeAssistantTurnEnded(SESSION_PATH, 'turn-1', 1_000, USAGE, 'completed', BILLING);
    accounting.observeAuxiliaryLlmUsage(SESSION_PATH, COMPACT_SAMPLE);
    accounting.observeAutoRetry(SESSION_PATH, RETRY_TIMING);
    accounting.observeAuxiliaryLlmUsage(SESSION_PATH, FAILED_ASSISTANT_SAMPLE);
    accounting.observeSkillPruningUsage(SESSION_PATH, 'message-p', new Date(OCCURRED_BASE + 400).toISOString(), PRUNING_DETAILS);
    accounting.observeSubagentToolResult(SESSION_PATH, subagentToolCall());
    accounting.observeSessionUsageSnapshot(SESSION_PATH, 'session-parity', SNAPSHOT);

    const facadeRecords = facadeStats.getBillableInvocationRecords();
    const directRecords = (directStats as unknown as {
      accounting: { exportRecords(): readonly unknown[] };
    }).accounting.exportRecords();
    assert.deepEqual(facadeRecords, directRecords);
    assert.deepEqual(
      facadeStats.getActivityIntervals(),
      (directStats as unknown as { accounting: { activityTimeline: { projectAll(): readonly unknown[] } } }).accounting.activityTimeline.projectAll(),
    );
    assert.deepEqual(facadeStats.getSessionUsage(SESSION_PATH), directStats.getSessionUsage(SESSION_PATH));

    // The scripted evidence covers every adaptation seam: conversation/retry
    // classification, auxiliary kinds, pruning, subagent, and snapshot
    // migration gaps.
    const kinds = facadeRecords.map((record) => record.kind as string);
    for (const expected of ['conversation', 'history_compaction', 'skill_pruning_prepass', 'subagent']) {
      assert.ok(kinds.includes(expected), `missing adapted kind ${expected}`);
    }
  } finally {
    await Promise.allSettled([facadeStats.shutdown(), directStats.shutdown()]);
    await fs.rm(tempDirA, { recursive: true, force: true });
    await fs.rm(tempDirB, { recursive: true, force: true });
  }
});

test('accounting clamps reversed provider timestamps before ledger persistence', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-accounting-reversed-time-'));
  const stats = new StatsService(tempOptions(tempDir, () => stateFor(SESSION_PATH), 'workspace-reversed-time'));
  try {
    await stats.start();
    stats.prepareForSend(SESSION_PATH, []);
    stats.onAuxiliaryLlmUsage(SESSION_PATH, {
      kind: 'history_compaction',
      sourceId: 'reversed-provider-time',
      occurredAt: at(1_000),
      startedAt: at(2_000),
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outcome: 'succeeded',
    });

    const record = stats.getBillableInvocationRecords().find(
      (candidate) => candidate.sourceId === 'reversed-provider-time',
    );
    assert.ok(record);
    assert.equal(record.startedAt, at(1_000));
    assert.equal(record.endedAt, at(1_000));
  } finally {
    await stats.shutdown();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});