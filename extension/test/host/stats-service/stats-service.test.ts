import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RUN_ANALYTICS_SCHEMA_VERSION,
  createEmptyFileMutationRollup,
  createEmptyToolUsageRollup,
  createEmptyVerificationRollup,
  type RunSnapshot,
} from '../../../src/host/run-analytics';
import { StatsService } from '../../../src/host/stats-service';
import { workspaceHash } from '../../../src/host/stats-service/helpers';
import { createInitialArchState, type ArchState } from '../../../src/host/core/arch-state';
import { reducer } from '../../../src/host/core/reducer';
import { produce } from 'immer';
import type { ModelSettings, SessionSummary } from '../../../src/shared/protocol';
import type { ComposerInput } from '../../../src/shared/protocol';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-stats-test-'));
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

async function readJsonl(filePath: string): Promise<unknown[]> {
  const raw = await fs.readFile(filePath, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function createOpenRunSnapshot(sessionPath: string, runId: string): RunSnapshot {
  return {
    sessionPath,
    runId,
    taskGroupId: `${runId}-task`,
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
    fileExtensions: { readCountsByExtension: {}, writeCountsByExtension: {}, editCountsByExtension: {} },
    verification: createEmptyVerificationRollup(),
  };
}

test('StatsService records run outcomes and persists snapshot metrics', async () => {
  await withTempDir(async (tempDir) => {
    let archState = createInitialArchState();
    const sessionPath = '/workspace/session-a.jsonl';
    let idCounter = 0;

    archState = produce(archState, draft => {
      draft.sessions.sessions.push({

      path: sessionPath,
      name: 'Session A',
      cwd: '/workspace',
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
      sessionId: 'stable-session-a',
      modelId: 'claude-3.7',
    
      } as SessionSummary);
    });
    archState = produce(archState, draft => {
      draft.settings.modelSettings = {

      defaultModel: 'claude-3.7',
      defaultThinkingLevel: 'medium',
    
      } as ModelSettings;
    });

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId: 'workspace-a',
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
      createId: () => `id-${++idCounter}`,
    });

    await stats.start();

    const inputs: ComposerInput[] = [
      {
        id: 'input-1',
        kind: 'filesystemPathRef',
        path: '/workspace/src/index.ts',
        name: 'index.ts',
        source: 'picker',
      },
      {
        id: 'input-2',
        kind: 'imageBlob',
        mimeType: 'image/png',
        name: 'diagram.png',
        sizeBytes: 2048,
        dataBase64: 'ZmFrZQ==',
        width: 64,
        height: 64,
        source: 'paste',
      },
    ];

    const runId = stats.prepareForSend(sessionPath, inputs);
    assert.equal(runId, 'id-1');
    assert.deepEqual(archState.composer.activeRunSummaryBySession[sessionPath], {
      runId: 'id-1',
      status: 'open',
    });

    stats.onAssistantTurnStarted(sessionPath, 'req-1');
    stats.onAssistantTurnEnded(sessionPath, 'req-1', 1200);
    stats.onContextUsageChanged(sessionPath, 8000, 200000);

    await stats.shutdown();

    const storageDir = await getRunStorageDir(tempDir);
    const snapshotEntries = await readJsonl(path.join(storageDir, 'run-snapshots.jsonl')) as Array<{
      kind: string;
      run: {
        runId: string;
        sessionId?: string;
        taskGroupId: string;
        status: string;
        sendCount: number;
        assistantTurnCount: number;
        assistantTurnDurationMs: number;
        filesystemPathRefCount: number;
        imageInputCount: number;
        imageInputBytes: number;
        contextTokens: number | null;
        contextLimit: number | null;
      };
    }>;
    const autoExport = JSON.parse(await fs.readFile(path.join(storageDir, 'run-analytics.json'), 'utf8')) as {
      completedRuns: Array<{ runId: string; status: string }>;
      openRuns: Array<{ runId: string }>;
    };

    assert.equal(snapshotEntries.length, 1);
    assert.equal(snapshotEntries[0].kind, 'run_snapshot');
    assert.equal(snapshotEntries[0].run.runId, 'id-1');
    assert.equal(snapshotEntries[0].run.sessionId, 'stable-session-a');
    assert.equal(snapshotEntries[0].run.taskGroupId, 'id-2');
    assert.equal(snapshotEntries[0].run.status, 'closed');
    assert.equal(snapshotEntries[0].run.sendCount, 1);
    assert.equal(snapshotEntries[0].run.assistantTurnCount, 1);
    assert.equal(snapshotEntries[0].run.assistantTurnDurationMs, 1200);
    assert.equal(snapshotEntries[0].run.filesystemPathRefCount, 1);
    assert.equal(snapshotEntries[0].run.imageInputCount, 1);
    assert.equal(snapshotEntries[0].run.imageInputBytes, 2048);
    assert.equal(snapshotEntries[0].run.contextTokens, 8000);
    assert.equal(snapshotEntries[0].run.contextLimit, 200000);

    assert.equal(autoExport.completedRuns.length, 1);
    assert.equal(autoExport.completedRuns[0]?.runId, 'id-1');
    assert.equal(autoExport.completedRuns[0]?.status, 'closed');
    assert.equal(autoExport.openRuns.length, 0);
  });
});

test('StatsService migrates legacy analytics files into data/outcomes', async () => {
  await withTempDir(async (tempDir) => {
    let archState = createInitialArchState();
    const workspaceId = 'workspace-migration';
    const legacyStorageDir = path.join(tempDir, 'usage-data', workspaceHash(workspaceId));
    await fs.mkdir(legacyStorageDir, { recursive: true });
    await fs.writeFile(path.join(legacyStorageDir, 'legacy-marker.txt'), 'legacy');

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId,
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
    });

    await stats.start();

    const storageDir = await getRunStorageDir(tempDir);
    assert.equal(await fs.readFile(path.join(storageDir, 'legacy-marker.txt'), 'utf8'), 'legacy');

    await stats.shutdown();
  });
});

test('StatsService starts a new task group on the next send after startNewTask', async () => {
  await withTempDir(async (tempDir) => {
    let archState = createInitialArchState();
    const sessionPath = '/workspace/session-b.jsonl';
    let idCounter = 0;

    archState = produce(archState, draft => {
      draft.sessions.sessions.push({

      path: sessionPath,
      name: 'Session B',
      cwd: '/workspace',
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
      modelId: 'gpt-4.1',
    
      } as SessionSummary);
    });
    archState = produce(archState, draft => {
      draft.settings.modelSettings = {

      defaultModel: 'gpt-4.1',
      defaultThinkingLevel: 'low',
    
      } as ModelSettings;
    });

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId: 'workspace-b',
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
      createId: () => `id-${++idCounter}`,
    });

    await stats.start();

    const firstRunId = stats.prepareForSend(sessionPath, []);
    stats.startNewTask(sessionPath);
    const secondRunId = stats.prepareForSend(sessionPath, []);

    assert.equal(firstRunId, 'id-1');
    assert.equal(secondRunId, 'id-3');
    assert.deepEqual(archState.composer.activeRunSummaryBySession[sessionPath], {
      runId: 'id-3',
      status: 'open',
    });

    await stats.shutdown();

    const storageDir = await getRunStorageDir(tempDir);
    const snapshotEntries = await readJsonl(path.join(storageDir, 'run-snapshots.jsonl')) as Array<{
      run: {
        runId: string;
        taskGroupId: string;
        finalizationReason?: string;
        status: string;
      };
    }>;

    assert.equal(snapshotEntries.length, 2, 'first run closes on new-task boundary; second closes on shutdown');
    assert.equal(snapshotEntries[0].run.runId, 'id-1');
    assert.equal(snapshotEntries[0].run.taskGroupId, 'id-2');
    assert.equal(snapshotEntries[0].run.finalizationReason, 'new_task');
    assert.equal(snapshotEntries[0].run.status, 'closed');
    assert.equal(snapshotEntries[1].run.runId, 'id-3');
    assert.equal(snapshotEntries[1].run.taskGroupId, 'id-4');
    assert.equal(snapshotEntries[1].run.finalizationReason, 'closed');
  });
});

test('StatsService restores active run summaries from checkpointed state', async () => {
  await withTempDir(async (tempDir) => {
    let firstArchState = createInitialArchState();
    let secondArchState = createInitialArchState();
    const sessionPath = '/workspace/session-c.jsonl';

    firstArchState = produce(firstArchState, draft => {
      draft.sessions.sessions.push({
        path: sessionPath,
        name: 'Session C',
        cwd: '/workspace',
        modifiedAt: new Date().toISOString(),
        messageCount: 0,
        modelId: 'claude',
      } as SessionSummary);
      draft.settings.modelSettings = {
        defaultModel: 'claude',
        defaultThinkingLevel: 'minimal',
      } as ModelSettings;
    });
    secondArchState = produce(secondArchState, draft => {
      draft.sessions.sessions.push({
        path: sessionPath,
        name: 'Session C',
        cwd: '/workspace',
        modifiedAt: new Date().toISOString(),
        messageCount: 0,
        modelId: 'claude',
      } as SessionSummary);
      draft.settings.modelSettings = {
        defaultModel: 'claude',
        defaultThinkingLevel: 'minimal',
      } as ModelSettings;
    });

    let idCounter = 0;
    const firstStats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId: 'workspace-c',
      getArchState: () => firstArchState,
      dispatchArchEvent: (event) => { const result = reducer(firstArchState, event); firstArchState = result.state; },
      createId: () => `id-${++idCounter}`,
    });

    await firstStats.start();
    firstStats.prepareForSend(sessionPath, []);
    await firstStats.flush();

    const secondStats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId: 'workspace-c',
      getArchState: () => secondArchState,
      dispatchArchEvent: (event) => { const result = reducer(secondArchState, event); secondArchState = result.state; },
    });

    await secondStats.start();

    assert.deepEqual(secondArchState.composer.activeRunSummaryBySession[sessionPath], {
      runId: 'id-1',
      status: 'open',
    });

    await firstStats.shutdown();
    await secondStats.shutdown();
    secondArchState = produce(secondArchState, draft => {
      draft.composer.activeRunSummaryBySession[sessionPath] = null;
    });
  });
});

test('StatsService restores completed runs and queued new-task state across restart', async () => {
  await withTempDir(async (tempDir) => {
    let firstArchState = createInitialArchState();
    let secondArchState = createInitialArchState();
    const sessionPath = '/workspace/session-c-rated.jsonl';

    firstArchState = produce(firstArchState, draft => {
      draft.sessions.sessions.push({
        path: sessionPath,
        name: 'Session C Rated',
        cwd: '/workspace',
        modifiedAt: new Date().toISOString(),
        messageCount: 0,
        modelId: 'claude',
      } as SessionSummary);
      draft.settings.modelSettings = {
        defaultModel: 'claude',
        defaultThinkingLevel: 'minimal',
      } as ModelSettings;
    });
    secondArchState = produce(secondArchState, draft => {
      draft.sessions.sessions.push({
        path: sessionPath,
        name: 'Session C Rated',
        cwd: '/workspace',
        modifiedAt: new Date().toISOString(),
        messageCount: 0,
        modelId: 'claude',
      } as SessionSummary);
      draft.settings.modelSettings = {
        defaultModel: 'claude',
        defaultThinkingLevel: 'minimal',
      } as ModelSettings;
    });

    let idCounter = 0;
    const firstStats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId: 'workspace-c-rated',
      getArchState: () => firstArchState,
      dispatchArchEvent: (event) => { const result = reducer(firstArchState, event); firstArchState = result.state; },
      createId: () => `id-${++idCounter}`,
    });

    await firstStats.start();
    firstStats.prepareForSend(sessionPath, []);
    firstStats.startNewTask(sessionPath);
    await firstStats.flush();
    await firstStats.shutdown();

    const secondStats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId: 'workspace-c-rated',
      getArchState: () => secondArchState,
      dispatchArchEvent: (event) => { const result = reducer(secondArchState, event); secondArchState = result.state; },
      createId: () => `id-${++idCounter}`,
    });

    await secondStats.start();

    assert.deepEqual(secondArchState.composer.activeRunSummaryBySession[sessionPath], {
      runId: 'id-1',
      status: 'closed',
      nextSendStartsNewTask: true,
    });

    const nextRunId = secondStats.prepareForSend(sessionPath, []);
    assert.equal(nextRunId, 'id-3');
    assert.deepEqual(secondArchState.composer.activeRunSummaryBySession[sessionPath], {
      runId: 'id-3',
      status: 'open',
    });

    await secondStats.shutdown();

    const storageDir = await getRunStorageDir(tempDir);
    const snapshotEntries = await readJsonl(path.join(storageDir, 'run-snapshots.jsonl')) as Array<{
      run: {
        runId: string;
        taskGroupId: string;
        status: string;
      };
    }>;

    assert.equal(snapshotEntries.length, 2);
    assert.equal(snapshotEntries[0].run.runId, 'id-1');
    assert.equal(snapshotEntries[0].run.taskGroupId, 'id-2');
    assert.equal(snapshotEntries[0].run.status, 'closed');
    assert.equal(snapshotEntries[1].run.runId, 'id-3');
    assert.equal(snapshotEntries[1].run.taskGroupId, 'id-4');
    assert.equal(snapshotEntries[1].run.status, 'closed');
  });
});

test('StatsService counts multiple assistant turns using distinct turn ids within one run', async () => {
  await withTempDir(async (tempDir) => {
    let archState = createInitialArchState();
    const sessionPath = '/workspace/session-d.jsonl';
    let idCounter = 0;

    archState = produce(archState, draft => {
      draft.sessions.sessions.push({

      path: sessionPath,
      name: 'Session D',
      cwd: '/workspace',
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
      modelId: 'claude',
    
      } as SessionSummary);
    });
    archState = produce(archState, draft => {
      draft.settings.modelSettings = {

      defaultModel: 'claude',
      defaultThinkingLevel: 'medium',
    
      } as ModelSettings;
    });

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId: 'workspace-d',
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
      createId: () => `id-${++idCounter}`,
    });

    await stats.start();
    stats.prepareForSend(sessionPath, []);
    stats.onAssistantTurnStarted(sessionPath, 'req-1:1');
    stats.onAssistantTurnEnded(sessionPath, 'req-1:1', 400);
    stats.onAssistantTurnStarted(sessionPath, 'req-1:2');
    stats.onAssistantTurnEnded(sessionPath, 'req-1:2', 600);
    await stats.shutdown();

    const storageDir = await getRunStorageDir(tempDir);
    const snapshotEntries = await readJsonl(path.join(storageDir, 'run-snapshots.jsonl')) as Array<{
      run: {
        assistantTurnCount: number;
        assistantTurnDurationMs: number;
      };
    }>;

    assert.equal(snapshotEntries.length, 1);
    assert.equal(snapshotEntries[0].run.assistantTurnCount, 2);
    assert.equal(snapshotEntries[0].run.assistantTurnDurationMs, 1000);
  });
});

test('StatsService marks runs mixed when model config changes mid-run', async () => {
  await withTempDir(async (tempDir) => {
    let archState = createInitialArchState();
    const sessionPath = '/workspace/session-e.jsonl';
    let idCounter = 0;

    archState = produce(archState, draft => {
      draft.sessions.sessions.push({

      path: sessionPath,
      name: 'Session E',
      cwd: '/workspace',
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
      modelId: 'claude',
    
      } as SessionSummary);
    });
    archState = produce(archState, draft => {
      draft.settings.modelSettings = {

      defaultModel: 'claude',
      defaultThinkingLevel: 'medium',
    
      } as ModelSettings;
    });

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId: 'workspace-e',
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
      createId: () => `id-${++idCounter}`,
    });

    await stats.start();
    stats.prepareForSend(sessionPath, []);
    stats.onModelConfigChanged(sessionPath, 'gpt-4.1', 'high');
    await stats.shutdown();

    const storageDir = await getRunStorageDir(tempDir);
    const snapshotEntries = await readJsonl(path.join(storageDir, 'run-snapshots.jsonl')) as Array<{
      run: {
        mixedModelConfig: boolean;
      };
    }>;

    assert.equal(snapshotEntries.length, 1);
    assert.equal(snapshotEntries[0].run.mixedModelConfig, true);
  });
});

test('StatsService carries unsupported input attempts into the next run snapshot', async () => {
  await withTempDir(async (tempDir) => {
    let archState = createInitialArchState();
    const sessionPath = '/workspace/session-f.jsonl';
    let idCounter = 0;

    archState = produce(archState, draft => {
      draft.sessions.sessions.push({

      path: sessionPath,
      name: 'Session F',
      cwd: '/workspace',
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
      modelId: 'claude',
    
      } as SessionSummary);
    });
    archState = produce(archState, draft => {
      draft.settings.modelSettings = {

      defaultModel: 'claude',
      defaultThinkingLevel: 'medium',
    
      } as ModelSettings;
    });

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId: 'workspace-f',
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
      createId: () => `id-${++idCounter}`,
    });

    await stats.start();
    stats.onUnsupportedInputAttempt(sessionPath);
    stats.prepareForSend(sessionPath, []);
    await stats.shutdown();

    const storageDir = await getRunStorageDir(tempDir);
    const snapshotEntries = await readJsonl(path.join(storageDir, 'run-snapshots.jsonl')) as Array<{
      run: {
        unsupportedInputCount: number;
      };
    }>;

    assert.equal(snapshotEntries.length, 1);
    assert.equal(snapshotEntries[0].run.unsupportedInputCount, 1);
  });
});

test('StatsService captures structured analytics factors and experiment assignment at run start', async () => {
  await withTempDir(async (tempDir) => {
    let archState = createInitialArchState();
    const sessionPath = '/workspace/session-g.jsonl';
    let idCounter = 0;

    archState = produce(archState, draft => {
      draft.sessions.sessions.push({

      path: sessionPath,
      name: 'Session G',
      cwd: '/workspace',
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
      modelId: 'claude',
    
      } as SessionSummary);
    });
    archState = produce(archState, draft => {
      draft.settings.modelSettings = {

      defaultModel: 'claude',
      defaultThinkingLevel: 'medium',
    
      } as ModelSettings;
    });
    archState = produce(archState, draft => {
      draft.sessions.analyticsFactorsBySession[sessionPath] = {
        promptFamily: 'harness+customPrompt',
        promptHash: 'prompt-hash',
        promptCapturedAt: '2025-06-15T10:30:00.000Z',
        harnessPromptHash: 'harness-hash',
        customPromptHash: 'custom-hash',
        appendSystemPromptHash: null,
        promptGuidelineHashes: ['guideline-hash'],
        contextFiles: [{ path: '/workspace/context.md', hash: 'context-hash' }],
        selectedToolIds: ['bash'],
        toolSnippetHashes: [{ toolId: 'bash', hash: 'snippet-hash' }],
        toolSetHash: 'tool-set-hash',
        skills: [{
          name: 'frontend-design',
          contentHash: 'skill-hash',
          sourceHash: 'skill-source-hash',
          disableModelInvocation: false,
          lastModifiedAt: null,
        }],
        skillSetHash: 'skill-set-hash',
        activeExtensions: [],
      };
    });

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId: 'workspace-g',
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
      createId: () => `id-${++idCounter}`,
      getExperimentAssignment: () => 'exp-a',
    });

    await stats.start();
    stats.prepareForSend(sessionPath, []);
    await stats.shutdown();

    const storageDir = await getRunStorageDir(tempDir);
    const snapshotEntries = await readJsonl(path.join(storageDir, 'run-snapshots.jsonl')) as Array<{
      run: {
        experimentAssignment: string | null;
        analyticsFactors: { promptHash: string; skillSetHash: string | null } | null;
      };
    }>;

    assert.equal(snapshotEntries.length, 1);
    assert.equal(snapshotEntries[0].run.experimentAssignment, 'exp-a');
    assert.equal(snapshotEntries[0].run.analyticsFactors?.promptHash, 'prompt-hash');
    assert.equal(snapshotEntries[0].run.analyticsFactors?.skillSetHash, 'skill-set-hash');
  });
});

test('StatsService rolls up tool usage, verification commands, subagents, and file mutations', async () => {
  await withTempDir(async (tempDir) => {
    let archState = createInitialArchState();
    const sessionPath = '/workspace/session-h.jsonl';
    let idCounter = 0;

    archState = produce(archState, draft => {
      draft.sessions.sessions.push({

      path: sessionPath,
      name: 'Session H',
      cwd: '/workspace',
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
      modelId: 'claude',
    
      } as SessionSummary);
    });
    archState = produce(archState, draft => {
      draft.settings.modelSettings = {

      defaultModel: 'claude',
      defaultThinkingLevel: 'medium',
    
      } as ModelSettings;
    });

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId: 'workspace-h',
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
      createId: () => `id-${++idCounter}`,
    });

    await stats.start();
    stats.prepareForSend(sessionPath, []);

    const failedVerificationTool = {
      id: 'tool-1',
      name: 'bash',
      input: { command: 'npm test -- --runInBand' },
      result: { exitCode: 1 },
      status: 'failed' as const,
      durationMs: 100,
    };
    stats.onToolStarted(sessionPath, { ...failedVerificationTool, result: undefined, status: 'running' });
    stats.onToolFinished(sessionPath, failedVerificationTool);

    const pendingChecksTool = {
      id: 'tool-2',
      name: 'bash',
      input: { command: 'gh pr checks 123' },
      result: { exitCode: 8 },
      status: 'failed' as const,
      durationMs: 50,
    };
    stats.onToolStarted(sessionPath, { ...pendingChecksTool, result: undefined, status: 'running' });
    stats.onToolFinished(sessionPath, pendingChecksTool);

    const subagentTool = {
      id: 'tool-3',
      name: 'subagent',
      input: {
        tasks: [
          { agent: 'scout', task: 'Trace tool events' },
          { agent: 'reviewer', task: 'Check analytics snapshot' },
        ],
      },
      result: 'done',
      status: 'completed' as const,
      durationMs: 250,
    };
    stats.onToolStarted(sessionPath, { ...subagentTool, result: undefined, status: 'running' });
    stats.onToolFinished(sessionPath, subagentTool);

    const mutationTool = {
      id: 'tool-4',
      name: 'edit',
      input: {
        path: '/workspace/src/main.ts',
        edits: [{
          oldText: 'const value = 1;\nconst next = 2;\n',
          newText: 'const value = 10;\nconst next = 20;\n',
        }],
      },
      result: 'patched',
      status: 'completed' as const,
      durationMs: 50,
    };
    stats.onToolStarted(sessionPath, { ...mutationTool, result: undefined, status: 'running' });
    stats.onToolFinished(sessionPath, mutationTool);
    await stats.shutdown();

    const storageDir = await getRunStorageDir(tempDir);
    const snapshotEntries = await readJsonl(path.join(storageDir, 'run-snapshots.jsonl')) as Array<{
      run: {
        toolUsage: {
          totalCount: number;
          failureCount: number;
          executionFailureCount: number;
          verificationProjectFailureCount: number;
          probeFailureCount: number;
          countsByName: Record<string, number>;
          failureCountsByKind: Record<string, number>;
          failureCountsByNameAndKind: Record<string, Record<string, number>>;
          failureSamples: Array<{
            toolName: string;
            failureKind: string;
            exitCode: number | null;
            errorExcerpt: string;
            verificationKinds: string[];
          }>;
          resultIssueCount: number;
          resultIssueCountsByKind: Record<string, number>;
          resultIssueCountsByNameAndKind: Record<string, Record<string, number>>;
          resultIssueSamples: Array<{
            toolName: string;
            resultIssueKind: string;
            exitCode: number | null;
            errorExcerpt: string;
            verificationKinds: string[];
          }>;
          subagentCallCount: number;
          subagentTaskCount: number;
          subagentAgentNames: string[];
          totalDurationMs: number;
          timedCallCount: number;
          durationMsByName: Record<string, number>;
        };
        verification: {
          totalCount: number;
          failureCount: number;
          countsByKind: Record<string, number>;
        };
        fileMutation: {
          editCount: number;
          lineModifications: number;
        };
      };
    }>;

    assert.equal(snapshotEntries.length, 1);
    assert.equal(snapshotEntries[0].run.toolUsage.totalCount, 4);
    assert.equal(snapshotEntries[0].run.toolUsage.failureCount, 0);
    assert.equal(snapshotEntries[0].run.toolUsage.executionFailureCount, 0);
    assert.equal(snapshotEntries[0].run.toolUsage.verificationProjectFailureCount, 1);
    assert.equal(snapshotEntries[0].run.toolUsage.probeFailureCount, 0);
    assert.equal(snapshotEntries[0].run.toolUsage.resultIssueCount, 2);
    assert.equal(snapshotEntries[0].run.toolUsage.countsByName['bash'], 2);
    assert.equal(snapshotEntries[0].run.toolUsage.resultIssueCountsByKind['verification_failure'], 1);
    assert.equal(snapshotEntries[0].run.toolUsage.resultIssueCountsByKind['verification_pending'], 1);
    assert.equal(snapshotEntries[0].run.toolUsage.resultIssueCountsByNameAndKind['bash']?.['verification_failure'], 1);
    assert.equal(snapshotEntries[0].run.toolUsage.resultIssueCountsByNameAndKind['bash']?.['verification_pending'], 1);
    assert.equal(snapshotEntries[0].run.toolUsage.failureSamples.length, 0);
    assert.equal(snapshotEntries[0].run.toolUsage.resultIssueSamples[0]?.toolName, 'bash');
    assert.equal(snapshotEntries[0].run.toolUsage.resultIssueSamples[0]?.resultIssueKind, 'verification_failure');
    assert.equal(snapshotEntries[0].run.toolUsage.resultIssueSamples[1]?.resultIssueKind, 'verification_pending');
    assert.equal(snapshotEntries[0].run.toolUsage.resultIssueSamples[0]?.exitCode, 1);
    assert.deepEqual(snapshotEntries[0].run.toolUsage.resultIssueSamples[0]?.verificationKinds, ['test']);
    assert.equal(snapshotEntries[0].run.toolUsage.subagentCallCount, 1);
    assert.equal(snapshotEntries[0].run.toolUsage.subagentTaskCount, 2);
    assert.deepEqual(snapshotEntries[0].run.toolUsage.subagentAgentNames, ['scout', 'reviewer']);
    assert.equal(snapshotEntries[0].run.toolUsage.totalDurationMs, 450);
    assert.equal(snapshotEntries[0].run.toolUsage.timedCallCount, 4);
    assert.equal(snapshotEntries[0].run.toolUsage.durationMsByName['bash'], 150);
    assert.equal(snapshotEntries[0].run.toolUsage.durationMsByName['subagent'], 250);
    assert.equal(snapshotEntries[0].run.toolUsage.durationMsByName['edit'], 50);
    assert.equal(snapshotEntries[0].run.verification.totalCount, 2);
    assert.equal(snapshotEntries[0].run.verification.failureCount, 1);
    assert.equal(snapshotEntries[0].run.verification.countsByKind['test'], 1);
    assert.equal(snapshotEntries[0].run.verification.countsByKind['other'], 1);
    assert.equal(snapshotEntries[0].run.fileMutation.editCount, 1);
    assert.equal(snapshotEntries[0].run.fileMutation.lineModifications, 2);
  });
});

test('StatsService tracks busy durations and mixed treatment changes', async () => {
  await withTempDir(async (tempDir) => {
    let archState = createInitialArchState();
    const sessionPath = '/workspace/session-i.jsonl';
    let idCounter = 0;
    let currentMs = 0;

    archState = produce(archState, draft => {
      draft.sessions.sessions.push({

      path: sessionPath,
      name: 'Session I',
      cwd: '/workspace',
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
      modelId: 'claude',
    
      } as SessionSummary);
    });
    archState = produce(archState, draft => {
      draft.settings.modelSettings = {

      defaultModel: 'claude',
      defaultThinkingLevel: 'medium',
    
      } as ModelSettings;
    });
    archState = produce(archState, draft => {
      draft.sessions.analyticsFactorsBySession[sessionPath] = {
        promptFamily: 'harness',
        promptHash: 'prompt-a',
        promptCapturedAt: '2025-06-15T10:30:00.000Z',
        harnessPromptHash: 'harness-a',
        customPromptHash: null,
        appendSystemPromptHash: null,
        promptGuidelineHashes: [],
        contextFiles: [],
        selectedToolIds: ['bash'],
        toolSnippetHashes: [],
        toolSetHash: 'tools-a',
        skills: [],
        skillSetHash: null,
        activeExtensions: [],
      };
    });

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId: 'workspace-i',
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
      createId: () => `id-${++idCounter}`,
      now: () => new Date(currentMs),
      getExperimentAssignment: () => 'exp-a',
    });

    await stats.start();
    stats.prepareForSend(sessionPath, []);

    currentMs = 1000;
    stats.onBusyChanged(sessionPath, true);
    currentMs = 2500;
    stats.onBusyChanged(sessionPath, false);
    currentMs = 3000;
    stats.onBusyChanged(sessionPath, true);
    currentMs = 4200;
    stats.onBusyChanged(sessionPath, false);

    stats.onExperimentAssignmentChanged('exp-b');
    await stats.shutdown();

    const storageDir = await getRunStorageDir(tempDir);
    const snapshotEntries = await readJsonl(path.join(storageDir, 'run-snapshots.jsonl')) as Array<{
      run: {
        busyDurationMs: number;
        busyPeriodCount: number;
        mixedTreatmentConfig: boolean;
        treatmentChangeKinds: string[];
      };
    }>;

    assert.equal(snapshotEntries.length, 1);
    assert.equal(snapshotEntries[0].run.busyDurationMs, 2700);
    assert.equal(snapshotEntries[0].run.busyPeriodCount, 2);
    assert.equal(snapshotEntries[0].run.mixedTreatmentConfig, true);
    assert.deepEqual(snapshotEntries[0].run.treatmentChangeKinds, ['experimentAssignment']);
  });
});

test('StatsService migrates legacy runs analytics files into data/outcomes', async () => {
  await withTempDir(async (tempDir) => {
    let archState = createInitialArchState();
    const workspaceId = 'workspace-runs-migration';
    const legacyStorageDir = path.join(tempDir, 'runs', workspaceHash(workspaceId));
    await fs.mkdir(legacyStorageDir, { recursive: true });
    await fs.writeFile(path.join(legacyStorageDir, 'legacy-runs-marker.txt'), 'legacy-runs');

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId,
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
    });

    await stats.start();

    const storageDir = await getRunStorageDir(tempDir);
    assert.equal(await fs.readFile(path.join(storageDir, 'legacy-runs-marker.txt'), 'utf8'), 'legacy-runs');

    await stats.shutdown();
  });
});

test('StatsService migrates repo-local usage-data roots for legacy workspace hashes', async () => {
  await withTempDir(async (tempDir) => {
    let archState = createInitialArchState();
    const currentWorkspaceId = 'workspace-current-hash';
    const legacyWorkspaceId = 'workspace-legacy-hash';
    const storageDir = path.join(
      tempDir,
      'data',
      'outcomes',
      workspaceHash(currentWorkspaceId),
    );
    const legacyStorageDir = path.join(
      tempDir,
      'data',
      'outcomes',
      'usage-data',
      workspaceHash(legacyWorkspaceId),
    );

    await fs.mkdir(legacyStorageDir, { recursive: true });
    await fs.writeFile(path.join(legacyStorageDir, 'legacy-alias-marker.txt'), 'legacy-alias');

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: path.join(tempDir, 'global-storage'),
      workspaceId: currentWorkspaceId,
      legacyWorkspaceIds: [legacyWorkspaceId],
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
    });

    await stats.start();

    assert.equal(await fs.readFile(path.join(storageDir, 'legacy-alias-marker.txt'), 'utf8'), 'legacy-alias');

    await stats.shutdown();
  });
});

test('StatsService migrates legacy canonical roots for legacy workspace hashes', async () => {
  await withTempDir(async (tempDir) => {
    let archState = createInitialArchState();
    const currentWorkspaceId = 'workspace-current-canonical-hash';
    const legacyWorkspaceId = 'workspace-legacy-canonical-hash';
    const storageDir = path.join(
      tempDir,
      'data',
      'outcomes',
      workspaceHash(currentWorkspaceId),
    );
    const legacyStorageDir = path.join(
      tempDir,
      'data',
      'outcomes',
      workspaceHash(legacyWorkspaceId),
    );

    await fs.mkdir(legacyStorageDir, { recursive: true });
    await fs.writeFile(path.join(legacyStorageDir, 'legacy-canonical-marker.txt'), 'legacy-canonical');

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: path.join(tempDir, 'global-storage'),
      workspaceId: currentWorkspaceId,
      legacyWorkspaceIds: [legacyWorkspaceId],
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
    });

    await stats.start();

    assert.equal(
      await fs.readFile(path.join(storageDir, 'legacy-canonical-marker.txt'), 'utf8'),
      'legacy-canonical',
    );

    await stats.shutdown();
  });
});

test('StatsService migrates legacy global data/outcomes roots for legacy workspace hashes', async () => {
  await withTempDir(async (tempDir) => {
    let archState = createInitialArchState();
    const currentWorkspaceId = 'workspace-current-global-outcomes';
    const legacyWorkspaceId = 'workspace-legacy-global-outcomes';
    const storageDir = path.join(
      tempDir,
      'data',
      'outcomes',
      workspaceHash(currentWorkspaceId),
    );
    const legacyStorageDir = path.join(
      tempDir,
      'global-storage',
      'data',
      'outcomes',
      workspaceHash(legacyWorkspaceId),
    );

    await fs.mkdir(legacyStorageDir, { recursive: true });
    await fs.writeFile(path.join(legacyStorageDir, 'legacy-global-outcomes-marker.txt'), 'legacy-global-outcomes');

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: path.join(tempDir, 'global-storage'),
      workspaceId: currentWorkspaceId,
      legacyWorkspaceIds: [legacyWorkspaceId],
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
    });

    await stats.start();

    assert.equal(
      await fs.readFile(path.join(storageDir, 'legacy-global-outcomes-marker.txt'), 'utf8'),
      'legacy-global-outcomes',
    );

    await stats.shutdown();
  });
});

test('StatsService prefers newer snapshots across overlapping legacy roots', async () => {
  await withTempDir(async (tempDir) => {
    let archState = createInitialArchState();
    const workspaceId = 'workspace-legacy-root-priority';
    const workspaceDir = workspaceHash(workspaceId);
    const storageDir = path.join(tempDir, 'data', 'outcomes', workspaceDir);
    const globalRunsDir = path.join(tempDir, 'global-storage', 'runs', workspaceDir);
    const repoUsageDataDir = path.join(tempDir, 'data', 'outcomes', 'usage-data', workspaceDir);
    const staleSnapshot = {
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      kind: 'run_snapshot',
      recordedAt: '2026-01-01T00:00:00.000Z',
      run: {
        ...createOpenRunSnapshot('/workspace/root-priority.jsonl', 'shared-root-run'),
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const newerSnapshot = {
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      kind: 'run_snapshot',
      recordedAt: '2026-01-03T00:00:00.000Z',
      run: {
        ...createOpenRunSnapshot('/workspace/root-priority.jsonl', 'shared-root-run'),
        updatedAt: '2026-01-03T00:00:00.000Z',
      },
    };

    await fs.mkdir(globalRunsDir, { recursive: true });
    await fs.mkdir(repoUsageDataDir, { recursive: true });
    await fs.writeFile(
      path.join(globalRunsDir, 'run-snapshots.jsonl'),
      `${JSON.stringify(staleSnapshot)}\n`,
      'utf8',
    );
    await fs.writeFile(
      path.join(repoUsageDataDir, 'run-snapshots.jsonl'),
      `${JSON.stringify(newerSnapshot)}\n`,
      'utf8',
    );

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: path.join(tempDir, 'global-storage'),
      workspaceId,
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
    });

    await stats.start();

    const snapshotEntries = await readJsonl(path.join(storageDir, 'run-snapshots.jsonl')) as Array<{
      run: { updatedAt: string };
    }>;
    assert.equal(snapshotEntries.length, 1);
    assert.equal(snapshotEntries[0].run.updatedAt, '2026-01-03T00:00:00.000Z');

    await stats.shutdown();
  });
});

test('StatsService merges overlapping legacy snapshot history instead of skipping existing files', async () => {
  await withTempDir(async (tempDir) => {
    let archState = createInitialArchState();
    const workspaceId = 'workspace-overlapping-log-merge';
    const workspaceDir = workspaceHash(workspaceId);
    const storageDir = path.join(tempDir, 'data', 'outcomes', workspaceDir);
    const legacyStorageDir = path.join(tempDir, 'runs', workspaceDir);

    await fs.mkdir(storageDir, { recursive: true });
    await fs.mkdir(legacyStorageDir, { recursive: true });
    await fs.writeFile(
      path.join(storageDir, 'run-snapshots.jsonl'),
      `${JSON.stringify({ source: 'current' })}\n`,
      'utf8',
    );
    await fs.writeFile(
      path.join(legacyStorageDir, 'run-snapshots.jsonl'),
      `${JSON.stringify({ source: 'legacy' })}\n`,
      'utf8',
    );

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId,
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
    });

    await stats.start();

    const snapshotEntries = await readJsonl(path.join(storageDir, 'run-snapshots.jsonl'));
    assert.deepEqual(snapshotEntries, [
      { source: 'legacy' },
      { source: 'current' },
    ]);

    await stats.shutdown();
  });
});

test('StatsService keeps canonical snapshot entries when the same run exists in legacy history', async () => {
  await withTempDir(async (tempDir) => {
    let archState = createInitialArchState();
    const workspaceId = 'workspace-conflicting-log-merge';
    const workspaceDir = workspaceHash(workspaceId);
    const storageDir = path.join(tempDir, 'data', 'outcomes', workspaceDir);
    const legacyStorageDir = path.join(tempDir, 'runs', workspaceDir);
    const currentSnapshot = {
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      kind: 'run_snapshot',
      recordedAt: '2026-01-02T00:00:00.000Z',
      run: {
        ...createOpenRunSnapshot('/workspace/shared-run.jsonl', 'shared-run'),
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    };
    const legacySnapshot = {
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      kind: 'run_snapshot',
      recordedAt: '2026-01-01T00:00:00.000Z',
      run: {
        ...createOpenRunSnapshot('/workspace/shared-run.jsonl', 'shared-run'),
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    };

    await fs.mkdir(storageDir, { recursive: true });
    await fs.mkdir(legacyStorageDir, { recursive: true });
    await fs.writeFile(
      path.join(storageDir, 'run-snapshots.jsonl'),
      `${JSON.stringify(currentSnapshot)}\n`,
      'utf8',
    );
    await fs.writeFile(
      path.join(legacyStorageDir, 'run-snapshots.jsonl'),
      `${JSON.stringify(legacySnapshot)}\n`,
      'utf8',
    );

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId,
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
    });

    await stats.start();

    const snapshotEntries = await readJsonl(path.join(storageDir, 'run-snapshots.jsonl')) as Array<{
      run: { updatedAt: string };
    }>;
    assert.equal(snapshotEntries.length, 1);
    assert.equal(snapshotEntries[0].run.updatedAt, '2026-01-02T00:00:00.000Z');

    await stats.shutdown();
  });
});

test('StatsService merges legacy checkpoint sessions with existing canonical checkpoint state', async () => {
  await withTempDir(async (tempDir) => {
    let archState = createInitialArchState();
    const workspaceId = 'workspace-checkpoint-merge';
    const workspaceDir = workspaceHash(workspaceId);
    const storageDir = path.join(tempDir, 'data', 'outcomes', workspaceDir);
    const legacyStorageDir = path.join(tempDir, 'runs', workspaceDir);
    const currentSessionPath = '/workspace/current-open.jsonl';
    const legacySessionPath = '/workspace/legacy-open.jsonl';

    await fs.mkdir(storageDir, { recursive: true });
    await fs.mkdir(legacyStorageDir, { recursive: true });
    await fs.writeFile(path.join(storageDir, 'open-runs.a.json'), JSON.stringify({
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      seq: 1,
      sessions: {
        [currentSessionPath]: {
          currentRun: createOpenRunSnapshot(currentSessionPath, 'run-current'),
          lastRun: null,
          nextTaskIntent: null,
          queuedUnsupportedInputCount: 0,
          busyStartedAt: null,
        },
      },
    }, null, 2), 'utf8');
    await fs.writeFile(path.join(storageDir, 'open-runs.gen'), 'a', 'utf8');
    await fs.writeFile(path.join(legacyStorageDir, 'open-runs.a.json'), JSON.stringify({
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      seq: 2,
      sessions: {
        [legacySessionPath]: {
          currentRun: createOpenRunSnapshot(legacySessionPath, 'run-legacy'),
          lastRun: null,
          nextTaskIntent: null,
          queuedUnsupportedInputCount: 0,
          busyStartedAt: null,
        },
      },
    }, null, 2), 'utf8');
    await fs.writeFile(path.join(legacyStorageDir, 'open-runs.gen'), 'a', 'utf8');

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId,
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
    });

    await stats.start();

    assert.deepEqual(archState.composer.activeRunSummaryBySession[currentSessionPath], {
      runId: 'run-current',
      status: 'open',
    });
    assert.deepEqual(archState.composer.activeRunSummaryBySession[legacySessionPath], {
      runId: 'run-legacy',
      status: 'open',
    });

    await stats.shutdown();
  });
});

test('StatsService prefers the newer checkpoint state for overlapping session paths', async () => {
  await withTempDir(async (tempDir) => {
    let archState = createInitialArchState();
    const workspaceId = 'workspace-checkpoint-conflict';
    const workspaceDir = workspaceHash(workspaceId);
    const storageDir = path.join(tempDir, 'data', 'outcomes', workspaceDir);
    const legacyStorageDir = path.join(tempDir, 'runs', workspaceDir);
    const sessionPath = '/workspace/conflicted-open.jsonl';

    await fs.mkdir(storageDir, { recursive: true });
    await fs.mkdir(legacyStorageDir, { recursive: true });
    await fs.writeFile(path.join(storageDir, 'open-runs.a.json'), JSON.stringify({
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      seq: 1,
      sessions: {
        [sessionPath]: {
          currentRun: createOpenRunSnapshot(sessionPath, 'run-current'),
          lastRun: null,
          nextTaskIntent: null,
          queuedUnsupportedInputCount: 0,
          busyStartedAt: null,
        },
      },
    }, null, 2), 'utf8');
    await fs.writeFile(path.join(storageDir, 'open-runs.gen'), 'a', 'utf8');
    await fs.writeFile(path.join(legacyStorageDir, 'open-runs.a.json'), JSON.stringify({
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      seq: 2,
      sessions: {
        [sessionPath]: {
          currentRun: {
            ...createOpenRunSnapshot(sessionPath, 'run-legacy'),
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
          lastRun: null,
          nextTaskIntent: null,
          queuedUnsupportedInputCount: 0,
          busyStartedAt: null,
        },
      },
    }, null, 2), 'utf8');
    await fs.writeFile(path.join(legacyStorageDir, 'open-runs.gen'), 'a', 'utf8');

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId,
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
    });

    await stats.start();

    assert.deepEqual(archState.composer.activeRunSummaryBySession[sessionPath], {
      runId: 'run-legacy',
      status: 'open',
    });

    await stats.shutdown();
  });
});

test('StatsService tolerates auto-export write failures during startup and persistence', async () => {
  await withTempDir(async (tempDir) => {
    let archState = createInitialArchState();
    const sessionPath = '/workspace/session-export-failure.jsonl';
    const workspaceId = 'workspace-export-failure';
    const storageDir = path.join(
      tempDir,
      'data',
      'outcomes',
      workspaceHash(workspaceId),
    );
    let idCounter = 0;

    archState = produce(archState, draft => {
      draft.sessions.sessions.push({

      path: sessionPath,
      name: 'Export Failure Session',
      cwd: '/workspace',
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
      modelId: 'claude',
    
      } as SessionSummary);
    });
    archState = produce(archState, draft => {
      draft.settings.modelSettings = {

      defaultModel: 'claude',
      defaultThinkingLevel: 'medium',
    
      } as ModelSettings;
    });

    await fs.mkdir(storageDir, { recursive: true });
    await fs.mkdir(path.join(storageDir, 'run-analytics.json'));

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId,
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
      createId: () => `id-${++idCounter}`,
    });

    await stats.start();
    stats.prepareForSend(sessionPath, []);
    await stats.shutdown();

    const snapshotEntries = await readJsonl(path.join(storageDir, 'run-snapshots.jsonl')) as Array<{
      run: { runId: string };
    }>;
    assert.equal(snapshotEntries.length, 1);
    assert.equal(snapshotEntries[0].run.runId, 'id-1');
  });
});
