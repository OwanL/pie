import assert from 'node:assert/strict';
import test from 'node:test';

import { coerceSessionAnalyticsFactors } from '../../../legacy/run-analytics/coercion-factors';
import { coerceFunctionalSettings } from '../../../legacy/run-analytics/coercion-functional-settings';
import { normalizeExperimentAssignment } from '../../../legacy/run-analytics/coercion-snapshots';
import {
  coerceFileExtensionRollup,
  coerceFileMutationRollup,
  coerceToolUsageRollup,
  coerceTreatmentChangeKinds,
  coerceVerificationRollup,
  createEmptyFileExtensionRollup,
  createEmptyFileMutationRollup,
  createEmptyToolUsageRollup,
  createEmptyVerificationRollup,
} from '../../../legacy/run-analytics/coercion-rollups';
import {
  areStringArraysEqual,
  toActiveRunSummary,
} from '../../../../application/backend/analytics-views/helpers';
import { summarizeInputs } from '../../../legacy/stats-service/helpers.js';
import { workspaceHash } from '../../../legacy/privacy-storage.js';
import type { ComposerInput } from '../../../../application/lib/protocol/index.js';
import type { RunSnapshot } from '../../../legacy/run-analytics/types.js';

function makeRunSnapshot(): RunSnapshot {
  return {
    sessionPath: '/workspace/session.jsonl',
    runId: 'run-1',
    taskGroupId: 'task-1',
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
    auxiliaryLlmUsage: [],
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
    fileExtensions: createEmptyFileExtensionRollup(),
    verification: createEmptyVerificationRollup(),
  };
}

test('coerceSessionAnalyticsFactors accepts only supported shapes and values', () => {
  assert.equal(coerceSessionAnalyticsFactors(null), null);
  assert.equal(coerceSessionAnalyticsFactors('invalid'), null);

  const coerced = coerceSessionAnalyticsFactors({
    promptFamily: 'harness+skills',
    promptHash: 123,
    harnessPromptHash: null,
    customPromptHash: 'custom-hash',
    appendSystemPromptHash: undefined,
    promptGuidelineHashes: ['a', 2, 'b'],
    contextFiles: [
      { path: '/repo/AGENTS.md', hash: 'ctx-1' },
      { path: '/repo/EMPTY.md', hash: 1 },
      null,
    ],
    selectedToolIds: ['read', null, 'bash'],
    toolSnippetHashes: [
      { toolId: 'read', hash: 'snippet-1' },
      { toolId: 'edit', hash: 1 },
    ],
    toolSetHash: 'tool-set-hash',
    skills: [
      { name: 'code-review', contentHash: 'content-hash', sourceHash: 7, disableModelInvocation: true, lastModifiedAt: '2026-01-01T00:00:00.000Z' },
      { name: '', contentHash: 'ignored', sourceHash: 'ignored' },
    ],
    skillSetHash: null,
    activeExtensions: ['subagent', 5, 'skill-pruner'],
  });

  assert.deepEqual(coerced, {
    promptFamily: 'harness+skills',
    promptHash: null,
    promptCapturedAt: null,
    harnessPromptHash: null,
    customPromptHash: 'custom-hash',
    appendSystemPromptHash: null,
    promptGuidelineHashes: ['a', 'b'],
    contextFiles: [{ path: '/repo/AGENTS.md', hash: 'ctx-1' }],
    selectedToolIds: ['read', 'bash'],
    toolSnippetHashes: [{ toolId: 'read', hash: 'snippet-1' }],
    toolSetHash: 'tool-set-hash',
    skills: [{
      name: 'code-review',
      contentHash: 'content-hash',
      sourceHash: null,
      disableModelInvocation: true,
      lastModifiedAt: '2026-01-01T00:00:00.000Z',
    }],
    skillSetHash: null,
    activeExtensions: ['subagent', 'skill-pruner'],
  });
});

test('rollup coercers normalize invalid nested records and preserve valid values', () => {
  assert.deepEqual(coerceTreatmentChangeKinds(['model', 'invalid', 'model', 'extensions']), ['model', 'extensions']);

  const toolUsage = coerceToolUsageRollup({
    totalCount: 3.9,
    failureCount: -1,
    executionFailureCount: 2.2,
    verificationProjectFailureCount: 1.1,
    probeFailureCount: 0.4,
    countsByName: { bash: 2.2, read: -1, invalid: 'x' },
    failureCountsByName: { bash: 1.8, edit: null },
    failureCountsByKind: { timeout: 2.6, unknown: 1.2 },
    failureCountsByNameAndKind: {
      bash: { timeout: 1.9, unknown: 0.6 },
      read: 'invalid',
    },
    failureSamples: [
      { toolName: 'bash', failureKind: 'timeout', exitCode: 7.9, errorExcerpt: 9, verificationKinds: ['test', 'bogus'], occurredAt: '2026-01-01T00:00:00.000Z' },
      { toolName: 9, failureKind: 'timeout', occurredAt: '2026-01-01T00:00:00.000Z' },
    ],
    totalDurationMs: 1234.9,
    timedCallCount: 2.6,
    durationMsByName: { bash: 900.7, read: -5, invalid: 'x' },
    subagentCallCount: 1,
    subagentTaskCount: 2,
    subagentAgentNames: ['worker', 3],
  });

  assert.equal(toolUsage.totalCount, 3);
  assert.equal(toolUsage.failureCount, 2);
  assert.equal(toolUsage.executionFailureCount, 2);
  assert.equal(toolUsage.verificationProjectFailureCount, 1);
  assert.equal(toolUsage.probeFailureCount, 0);
  assert.equal(toolUsage.resultIssueCount, 1);
  assert.deepEqual(toolUsage.countsByName, { bash: 2 });
  assert.deepEqual(toolUsage.failureCountsByName, { bash: 1 });
  assert.equal(toolUsage.failureCountsByKind.timeout, 2);
  assert.equal(toolUsage.failureCountsByNameAndKind.bash?.timeout, 1);
  assert.equal(toolUsage.failureSamples.length, 1);
  assert.equal(toolUsage.failureSamples[0]?.exitCode, 7);
  assert.equal(toolUsage.failureSamples[0]?.errorExcerpt, '');
  assert.deepEqual(toolUsage.failureSamples[0]?.verificationKinds, ['test']);
  assert.deepEqual(toolUsage.subagentAgentNames, ['worker']);
  assert.equal(toolUsage.totalDurationMs, 1234);
  assert.equal(toolUsage.timedCallCount, 2);
  assert.deepEqual(toolUsage.durationMsByName, { bash: 900 });
  assert.deepEqual(toolUsage.timedCallCountsByName, {});

  assert.deepEqual(coerceFileMutationRollup({ writeCount: 1.9, editCount: 2.1, deleteCount: 'x', renameCount: -1, touchedFileCount: 3.8, lineAdditions: 4.4, lineDeletions: 5.2, lineModifications: 6.7, readCountsByFile: { aaa: 2.5, bbb: -1 } }), {
    writeCount: 1,
    editCount: 2,
    deleteCount: 0,
    renameCount: 0,
    touchedFileCount: 3,
    lineAdditions: 4,
    lineDeletions: 5,
    lineModifications: 6,
    editCountsByFile: {},
    readCountsByFile: { aaa: 2 },
  });
  assert.deepEqual(coerceFileMutationRollup(null), createEmptyFileMutationRollup());

  assert.deepEqual(coerceFileExtensionRollup({
    readCountsByExtension: { '.ts': 2.4, '.md': -1 },
    writeCountsByExtension: null,
    editCountsByExtension: { '.json': 1.8 },
  }), {
    readCountsByExtension: { '.ts': 2 },
    writeCountsByExtension: {},
    editCountsByExtension: { '.json': 1 },
  });
  assert.deepEqual(coerceFileExtensionRollup(undefined), createEmptyFileExtensionRollup());

  assert.deepEqual(coerceVerificationRollup({
    totalCount: 5.9,
    failureCount: -1,
    countsByKind: { test: 2.2, build: 1.1, lint: -1, typecheck: 3.9 },
  }), {
    totalCount: 5,
    failureCount: 0,
    countsByKind: {
      test: 2,
      build: 1,
      lint: 0,
      typecheck: 3,
      format: 0,
      other: 0,
    },
  });
  assert.deepEqual(coerceVerificationRollup('invalid'), createEmptyVerificationRollup());
});

test('stats-service helpers summarize inputs and utility helpers', () => {
  const run = makeRunSnapshot();
  const inputs: ComposerInput[] = [
    { id: 'file-1', kind: 'filesystemPathRef', path: '/repo/a.ts', name: 'a.ts', source: 'picker' },
    { id: 'image-1', kind: 'imageBlob', mimeType: 'image/png', name: 'diagram.png', sizeBytes: 2048, dataBase64: 'ZmFrZQ==', source: 'paste' },
    { id: 'blob-1', kind: 'fileBlob', mimeType: 'application/pdf', name: 'spec.pdf', sizeBytes: 512, dataBase64: 'ZmFrZQ==', source: 'drop' },
    { id: 'file-2', kind: 'filesystemPathRef', path: '/repo/b.ts', name: 'b.ts', source: 'picker' },
  ];

  summarizeInputs(run, inputs);
  assert.equal(run.filesystemPathRefCount, 2);
  assert.equal(run.imageInputCount, 1);
  assert.equal(run.imageInputBytes, 2048);
  assert.equal(run.unsupportedInputCount, 1);
  assert.deepEqual(run.inputKindsUsed.sort(), ['fileBlob', 'filesystemPathRef', 'imageBlob']);

  assert.equal(workspaceHash('workspace-a'), workspaceHash('workspace-a'));
  assert.notEqual(workspaceHash('workspace-a'), workspaceHash('workspace-b'));

  assert.equal(toActiveRunSummary(null), null);
  assert.deepEqual(toActiveRunSummary(run), { runId: 'run-1', status: 'open' });
  assert.deepEqual(toActiveRunSummary(run, true), { runId: 'run-1', status: 'open', nextSendStartsNewTask: true });

  assert.equal(areStringArraysEqual(undefined, []), true);
  assert.equal(areStringArraysEqual(['a', 'b'], ['a', 'b']), true);
  assert.equal(areStringArraysEqual(['a'], ['b']), false);
  assert.equal(areStringArraysEqual(['a'], ['a', 'b']), false);
});

test('coerceFunctionalSettings accepts valid snapshots and drops malformed ones', () => {
  assert.equal(coerceFunctionalSettings(null), null);
  assert.equal(coerceFunctionalSettings('invalid'), null);
  assert.equal(coerceFunctionalSettings({ subagentAlwaysParentModel: true }), null); // missing pruningMode
  assert.equal(coerceFunctionalSettings({ pruningMode: 'bogus' }), null); // invalid pruningMode

  const coerced = coerceFunctionalSettings({
    subagentAlwaysParentModel: 'truthy',
    pruningMode: 'shadow',
    extensionToggles: { subagent: true, safeguard: 'no', cwd: false },
    toolResultPruningEnabled: true,
    toolResultPruningProfile: 'security',
  });
  assert.deepEqual(coerced, {
    subagentAlwaysParentModel: false,
    pruningMode: 'shadow',
    extensionToggles: { subagent: true, cwd: false },
    toolResultPruningEnabled: true,
    toolResultPruningProfile: 'security',
  });
});

test('coerceFunctionalSettings defaults tool-result-pruning fields to null when absent or invalid', () => {
  const coerced = coerceFunctionalSettings({
    pruningMode: 'auto',
    toolResultPruningEnabled: 'truthy',
    toolResultPruningProfile: 'bogus',
  });
  assert.deepEqual(coerced, {
    subagentAlwaysParentModel: false,
    pruningMode: 'auto',
    extensionToggles: {},
    toolResultPruningEnabled: null,
    toolResultPruningProfile: null,
  });
});

test('coerceToolUsageRollup preserves per-tool timed call counts and unknown critical-path coverage', () => {
  const toolUsage = coerceToolUsageRollup({
    totalCount: 3,
    totalDurationMs: 1200,
    timedCallCount: 2,
    durationMsByName: { bash: 500, read: 700 },
    timedCallCountsByName: { bash: 1, read: 1, edit: 0, invalid: 'x' },
  } as unknown as Parameters<typeof coerceToolUsageRollup>[0]);
  assert.deepEqual(toolUsage.timedCallCountsByName, { bash: 1, read: 1, edit: 0 });
  assert.equal(toolUsage.criticalPathDurationMs, undefined);

  const measured = coerceToolUsageRollup({
    totalCount: 1,
    totalDurationMs: 0,
    criticalPathDurationMs: 0,
    timedCallCount: 1,
  } as unknown as Parameters<typeof coerceToolUsageRollup>[0]);
  assert.equal(measured.criticalPathDurationMs, 0, 'an explicit measured zero remains distinct from legacy absence');
});

test('coerceToolUsageRollup preserves verification-pending result issues without failure counters', () => {
  const toolUsage = coerceToolUsageRollup({
    failureCount: 0,
    executionFailureCount: 0,
    verificationProjectFailureCount: 0,
    probeFailureCount: 0,
    resultIssueCount: 1,
    resultIssueCountsByKind: { verification_pending: 1 },
    resultIssueCountsByName: { bash: 1 },
    resultIssueCountsByNameAndKind: { bash: { verification_pending: 1 } },
    resultIssueSamples: [{
      toolName: 'bash',
      resultIssueKind: 'verification_pending',
      exitCode: 8,
      errorExcerpt: '',
      verificationKinds: ['other'],
      occurredAt: '2026-01-03T00:00:00.000Z',
    }],
  });

  assert.equal(toolUsage.failureCount, 0);
  assert.equal(toolUsage.executionFailureCount, 0);
  assert.equal(toolUsage.verificationProjectFailureCount, 0);
  assert.equal(toolUsage.probeFailureCount, 0);
  assert.equal(toolUsage.resultIssueCount, 1);
  assert.equal(toolUsage.resultIssueCountsByKind.verification_pending, 1);
  assert.equal(toolUsage.resultIssueCountsByNameAndKind.bash?.verification_pending, 1);
  assert.equal(toolUsage.resultIssueSamples[0]?.resultIssueKind, 'verification_pending');
});

test('coerceToolUsageRollup remaps legacy failure kinds into result-issue rollups', () => {
  // Pre-split data: verification_project_failure and probe_no_match were counted
  // under the failure rollups, and no resultIssue* fields existed.
  const legacy = {
    totalCount: 5,
    failureCount: 4,
    executionFailureCount: 2,
    verificationProjectFailureCount: 1,
    probeFailureCount: 1,
    countsByName: { bash: 3, read: 2 },
    failureCountsByName: { bash: 3, read: 1 },
    failureCountsByKind: {
      timeout: 1,
      nonzero_exit: 1,
      verification_project_failure: 1,
      probe_no_match: 1,
    },
    failureCountsByNameAndKind: {
      bash: { timeout: 1, verification_project_failure: 1, probe_no_match: 1 },
      read: { nonzero_exit: 1 },
    },
    failureSamples: [
      { toolName: 'bash', failureKind: 'timeout', exitCode: 124, errorExcerpt: 'timed out', verificationKinds: [], occurredAt: '2026-01-01T00:00:00.000Z' },
      { toolName: 'bash', failureKind: 'verification_project_failure', exitCode: 1, errorExcerpt: 'tests failed', verificationKinds: ['test'], occurredAt: '2026-01-02T00:00:00.000Z' },
      { toolName: 'bash', failureKind: 'probe_no_match', exitCode: 1, errorExcerpt: '', verificationKinds: [], occurredAt: '2026-01-03T00:00:00.000Z' },
    ],
  } as unknown as Parameters<typeof coerceToolUsageRollup>[0];

  const toolUsage = coerceToolUsageRollup(legacy);

  // Execution-only failure counts (verification/probe no longer counted as failures).
  assert.equal(toolUsage.failureCount, 2);
  assert.equal(toolUsage.executionFailureCount, 2);
  assert.equal(toolUsage.verificationProjectFailureCount, 1);
  assert.equal(toolUsage.probeFailureCount, 1);
  assert.equal(toolUsage.resultIssueCount, 2);

  // Legacy kinds removed from the failure by-kind rollup...
  assert.equal(toolUsage.failureCountsByKind.timeout, 1);
  assert.equal(toolUsage.failureCountsByKind.nonzero_exit, 1);
  assert.equal(('verification_project_failure' in toolUsage.failureCountsByKind), false);
  assert.equal(('probe_no_match' in toolUsage.failureCountsByKind), false);

  // ...and remapped into the result-issue by-kind rollup.
  assert.equal(toolUsage.resultIssueCountsByKind.verification_failure, 1);
  assert.equal(toolUsage.resultIssueCountsByKind.probe_no_match, 1);

  // Per-tool split: bash keeps execution kinds, gains result-issue kinds.
  assert.equal(toolUsage.failureCountsByNameAndKind.bash?.timeout, 1);
  // bash's embedded legacy result-issue counts (1 + 1) are subtracted from
  // failureCountsByName (3 -> 1) to keep the per-tool totals execution-only.
  assert.deepEqual(toolUsage.failureCountsByName, { bash: 1, read: 1 });
  assert.equal(('verification_project_failure' in (toolUsage.failureCountsByNameAndKind.bash ?? {})), false);
  assert.equal(toolUsage.resultIssueCountsByNameAndKind.bash?.verification_failure, 1);
  assert.equal(toolUsage.resultIssueCountsByNameAndKind.bash?.probe_no_match, 1);

  // Samples split: execution sample stays; verification/probe move to result-issue samples.
  assert.equal(toolUsage.failureSamples.length, 1);
  assert.equal(toolUsage.failureSamples[0]?.failureKind, 'timeout');
  assert.equal(toolUsage.resultIssueSamples.length, 2);
  assert.equal(toolUsage.resultIssueSamples[0]?.resultIssueKind, 'verification_failure');
  assert.deepEqual(toolUsage.resultIssueSamples[0]?.verificationKinds, ['test']);
  assert.equal(toolUsage.resultIssueSamples[1]?.resultIssueKind, 'probe_no_match');
});

test('normalizeExperimentAssignment trims assignments and normalizes empty values', () => {
  assert.equal(normalizeExperimentAssignment(undefined), null);
  assert.equal(normalizeExperimentAssignment(null), null);
  assert.equal(normalizeExperimentAssignment(''), null);
  assert.equal(normalizeExperimentAssignment(' \t\n '), null);
  assert.equal(normalizeExperimentAssignment('  experiment-a  '), 'experiment-a');
  assert.equal(normalizeExperimentAssignment('experiment a'), 'experiment a');
});
