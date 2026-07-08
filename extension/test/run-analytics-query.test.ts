import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { produce } from 'immer';
import { StatsService } from '../src/host/stats-service';
import { exportRunAnalyticsStore, queryRunAnalyticsStore } from '../src/host/run-analytics/query';
import { createInitialArchState, type ArchState } from '../src/host/core/arch-state';
import { reducer } from '../src/host/core/reducer';
import type { SessionAnalyticsFactors } from '../src/shared/protocol';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-run-query-test-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function getRunStorageDir(tempDir: string): Promise<string> {
  const usageDataRoot = path.join(tempDir, 'data', 'outcomes');
  const entries = await fs.readdir(usageDataRoot);
  assert.equal(entries.length, 1, 'expected one hashed workspace directory');
  return path.join(usageDataRoot, entries[0]);
}

const ANALYTICS_FACTORS: SessionAnalyticsFactors = {
  promptFamily: 'harness+customPrompt',
  promptHash: 'prompt-hash',
  promptCapturedAt: '2025-06-15T10:30:00.000Z',
  harnessPromptHash: 'harness-hash',
  customPromptHash: 'custom-hash',
  appendSystemPromptHash: null,
  promptGuidelineHashes: [],
  contextFiles: [],
  selectedToolIds: ['bash'],
  toolSnippetHashes: [{ toolId: 'bash', hash: 'snippet-hash' }],
  toolSetHash: 'tool-set-hash',
  skills: [],
  skillSetHash: null,
  activeExtensions: [],
};

test('queryRunAnalyticsStore returns finalized snapshots and checkpointed open runs', async () => {
  await withTempDir(async (tempDir) => {
    let archState: ArchState = createInitialArchState();
    const sessionPath = '/workspace/session-query.jsonl';
    let idCounter = 0;

    archState = produce(archState, draft => {
      draft.sessions.sessions.push({
        path: sessionPath,
        name: 'Query Session',
        cwd: '/workspace',
        modifiedAt: new Date().toISOString(),
        messageCount: 0,
        modelId: 'claude',
      });
      draft.settings.modelSettings = {
        defaultModel: 'claude',
        defaultThinkingLevel: 'medium',
      };
      draft.sessions.analyticsFactorsBySession[sessionPath] = ANALYTICS_FACTORS;
    });

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId: 'workspace-query',
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
      createId: () => `id-${++idCounter}`,
      getExperimentAssignment: () => 'treatment-a',
    });

    await stats.start();
    const firstRunId = stats.prepareForSend(sessionPath, []);
    stats.recordOutcome(sessionPath, { resolution: 'resolved', satisfaction: 5 });
    const secondRunId = stats.prepareForSend(sessionPath, []);
    await stats.flush();

    const storageDir = await getRunStorageDir(tempDir);
    const result = await queryRunAnalyticsStore(storageDir);

    assert.equal(firstRunId, 'id-1');
    assert.equal(secondRunId, 'id-3');
    assert.equal(result.completedRuns.length, 1);
    assert.equal(result.completedRuns[0]?.runId, 'id-1');
    assert.equal(result.completedRuns[0]?.experimentAssignment, 'treatment-a');
    assert.equal(result.completedRuns[0]?.analyticsFactors?.promptHash, 'prompt-hash');
    assert.equal(result.openRuns.length, 1);
    assert.equal(result.openRuns[0]?.runId, 'id-3');
    assert.equal(result.outcomes.length, 1);

    await stats.shutdown();
  });
});

test('post-finalization lastRun mutations are exported (A2)', async () => {
  await withTempDir(async (tempDir) => {
    let archState: ArchState = createInitialArchState();
    const sessionPath = '/workspace/session-a2-late.jsonl';
    let idCounter = 0;

    archState = produce(archState, draft => {
      draft.sessions.sessions.push({
        path: sessionPath,
        name: 'A2 Late',
        cwd: '/workspace',
        modifiedAt: new Date().toISOString(),
        messageCount: 0,
        modelId: 'claude',
      });
      draft.settings.modelSettings = {
        defaultModel: 'claude',
        defaultThinkingLevel: 'medium',
      };
      draft.sessions.analyticsFactorsBySession[sessionPath] = ANALYTICS_FACTORS;
    });

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId: 'workspace-a2-late',
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
      createId: () => `id-${++idCounter}`,
      getExperimentAssignment: () => null,
    });

    await stats.start();
    stats.prepareForSend(sessionPath, []);
    stats.recordOutcome(sessionPath, { resolution: 'resolved', satisfaction: 5 });
    // currentRun is now null; lastRun holds the finalized run. A late backend
    // error mutates lastRun and must be appended so it surfaces in exports
    // (previously it was written only to the checkpoint's lastRun, which query
    // never reads, so it was silently lost).
    stats.onBackendError(sessionPath, 'E_LATE');
    await stats.flush();

    const storageDir = await getRunStorageDir(tempDir);
    const result = await queryRunAnalyticsStore(storageDir);
    assert.equal(result.completedRuns.length, 1);
    assert.ok(
      result.completedRuns[0]?.backendErrorCodes.includes('E_LATE'),
      'post-finalization lastRun mutation must be exported',
    );

    await stats.shutdown();
  });
});

test('mid-run mutations do not leak an open snapshot into completedRuns (A2)', async () => {
  await withTempDir(async (tempDir) => {
    let archState: ArchState = createInitialArchState();
    const sessionPath = '/workspace/session-a2-mid.jsonl';
    let idCounter = 0;

    archState = produce(archState, draft => {
      draft.sessions.sessions.push({
        path: sessionPath,
        name: 'A2 Mid',
        cwd: '/workspace',
        modifiedAt: new Date().toISOString(),
        messageCount: 0,
        modelId: 'claude',
      });
      draft.settings.modelSettings = {
        defaultModel: 'claude',
        defaultThinkingLevel: 'medium',
      };
      draft.sessions.analyticsFactorsBySession[sessionPath] = ANALYTICS_FACTORS;
    });

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId: 'workspace-a2-mid',
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
      createId: () => `id-${++idCounter}`,
      getExperimentAssignment: () => null,
    });

    await stats.start();
    stats.prepareForSend(sessionPath, []); // active currentRun
    // Mid-run mutation: must update the checkpoint (openRuns) only — NOT append a
    // snapshot, which would leak an in-progress run into completedRuns.
    stats.onBackendError(sessionPath, 'E_MID');
    await stats.flush();

    const storageDir = await getRunStorageDir(tempDir);
    const result = await queryRunAnalyticsStore(storageDir);
    assert.equal(result.completedRuns.length, 0, 'no finalized run should appear in completedRuns');
    assert.equal(result.openRuns.length, 1);
    assert.ok(
      result.openRuns[0]?.backendErrorCodes.includes('E_MID'),
      'mid-run mutation must still be recorded on the open run',
    );

    await stats.shutdown();
  });
});

test('exportRunAnalyticsStore writes a supported JSON export payload', async () => {
  await withTempDir(async (tempDir) => {
    let archState: ArchState = createInitialArchState();
    const sessionPath = '/workspace/session-export.jsonl';
    let idCounter = 0;

    archState = produce(archState, draft => {
      draft.sessions.sessions.push({
        path: sessionPath,
        name: 'Export Session',
        cwd: '/workspace',
        modifiedAt: new Date().toISOString(),
        messageCount: 0,
        modelId: 'gpt-4.1',
      });
      draft.settings.modelSettings = {
        defaultModel: 'gpt-4.1',
        defaultThinkingLevel: 'low',
      };
    });

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId: 'workspace-export',
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
      createId: () => `id-${++idCounter}`,
    });

    await stats.start();
    stats.prepareForSend(sessionPath, []);
    stats.recordOutcome(sessionPath, { resolution: 'resolved', satisfaction: 4 });
    await stats.flush();

    const storageDir = await getRunStorageDir(tempDir);
    const targetPath = path.join(tempDir, 'analytics-export.json');
    const payload = await exportRunAnalyticsStore(storageDir, targetPath, () => new Date('2026-01-01T00:00:00.000Z'));
    const written = JSON.parse(await fs.readFile(targetPath, 'utf8')) as {
      schemaVersion: number;
      exportedAt: string;
      completedRuns: Array<{ runId: string }>;
      openRuns: unknown[];
      outcomes: Array<{ runId: string }>;
      agentReviews: Array<{ runId: string }>;
    };

    assert.equal(payload.completedRuns.length, 1);
    assert.equal(payload.openRuns.length, 0);
    assert.equal(payload.agentReviews.length, 0);
    assert.equal(written.schemaVersion, 1);
    assert.equal(written.exportedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(written.completedRuns[0]?.runId, 'id-1');
    assert.equal(written.outcomes[0]?.runId, 'id-1');
    assert.equal(written.agentReviews.length, 0);

    await stats.shutdown();
  });
});

test('agent reviews are surfaced in query and export payloads', async () => {
  await withTempDir(async (tempDir) => {
    let archState: ArchState = createInitialArchState();
    const sessionPath = '/workspace/session-reviews.jsonl';
    let idCounter = 0;

    archState = produce(archState, draft => {
      draft.sessions.sessions.push({
        path: sessionPath,
        name: 'Review Session',
        cwd: '/workspace',
        modifiedAt: new Date().toISOString(),
        messageCount: 0,
        modelId: 'claude',
      });
      draft.settings.modelSettings = {
        defaultModel: 'claude',
        defaultThinkingLevel: 'medium',
      };
      draft.sessions.analyticsFactorsBySession[sessionPath] = ANALYTICS_FACTORS;
    });

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId: 'workspace-reviews',
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
      createId: () => `id-${++idCounter}`,
      getExperimentAssignment: () => null,
    });

    await stats.start();
    stats.prepareForSend(sessionPath, []);
    stats.recordOutcome(sessionPath, { resolution: 'resolved', satisfaction: 4 });
    stats.recordAgentReview(sessionPath, {
      done: true,
      rating: 5,
      completion: 'fully',
      reason: 'all green',
      evaluatedAt: '2026-07-08T12:00:00.000Z',
      reviewerBuckets: ['medium', 'small'],
      reviewerCount: 2,
    });
    await stats.flush();

    const storageDir = await getRunStorageDir(tempDir);
    const result = await queryRunAnalyticsStore(storageDir);
    assert.equal(result.completedRuns.length, 1);
    assert.equal(result.agentReviews.length, 1);
    assert.equal(result.agentReviews[0]?.runId, 'id-1');
    assert.equal(result.agentReviews[0]?.rating, 5);
    assert.equal(result.agentReviews[0]?.completion, 'fully');
    assert.deepEqual(result.agentReviews[0]?.reviewerBuckets, ['medium', 'small']);

    const targetPath = path.join(tempDir, 'analytics-export-reviews.json');
    const payload = await exportRunAnalyticsStore(storageDir, targetPath, () => new Date('2026-07-08T00:00:00.000Z'));
    assert.equal(payload.agentReviews.length, 1);
    assert.equal(payload.agentReviews[0]?.runId, 'id-1');

    await stats.shutdown();
  });
});