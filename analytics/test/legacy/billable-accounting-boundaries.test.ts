import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { produce } from 'immer';

import { createInitialArchState, type ArchState } from '../../../application/backend/conversation-state/arch-state';
import { StatsService } from '../../../application/backend/analytics-views';
import type { ToolCall } from '../../../application/lib/protocol/index.js';
import type { SessionUsageSample, SessionUsageSnapshot } from '../../usage-accounting/session-usage';
import { buildSubagentUsageSamples } from '../../../harness/session-storage/transcripts/session-usage-adapter.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

async function readSource(fileName: string): Promise<string> {
  return await fs.readFile(path.join(repoRoot, fileName), 'utf8');
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

test('canonical accounting keeps adaptation and injected pricing without legacy persistence', async () => {
  const [facade, accounting, adaptation] = await Promise.all([
    readSource('application/backend/analytics-views/service.ts'),
    readSource('analytics/usage-accounting/canonical-accounting.ts'),
    readSource('analytics/usage-accounting/invocation-adaptation.ts'),
  ]);
  assert.ok(facade.includes('createCanonicalAccounting('));
  assert.ok(facade.includes('new CapturedPricingFactsLoader('));
  assert.ok(facade.includes('resolveInvocationPricing: resolveCapturedInvocationPricing'));
  assert.ok(facade.includes('buildSubagentUsageSamples(toolCall)'));
  assert.ok(accounting.includes('adaptInvocationRecord('));
  assert.ok(accounting.includes('captureProviderSettlement('));
  assert.ok(accounting.includes('getCapturedPricingFacts(sessionPath)'));
  assert.ok(adaptation.includes('resolveInvocationPricing('));
  for (const source of [facade, accounting, adaptation]) {
    assert.doesNotMatch(source, /new (?:BillableInvocationLedger|ActivityTimeline|RunSnapshotStorage)/);
    assert.ok(importStatements(source).every((target) => !/billable-accounting|billable-invocation-ledger|activity-timeline|completed-history-cache|run-analytics\/(query|storage|checkpoint)/.test(target)));
  }
  for (const source of [accounting, adaptation]) {
    assert.doesNotMatch(source, /loadModelPricing|model-pricing-history|harness\/model-providers\/pricing|node:fs/);
  }
});

test('analytics production owners do not import application implementation modules', async () => {
  const owners = [
    'analytics/legacy/working-time-service.ts',
    'analytics/legacy/stats-service/helpers.ts',
    'analytics/legacy/stats-service/session-run-state.ts',
    'analytics/legacy/stats-service/tracker.ts',
    'analytics/legacy/run-analytics/coercion-functional-settings.ts',
    'analytics/legacy/run-analytics/coercion-factors.ts',
    'analytics/legacy/run-analytics/coercion-snapshots.ts',
    'analytics/legacy/run-analytics/coercion-utils.ts',
    'analytics/usage-accounting/canonical-accounting.ts',
    'analytics/usage-accounting/invocation-adaptation.ts',
    'analytics/capture/canonical-capture.ts',
    'analytics/capture/tool-call-analysis/index.ts',
    'analytics/capture/tool-call-analysis/summary.ts',
    'analytics/capture/tool-call-analysis/mutation-file.ts',
    'analytics/capture/tool-call-analysis/mutation-size.ts',
    'analytics/capture/tool-call-analysis/mutation-tools.ts',
    'analytics/projections/tool-facet.ts',
    'analytics/usage-accounting/session-usage.ts',
  ];
  const sources = await Promise.all(owners.map((fileName) => readSource(fileName)));
  for (const [index, source] of sources.entries()) {
    assert.ok(
      importStatements(source).every((target) => !target.includes('application/')),
      `${owners[index]} must depend on canonical analytics or protocol contracts, not application modules`,
    );
  }
});

test('aggregate statistics use canonical reads, not legacy history or pricing caches', async () => {
  const service = await readSource('application/backend/analytics-views/aggregate-stats-service.ts');
  assert.match(service, /readProviderAggregateSummary/);
  assert.match(service, /publishUnknown/);
  assert.doesNotMatch(service, /new CompletedHistoryCache|new AggregatePricingCache|loadModelPricing|projectLedgerIfAvailable/);
  assert.ok(importStatements(service).every((target) => !target.includes('analytics/legacy/')));
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
        observeSubagentToolResult(sessionPath: string, toolCallId: string, samples: SessionUsageSample[]): void;
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
    const directSubagentTool = subagentToolCall();
    accounting.observeSubagentToolResult(
      SESSION_PATH,
      directSubagentTool.id,
      buildSubagentUsageSamples(directSubagentTool),
    );
    accounting.observeSessionUsageSnapshot(SESSION_PATH, 'session-parity', SNAPSHOT);

    assert.equal('getBillableInvocationRecords' in facadeStats, false);
    assert.equal('exportRecords' in accounting, false);
    assert.equal('getActivityIntervals' in facadeStats, false);
    assert.deepEqual(facadeStats.getSessionUsage(SESSION_PATH), directStats.getSessionUsage(SESSION_PATH));

    // Observations without canonical authority cannot resurrect legacy history.
    assert.equal(facadeStats.getSessionUsage(SESSION_PATH).authority, 'unknown');
    assert.deepEqual(await fs.readdir(tempDirA), []);
    assert.deepEqual(await fs.readdir(tempDirB), []);
  } finally {
    await Promise.allSettled([facadeStats.shutdown(), directStats.shutdown()]);
    await fs.rm(tempDirA, { recursive: true, force: true });
    await fs.rm(tempDirB, { recursive: true, force: true });
  }
});

test('accounting without canonical capture does not persist reversed timestamps', async () => {
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

    assert.equal('getBillableInvocationRecords' in stats, false);
    assert.deepEqual(await fs.readdir(tempDir), []);
  } finally {
    await stats.shutdown();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});