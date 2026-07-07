import assert from 'node:assert/strict';
import test from 'node:test';

import { produce } from 'immer';

import { createInitialArchState } from '../src/host/core/arch-state';
import { reducer } from '../src/host/core/reducer';
import type { Event } from '../src/host/core/events';
import type { ArchState } from '../src/host/core/arch-state';
import {
  RUN_ANALYTICS_SCHEMA_VERSION,
  type AgentReviewEntry,
  type OutcomeHistoryLogEntry,
  type PersistedSessionRunState,
  type RunSnapshot,
  type TreatmentChangeKind,
} from '../src/host/run-analytics';
import { SessionRunStateManager } from '../src/host/stats-service/run-state-manager';
import { toPersistedSessionState } from '../src/host/stats-service/helpers';
import type { SessionAnalyticsFactors, SessionSkillFactor } from '../src/shared/protocol';

interface Harness {
  manager: SessionRunStateManager;
  persistCalls: Array<{ snapshot?: RunSnapshot; outcome?: OutcomeHistoryLogEntry }>;
  agentReviewCalls: AgentReviewEntry[];
  renderCount: number;
  getArchState: () => ArchState;
  dispatchArchEvent: (event: Event) => void;
  mutateArch: (mutator: (draft: ArchState) => void) => void;
  setNow: (ms: number) => void;
  setExperimentAssignment: (value: string | null) => void;
  setIdCounter: (n: number) => void;
}

function baseAnalyticsFactors(hash: string): SessionAnalyticsFactors {
  return {
    promptFamily: 'harness',
    promptHash: `prompt-${hash}`,
    promptCapturedAt: '2025-06-15T10:30:00.000Z',
    harnessPromptHash: `harness-${hash}`,
    customPromptHash: null,
    appendSystemPromptHash: null,
    promptGuidelineHashes: [],
    contextFiles: [],
    selectedToolIds: ['bash'],
    toolSnippetHashes: [],
    toolSetHash: `tools-${hash}`,
    skills: [],
    skillSetHash: null,
    activeExtensions: [],
  };
}

function createHarness(sessionPath = '/workspace/session-rsm.jsonl'): Harness {
  let archState = createInitialArchState();
  let nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  let experimentAssignment: string | null = 'control';
  let idCounter = 0;

  archState = produce(archState, (draft) => {
    draft.sessions.sessions.push({
      path: sessionPath,
      name: 'Session RSM',
      cwd: '/workspace',
      modifiedAt: new Date(nowMs).toISOString(),
      messageCount: 0,
      modelId: 'claude-test',
      thinkingLevel: 'medium',
    });
    draft.settings.modelSettings = {
      defaultModel: 'claude-default',
      defaultThinkingLevel: 'low',
    };
    draft.sessions.analyticsFactorsBySession[sessionPath] = baseAnalyticsFactors('a');
  });

  const persistCalls: Array<{ snapshot?: RunSnapshot; outcome?: OutcomeHistoryLogEntry }> = [];
  const agentReviewCalls: AgentReviewEntry[] = [];
  const renderCount = 0;

  const getArchState = () => archState;
  const dispatchArchEvent = (event: Event) => {
    const result = reducer(archState, event);
    archState = result.state;
  };

  const manager = new SessionRunStateManager({
    getArchState,
    dispatchArchEvent,
    schedulePersist: (snapshot, outcome) => {
      persistCalls.push({ snapshot, outcome });
    },
    schedulePersistAgentReview: (entry) => {
      agentReviewCalls.push(entry);
    },
    now: () => new Date(nowMs),
    createId: () => `id-${++idCounter}`,
    getExperimentAssignment: () => experimentAssignment,
  });

  const mutateArch = (mutator: (draft: ArchState) => void) => {
    archState = produce(archState, mutator);
  };

  return {
    manager,
    persistCalls,
    agentReviewCalls,
    get renderCount() { return renderCount; },
    getArchState,
    dispatchArchEvent,
    mutateArch,
    setNow: (ms) => { nowMs = ms; },
    setExperimentAssignment: (value) => { experimentAssignment = value; },
    setIdCounter: (n) => { idCounter = n; },
  };
}

function openRun(manager: SessionRunStateManager, sessionPath: string): RunSnapshot {
  const state = manager.getOrCreateSessionState(sessionPath);
  const run = manager.createRunSnapshot(sessionPath, state);
  state.currentRun = run;
  return run;
}

test('createRunSnapshot seeds an open run from arch state with no counted activity', () => {
  const h = createHarness();
  const sessionPath = '/workspace/session-rsm.jsonl';
  const state = h.manager.getOrCreateSessionState(sessionPath);
  const run = h.manager.createRunSnapshot(sessionPath, state);

  assert.equal(run.sessionPath, sessionPath);
  assert.equal(run.status, 'open');
  assert.equal(run.scored, false);
  assert.equal(run.runId, 'id-1');
  assert.equal(run.taskGroupId, 'id-2', 'no lastRun ⇒ fresh task group id');
  assert.equal(run.modelId, 'claude-test', 'modelId comes from the session row');
  assert.equal(run.thinkingLevel, 'medium', 'thinkingLevel comes from the session row');
  assert.equal(run.experimentAssignment, 'control', 'experiment assignment is normalized and captured at run start');
  assert.equal(run.analyticsFactors?.promptHash, 'prompt-a');
  assert.equal(run.functionalSettings?.pruningMode, 'auto');
  assert.equal(run.functionalSettings?.toolResultPruningEnabled, true);
  assert.equal(run.functionalSettings?.toolResultPruningProfile, 'default');
  assert.equal(run.functionalSettings?.subagentAlwaysParentModel, false);

  // No activity counted yet — these feed user-facing readouts and must start at zero.
  assert.equal(run.sendCount, 0);
  assert.equal(run.assistantTurnCount, 0);
  assert.equal(run.assistantTurnDurationMs, 0);
  assert.equal(run.busyDurationMs, 0);
  assert.equal(run.busyPeriodCount, 0);
  assert.equal(run.interruptedCount, 0);
  assert.equal(run.messageEditCount, 0);
  assert.equal(run.truncatedAfterCount, 0);
  assert.equal(run.inputTokens, 0);
  assert.equal(run.outputTokens, 0);
  assert.equal(run.toolUsage.totalCount, 0);
  assert.equal(run.fileMutation.editCount, 0);
  assert.equal(run.verification.totalCount, 0);
  assert.equal(run.mixedModelConfig, false);
  assert.equal(run.mixedTreatmentConfig, false);
  assert.deepEqual(run.treatmentChangeKinds, []);
});

test('createRunSnapshot falls back to default model settings when the session row omits them', () => {
  const sessionPath = '/workspace/no-model-session.jsonl';
  const h = createHarness(sessionPath);
  // Drop the per-session model config so the run must fall back to defaults.
  h.mutateArch((draft) => {
    const s = draft.sessions.sessions.find((x) => x.path === sessionPath);
    if (s) {
      s.modelId = undefined;
      s.thinkingLevel = undefined;
    }
  });
  const state = h.manager.getOrCreateSessionState(sessionPath);
  const run = h.manager.createRunSnapshot(sessionPath, state);
  assert.equal(run.modelId, 'claude-default', 'falls back to defaultModel');
  assert.equal(run.thinkingLevel, 'low', 'falls back to defaultThinkingLevel');
});

test('finalizeCurrentRun with outcome transitions to scored and persists snapshot + outcome entry', () => {
  const h = createHarness();
  const sessionPath = '/workspace/session-rsm.jsonl';
  const run = openRun(h.manager, sessionPath);
  h.persistCalls.length = 0;

  // Advance the injected clock so finalizedAt is strictly newer than startedAt.
  h.setNow(Date.UTC(2026, 0, 1, 0, 0, 5));
  const expectedFinalizedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 5)).toISOString();

  const outcome = { resolution: 'resolved' as const, satisfaction: 5 };
  const finalized = h.manager.finalizeCurrentRun(sessionPath, 'scored', outcome);

  assert.ok(finalized, 'finalizeCurrentRun should return the finalized run');
  assert.equal(finalized!.runId, run.runId);
  assert.equal(finalized!.status, 'scored');
  assert.equal(finalized!.scored, true);
  assert.equal(finalized!.outcome, outcome);
  assert.equal(finalized!.finalizationReason, 'scored');
  assert.equal(finalized!.finalizedAt, expectedFinalizedAt, 'finalizedAt uses the injected now()');
  assert.notEqual(finalized!.finalizedAt, run.startedAt, 'finalizedAt advances past startedAt');

  // The returned snapshot is the exact object downstream persistence receives (no copy/loss).
  assert.equal(h.persistCalls.length, 1, 'exactly one persist call on finalize');
  assert.equal(h.persistCalls[0].snapshot, finalized, 'persisted snapshot is the finalized run object');
  assert.ok(h.persistCalls[0].outcome, 'scored finalize schedules an outcome history entry');
  assert.equal(h.persistCalls[0].outcome!.kind, 'run_outcome');
  assert.equal(h.persistCalls[0].outcome!.runId, run.runId);
  assert.equal(h.persistCalls[0].outcome!.taskGroupId, run.taskGroupId);
  assert.deepEqual(h.persistCalls[0].outcome!.outcome, outcome);

  // currentRun cleared, lastRun holds the finalized snapshot.
  const state = h.manager.sessions.get(sessionPath);
  assert.equal(state!.currentRun, null);
  assert.equal(state!.lastRun, finalized);
  assert.equal(state!.busyStartedAt, null);

  // ActiveRunSummaryChanged dispatched with scored summary.
  assert.deepEqual(
    h.getArchState().composer.activeRunSummaryBySession[sessionPath],
    { runId: run.runId, status: 'scored', scored: true },
  );
});

test('finalizeCurrentRun without outcome transitions to closed_unscored and persists snapshot only', () => {
  const h = createHarness();
  const sessionPath = '/workspace/session-rsm.jsonl';
  const run = openRun(h.manager, sessionPath);
  h.persistCalls.length = 0;

  const finalized = h.manager.finalizeCurrentRun(sessionPath, 'new_task');
  assert.ok(finalized);
  assert.equal(finalized!.status, 'closed_unscored');
  assert.equal(finalized!.scored, false);
  assert.equal(finalized!.outcome, undefined);
  assert.equal(finalized!.finalizationReason, 'new_task');

  assert.equal(h.persistCalls.length, 1);
  assert.equal(h.persistCalls[0].snapshot, finalized);
  assert.equal(h.persistCalls[0].outcome, undefined, 'no outcome entry when unscored');
});

test('finalizeCurrentRun is a safe no-op when there is no current run (idempotent)', () => {
  const h = createHarness();
  const sessionPath = '/workspace/session-rsm.jsonl';
  h.persistCalls.length = 0;
  // Session state has never been created — no current run.
  const result = h.manager.finalizeCurrentRun(sessionPath, 'closed_unscored');
  assert.equal(result, null);
  assert.equal(h.persistCalls.length, 0, 'no persist scheduled when nothing to finalize');
  // No summary dispatched for an unknown session.
  assert.equal(h.getArchState().composer.activeRunSummaryBySession[sessionPath], undefined);

  // Even after a run exists and is finalized, a second finalize is a no-op.
  openRun(h.manager, sessionPath);
  h.manager.finalizeCurrentRun(sessionPath, 'scored', { resolution: 'resolved', satisfaction: 4 });
  h.persistCalls.length = 0;
  const second = h.manager.finalizeCurrentRun(sessionPath, 'scored', { resolution: 'resolved', satisfaction: 3 });
  assert.equal(second, null);
  assert.equal(h.persistCalls.length, 0, 'second finalize after closing is a no-op (no double persist)');
});

test('getOrCreateSessionState is idempotent and getMostRelevantRun prefers current over last', () => {
  const h = createHarness();
  const sessionPath = '/workspace/session-rsm.jsonl';

  const first = h.manager.getOrCreateSessionState(sessionPath);
  const second = h.manager.getOrCreateSessionState(sessionPath);
  assert.equal(first, second, 'returns the same state instance across calls');
  assert.equal(h.manager.sessions.size, 1);

  // No run yet ⇒ null.
  assert.equal(h.manager.getMostRelevantRun(sessionPath), null);

  // currentRun present ⇒ returned.
  const run = openRun(h.manager, sessionPath);
  assert.equal(h.manager.getMostRelevantRun(sessionPath), run);

  // After finalize, currentRun gone ⇒ lastRun returned.
  const finalized = h.manager.finalizeCurrentRun(sessionPath, 'scored', { resolution: 'resolved', satisfaction: 5 });
  assert.equal(h.manager.getMostRelevantRun(sessionPath), finalized);

  // Unknown session ⇒ null.
  assert.equal(h.manager.getMostRelevantRun('/workspace/unknown.jsonl'), null);
});

test('closeBusyInterval accumulates busyDurationMs from now() and is idempotent', () => {
  const h = createHarness();
  const sessionPath = '/workspace/session-rsm.jsonl';
  const run = openRun(h.manager, sessionPath);
  const state = h.manager.sessions.get(sessionPath)!;

  // No busy started ⇒ returns false, no duration added, busyStartedAt cleared.
  state.busyStartedAt = null;
  assert.equal(h.manager.closeBusyInterval(state), false);
  assert.equal(run.busyDurationMs, 0);

  // Start a busy interval at t0, close at t0+1500ms.
  h.setNow(Date.UTC(2026, 0, 1, 0, 0, 0));
  state.busyStartedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString();
  h.setNow(Date.UTC(2026, 0, 1, 0, 0, 1, 500));
  assert.equal(h.manager.closeBusyInterval(state), true);
  assert.equal(run.busyDurationMs, 1500);
  assert.equal(state.busyStartedAt, null);

  // Closing again is a no-op (idempotent) — does not re-add duration.
  h.setNow(Date.UTC(2026, 0, 1, 0, 0, 5));
  assert.equal(h.manager.closeBusyInterval(state), false);
  assert.equal(run.busyDurationMs, 1500, 'no double-count on repeated close');

  // A second busy window accumulates on top of the first.
  state.busyStartedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 5)).toISOString();
  h.setNow(Date.UTC(2026, 0, 1, 0, 0, 6, 250));
  assert.equal(h.manager.closeBusyInterval(state), true);
  assert.equal(run.busyDurationMs, 1500 + 1250);

  // No current run ⇒ returns false and does not throw.
  const empty = h.manager.getOrCreateSessionState('/workspace/empty.jsonl');
  assert.equal(h.manager.closeBusyInterval(empty), false);
});

test('markTreatmentChanges sets mixedTreatmentConfig and appends unique kinds only', () => {
  const h = createHarness();
  const sessionPath = '/workspace/session-rsm.jsonl';
  const run = openRun(h.manager, sessionPath);

  h.manager.markTreatmentChanges(run, []);
  assert.equal(run.mixedTreatmentConfig, false, 'empty kinds is a no-op');
  assert.deepEqual(run.treatmentChangeKinds, []);

  h.manager.markTreatmentChanges(run, ['prompt' as TreatmentChangeKind]);
  assert.equal(run.mixedTreatmentConfig, true);
  assert.deepEqual(run.treatmentChangeKinds, ['prompt']);

  // Duplicates are not appended; new kinds are.
  h.manager.markTreatmentChanges(run, ['prompt' as TreatmentChangeKind, 'skills' as TreatmentChangeKind]);
  assert.deepEqual(run.treatmentChangeKinds, ['prompt', 'skills']);
  assert.equal(run.treatmentChangeKinds.length, 2, 'no duplicate kinds');
});

test('diffAnalyticsFactors flags prompt, tool, skills (excluding mtime), and extensions changes', () => {
  const h = createHarness();
  const base = baseAnalyticsFactors('a');

  // No change.
  assert.deepEqual(h.manager.diffAnalyticsFactors(base, base), []);

  // Prompt change (customPromptHash differs).
  let next: SessionAnalyticsFactors = { ...base, customPromptHash: 'custom-b' };
  assert.deepEqual(h.manager.diffAnalyticsFactors(base, next), ['prompt']);

  // Tool selection change (toolSetHash differs).
  next = { ...base, toolSetHash: 'tools-b' };
  assert.deepEqual(h.manager.diffAnalyticsFactors(base, next), ['toolSelection']);

  // Extensions change.
  next = { ...base, activeExtensions: ['ext-a'] };
  assert.deepEqual(h.manager.diffAnalyticsFactors(base, next), ['extensions']);

  // Skills content change is detected.
  const skillsA: SessionSkillFactor[] = [{
    name: 'frontend-design',
    contentHash: 'content-1',
    sourceHash: 'source-1',
    disableModelInvocation: false,
    lastModifiedAt: '2026-01-01T00:00:00.000Z',
  }];
  const skillsSameContentNewMtime: SessionSkillFactor[] = [{
    name: 'frontend-design',
    contentHash: 'content-1',
    sourceHash: 'source-1',
    disableModelInvocation: false,
    lastModifiedAt: '2026-02-02T00:00:00.000Z', // mtime changed, content identical
  }];
  const skillsNewContent: SessionSkillFactor[] = [{
    name: 'frontend-design',
    contentHash: 'content-2',
    sourceHash: 'source-1',
    disableModelInvocation: false,
    lastModifiedAt: '2026-01-01T00:00:00.000Z',
  }];

  const withSkillsA: SessionAnalyticsFactors = { ...base, skills: skillsA, skillSetHash: 'skills-a' };
  const withSkillsSameContentNewMtime: SessionAnalyticsFactors = {
    ...base,
    skills: skillsSameContentNewMtime,
    skillSetHash: 'skills-a', // same hash — mirrors how skillSetHash excludes mtime
  };
  assert.deepEqual(
    h.manager.diffAnalyticsFactors(withSkillsA, withSkillsSameContentNewMtime),
    [],
    'mtime-only change must NOT flip the skills treatment (mirrors skillSetHash/promptHash redaction)',
  );

  const withSkillsNewContent: SessionAnalyticsFactors = {
    ...base,
    skills: skillsNewContent,
    skillSetHash: 'skills-b',
  };
  assert.deepEqual(
    h.manager.diffAnalyticsFactors(withSkillsA, withSkillsNewContent),
    ['skills'],
    'content change flips the skills treatment',
  );
});

test('serializeSessions then restore round-trips persisted state exactly and resets transient bookkeeping', () => {
  const h = createHarness();
  const sessionPath = '/workspace/session-rsm.jsonl';
  const run = openRun(h.manager, sessionPath);
  run.sendCount = 3;
  run.assistantTurnCount = 2;
  run.inputTokens = 500;
  const state = h.manager.sessions.get(sessionPath)!;
  // Simulate transient bookkeeping that must NOT be persisted.
  state.turnIdsSeenInCurrentRun.add('turn-1');
  state.endedTurnIdsInCurrentRun.add('turn-1');
  state.startedToolCallIdsInCurrentRun.add('tool-1');
  state.finishedToolCallIdsInCurrentRun.add('tool-1');
  state.queuedUnsupportedInputCount = 7;
  state.nextTaskIntent = 'new_task';
  state.busyStartedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString();

  const serialized = h.manager.serializeSessions();
  const expectedPersisted: PersistedSessionRunState = {
    currentRun: run,
    lastRun: null,
    nextTaskIntent: 'new_task',
    queuedUnsupportedInputCount: 7,
    busyStartedAt: state.busyStartedAt,
  };
  assert.deepEqual(serialized[sessionPath], expectedPersisted, 'persisted state contains exactly the run + checkpoint fields');
  // Persisted state excludes the transient Sets.
  assert.equal((serialized[sessionPath] as unknown as Record<string, unknown>).turnIdsSeenInCurrentRun, undefined);

  // Restore into a fresh manager (downstream restart path).
  const h2 = createHarness();
  h2.manager.restore(serialized);
  const restored = h2.manager.sessions.get(sessionPath)!;
  assert.ok(restored);
  assert.equal(restored.currentRun, run, 'currentRun object is preserved across restore');
  assert.equal(restored.currentRun!.sendCount, 3);
  assert.equal(restored.currentRun!.inputTokens, 500);
  assert.equal(restored.nextTaskIntent, 'new_task');
  assert.equal(restored.queuedUnsupportedInputCount, 7);
  assert.equal(restored.busyStartedAt, state.busyStartedAt);
  // Transient Sets are reset to empty on restore (no stale dedup state).
  assert.equal(restored.turnIdsSeenInCurrentRun.size, 0);
  assert.equal(restored.endedTurnIdsInCurrentRun.size, 0);
  assert.equal(restored.startedToolCallIdsInCurrentRun.size, 0);
  assert.equal(restored.finishedToolCallIdsInCurrentRun.size, 0);

  // restore dispatches a summary reflecting nextTaskIntent === 'new_task'.
  assert.deepEqual(
    h2.getArchState().composer.activeRunSummaryBySession[sessionPath],
    { runId: run.runId, status: 'open', scored: false, nextSendStartsNewTask: true },
  );

  // restore clears the in-memory map. By design it only syncs summaries for
  // sessions present in the checkpoint, so a previously-known session that is
  // absent from the checkpoint is simply dropped — it does not get a null
  // summary dispatched (the production restart path uses a fresh archState, so
  // there is never a stale summary to clear).
  h2.manager.restore({});
  assert.equal(h2.manager.sessions.size, 0, 'restore with empty checkpoint clears existing sessions');
});

test('restore only syncs summaries for sessions present in the checkpoint (absent sessions are not nulled)', () => {
  const h = createHarness();
  const sessionPath = '/workspace/session-rsm.jsonl';
  const run = openRun(h.manager, sessionPath);
  h.manager.syncSessionSummary(sessionPath);
  const priorSummary = h.getArchState().composer.activeRunSummaryBySession[sessionPath];
  assert.ok(priorSummary);
  void run;

  // Restoring an empty checkpoint clears the session map but leaves the
  // previously-dispatched summary untouched (restore does not null absent sessions).
  h.manager.restore({});
  assert.equal(h.manager.sessions.size, 0);
  assert.equal(
    h.getArchState().composer.activeRunSummaryBySession[sessionPath],
    priorSummary,
    'restore does not null summaries for sessions absent from the checkpoint',
  );
});

test('syncSessionSummary reflects nextSendStartsNewTask only when nextTaskIntent is new_task', () => {
  const h = createHarness();
  const sessionPath = '/workspace/session-rsm.jsonl';
  const run = openRun(h.manager, sessionPath);
  const state = h.manager.sessions.get(sessionPath)!;

  state.nextTaskIntent = null;
  h.manager.syncSessionSummary(sessionPath);
  assert.deepEqual(
    h.getArchState().composer.activeRunSummaryBySession[sessionPath],
    { runId: run.runId, status: 'open', scored: false },
  );

  state.nextTaskIntent = 'continue_task';
  h.manager.syncSessionSummary(sessionPath);
  assert.deepEqual(
    h.getArchState().composer.activeRunSummaryBySession[sessionPath],
    { runId: run.runId, status: 'open', scored: false },
    'continue_task does not set nextSendStartsNewTask',
  );

  state.nextTaskIntent = 'new_task';
  h.manager.syncSessionSummary(sessionPath);
  assert.deepEqual(
    h.getArchState().composer.activeRunSummaryBySession[sessionPath],
    { runId: run.runId, status: 'open', scored: false, nextSendStartsNewTask: true },
  );

  // Unknown session ⇒ null summary dispatched.
  h.manager.syncSessionSummary('/workspace/unknown.jsonl');
  assert.equal(h.getArchState().composer.activeRunSummaryBySession['/workspace/unknown.jsonl'], null);
});

test('buildOutcomeHistoryEntry produces the exact downstream outcome-log record', () => {
  const h = createHarness();
  const sessionPath = '/workspace/session-rsm.jsonl';
  const run = openRun(h.manager, sessionPath);
  const outcome = { resolution: 'partially_resolved' as const, satisfaction: 3 };

  const entry = h.manager.buildOutcomeHistoryEntry(run, outcome);
  assert.equal(entry.schemaVersion, RUN_ANALYTICS_SCHEMA_VERSION);
  assert.equal(entry.kind, 'run_outcome');
  assert.ok(entry.recordedAt);
  assert.equal(entry.sessionPath, sessionPath);
  assert.equal(entry.runId, run.runId);
  assert.equal(entry.taskGroupId, run.taskGroupId);
  assert.equal(entry.outcome, outcome);
});

test('persist and persistAgentReview forward verbatim to the scheduled callbacks', () => {
  const h = createHarness();
  const sessionPath = '/workspace/session-rsm.jsonl';
  const run = openRun(h.manager, sessionPath);
  const outcomeEntry: OutcomeHistoryLogEntry = {
    schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
    kind: 'run_outcome',
    recordedAt: new Date().toISOString(),
    sessionPath,
    runId: run.runId,
    taskGroupId: run.taskGroupId,
    outcome: { resolution: 'resolved', satisfaction: 5 },
  };

  h.persistCalls.length = 0;
  h.manager.persist(run, outcomeEntry);
  assert.equal(h.persistCalls.length, 1);
  assert.equal(h.persistCalls[0].snapshot, run);
  assert.equal(h.persistCalls[0].outcome, outcomeEntry);

  h.manager.persist();
  assert.equal(h.persistCalls.length, 2, 'persist with no args still forwards');

  const review: AgentReviewEntry = {
    schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
    kind: 'agent_review',
    recordedAt: new Date().toISOString(),
    sessionPath,
    runId: run.runId,
    taskGroupId: run.taskGroupId,
    done: true,
    rating: 5,
    completion: 'fully',
    reason: 'great',
    evaluatedAt: new Date().toISOString(),
    reviewerBuckets: ['medium'],
    reviewerCount: 1,
  };
  h.manager.persistAgentReview(review);
  assert.equal(h.agentReviewCalls.length, 1);
  assert.equal(h.agentReviewCalls[0], review);
});

test('createRunSnapshot reuses the last taskGroupId across sends within a task, but mints a new one on new_task', () => {
  const h = createHarness();
  const sessionPath = '/workspace/session-rsm.jsonl';

  // First run: no lastRun ⇒ fresh task group id.
  let state = h.manager.getOrCreateSessionState(sessionPath);
  const run1 = h.manager.createRunSnapshot(sessionPath, state);
  state.currentRun = run1;
  assert.equal(run1.runId, 'id-1');
  assert.equal(run1.taskGroupId, 'id-2');

  // Finalize run1 → lastRun set; default nextTaskIntent null ⇒ continue.
  h.manager.finalizeCurrentRun(sessionPath, 'scored', { resolution: 'resolved', satisfaction: 5 });
  state = h.manager.sessions.get(sessionPath)!;
  assert.equal(state.lastRun!.taskGroupId, 'id-2');

  // Next run with nextTaskIntent null ⇒ reuses the prior taskGroupId (same task group).
  state.nextTaskIntent = null;
  const run2 = h.manager.createRunSnapshot(sessionPath, state);
  assert.equal(run2.runId, 'id-3', 'new run id');
  assert.equal(run2.taskGroupId, 'id-2', 'reuses last taskGroupId within the same task');

  // Explicitly continue_task ⇒ still reuses.
  state.currentRun = run2;
  h.manager.finalizeCurrentRun(sessionPath, 'scored', { resolution: 'resolved', satisfaction: 4 });
  state = h.manager.sessions.get(sessionPath)!;
  state.nextTaskIntent = 'continue_task';
  const run3 = h.manager.createRunSnapshot(sessionPath, state);
  assert.equal(run3.taskGroupId, 'id-2', 'continue_task reuses last taskGroupId');

  // new_task ⇒ mints a fresh task group id.
  state.currentRun = run3;
  h.manager.finalizeCurrentRun(sessionPath, 'scored', { resolution: 'resolved', satisfaction: 3 });
  state = h.manager.sessions.get(sessionPath)!;
  state.nextTaskIntent = 'new_task';
  const run4 = h.manager.createRunSnapshot(sessionPath, state);
  assert.notEqual(run4.taskGroupId, 'id-2', 'new_task starts a fresh task group');
  assert.ok(run4.taskGroupId, 'new taskGroupId is a non-empty id');
});

test('isoNow reflects the injected clock', () => {
  const h = createHarness();
  h.setNow(Date.UTC(2026, 6, 7, 12, 30, 0));
  assert.equal(h.manager.isoNow(), '2026-07-07T12:30:00.000Z');
});

test('toPersistedSessionState helper agrees with serializeSessions for a single session', () => {
  const h = createHarness();
  const sessionPath = '/workspace/session-rsm.jsonl';
  const run = openRun(h.manager, sessionPath);
  const state = h.manager.sessions.get(sessionPath)!;
  state.queuedUnsupportedInputCount = 4;
  state.nextTaskIntent = 'continue_task';
  state.busyStartedAt = '2026-01-01T00:00:00.000Z';

  const serialized = h.manager.serializeSessions()[sessionPath];
  const helperSerialized = toPersistedSessionState({
    currentRun: state.currentRun,
    lastRun: state.lastRun,
    nextTaskIntent: state.nextTaskIntent,
    queuedUnsupportedInputCount: state.queuedUnsupportedInputCount,
    busyStartedAt: state.busyStartedAt,
  });
  assert.deepEqual(serialized, helperSerialized);
  assert.equal(serialized.currentRun, run, 'serializeSessions keeps the live run object (downstream consumes the same reference)');
});