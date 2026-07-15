// Stub the `vscode` module BEFORE importing handlers/session.ts (which uses
// vscode.env at runtime). Must run first — see the helper for details.
import '../../helpers/vscode-stub';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { produce } from 'immer';

import { StatsService, NOOP_RUN_OBSERVER } from '../../../src/host/stats-service';
import type { RunObserver } from '../../../src/host/stats-service';
import type { AgentReviewEntry, OutcomeHistoryLogEntry, RunSnapshotLogEntry } from '../../../src/host/run-analytics';
import { createInitialArchState } from '../../../src/host/core/arch-state';
import type { ArchState } from '../../../src/host/core/arch-state';
import { reducer } from '../../../src/host/core/reducer';
import type { Event } from '../../../src/host/core/events';
import { SessionServiceState } from '../../../src/host/session-service/state';
import { onSessionListChanged } from '../../../src/host/session-service/handlers/session';
import type { ModelSettings, SessionListChangedPayload, SessionSummary } from '../../../src/shared/protocol';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-agent-review-test-'));
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
  return path.join(usageDataRoot, entries[0]!);
}

async function readJsonl(filePath: string): Promise<unknown[]> {
  const raw = await fs.readFile(filePath, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/** Asserts the file does not exist (used for the no-run no-op case). */
async function assertFileMissing(filePath: string): Promise<void> {
  await assert.rejects(
    fs.access(filePath),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    `expected ${filePath} to not exist`,
  );
}

function seedArchState(sessionPath: string): ArchState {
  let archState = createInitialArchState();
  archState = produce(archState, (draft) => {
    draft.sessions.sessions.push({
      path: sessionPath,
      name: 'Session',
      cwd: '/workspace',
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
      modelId: 'claude-test',
    } as SessionSummary);
    draft.settings.modelSettings = {
      defaultModel: 'claude-test',
      defaultThinkingLevel: 'medium',
    } as ModelSettings;
  });
  return archState;
}

test('StatsService recordAgentReview writes an agent_review entry to agent-reviews.jsonl joined to the last run', async () => {
  await withTempDir(async (tempDir) => {
    const sessionPath = '/workspace/session-review.jsonl';
    let archState = seedArchState(sessionPath);
    let idCounter = 0;

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId: 'workspace-agent-review',
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
      createId: () => `id-${++idCounter}`,
    });

    await stats.start();

    // Start a run, then finalize it as scored so it becomes lastRun. The review
    // should join to that last run's runId / taskGroupId.
    const runId = stats.prepareForSend(sessionPath, []);
    stats.recordOutcome(sessionPath, { resolution: 'resolved', satisfaction: 5 });

    const evaluatedAt = '2026-07-05T12:00:00.000Z';
    stats.recordAgentReview(sessionPath, {
      done: true,
      rating: 5,
      completion: 'fully',
      reason: 'task completed',
      evaluatedAt,
      reviewerBuckets: [],
      reviewerCount: 0,
    });

    await stats.shutdown();

    const storageDir = await getRunStorageDir(tempDir);
    const reviewEntries = await readJsonl(path.join(storageDir, 'agent-reviews.jsonl')) as AgentReviewEntry[];

    assert.equal(reviewEntries.length, 1);
    assert.equal(reviewEntries[0]!.schemaVersion, 1);
    assert.equal(reviewEntries[0]!.kind, 'agent_review');
    assert.equal(reviewEntries[0]!.sessionPath, sessionPath);
    assert.equal(reviewEntries[0]!.runId, runId);
    // First run: runId='id-1', taskGroupId='id-2' (createId order in createRunSnapshot).
    assert.equal(reviewEntries[0]!.taskGroupId, 'id-2');
    assert.equal(reviewEntries[0]!.done, true);
    assert.equal(reviewEntries[0]!.rating, 5);
    assert.equal(reviewEntries[0]!.completion, 'fully');
    assert.equal(reviewEntries[0]!.reason, 'task completed');
    assert.equal(reviewEntries[0]!.evaluatedAt, evaluatedAt);
    assert.deepEqual(reviewEntries[0]!.reviewerBuckets, []);
    assert.equal(reviewEntries[0]!.reviewerCount, 0);
    assert.equal(typeof reviewEntries[0]!.recordedAt, 'string');
  });
});

test('StatsService completed agent review scores the run with agent provenance', async () => {
  await withTempDir(async (tempDir) => {
    const sessionPath = '/workspace/session-agent-outcome.jsonl';
    let archState = seedArchState(sessionPath);

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId: 'workspace-agent-outcome',
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
      createId: (() => { let id = 0; return () => `id-${++id}`; })(),
    });

    await stats.start();
    const runId = stats.prepareForSend(sessionPath, []);
    stats.recordAgentReview(sessionPath, {
      done: true,
      rating: 4,
      completion: 'partial',
      reason: 'valuable work, but one follow-up remains',
      evaluatedAt: '2026-07-05T12:00:00.000Z',
      reviewerBuckets: ['medium'],
      reviewerCount: 1,
    });
    // Mirrors the auto-close that immediately follows the review transition.
    stats.onSessionClosed(sessionPath);
    await stats.shutdown();

    const storageDir = await getRunStorageDir(tempDir);
    const snapshots = await readJsonl(path.join(storageDir, 'run-snapshots.jsonl')) as RunSnapshotLogEntry[];
    const outcomes = await readJsonl(path.join(storageDir, 'outcome-history.jsonl')) as OutcomeHistoryLogEntry[];

    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]!.run.runId, runId);
    assert.equal(snapshots[0]!.run.status, 'scored');
    assert.equal(snapshots[0]!.run.scored, true);
    assert.deepEqual(snapshots[0]!.run.outcome, {
      resolution: 'partially_resolved',
      satisfaction: 4,
      source: 'agent',
    });
    assert.equal(outcomes.length, 1);
    assert.deepEqual(outcomes[0]!.outcome, snapshots[0]!.run.outcome);
  });
});

test('StatsService recordAgentReview is a no-op when no run exists', async () => {
  await withTempDir(async (tempDir) => {
    const sessionPath = '/workspace/session-no-run.jsonl';
    let archState = seedArchState(sessionPath);

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId: 'workspace-agent-review-no-run',
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
    });

    await stats.start();

    // No prepareForSend — no currentRun / lastRun for this session.
    stats.recordAgentReview(sessionPath, {
      done: true,
      rating: 4,
      completion: 'fully',
      reason: 'should be dropped',
      evaluatedAt: '2026-07-05T12:00:00.000Z',
      reviewerBuckets: ['medium'],
      reviewerCount: 1,
    });

    await stats.shutdown();

    const storageDir = await getRunStorageDir(tempDir);
    await assertFileMissing(path.join(storageDir, 'agent-reviews.jsonl'));
  });
});

test('StatsService recordAgentReview persists reviewerBuckets and reviewerCount', async () => {
  await withTempDir(async (tempDir) => {
    const sessionPath = '/workspace/session-reviewers.jsonl';
    let archState = seedArchState(sessionPath);
    let idCounter = 0;

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId: 'workspace-agent-review-reviewers',
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
      createId: () => `id-${++idCounter}`,
    });

    await stats.start();
    const runId = stats.prepareForSend(sessionPath, []);
    stats.recordOutcome(sessionPath, { resolution: 'resolved', satisfaction: 4 });

    stats.recordAgentReview(sessionPath, {
      done: true,
      rating: 4,
      completion: 'partial',
      reason: 'work done but unresolved',
      evaluatedAt: '2026-07-05T12:00:00.000Z',
      reviewerBuckets: ['medium', 'small'],
      reviewerCount: 2,
    });

    await stats.shutdown();

    const storageDir = await getRunStorageDir(tempDir);
    const reviewEntries = await readJsonl(path.join(storageDir, 'agent-reviews.jsonl')) as AgentReviewEntry[];

    assert.equal(reviewEntries.length, 1);
    assert.equal(reviewEntries[0]!.runId, runId);
    assert.deepEqual(reviewEntries[0]!.reviewerBuckets, ['medium', 'small']);
    assert.equal(reviewEntries[0]!.reviewerCount, 2);
  });
});

test('StatsService recordAgentReview re-record updates: latest per runId wins', async () => {
  await withTempDir(async (tempDir) => {
    const sessionPath = '/workspace/session-rerecord.jsonl';
    let archState = seedArchState(sessionPath);
    let idCounter = 0;
    // Deterministic, advancing clock so the second record is strictly newer.
    let nowMs = Date.UTC(2026, 6, 5, 12, 0, 0);

    const stats = new StatsService({
      dataOutcomesRootPath: path.join(tempDir, 'data', 'outcomes'),
      legacyUsageDataRootPath: tempDir,
      workspaceId: 'workspace-agent-review-rerecord',
      getArchState: () => archState,
      dispatchArchEvent: (event) => { const result = reducer(archState, event); archState = result.state; },
      createId: () => `id-${++idCounter}`,
      now: () => new Date(nowMs),
    });

    await stats.start();
    const runId = stats.prepareForSend(sessionPath, []);
    stats.recordOutcome(sessionPath, { resolution: 'resolved', satisfaction: 5 });

    // First review: rating 3. Advance time so the second record is newer.
    nowMs = Date.UTC(2026, 6, 5, 12, 0, 1);
    stats.recordAgentReview(sessionPath, {
      done: true,
      rating: 3,
      completion: 'partial',
      reason: 'first take',
      evaluatedAt: '2026-07-05T12:00:01.000Z',
      reviewerBuckets: ['medium'],
      reviewerCount: 1,
    });

    // Re-record for the same run: rating 5 (latest should win).
    nowMs = Date.UTC(2026, 6, 5, 12, 0, 2);
    stats.recordAgentReview(sessionPath, {
      done: true,
      rating: 5,
      completion: 'fully',
      reason: 'second take',
      evaluatedAt: '2026-07-05T12:00:02.000Z',
      reviewerBuckets: ['medium', 'small'],
      reviewerCount: 2,
    });

    await stats.shutdown();

    const storageDir = await getRunStorageDir(tempDir);
    const reviewEntries = await readJsonl(path.join(storageDir, 'agent-reviews.jsonl')) as AgentReviewEntry[];

    assert.equal(reviewEntries.length, 1, 're-record for the same runId must not double-append; latest wins');
    assert.equal(reviewEntries[0]!.runId, runId);
    assert.equal(reviewEntries[0]!.rating, 5);
    assert.equal(reviewEntries[0]!.completion, 'fully');
    assert.equal(reviewEntries[0]!.reason, 'second take');
    assert.deepEqual(reviewEntries[0]!.reviewerBuckets, ['medium', 'small']);
    assert.equal(reviewEntries[0]!.reviewerCount, 2);
  });
});

test('onSessionListChanged records agent-review analytics on a fresh done transition', () => {
  const A = '/workspace/session-done-transition.jsonl';
  const baseSummary: SessionSummary = {
    path: A,
    name: 'Alpha',
    cwd: '/workspace',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 3,
  };

  let archState: ArchState = {
    ...createInitialArchState(),
    sessions: {
      ...createInitialArchState().sessions,
      sessions: [baseSummary],
      openTabPaths: [A],
      activeSessionPath: A,
    },
  };
  const getArchState = () => archState;
  const dispatchArch = (event: Event) => {
    archState = reducer(archState, event).state;
  };

  const context = {
    globalState: { update: async () => undefined },
    workspaceState: { update: async () => undefined },
  } as any;  
  const backend = { request: async () => ({}) } as any;  
  const state = new SessionServiceState(context, backend, () => undefined, getArchState, dispatchArch, 0);

  const recordAgentReviewCalls: Array<{ sessionPath: string; review: Record<string, unknown> }> = [];
  const runObserver: RunObserver = {
    ...NOOP_RUN_OBSERVER,
    recordAgentReview: (sessionPath, review) => {
      recordAgentReviewCalls.push({ sessionPath, review: { ...review } });
    },
  };

  const scheduleRenderCalls: number[] = [];
  const deps = {
    context,
    getArchState,
    dispatchArch,
    runObserver,
    state,
    scheduleRender: () => { scheduleRenderCalls.push(1); },
    requireEventSessionPath: (_eventName: string, sessionPath: string | undefined) => sessionPath ?? null,
  };

  // First call: seed with A not done, so the next done transition is "fresh".
  // (computeReviewAutoCloseClosures returns [] on the first/seed call.)
  const seedPayload: SessionListChangedPayload = {
    sessions: [{ ...baseSummary, done: false }],
    activeSessionPath: A,
  };
  onSessionListChanged(seedPayload, deps);
  assert.equal(recordAgentReviewCalls.length, 0, 'no record on the seeding call');

  // Second call: A flips to done with a full review. Fresh done transition
  // → closure → CloseSession dispatched, then recordAgentReview called with
  // the review fields extracted from the summary.
  const evaluatedAt = '2026-07-05T12:34:56.000Z';
  const donePayload: SessionListChangedPayload = {
    sessions: [{
      ...baseSummary,
      done: true,
      rating: 4,
      completion: 'fully',
      reviewReason: 'shipped it',
      evaluatedAt,
      reviewerBuckets: ['medium'],
      reviewerCount: 1,
    }],
    activeSessionPath: A,
  };
  onSessionListChanged(donePayload, deps);

  assert.equal(recordAgentReviewCalls.length, 1);
  assert.equal(recordAgentReviewCalls[0]!.sessionPath, A);
  const review = recordAgentReviewCalls[0]!.review;
  assert.equal(review.done, true);
  assert.equal(review.rating, 4);
  assert.equal(review.completion, 'fully');
  assert.equal(review.reason, 'shipped it');
  assert.equal(review.evaluatedAt, evaluatedAt);
  assert.deepEqual(review.reviewerBuckets, ['medium']);
  assert.equal(review.reviewerCount, 1);
});

test('onSessionListChanged skips agent-review analytics for a selfClose review but still closes the tab', () => {
  const A = '/workspace/session-self-close.jsonl';
  const baseSummary: SessionSummary = {
    path: A,
    name: 'Reviewer',
    cwd: '/workspace',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 3,
  };

  let archState: ArchState = {
    ...createInitialArchState(),
    sessions: {
      ...createInitialArchState().sessions,
      sessions: [baseSummary],
      openTabPaths: [A],
      activeSessionPath: A,
    },
  };
  const getArchState = () => archState;
  const dispatchedEvents: Event[] = [];
  const dispatchArch = (event: Event) => {
    dispatchedEvents.push(event);
    archState = reducer(archState, event).state;
  };

  const context = {
    globalState: { update: async () => undefined },
    workspaceState: { update: async () => undefined },
  } as any;
  const backend = { request: async () => ({}) } as any;
  const state = new SessionServiceState(context, backend, () => undefined, getArchState, dispatchArch, 0);

  const recordAgentReviewCalls: Array<{ sessionPath: string; review: Record<string, unknown> }> = [];
  const runObserver: RunObserver = {
    ...NOOP_RUN_OBSERVER,
    recordAgentReview: (sessionPath, review) => {
      recordAgentReviewCalls.push({ sessionPath, review: { ...review } });
    },
  };

  const deps = {
    context,
    getArchState,
    dispatchArch,
    runObserver,
    state,
    scheduleRender: () => undefined,
    requireEventSessionPath: (_eventName: string, sessionPath: string | undefined) => sessionPath ?? null,
  };

  // Seed with A not done.
  onSessionListChanged(
    { sessions: [{ ...baseSummary, done: false }], activeSessionPath: A },
    deps,
  );
  dispatchedEvents.length = 0;

  // Flip to done as a selfClose marker. The tab must still close (CloseSession
  // dispatched) but no agent-review analytics should be recorded.
  onSessionListChanged(
    { sessions: [{ ...baseSummary, done: true, selfClose: true }], activeSessionPath: A },
    deps,
  );

  assert.equal(recordAgentReviewCalls.length, 0, 'selfClose must not record agent-review analytics');
  const closeCommands = dispatchedEvents.filter(
    (e) => e.kind === 'Command' && (e as any).cmd?.kind === 'CloseSession',
  );
  assert.equal(closeCommands.length, 1, 'selfClose must still dispatch a CloseSession to close the tab');
});

test('onSessionListChanged applies defaults for missing review fields on a done transition', () => {
  const A = '/workspace/session-done-defaults.jsonl';
  const baseSummary: SessionSummary = {
    path: A,
    name: 'Alpha',
    cwd: '/workspace',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 3,
  };

  let archState: ArchState = {
    ...createInitialArchState(),
    sessions: {
      ...createInitialArchState().sessions,
      sessions: [baseSummary],
      openTabPaths: [A],
      activeSessionPath: A,
    },
  };
  const getArchState = () => archState;
  const dispatchArch = (event: Event) => {
    archState = reducer(archState, event).state;
  };

  const context = {
    globalState: { update: async () => undefined },
    workspaceState: { update: async () => undefined },
  } as any;  
  const backend = { request: async () => ({}) } as any;  
  const state = new SessionServiceState(context, backend, () => undefined, getArchState, dispatchArch, 0);

  const recordAgentReviewCalls: Array<{ sessionPath: string; review: Record<string, unknown> }> = [];
  const runObserver: RunObserver = {
    ...NOOP_RUN_OBSERVER,
    recordAgentReview: (sessionPath, review) => {
      recordAgentReviewCalls.push({ sessionPath, review: { ...review } });
    },
  };

  const deps = {
    context,
    getArchState,
    dispatchArch,
    runObserver,
    state,
    scheduleRender: () => undefined,
    requireEventSessionPath: (_eventName: string, sessionPath: string | undefined) => sessionPath ?? null,
  };

  // Seed with A not done.
  onSessionListChanged(
    { sessions: [{ ...baseSummary, done: false }], activeSessionPath: A },
    deps,
  );

  // Flip to done with ONLY `done: true` set — every other review field
  // omitted. The handler must apply the documented defaults.
  onSessionListChanged(
    { sessions: [{ ...baseSummary, done: true }], activeSessionPath: A },
    deps,
  );

  assert.equal(recordAgentReviewCalls.length, 1);
  const review = recordAgentReviewCalls[0]!.review;
  assert.equal(review.done, true);
  assert.equal(review.rating, 0);
  assert.equal(review.completion, 'partial');
  assert.equal(review.reason, '');
  assert.equal(typeof review.evaluatedAt, 'string');
  assert.equal((review.evaluatedAt as string).length > 0, true);
  assert.deepEqual(review.reviewerBuckets, []);
  assert.equal(review.reviewerCount, 0);
});
