import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { produce } from 'immer';
import { StatsService } from '../../../src/host/stats-service';
import { exportRunAnalyticsStore, queryRunAnalyticsStore } from '../../../src/host/run-analytics/query';
import { createInitialArchState, type ArchState } from '../../../src/host/core/arch-state';
import { reducer } from '../../../src/host/core/reducer';
import type { SessionAnalyticsFactors } from '../../../src/shared/protocol';

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
    // A backend error recorded on the active run must survive finalization and
    // surface in exports once the run is closed. Closing the session finalizes
    // the run and appends its snapshot (carrying the error code) to the store.
    stats.onBackendError(sessionPath, 'E_LATE');
    stats.onSessionClosed(sessionPath);
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
    stats.onSessionClosed(sessionPath);
    await stats.flush();

    const storageDir = await getRunStorageDir(tempDir);
    const targetPath = path.join(tempDir, 'analytics-export.json');
    const payload = await exportRunAnalyticsStore(storageDir, targetPath, () => new Date('2026-01-01T00:00:00.000Z'));
    const written = JSON.parse(await fs.readFile(targetPath, 'utf8')) as {
      schemaVersion: number;
      exportedAt: string;
      completedRuns: Array<{ runId: string }>;
      openRuns: unknown[];
    };

    assert.equal(payload.completedRuns.length, 1);
    assert.equal(payload.openRuns.length, 0);
    assert.equal(written.schemaVersion, 1);
    assert.equal(written.exportedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(written.completedRuns[0]?.runId, 'id-1');

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
    stats.onSessionClosed(sessionPath);
    await stats.flush();

    const storageDir = await getRunStorageDir(tempDir);
    const result = await queryRunAnalyticsStore(storageDir);
    assert.equal(result.completedRuns.length, 1);

    const targetPath = path.join(tempDir, 'analytics-export-reviews.json');
    const payload = await exportRunAnalyticsStore(storageDir, targetPath, () => new Date('2026-07-08T00:00:00.000Z'));
    assert.equal(payload.completedRuns.length, 1);

    await stats.shutdown();
  });
});

test('exportRunAnalyticsStore embeds parsed global side-channel logs', async () => {
  await withTempDir(async (tempDir) => {
    let archState: ArchState = createInitialArchState();
    const sessionPath = '/workspace/session-side-channels.jsonl';
    let idCounter = 0;

    archState = produce(archState, draft => {
      draft.sessions.sessions.push({
        path: sessionPath,
        name: 'Side Channel Session',
        cwd: '/workspace',
        modifiedAt: new Date().toISOString(),
        messageCount: 0,
        modelId: 'claude',
      });
      draft.settings.modelSettings = {
        defaultModel: 'claude',
        defaultThinkingLevel: 'medium',
      };
    });

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId: 'workspace-side-channels',
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
      createId: () => `id-${++idCounter}`,
    });

    await stats.start();
    stats.prepareForSend(sessionPath, []);
    stats.onSessionClosed(sessionPath);
    await stats.flush();

    // Global side-channel logs live at <configRoot>/data/*.jsonl, two levels
    // above the hashed workspace store. The exported payload should embed them.
    await fs.mkdir(path.join(tempDir, 'data'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'data', 'pruning.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-01-01T00:00:00.000Z',
          sessionId: 'sess-prune-1',
          mode: 'auto',
          included: ['skill-a'],
          excluded: ['skill-b'],
          skillBlockTokens: 100,
          originalBlockTokens: 200,
          toolIncluded: ['tool-a'],
          toolExcluded: ['tool-b'],
          toolBlockTokens: 50,
          originalToolBlockTokens: 80,
        }),
        JSON.stringify({ event: 'skill_miss', sessionId: 'sess-prune-1', timestamp: '2026-01-01T00:00:01.000Z', skillName: 'skill-b' }),
        'this is not valid json and should be ignored',
      ].join('\n') + '\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(tempDir, 'data', 'tool-result-pruning.jsonl'),
      JSON.stringify({
        event: 'tool_result_pruned',
        sessionId: 'sess-prune-1',
        toolName: 'bash',
        rules: ['strip-ansi'],
        beforeTokens: 500,
        afterTokens: 100,
        tokensSaved: 400,
        timestamp: '2026-01-01T00:00:02.000Z',
      }) + '\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(tempDir, 'data', 'warm-bash.jsonl'),
      [
        JSON.stringify({
          event: 'auto_prune_rewrite',
          sessionId: 'sess-warm-1',
          timestamp: '2026-01-01T00:00:03.000Z',
          before: 'grep x',
          after: 'grep --exclude-dir=node_modules x',
        }),
        JSON.stringify({
          event: 'session_summary',
          sessionId: 'sess-warm-1',
          timestamp: '2026-01-01T00:00:04.000Z',
          fastPath: 1,
          warm: 2,
          fallback: 0,
          poolSize: 4,
          warmupFailures: 0,
          autoPruneEnabled: true,
          fastPathEnabled: true,
          gnuGrep: true,
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const storageDir = await getRunStorageDir(tempDir);
    const targetPath = path.join(tempDir, 'analytics-export-side-channels.json');
    const payload = await exportRunAnalyticsStore(storageDir, targetPath, () => new Date('2026-01-01T00:00:05.000Z'));
    const written = JSON.parse(await fs.readFile(targetPath, 'utf8')) as {
      pruningDecisions: Array<{ sessionId: string; query: string }>;
      pruningEvents: Array<{ event: string; sessionId: string }>;
      toolResultPruningEvents: Array<{ toolName: string }>;
      warmBashRewrites: Array<{ sessionId: string }>;
      warmBashSummaries: Array<{ warm: number }>;
    };

    assert.equal(payload.pruningDecisions.length, 1);
    assert.equal(payload.pruningDecisions[0]?.sessionId, 'sess-prune-1');
    assert.equal(payload.pruningDecisions[0]?.query, '', 'portable export must redact user-authored pruning queries');
    assert.equal(payload.pruningEvents.length, 1);
    assert.equal(payload.pruningEvents[0]?.event, 'skill_miss');
    assert.equal(payload.toolResultPruningEvents.length, 1);
    assert.equal(payload.toolResultPruningEvents[0]?.toolName, 'bash');
    // Raw rewrite commands may contain paths or secrets, so portable exports
    // retain only content-free warm-bash summaries.
    assert.equal(payload.warmBashRewrites.length, 0);
    assert.equal(payload.warmBashSummaries.length, 1);
    assert.equal(payload.warmBashSummaries[0]?.warm, 2);

    assert.equal(written.pruningDecisions.length, 1);
    assert.equal(written.pruningEvents.length, 1);
    assert.equal(written.toolResultPruningEvents.length, 1);
    assert.equal(written.warmBashRewrites.length, 0);
    assert.equal(written.warmBashSummaries.length, 1);

    await stats.shutdown();
  });
});