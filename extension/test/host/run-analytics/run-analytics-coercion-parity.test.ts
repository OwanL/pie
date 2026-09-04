import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * Coercion parity matrix.
 *
 * `analysis/scripts/source.ts` carries a deliberate "thin duplicate" of the
 * extension's run-analytics coercion (`extension/src/host/run-analytics/`),
 * duplicated across packages to avoid cross-package import complexity. The
 * source.ts header demands the two stay synchronized. This matrix feeds the
 * same edge-case run snapshots through BOTH `coerceRunSnapshot` implementations
 * and asserts they produce identical coerced outputs, so silent drift between
 * the duplicates is caught.
 *
 * The two implementations have one known, pre-existing divergence (documented
 * in the "known divergences" test below): the extension defaults
 * `providerQueueAttemptCount` to 0 instead of omitting it. The matrix avoids it
 * by construction so all shared coercion logic is compared directly.
 */

import { coerceRunSnapshot as extensionCoerce } from '../../../src/host/run-analytics/coercion-snapshots';
import { MAX_USER_INPUT_SAMPLE_CHARS } from '../../../src/host/run-analytics';
import { coerceRunSnapshot as analysisCoerce } from '../../../../analysis/scripts/source.ts';

type AnySnapshot = Record<string, unknown>;

/** Persisted JSON does not distinguish an absent key from an undefined key. */
function normalizeForParity<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validBase(): AnySnapshot {
  return {
    sessionPath: '/workspace/session.jsonl',
    runId: 'run-1',
    taskGroupId: 'task-group-1',
    status: 'closed',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:10:00.000Z',
    mixedModelConfig: false,
    sendCount: 1,
    assistantTurnCount: 1,
    assistantTurnDurationMs: 1000,
    interruptedCount: 0,
    messageEditCount: 0,
    truncatedAfterCount: 0,
    filesystemPathRefCount: 2,
    imageInputCount: 0,
    imageInputBytes: 0,
    unsupportedInputCount: 0,
    backendErrorCodes: [],
    inputKindsUsed: ['filesystemPathRef'],
  };
}

const EMPTY_TOOL_USAGE = {
  totalCount: 0, failureCount: 0, executionFailureCount: 0,
  verificationProjectFailureCount: 0, probeFailureCount: 0, resultIssueCount: 0,
  countsByName: {}, failureCountsByName: {}, failureCountsByKind: {},
  failureCountsByNameAndKind: {}, failureSamples: [],
  resultIssueCountsByName: {}, resultIssueCountsByKind: {},
  resultIssueCountsByNameAndKind: {}, resultIssueSamples: [],
  totalDurationMs: 0, timedCallCount: 0, durationMsByName: {}, timedCallCountsByName: {},
  subagentCallCount: 0, subagentTaskCount: 0, subagentAgentNames: [],
  subagentInputTokens: 0, subagentOutputTokens: 0,
  subagentCacheReadTokens: 0, subagentCacheWriteTokens: 0,
};

const EMPTY_FILE_MUTATION = {
  writeCount: 0, editCount: 0, deleteCount: 0, renameCount: 0,
  touchedFileCount: 0, lineAdditions: 0, lineDeletions: 0, lineModifications: 0,
  editCountsByFile: {}, readCountsByFile: {},
};

const EMPTY_FILE_EXTENSIONS = {
  readCountsByExtension: {}, writeCountsByExtension: {}, editCountsByExtension: {},
};

const EMPTY_VERIFICATION = { totalCount: 0, failureCount: 0, countsByKind: {} };

/** Each case exercises a distinct coercion path; all avoid the known divergences. */
const EDGE_CASES: Array<{ name: string; snapshot: AnySnapshot }> = [
  {
    name: 'minimal valid snapshot with empty rollups',
    snapshot: {
      ...validBase(),
      toolUsage: EMPTY_TOOL_USAGE,
      fileMutation: EMPTY_FILE_MUTATION,
      fileExtensions: EMPTY_FILE_EXTENSIONS,
      verification: EMPTY_VERIFICATION,
    },
  },
  {
    name: 'all optional fields present with valid values',
    snapshot: {
      ...validBase(),
      status: 'open',
      finalizedAt: '2026-01-01T00:05:00.000Z',
      finalizationReason: 'new_task',
      modelId: 'gpt-4.1',
      provider: 'openai',
      thinkingLevel: 'high',
      mixedTreatmentConfig: true,
      treatmentChangeKinds: ['model', 'thinking', 'model'],
      experimentAssignment: 'treatment-a',
      harnessRevision: 'pie-harness-2026-08',
      harnessFingerprint: 'a3f9c1e7b2d84650a3f9c1e7b2d84650a3f9c1e7b2d84650a3f9c1e7b2d84650',
      contextTokens: 12000,
      contextLimit: 200000,
      initialUserMessageChars: 142,
      userInputCharSamples: [
        { occurredAt: '2026-01-01T00:00:00.000Z', chars: 142 },
        { occurredAt: '2026-01-01T00:02:00.000Z', chars: 3 },
        { occurredAt: '2026-01-01T00:04:00.000Z', chars: 17 },
      ],
      initialUserMessageTokens: 41,
      askUserAnsweredCount: 2,
      askUserCancelledCount: 1,
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      tokenReportedTurnCount: 2,
      busyDurationMs: 5000,
      busyPeriodCount: 1,
      compactionCount: 0,
      autoRetryCount: 1,
      toolUsage: EMPTY_TOOL_USAGE,
      fileMutation: EMPTY_FILE_MUTATION,
      fileExtensions: EMPTY_FILE_EXTENSIONS,
      verification: EMPTY_VERIFICATION,
    },
  },
  {
    name: 'user-input character samples drop malformed entries while preserving tracking presence',
    snapshot: {
      ...validBase(),
      userInputCharSamples: [
        { occurredAt: '2026-01-01T00:00:00.000Z', chars: 10 },
        { occurredAt: 'invalid', chars: 8 },
        { occurredAt: '2026-01-01T00:01:00.000Z', chars: -1 },
        { occurredAt: '2026-01-01T00:02:00.000Z', chars: 2.9 },
        { occurredAt: '2026-01-01T00:03:00.000Z', chars: null },
        { occurredAt: '2026-01-01T00:04:00.000Z', chars: Number.POSITIVE_INFINITY },
        { occurredAt: '2026-01-01T00:05:00.000Z', chars: MAX_USER_INPUT_SAMPLE_CHARS + 1 },
      ],
      toolUsage: EMPTY_TOOL_USAGE,
      fileMutation: EMPTY_FILE_MUTATION,
      fileExtensions: EMPTY_FILE_EXTENSIONS,
      verification: EMPTY_VERIFICATION,
    },
  },
  {
    name: 'decimal counters truncate identically (Math.trunc parity)',
    snapshot: {
      ...validBase(),
      sendCount: 3.9,
      assistantTurnCount: 2.7,
      assistantTurnDurationMs: 1234.9,
      interruptedCount: 1.5,
      messageEditCount: 2.1,
      truncatedAfterCount: 0.8,
      filesystemPathRefCount: 4.6,
      imageInputCount: 1.2,
      imageInputBytes: 2048.9,
      unsupportedInputCount: 0.4,
      busyDurationMs: 5000.5,
      busyPeriodCount: 1.9,
      compactionCount: 2.2,
      autoRetryCount: 1.8,
      inputTokens: 100.9,
      outputTokens: 200.1,
      toolUsage: { ...EMPTY_TOOL_USAGE, totalCount: 7.9, totalDurationMs: 1234.9, timedCallCount: 2.6 },
      fileMutation: EMPTY_FILE_MUTATION,
      fileExtensions: EMPTY_FILE_EXTENSIONS,
      verification: EMPTY_VERIFICATION,
    },
  },
  {
    name: 'legacy failure kinds split in aggregate and samples',
    snapshot: {
      ...validBase(),
      toolUsage: {
        ...EMPTY_TOOL_USAGE,
        totalCount: 5,
        failureCount: 2,
        executionFailureCount: 2,
        // Aggregate by-kind carries legacy kinds → both split into execution/result-issue.
        failureCountsByKind: { timeout: 1, nonzero_exit: 1, verification_project_failure: 1, probe_no_match: 1 },
        // Per-tool by-name-and-kind uses ONLY execution kinds here; the legacy
        // per-tool split (with its failureCountsByName recomputation) is covered
        // by its own edge case below.
        failureCountsByNameAndKind: { bash: { timeout: 1 }, read: { nonzero_exit: 1 } },
        failureCountsByName: { bash: 1, read: 1 },
        // Samples carrying legacy kinds → both split into result-issue samples.
        failureSamples: [
          { toolName: 'bash', failureKind: 'timeout', exitCode: 124, errorExcerpt: 'timed out', verificationKinds: [], occurredAt: '2026-01-01T00:00:00.000Z' },
          { toolName: 'bash', failureKind: 'verification_project_failure', exitCode: 1, errorExcerpt: 'tests failed', verificationKinds: ['test'], occurredAt: '2026-01-02T00:00:00.000Z' },
          { toolName: 'bash', failureKind: 'probe_no_match', exitCode: 1, errorExcerpt: '', verificationKinds: [], occurredAt: '2026-01-03T00:00:00.000Z' },
        ],
      },
      fileMutation: EMPTY_FILE_MUTATION,
      fileExtensions: EMPTY_FILE_EXTENSIONS,
      verification: EMPTY_VERIFICATION,
    },
  },
  {
    name: 'new-format explicit result-issue rollups',
    snapshot: {
      ...validBase(),
      toolUsage: {
        ...EMPTY_TOOL_USAGE,
        totalCount: 6,
        failureCount: 2,
        executionFailureCount: 2,
        resultIssueCount: 2,
        verificationProjectFailureCount: 1,
        probeFailureCount: 1,
        countsByName: { bash: 4, read: 2 },
        failureCountsByName: { bash: 1, read: 1 },
        failureCountsByKind: { timeout: 1, nonzero_exit: 1 },
        failureCountsByNameAndKind: { bash: { timeout: 1 }, read: { nonzero_exit: 1 } },
        resultIssueCountsByKind: { verification_failure: 1, probe_no_match: 1 },
        resultIssueCountsByName: { bash: 2 },
        resultIssueCountsByNameAndKind: { bash: { verification_failure: 1, probe_no_match: 1 } },
        resultIssueSamples: [
          { toolName: 'bash', resultIssueKind: 'verification_failure', exitCode: 1, errorExcerpt: 'fail', verificationKinds: ['test'], occurredAt: '2026-01-01T00:00:00.000Z' },
        ],
        failureSamples: [
          { toolName: 'bash', failureKind: 'timeout', exitCode: 124, errorExcerpt: 'timed out', verificationKinds: [], occurredAt: '2026-01-02T00:00:00.000Z' },
        ],
      },
      fileMutation: EMPTY_FILE_MUTATION,
      fileExtensions: EMPTY_FILE_EXTENSIONS,
      verification: EMPTY_VERIFICATION,
    },
  },
  {
    name: 'legacy per-tool result-issue kinds recompute failureCountsByName',
    snapshot: {
      ...validBase(),
      toolUsage: {
        ...EMPTY_TOOL_USAGE,
        failureCountsByName: { bash: 3 },
        // Legacy data embedded result issues under failureCountsByName; both
        // implementations must subtract the 2 result-issue counts attributed
        // to bash (3 -> 1) when splitting by-name-and-kind.
        failureCountsByNameAndKind: { bash: { timeout: 1, verification_project_failure: 1, probe_no_match: 1 } },
      },
      fileMutation: EMPTY_FILE_MUTATION,
      fileExtensions: EMPTY_FILE_EXTENSIONS,
      verification: EMPTY_VERIFICATION,
    },
  },
  {
    name: 'analyticsFactors with null hashes and mixed-type arrays',
    snapshot: {
      ...validBase(),
      analyticsFactors: {
        promptFamily: 'harness+custom',
        promptHash: null,
        promptCapturedAt: null,
        harnessPromptHash: 'hp',
        customPromptHash: undefined,
        appendSystemPromptHash: 'as',
        promptGuidelineHashes: ['a', 2, 'b', null],
        contextFiles: [{ path: '/a.md', hash: 'h1' }, { path: '', hash: 'x' }, { path: '/b.md', hash: 1 }],
        selectedToolIds: ['read', null, 'bash'],
        toolSnippetHashes: [{ toolId: 'read', hash: 's1' }, { toolId: 'edit', hash: 1 }],
        toolSetHash: 'tsh',
        skills: [{ name: 'code-review', contentHash: 'ch', sourceHash: 7, disableModelInvocation: true, lastModifiedAt: '2026-01-01T00:00:00.000Z' }, { name: '' }],
        skillSetHash: null,
        activeExtensions: ['subagent', 5, 'skill-pruner'],
      },
      toolUsage: EMPTY_TOOL_USAGE,
      fileMutation: EMPTY_FILE_MUTATION,
      fileExtensions: EMPTY_FILE_EXTENSIONS,
      verification: EMPTY_VERIFICATION,
    },
  },
  {
    name: 'functionalSettings with toggles and pruning profile',
    snapshot: {
      ...validBase(),
      functionalSettings: {
        subagentAlwaysParentModel: 'truthy',
        pruningMode: 'shadow',
        extensionToggles: { subagent: true, safeguard: 'no', cwd: false },
        toolResultPruningEnabled: true,
        toolResultPruningProfile: 'security',
      },
      toolUsage: EMPTY_TOOL_USAGE,
      fileMutation: EMPTY_FILE_MUTATION,
      fileExtensions: EMPTY_FILE_EXTENSIONS,
      verification: EMPTY_VERIFICATION,
    },
  },
  {
    name: 'throughput samples with explicit queue-attempt counts and latencies',
    snapshot: {
      ...validBase(),
      turnThroughputSamples: [
        { endedAt: '2026-01-01T00:00:00.000Z', outputTokens: 10, generationDurationMs: 500, concurrentBusySessions: 1, status: 'completed', turnLatencyMs: 800, overheadMs: 100, providerLatencyMs: 700, providerQueueMs: 0, providerQueueAttemptCount: 1, provider: 'openai' },
        { endedAt: '2026-01-01T00:00:01.000Z', outputTokens: 4, generationDurationMs: 200, concurrentBusySessions: 1, status: 'completed', turnLatencyMs: 400, overheadMs: 50, providerLatencyMs: 350, providerQueueMs: 10, providerQueueAttemptCount: 2 },
        { endedAt: '2026-01-01T00:00:02.000Z', outputTokens: 0, generationDurationMs: 0, concurrentBusySessions: 1, status: 'error', providerQueueAttemptCount: 0 },
      ],
      toolUsage: EMPTY_TOOL_USAGE,
      fileMutation: EMPTY_FILE_MUTATION,
      fileExtensions: EMPTY_FILE_EXTENSIONS,
      verification: EMPTY_VERIFICATION,
    },
  },
  {
    name: 'auxiliary LLM usage with and without provider',
    snapshot: {
      ...validBase(),
      auxiliaryLlmUsage: [
        { kind: 'skill_pruning_prepass', sourceId: 'p1', occurredAt: '2026-01-01T00:00:00.000Z', modelId: 'openai/pruner', provider: 'openai', inputTokens: 100, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4, durationMs: 250, reportedCostUsd: 0.001 },
        // Surviving sample without provider/modelId — exercises the provider-key divergence.
        { kind: 'subagent', sourceId: 'sub-1', occurredAt: '2026-01-02T00:00:00.000Z', inputTokens: 40, outputTokens: 12, cacheReadTokens: 1, cacheWriteTokens: 0 },
        { kind: 'unknown', sourceId: 'dropped', occurredAt: '2026-01-03T00:00:00.000Z' },
      ],
      toolUsage: EMPTY_TOOL_USAGE,
      fileMutation: EMPTY_FILE_MUTATION,
      fileExtensions: EMPTY_FILE_EXTENSIONS,
      verification: EMPTY_VERIFICATION,
    },
  },
  {
    name: 'null analyticsFactors and null functionalSettings',
    snapshot: {
      ...validBase(),
      analyticsFactors: null,
      functionalSettings: null,
      toolUsage: EMPTY_TOOL_USAGE,
      fileMutation: EMPTY_FILE_MUTATION,
      fileExtensions: EMPTY_FILE_EXTENSIONS,
      verification: EMPTY_VERIFICATION,
    },
  },
];

test('coercion parity matrix: both implementations produce identical coerced snapshots', () => {
  for (const { name, snapshot } of EDGE_CASES) {
    const analysis = analysisCoerce(snapshot);
    const extension = extensionCoerce(snapshot);
    assert.ok(analysis, `${name}: analysis coerced to null`);
    assert.ok(extension, `${name}: extension coerced to null`);
    assert.deepEqual(
      normalizeForParity(analysis),
      normalizeForParity(extension),
      `${name}: coerced outputs diverged`,
    );
  }
});

test('both implementations reject the same malformed identity fields with null', () => {
  // Only the identity fields (sessionPath/runId/taskGroupId/status/startedAt/
  // updatedAt) are validated identically by both. The extension additionally
  // type-checks counters/arrays and rejects mismatches; the analysis leniently
  // coerces them (documented below).
  for (const malformed of [
    { ...validBase(), status: 'scored' },
    { ...validBase(), sessionPath: 123 },
    { ...validBase(), runId: null },
    { ...validBase(), taskGroupId: undefined },
    { ...validBase(), startedAt: null },
    { ...validBase(), updatedAt: 42 },
  ]) {
    assert.equal(analysisCoerce(malformed), null, 'analysis should reject malformed identity');
    assert.equal(extensionCoerce(malformed), null, 'extension should reject malformed identity');
  }
});

test('analysis is lenient where the extension is strict (counter/array coercion divergence)', () => {
  // The extension type-checks counters/arrays and returns null on mismatch;
  // the analysis coerces them defensively. Both are pre-existing behaviors.
  assert.notEqual(analysisCoerce({ ...validBase(), sendCount: 'bad' }), null);
  assert.equal(extensionCoerce({ ...validBase(), sendCount: 'bad' }), null);
  assert.notEqual(analysisCoerce({ ...validBase(), backendErrorCodes: 'not-array' }), null);
  assert.equal(extensionCoerce({ ...validBase(), backendErrorCodes: 'not-array' }), null);
});

test('known divergences are pinned (fail loudly if either side is changed without the other)', () => {
  // providerQueueAttemptCount: extension defaults to 0; analysis omits the key.
  // (The legacy per-tool failureCountsByName recomputation divergence was fixed:
  // both implementations now subtract, covered by the parity matrix above.)
  const noQueueAttempt = {
    ...validBase(),
    turnThroughputSamples: [{ endedAt: '2026-01-01T00:00:00.000Z', outputTokens: 5, generationDurationMs: 100, concurrentBusySessions: 1, status: 'completed' }],
  };
  const aSample = analysisCoerce(noQueueAttempt)!.turnThroughputSamples[0]!;
  const eSample = extensionCoerce(noQueueAttempt)!.turnThroughputSamples[0]!;
  assert.ok(!('providerQueueAttemptCount' in aSample), 'analysis omits providerQueueAttemptCount when absent');
  assert.equal(eSample.providerQueueAttemptCount, 0, 'extension defaults providerQueueAttemptCount to 0');
});
