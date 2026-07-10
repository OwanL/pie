/**
 * Source analytics loader & coercer (pie-analysis standalone CLI).
 *
 * The run-analytics coercion logic in this file (the schema `*_KINDS`
 * constants, `LEGACY_RESULT_ISSUE_KIND_MAP`, the legacy failure/sample split
 * helpers, and `coerceToolUsageRollup` with its empty-rollup builders) is a thin
 * duplicate of `extension/src/host/run-analytics/coercion-rollups.ts`
 * (pie extension) to avoid cross-package import complexity. Keep those
 * schema-defining coercion blocks synchronized.
 */

import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseJsonOrThrow } from '../../shared/error-message.js';
import { listStorageDirCandidates } from './source-auto.ts';

import {
  RUN_ANALYTICS_SCHEMA_VERSION,
  type AgentReviewSourceEvent,
  type AssistantUsage,
  type FileExtensionRollup,
  type FileMutationRollup,
  type FunctionalSettingsSnapshot,
  type InputKind,
  type LoadedSourceAnalytics,
  type OutcomeHistoryLogEntry,
  type PruningMode,
  type PruningSourceDecision,
  type PruningSourceEvent,
  type ToolResultPruningSourceEvent,
  type WarmBashRewriteSourceEvent,
  type WarmBashSessionSummarySourceEvent,
  type RunFinalizationReason,
  type RunOutcome,
  type RunSnapshot,
  type SessionAnalyticsFactors,
  type SourceAnalyticsPayload,
  type ThinkingLevel,
  type ToolFailureKind,
  type ToolFailureSample,
  type ToolResultIssueKind,
  type ToolResultIssueSample,
  type ToolUsageRollup,
  type TreatmentChangeKind,
  type TurnThroughputSample,
  type TurnThroughputStatus,
  type VerificationCommandKind,
  type VerificationRollup,
} from './contracts.ts';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

export const DEFAULT_FIXTURE_PATH = fileURLToPath(new URL('../fixtures/small-run-analytics.json', import.meta.url));
export const DEFAULT_SITE_DATA_DIR = fileURLToPath(new URL('../site/data', import.meta.url));
export const DEFAULT_DUCKDB_PATH = fileURLToPath(new URL('../data/usage.duckdb', import.meta.url));
export const DEFAULT_STAGING_EXPORTS_DIR = fileURLToPath(new URL('../data/exports', import.meta.url));
export const DEFAULT_OUTCOMES_ROOT = path.join(CONFIG_ROOT, 'data', 'outcomes');

const INPUT_KINDS = new Set<InputKind>(['filesystemPathRef', 'imageBlob', 'fileBlob']);
const THINKING_LEVELS = new Set<ThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const PRUNING_MODES = new Set<PruningMode>(['auto', 'shadow', 'off', 'custom']);
const FINALIZATION_REASONS = new Set<RunFinalizationReason>(['scored', 'closed_unscored', 'new_task']);
const TREATMENT_CHANGE_KINDS = new Set<TreatmentChangeKind>([
  'model',
  'thinking',
  'prompt',
  'toolSelection',
  'skills',
  'experimentAssignment',
  'extensions',
]);
const VERIFICATION_COMMAND_KINDS: VerificationCommandKind[] = [
  'test',
  'build',
  'lint',
  'typecheck',
  'format',
  'other',
];
const TOOL_FAILURE_KINDS: ToolFailureKind[] = [
  'unavailable_tool',
  'invalid_tool_arguments',
  'missing_file_or_path',
  'shell_command_error',
  'timeout',
  'nonzero_exit',
  'unknown',
];

const TOOL_RESULT_ISSUE_KINDS: ToolResultIssueKind[] = ['verification_failure', 'probe_no_match'];

/**
 * Legacy failure-kind names (pre-split) that are now classified as non-success
 * results rather than tool failures, mapped to their new `ToolResultIssueKind`.
 * Used to remap historical run-analytics data on read so old dashboards stay
 * consistent with the execution-only failure semantics.
 */
const LEGACY_RESULT_ISSUE_KIND_MAP: Record<string, ToolResultIssueKind> = {
  verification_project_failure: 'verification_failure',
  probe_no_match: 'probe_no_match',
};

export interface SourceSelection {
  exportPath?: string;
  storageDir?: string;
  /**
   * Aggregate every run store found under this directory. When omitted (and no
   * exportPath/storageDir is given), defaults to {@link DEFAULT_OUTCOMES_ROOT}.
   */
  outcomesRoot?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toNonNegativeInteger(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function toNullableNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.trunc(value);
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function coerceOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function coerceNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function coerceCountRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
      result[key] = Math.trunc(count);
    }
  }
  return result;
}

function coerceSubagentTaskScores(value: unknown): ToolUsageRollup['subagentTaskScores'] {
  if (!isRecord(value)) {
    return {
      precision:    { sum: 0, count: 0, max: 0 },
      creativity:   { sum: 0, count: 0, max: 0 },
      reasoning:    { sum: 0, count: 0, max: 0 },
      thoroughness: { sum: 0, count: 0, max: 0 },
    };
  }

  const coerceDim = (dim: unknown): { sum: number; count: number; max: number } => {
    if (!isRecord(dim)) return { sum: 0, count: 0, max: 0 };
    return {
      sum:   toNonNegativeInteger(dim.sum),
      count: toNonNegativeInteger(dim.count),
      max:   toNonNegativeInteger(dim.max),
    };
  };

  return {
    precision:    coerceDim(value.precision),
    creativity:   coerceDim(value.creativity),
    reasoning:    coerceDim(value.reasoning),
    thoroughness: coerceDim(value.thoroughness),
  };
}

function createEmptyToolUsageRollup(): ToolUsageRollup {
  return {
    totalCount: 0,
    failureCount: 0,
    executionFailureCount: 0,
    verificationProjectFailureCount: 0,
    probeFailureCount: 0,
    resultIssueCount: 0,
    countsByName: {},
    failureCountsByName: {},
    failureCountsByKind: createEmptyToolFailureKindRecord(),
    failureCountsByNameAndKind: {},
    failureSamples: [],
    resultIssueCountsByName: {},
    resultIssueCountsByKind: createEmptyToolResultIssueKindRecord(),
    resultIssueCountsByNameAndKind: {},
    resultIssueSamples: [],
    totalDurationMs: 0,
    timedCallCount: 0,
    durationMsByName: {},
    subagentCallCount: 0,
    subagentTaskCount: 0,
    subagentAgentNames: [],
    subagentScoredTaskCount: 0,
    subagentTaskScores: {
      precision:    { sum: 0, count: 0, max: 0 },
      creativity:   { sum: 0, count: 0, max: 0 },
      reasoning:    { sum: 0, count: 0, max: 0 },
      thoroughness: { sum: 0, count: 0, max: 0 },
    },
    subagentInputTokens: 0,
    subagentOutputTokens: 0,
    subagentCacheReadTokens: 0,
    subagentCacheWriteTokens: 0,
  };
}

function createEmptyFileMutationRollup(): FileMutationRollup {
  return {
    writeCount: 0,
    editCount: 0,
    deleteCount: 0,
    renameCount: 0,
    touchedFileCount: 0,
    lineAdditions: 0,
    lineDeletions: 0,
    lineModifications: 0,
    editCountsByFile: {},
    readCountsByFile: {},
  };
}

function createEmptyFileExtensionRollup(): FileExtensionRollup {
  return {
    readCountsByExtension: {},
    writeCountsByExtension: {},
    editCountsByExtension: {},
  };
}

function coerceExtensionCountRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, count]) => typeof count === 'number' && Number.isFinite(count) && count >= 0)
      .map(([ext, count]) => [ext, Math.trunc(count as number)]),
  );
}

function coerceFileExtensionRollup(value: unknown): FileExtensionRollup {
  if (!isRecord(value)) {
    return createEmptyFileExtensionRollup();
  }

  return {
    readCountsByExtension: coerceExtensionCountRecord(value.readCountsByExtension),
    writeCountsByExtension: coerceExtensionCountRecord(value.writeCountsByExtension),
    editCountsByExtension: coerceExtensionCountRecord(value.editCountsByExtension),
  };
}

function createEmptyVerificationRollup(): VerificationRollup {
  return {
    totalCount: 0,
    failureCount: 0,
    countsByKind: {
      test: 0,
      build: 0,
      lint: 0,
      typecheck: 0,
      format: 0,
      other: 0,
    },
  };
}

function createEmptyToolFailureKindRecord(): Record<ToolFailureKind, number> {
  return {
    unavailable_tool: 0,
    invalid_tool_arguments: 0,
    missing_file_or_path: 0,
    shell_command_error: 0,
    timeout: 0,
    nonzero_exit: 0,
    unknown: 0,
  };
}

function createEmptyToolResultIssueKindRecord(): Record<ToolResultIssueKind, number> {
  return {
    verification_failure: 0,
    probe_no_match: 0,
  };
}

/**
 * Split a raw by-kind failure record into execution failures and non-success
 * results. Handles both new-format data (execution kinds only) and legacy data
 * (which also embedded `verification_project_failure` / `probe_no_match`).
 * Legacy result-issue kinds are remapped to their new `ToolResultIssueKind`.
 */
interface SplitFailureKinds {
  execution: Record<ToolFailureKind, number>;
  resultIssue: Record<ToolResultIssueKind, number>;
  executionTotal: number;
  verificationTotal: number;
  probeTotal: number;
}

function splitRawFailureKindRecord(value: unknown): SplitFailureKinds {
  const execution = createEmptyToolFailureKindRecord();
  const resultIssue = createEmptyToolResultIssueKindRecord();
  let executionTotal = 0;
  let verificationTotal = 0;
  let probeTotal = 0;
  if (!isRecord(value)) {
    return { execution, resultIssue, executionTotal, verificationTotal, probeTotal };
  }
  for (const [kind, rawCount] of Object.entries(value)) {
    if (typeof rawCount !== 'number' || !Number.isFinite(rawCount) || rawCount < 0) {
      continue;
    }
    const count = Math.trunc(rawCount);
    if ((TOOL_FAILURE_KINDS as string[]).includes(kind)) {
      execution[kind as ToolFailureKind] = count;
      executionTotal += count;
    } else if (kind in LEGACY_RESULT_ISSUE_KIND_MAP) {
      const mapped = LEGACY_RESULT_ISSUE_KIND_MAP[kind]!;
      resultIssue[mapped] += count;
      if (mapped === 'verification_failure') {
        verificationTotal += count;
      } else {
        probeTotal += count;
      }
    }
  }
  return { execution, resultIssue, executionTotal, verificationTotal, probeTotal };
}

function coerceToolResultIssueKindRecord(value: unknown): Record<ToolResultIssueKind, number> {
  const result = createEmptyToolResultIssueKindRecord();
  if (!isRecord(value)) {
    return result;
  }
  for (const kind of TOOL_RESULT_ISSUE_KINDS) {
    const count = value[kind];
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
      result[kind] = Math.trunc(count);
    }
  }
  return result;
}

function coerceResultIssueSample(value: unknown): ToolResultIssueSample | null {
  if (!isRecord(value)) {
    return null;
  }
  const resultIssueKind = typeof value.resultIssueKind === 'string'
    && (TOOL_RESULT_ISSUE_KINDS as string[]).includes(value.resultIssueKind)
    ? value.resultIssueKind as ToolResultIssueKind
    : null;
  if (typeof value.toolName !== 'string' || !resultIssueKind || typeof value.occurredAt !== 'string') {
    return null;
  }
  const exitCode = typeof value.exitCode === 'number' && Number.isFinite(value.exitCode)
    ? Math.trunc(value.exitCode)
    : null;
  return {
    toolName: value.toolName,
    resultIssueKind,
    exitCode,
    errorExcerpt: typeof value.errorExcerpt === 'string' ? value.errorExcerpt : '',
    verificationKinds: coerceStringArray(value.verificationKinds)
      .filter((kind): kind is VerificationCommandKind => VERIFICATION_COMMAND_KINDS.includes(kind as VerificationCommandKind)),
    occurredAt: value.occurredAt,
  };
}

/**
 * Coerce a raw sample, splitting legacy samples that carry a
 * `verification_project_failure` or `probe_no_match` kind (pre-split these were
 * stored under `failureSamples`) into a `ToolResultIssueSample`.
 */
function coerceSampleSplit(value: unknown): { failure: ToolFailureSample | null; resultIssue: ToolResultIssueSample | null } {
  if (!isRecord(value)) {
    return { failure: null, resultIssue: null };
  }
  if (typeof value.toolName !== 'string' || typeof value.occurredAt !== 'string') {
    return { failure: null, resultIssue: null };
  }
  const exitCode = typeof value.exitCode === 'number' && Number.isFinite(value.exitCode)
    ? Math.trunc(value.exitCode)
    : null;
  const errorExcerpt = typeof value.errorExcerpt === 'string' ? value.errorExcerpt : '';
  const verificationKinds = coerceStringArray(value.verificationKinds)
    .filter((kind): kind is VerificationCommandKind => VERIFICATION_COMMAND_KINDS.includes(kind as VerificationCommandKind));
  const base = { toolName: value.toolName, exitCode, errorExcerpt, verificationKinds, occurredAt: value.occurredAt };
  const rawKind = typeof value.failureKind === 'string' ? value.failureKind : null;
  if (rawKind && (TOOL_FAILURE_KINDS as string[]).includes(rawKind)) {
    return { failure: { ...base, failureKind: rawKind as ToolFailureKind }, resultIssue: null };
  }
  if (rawKind && rawKind in LEGACY_RESULT_ISSUE_KIND_MAP) {
    return { failure: null, resultIssue: { ...base, resultIssueKind: LEGACY_RESULT_ISSUE_KIND_MAP[rawKind]! } };
  }
  return { failure: null, resultIssue: null };
}

function coerceToolUsageRollup(value: unknown): ToolUsageRollup {
  if (!isRecord(value)) {
    return createEmptyToolUsageRollup();
  }

  const countsByName = coerceCountRecord(value.countsByName);
  const failureCountsByName = coerceCountRecord(value.failureCountsByName);

  // Split aggregate by-kind (handles legacy embedded verification/probe kinds).
  const failureByKindSplit = splitRawFailureKindRecord(value.failureCountsByKind);

  // Split per-tool by-name-and-kind; collect derived result-issue-by-name for legacy data.
  const failureCountsByNameAndKind: Record<string, Record<ToolFailureKind, number>> = {};
  const derivedResultIssueByNameAndKind: Record<string, Record<ToolResultIssueKind, number>> = {};
  if (isRecord(value.failureCountsByNameAndKind)) {
    for (const [toolName, counts] of Object.entries(value.failureCountsByNameAndKind)) {
      const split = splitRawFailureKindRecord(counts);
      if (Object.values(split.execution).some((c) => c > 0)) {
        failureCountsByNameAndKind[toolName] = split.execution;
      }
      const resultIssueTotal = split.verificationTotal + split.probeTotal;
      if (resultIssueTotal > 0) {
        derivedResultIssueByNameAndKind[toolName] = split.resultIssue;
        // Recompute the per-tool failure count to execution-only: legacy data
        // embedded verification/probe results in failureCountsByName, so subtract
        // the result-issue count now attributed to this tool. (New-format data has
        // no verification/probe in failureCountsByNameAndKind, so this is a no-op.)
        if (typeof failureCountsByName[toolName] === 'number') {
          failureCountsByName[toolName] = Math.max(0, failureCountsByName[toolName] - resultIssueTotal);
        }
      }
    }
  }

  // result-issue rollups: prefer explicit new-format fields, else derive from the legacy split.
  const hasResultIssueField = typeof value.resultIssueCount === 'number' || isRecord(value.resultIssueCountsByKind);
  const resultIssueCountsByKind = isRecord(value.resultIssueCountsByKind)
    ? coerceToolResultIssueKindRecord(value.resultIssueCountsByKind)
    : failureByKindSplit.resultIssue;
  const resultIssueCountsByNameAndKind = isRecord(value.resultIssueCountsByNameAndKind)
    ? Object.fromEntries(
      Object.entries(value.resultIssueCountsByNameAndKind)
        .map(([toolName, counts]) => [toolName, coerceToolResultIssueKindRecord(counts)]),
    )
    : derivedResultIssueByNameAndKind;
  const resultIssueCountsByName = coerceCountRecord(value.resultIssueCountsByName);

  // Counts: new-format data carries execution-only failureCount + resultIssueCount;
  // legacy data carries a total failureCount with verification/probe embedded, so recompute.
  let failureCount: number;
  let resultIssueCount: number;
  let executionFailureCount: number;
  let verificationProjectFailureCount: number;
  let probeFailureCount: number;
  if (hasResultIssueField) {
    failureCount = toNonNegativeInteger(value.failureCount);
    resultIssueCount = toNonNegativeInteger(value.resultIssueCount);
    executionFailureCount = toNonNegativeInteger(value.executionFailureCount) || failureCount;
    verificationProjectFailureCount = toNonNegativeInteger(value.verificationProjectFailureCount);
    probeFailureCount = toNonNegativeInteger(value.probeFailureCount);
  } else {
    verificationProjectFailureCount = toNonNegativeInteger(value.verificationProjectFailureCount)
      || failureByKindSplit.verificationTotal;
    probeFailureCount = toNonNegativeInteger(value.probeFailureCount)
      || failureByKindSplit.probeTotal;
    resultIssueCount = verificationProjectFailureCount + probeFailureCount;
    executionFailureCount = toNonNegativeInteger(value.executionFailureCount)
      || failureByKindSplit.executionTotal;
    // Attribute the legacy total minus classified result-issues to execution
    // failures. Falls back to the full legacy total for ancient data that
    // predates by-kind classification (no execution kinds to split out).
    failureCount = executionFailureCount > 0
      ? executionFailureCount
      : Math.max(0, toNonNegativeInteger(value.failureCount) - resultIssueCount);
  }

  // Samples: split legacy samples (which may carry verification/probe kinds) into result-issue samples.
  const failureSamples: ToolFailureSample[] = [];
  const resultIssueSamples: ToolResultIssueSample[] = [];
  if (Array.isArray(value.failureSamples)) {
    for (const sample of value.failureSamples) {
      const split = coerceSampleSplit(sample);
      if (split.failure) {
        failureSamples.push(split.failure);
      }
      if (split.resultIssue) {
        resultIssueSamples.push(split.resultIssue);
      }
    }
  }
  if (Array.isArray(value.resultIssueSamples)) {
    for (const sample of value.resultIssueSamples) {
      const coerced = coerceResultIssueSample(sample);
      if (coerced) {
        resultIssueSamples.push(coerced);
      }
    }
  }

  return {
    totalCount: toNonNegativeInteger(value.totalCount),
    failureCount,
    executionFailureCount,
    verificationProjectFailureCount,
    probeFailureCount,
    resultIssueCount,
    countsByName,
    failureCountsByName,
    failureCountsByKind: failureByKindSplit.execution,
    failureCountsByNameAndKind,
    failureSamples,
    resultIssueCountsByName,
    resultIssueCountsByKind,
    resultIssueCountsByNameAndKind,
    resultIssueSamples,
    totalDurationMs: toNonNegativeInteger(value.totalDurationMs),
    timedCallCount: toNonNegativeInteger(value.timedCallCount),
    durationMsByName: coerceCountRecord(value.durationMsByName),
    subagentCallCount: toNonNegativeInteger(value.subagentCallCount),
    subagentTaskCount: toNonNegativeInteger(value.subagentTaskCount),
    subagentAgentNames: coerceStringArray(value.subagentAgentNames),
    subagentScoredTaskCount: toNonNegativeInteger(value.subagentScoredTaskCount),
    subagentTaskScores: coerceSubagentTaskScores(value.subagentTaskScores),
    subagentInputTokens: toNonNegativeInteger(value.subagentInputTokens),
    subagentOutputTokens: toNonNegativeInteger(value.subagentOutputTokens),
    subagentCacheReadTokens: toNonNegativeInteger(value.subagentCacheReadTokens),
    subagentCacheWriteTokens: toNonNegativeInteger(value.subagentCacheWriteTokens),
  };
}

function coerceFileMutationRollup(value: unknown): FileMutationRollup {
  if (!isRecord(value)) {
    return createEmptyFileMutationRollup();
  }

  return {
    writeCount: toNonNegativeInteger(value.writeCount),
    editCount: toNonNegativeInteger(value.editCount),
    deleteCount: toNonNegativeInteger(value.deleteCount),
    renameCount: toNonNegativeInteger(value.renameCount),
    touchedFileCount: toNonNegativeInteger(value.touchedFileCount),
    lineAdditions: toNonNegativeInteger(value.lineAdditions),
    lineDeletions: toNonNegativeInteger(value.lineDeletions),
    lineModifications: toNonNegativeInteger(value.lineModifications),
    editCountsByFile: coerceCountRecord(value.editCountsByFile),
    readCountsByFile: coerceCountRecord(value.readCountsByFile),
  };
}

function coerceVerificationRollup(value: unknown): VerificationRollup {
  if (!isRecord(value)) {
    return createEmptyVerificationRollup();
  }

  const countsByKind = createEmptyVerificationRollup().countsByKind;
  if (isRecord(value.countsByKind)) {
    for (const kind of VERIFICATION_COMMAND_KINDS) {
      countsByKind[kind] = toNonNegativeInteger(value.countsByKind[kind]);
    }
  }

  return {
    totalCount: toNonNegativeInteger(value.totalCount),
    failureCount: toNonNegativeInteger(value.failureCount),
    countsByKind,
  };
}

function coerceSessionAnalyticsFactors(value: unknown): SessionAnalyticsFactors | null {
  if (!isRecord(value)) {
    return null;
  }

  const contextFiles = Array.isArray(value.contextFiles)
    ? value.contextFiles
      .filter(isRecord)
      .map((entry) => ({
        path: typeof entry.path === 'string' ? entry.path : '',
        hash: typeof entry.hash === 'string' ? entry.hash : '',
      }))
      .filter((entry) => entry.path.length > 0 && entry.hash.length > 0)
    : [];

  const toolSnippetHashes = Array.isArray(value.toolSnippetHashes)
    ? value.toolSnippetHashes
      .filter(isRecord)
      .map((entry) => ({
        toolId: typeof entry.toolId === 'string' ? entry.toolId : '',
        hash: typeof entry.hash === 'string' ? entry.hash : '',
      }))
      .filter((entry) => entry.toolId.length > 0 && entry.hash.length > 0)
    : [];

  const skills = Array.isArray(value.skills)
    ? value.skills
      .filter(isRecord)
      .map((entry) => ({
        name: typeof entry.name === 'string' ? entry.name : '',
        contentHash: typeof entry.contentHash === 'string' ? entry.contentHash : null,
        sourceHash: typeof entry.sourceHash === 'string' ? entry.sourceHash : null,
        disableModelInvocation: entry.disableModelInvocation === true,
        lastModifiedAt: typeof entry.lastModifiedAt === 'string' ? entry.lastModifiedAt : null,
      }))
      .filter((entry) => entry.name.length > 0)
    : [];

  return {
    promptFamily: coerceNullableString(value.promptFamily),
    promptHash: coerceNullableString(value.promptHash),
    promptCapturedAt: coerceNullableString(value.promptCapturedAt),
    harnessPromptHash: coerceNullableString(value.harnessPromptHash),
    customPromptHash: coerceNullableString(value.customPromptHash),
    appendSystemPromptHash: coerceNullableString(value.appendSystemPromptHash),
    promptGuidelineHashes: coerceStringArray(value.promptGuidelineHashes),
    contextFiles,
    selectedToolIds: coerceStringArray(value.selectedToolIds),
    toolSnippetHashes,
    toolSetHash: coerceNullableString(value.toolSetHash),
    skills,
    skillSetHash: coerceNullableString(value.skillSetHash),
    activeExtensions: coerceStringArray(value.activeExtensions),
  };
}

function coerceBooleanRecord(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key === 'string' && typeof entry === 'boolean') {
      result[key] = entry;
    }
  }
  return result;
}

const THROUGHPUT_STATUSES = new Set<TurnThroughputStatus>(['completed', 'error', 'interrupted']);

/**
 * Coerce per-turn throughput samples. Malformed samples are dropped; older runs
 * recorded before sampling existed coerce to an empty array.
 */
function coerceTurnThroughputSamples(value: unknown): TurnThroughputSample[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const samples: TurnThroughputSample[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.endedAt !== 'string') {
      continue;
    }
    const status: TurnThroughputStatus =
      typeof entry.status === 'string' && THROUGHPUT_STATUSES.has(entry.status as TurnThroughputStatus)
        ? (entry.status as TurnThroughputStatus)
        : 'completed';
    samples.push({
      endedAt: entry.endedAt,
      outputTokens: toNonNegativeInteger(entry.outputTokens),
      inputTokens: toNonNegativeInteger(entry.inputTokens),
      cacheReadTokens: toNonNegativeInteger(entry.cacheReadTokens),
      cacheWriteTokens: toNonNegativeInteger(entry.cacheWriteTokens),
      contextTokens: toNullableNonNegativeInteger(entry.contextTokens),
      generationDurationMs: toNonNegativeInteger(entry.generationDurationMs),
      concurrentBusySessions: toNonNegativeInteger(entry.concurrentBusySessions),
      status,
      turnLatencyMs: toNullableNonNegativeInteger(entry.turnLatencyMs),
      overheadMs: toNullableNonNegativeInteger(entry.overheadMs),
      providerLatencyMs: toNullableNonNegativeInteger(entry.providerLatencyMs),
    });
  }
  return samples;
}

function coerceFunctionalSettings(value: unknown): FunctionalSettingsSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  const pruningModeCandidate = value.pruningMode;
  const pruningMode =
    typeof pruningModeCandidate === 'string' && PRUNING_MODES.has(pruningModeCandidate as PruningMode)
      ? (pruningModeCandidate as PruningMode)
      : null;
  if (pruningMode === null) {
    return null;
  }
  return {
    subagentAlwaysParentModel: value.subagentAlwaysParentModel === true,
    pruningMode,
    extensionToggles: coerceBooleanRecord(value.extensionToggles),
    toolResultPruningEnabled: value.toolResultPruningEnabled === true || value.toolResultPruningEnabled === false ? value.toolResultPruningEnabled : null,
    toolResultPruningProfile: value.toolResultPruningProfile === 'default' || value.toolResultPruningProfile === 'security' ? value.toolResultPruningProfile : null,
  };
}

function coerceRunOutcome(value: unknown): RunOutcome | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    (value.resolution !== 'resolved' && value.resolution !== 'partially_resolved' && value.resolution !== 'unresolved')
    || typeof value.satisfaction !== 'number'
    || !Number.isFinite(value.satisfaction)
  ) {
    return null;
  }

  return {
    resolution: value.resolution,
    satisfaction: value.satisfaction,
  };
}

function coerceInputKinds(value: unknown): InputKind[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((kind): kind is InputKind => typeof kind === 'string' && INPUT_KINDS.has(kind as InputKind));
}

function coerceTreatmentChangeKinds(value: unknown): TreatmentChangeKind[] {
  const kinds = new Set<TreatmentChangeKind>();
  for (const kind of coerceStringArray(value)) {
    if (TREATMENT_CHANGE_KINDS.has(kind as TreatmentChangeKind)) {
      kinds.add(kind as TreatmentChangeKind);
    }
  }
  return [...kinds];
}

function coerceThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === 'max') {
    return 'xhigh';
  }
  return THINKING_LEVELS.has(normalized as ThinkingLevel) ? normalized as ThinkingLevel : undefined;
}

function coerceAssistantUsage(value: unknown): AssistantUsage | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    inputTokens: toNonNegativeInteger(value.inputTokens),
    outputTokens: toNonNegativeInteger(value.outputTokens),
    cacheReadTokens: toNonNegativeInteger(value.cacheReadTokens),
    cacheWriteTokens: toNonNegativeInteger(value.cacheWriteTokens),
    totalTokens: toNonNegativeInteger(value.totalTokens),
  };
}

export function coerceRunSnapshot(value: unknown): RunSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const status = value.status;
  if (
    typeof value.sessionPath !== 'string'
    || typeof value.runId !== 'string'
    || typeof value.taskGroupId !== 'string'
    || (status !== 'open' && status !== 'scored' && status !== 'closed_unscored')
    || typeof value.scored !== 'boolean'
    || typeof value.startedAt !== 'string'
    || typeof value.updatedAt !== 'string'
  ) {
    return null;
  }

  const outcomeCandidate = value.outcome == null ? undefined : coerceRunOutcome(value.outcome);
  if (value.outcome != null && !outcomeCandidate) {
    return null;
  }

  const thinkingLevel = coerceThinkingLevel(value.thinkingLevel);
  const finalizationReason = typeof value.finalizationReason === 'string' && FINALIZATION_REASONS.has(value.finalizationReason as RunFinalizationReason)
    ? value.finalizationReason as RunFinalizationReason
    : undefined;

  return {
    sessionPath: value.sessionPath,
    runId: value.runId,
    taskGroupId: value.taskGroupId,
    status,
    scored: value.scored,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    finalizedAt: coerceOptionalString(value.finalizedAt),
    finalizationReason,
    outcome: outcomeCandidate ?? undefined,
    modelId: coerceOptionalString(value.modelId),
    thinkingLevel,
    mixedModelConfig: value.mixedModelConfig === true,
    mixedTreatmentConfig: value.mixedTreatmentConfig === true,
    treatmentChangeKinds: coerceTreatmentChangeKinds(value.treatmentChangeKinds),
    experimentAssignment: typeof value.experimentAssignment === 'string' && value.experimentAssignment.trim().length > 0
      ? value.experimentAssignment
      : null,
    analyticsFactors: coerceSessionAnalyticsFactors(value.analyticsFactors),
    functionalSettings: coerceFunctionalSettings(value.functionalSettings),
    sendCount: toNonNegativeInteger(value.sendCount),
    assistantTurnCount: toNonNegativeInteger(value.assistantTurnCount),
    assistantTurnDurationMs: toNonNegativeInteger(value.assistantTurnDurationMs),
    busyDurationMs: toNonNegativeInteger(value.busyDurationMs),
    busyPeriodCount: toNonNegativeInteger(value.busyPeriodCount),
    interruptedCount: toNonNegativeInteger(value.interruptedCount),
    messageEditCount: toNonNegativeInteger(value.messageEditCount),
    truncatedAfterCount: toNonNegativeInteger(value.truncatedAfterCount),
    compactionCount: toNonNegativeInteger(value.compactionCount),
    autoRetryCount: toNonNegativeInteger(value.autoRetryCount),
    backendErrorCodes: coerceStringArray(value.backendErrorCodes),
    contextTokens: typeof value.contextTokens === 'number' && Number.isFinite(value.contextTokens)
      ? Math.trunc(value.contextTokens)
      : null,
    contextLimit: typeof value.contextLimit === 'number' && Number.isFinite(value.contextLimit)
      ? Math.trunc(value.contextLimit)
      : null,
    inputTokens: toNonNegativeInteger(value.inputTokens),
    outputTokens: toNonNegativeInteger(value.outputTokens),
    cacheReadTokens: toNonNegativeInteger(value.cacheReadTokens),
    cacheWriteTokens: toNonNegativeInteger(value.cacheWriteTokens),
    tokenReportedTurnCount: toNonNegativeInteger(value.tokenReportedTurnCount),
    lastTurnUsage: coerceAssistantUsage(value.lastTurnUsage),
    turnThroughputSamples: coerceTurnThroughputSamples(value.turnThroughputSamples),
    filesystemPathRefCount: toNonNegativeInteger(value.filesystemPathRefCount),
    imageInputCount: toNonNegativeInteger(value.imageInputCount),
    imageInputBytes: toNonNegativeInteger(value.imageInputBytes),
    unsupportedInputCount: toNonNegativeInteger(value.unsupportedInputCount),
    inputKindsUsed: coerceInputKinds(value.inputKindsUsed),
    toolUsage: coerceToolUsageRollup(value.toolUsage),
    fileMutation: coerceFileMutationRollup(value.fileMutation),
    fileExtensions: coerceFileExtensionRollup(value.fileExtensions),
    verification: coerceVerificationRollup(value.verification),
  };
}

export function coerceOutcomeHistoryEntry(value: unknown): OutcomeHistoryLogEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  const outcome = coerceRunOutcome(value.outcome);
  if (
    value.schemaVersion !== RUN_ANALYTICS_SCHEMA_VERSION
    || value.kind !== 'run_outcome'
    || typeof value.recordedAt !== 'string'
    || typeof value.sessionPath !== 'string'
    || typeof value.runId !== 'string'
    || typeof value.taskGroupId !== 'string'
    || !outcome
  ) {
    return null;
  }

  return {
    schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
    kind: 'run_outcome',
    recordedAt: value.recordedAt,
    sessionPath: value.sessionPath,
    runId: value.runId,
    taskGroupId: value.taskGroupId,
    outcome,
  };
}

function coerceRunSnapshotArray(label: string, value: unknown): RunSnapshot[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an array.`);
  }

  return value.map((entry, index) => {
    const snapshot = coerceRunSnapshot(entry);
    if (!snapshot) {
      throw new Error(`Invalid run snapshot at ${label}[${index}].`);
    }
    return snapshot;
  });
}

function coerceOutcomeArray(value: unknown): OutcomeHistoryLogEntry[] {
  if (!Array.isArray(value)) {
    throw new Error('Expected outcomes to be an array.');
  }

  return value.map((entry, index) => {
    const outcome = coerceOutcomeHistoryEntry(entry);
    if (!outcome) {
      throw new Error(`Invalid outcome history entry at outcomes[${index}].`);
    }
    return outcome;
  });
}

export function coerceSourceAnalyticsPayload(value: unknown): SourceAnalyticsPayload {
  if (!isRecord(value)) {
    throw new Error('Source analytics payload must be a JSON object.');
  }

  if (value.schemaVersion !== RUN_ANALYTICS_SCHEMA_VERSION) {
    throw new Error(`Unsupported schemaVersion: expected ${RUN_ANALYTICS_SCHEMA_VERSION}, received ${String(value.schemaVersion)}.`);
  }
  if (typeof value.exportedAt !== 'string') {
    throw new Error('Source analytics payload is missing exportedAt.');
  }
  if (typeof value.workspaceKey !== 'string') {
    throw new Error('Source analytics payload is missing workspaceKey.');
  }

  return {
    schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
    exportedAt: value.exportedAt,
    workspaceKey: value.workspaceKey,
    completedRuns: coerceRunSnapshotArray('completedRuns', value.completedRuns),
    openRuns: coerceRunSnapshotArray('openRuns', value.openRuns),
    outcomes: coerceOutcomeArray(value.outcomes),
    pruningDecisions: Array.isArray(value.pruningDecisions) ? value.pruningDecisions : [],
    pruningEvents: coercePruningEvents(value.pruningEvents),
    toolResultPruningEvents: coerceToolResultPruningEvents(value.toolResultPruningEvents),
    agentReviews: coerceAgentReviews(value.agentReviews),
  };
}

function coercePruningEvents(value: unknown): PruningSourceEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const events: PruningSourceEvent[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    if (
      typeof entry.event === 'string' &&
      (entry.event === 'skill_read' ||
        entry.event === 'skill_miss' ||
        entry.event === 'shadow_miss_candidate' ||
        entry.event === 'tool_recovered') &&
      typeof entry.sessionId === 'string' &&
      typeof entry.timestamp === 'string'
    ) {
      events.push({
        event: entry.event,
        skillName: typeof entry.skillName === 'string' ? entry.skillName : undefined,
        toolName: typeof entry.toolName === 'string' ? entry.toolName : undefined,
        sessionId: entry.sessionId,
        timestamp: entry.timestamp,
      });
    }
  }
  return events;
}

function coerceToolResultPruningEvents(value: unknown): ToolResultPruningSourceEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const events: ToolResultPruningSourceEvent[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    if (
      entry.event === 'tool_result_pruned' &&
      typeof entry.sessionId === 'string' &&
      typeof entry.toolName === 'string' &&
      Array.isArray(entry.rules) &&
      entry.rules.every((r: unknown) => typeof r === 'string') &&
      typeof entry.beforeTokens === 'number' &&
      typeof entry.afterTokens === 'number' &&
      typeof entry.tokensSaved === 'number' &&
      typeof entry.timestamp === 'string'
    ) {
      events.push({
        event: 'tool_result_pruned',
        sessionId: entry.sessionId,
        toolName: entry.toolName,
        rules: entry.rules as string[],
        beforeTokens: entry.beforeTokens,
        afterTokens: entry.afterTokens,
        tokensSaved: entry.tokensSaved,
        timestamp: entry.timestamp,
      });
    }
  }
  return events;
}

/** Coerce a single parsed JSONL line into an {@link AgentReviewSourceEvent}, or null if invalid. */
function coerceAgentReviewEntry(value: unknown): AgentReviewSourceEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const completion = value.completion;
  if (
    value.schemaVersion !== RUN_ANALYTICS_SCHEMA_VERSION ||
    value.kind !== 'agent_review' ||
    typeof value.recordedAt !== 'string' ||
    typeof value.sessionPath !== 'string' ||
    typeof value.runId !== 'string' ||
    typeof value.taskGroupId !== 'string' ||
    typeof value.done !== 'boolean' ||
    typeof value.rating !== 'number' ||
    !Number.isFinite(value.rating) ||
    (completion !== 'fully' && completion !== 'partial' && completion !== 'setback') ||
    typeof value.evaluatedAt !== 'string' ||
    !Array.isArray(value.reviewerBuckets) ||
    !value.reviewerBuckets.every((b: unknown) => typeof b === 'string') ||
    typeof value.reviewerCount !== 'number' ||
    !Number.isFinite(value.reviewerCount)
  ) {
    return null;
  }
  return {
    schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
    kind: 'agent_review',
    recordedAt: value.recordedAt,
    sessionPath: value.sessionPath,
    runId: value.runId,
    taskGroupId: value.taskGroupId,
    done: value.done,
    rating: value.rating,
    completion,
    reason: typeof value.reason === 'string' ? value.reason : '',
    evaluatedAt: value.evaluatedAt,
    reviewerBuckets: value.reviewerBuckets as string[],
    reviewerCount: Math.trunc(value.reviewerCount),
  };
}

/** Coerce a raw array into {@link AgentReviewSourceEvent}[], dropping malformed entries. */
export function coerceAgentReviews(value: unknown): AgentReviewSourceEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const events: AgentReviewSourceEvent[] = [];
  for (const entry of value) {
    const coerced = coerceAgentReviewEntry(entry);
    if (coerced) {
      events.push(coerced);
    }
  }
  return events;
}

function readToolResultPruningLog(configRoot: string): ToolResultPruningSourceEvent[] {
  const logPath = path.join(configRoot, 'data', 'tool-result-pruning.jsonl');
  let raw: string;
  try {
    raw = readFileSync(logPath, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.trim().split('\n').filter((line) => line.trim().length > 0);
  const events: ToolResultPruningSourceEvent[] = [];
  for (const line of lines) {
    try {
      const parsed = parseJsonOrThrow<any>(line, logPath);
      if (
        parsed.event === 'tool_result_pruned' &&
        typeof parsed.sessionId === 'string' &&
        typeof parsed.toolName === 'string' &&
        Array.isArray(parsed.rules) &&
        parsed.rules.every((r: unknown) => typeof r === 'string') &&
        typeof parsed.beforeTokens === 'number' &&
        typeof parsed.afterTokens === 'number' &&
        typeof parsed.tokensSaved === 'number' &&
        typeof parsed.timestamp === 'string'
      ) {
        events.push({
          event: 'tool_result_pruned',
          sessionId: parsed.sessionId,
          toolName: parsed.toolName,
          rules: parsed.rules,
          beforeTokens: parsed.beforeTokens,
          afterTokens: parsed.afterTokens,
          tokensSaved: parsed.tokensSaved,
          timestamp: parsed.timestamp,
        });
      }
    } catch {
      // Skip malformed lines
    }
  }
  return events;
}

/** Read `<storageDir>/agent-reviews.jsonl` (the agent-side counterpart to outcome-history.jsonl).
 *  Missing file or malformed lines are skipped; returns [] when the file is absent. */
export function readAgentReviewsLog(storageDir: string): AgentReviewSourceEvent[] {
  const logPath = path.join(storageDir, 'agent-reviews.jsonl');
  let raw: string;
  try {
    raw = readFileSync(logPath, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.trim().split('\n').filter((line) => line.trim().length > 0);
  const events: AgentReviewSourceEvent[] = [];
  for (const line of lines) {
    try {
      const parsed = parseJsonOrThrow<unknown>(line, logPath);
      const coerced = coerceAgentReviewEntry(parsed);
      if (coerced) {
        events.push(coerced);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return events;
}
export function readWarmBashLog(configRoot: string): { rewrites: WarmBashRewriteSourceEvent[]; summaries: WarmBashSessionSummarySourceEvent[] } {
  const logPath = path.join(configRoot, 'data', 'warm-bash.jsonl');
  let raw: string;
  try {
    raw = readFileSync(logPath, 'utf8');
  } catch {
    return { rewrites: [], summaries: [] };
  }
  const lines = raw.trim().split('\n').filter((line) => line.trim().length > 0);
  const rewrites: WarmBashRewriteSourceEvent[] = [];
  const summaries: WarmBashSessionSummarySourceEvent[] = [];
  for (const line of lines) {
    try {
      const parsed = parseJsonOrThrow<any>(line, logPath);
      if (
        parsed.event === 'auto_prune_rewrite' &&
        typeof parsed.sessionId === 'string' &&
        typeof parsed.timestamp === 'string' &&
        typeof parsed.before === 'string' &&
        typeof parsed.after === 'string'
      ) {
        rewrites.push({
          event: 'auto_prune_rewrite',
          sessionId: parsed.sessionId,
          timestamp: parsed.timestamp,
          before: parsed.before,
          after: parsed.after,
        });
        continue;
      }
      if (
        parsed.event === 'session_summary' &&
        typeof parsed.sessionId === 'string' &&
        typeof parsed.timestamp === 'string' &&
        typeof parsed.fastPath === 'number' &&
        typeof parsed.warm === 'number' &&
        typeof parsed.fallback === 'number' &&
        typeof parsed.poolSize === 'number' &&
        typeof parsed.warmupFailures === 'number' &&
        typeof parsed.autoPruneEnabled === 'boolean' &&
        typeof parsed.fastPathEnabled === 'boolean' &&
        typeof parsed.gnuGrep === 'boolean'
      ) {
        summaries.push({
          event: 'session_summary',
          sessionId: parsed.sessionId,
          timestamp: parsed.timestamp,
          fastPath: parsed.fastPath,
          warm: parsed.warm,
          fallback: parsed.fallback,
          poolSize: parsed.poolSize,
          warmupFailures: parsed.warmupFailures,
          autoPruneEnabled: parsed.autoPruneEnabled,
          fastPathEnabled: parsed.fastPathEnabled,
          gnuGrep: parsed.gnuGrep,
        });
      }
    } catch {
      // Skip malformed lines
    }
  }
  return { rewrites, summaries };
}

/** Attach the global side-channel logs (pruning.jsonl, tool-result-pruning.jsonl,
 *  warm-bash.jsonl — all read once from <configRoot>/data/) to a source payload. */
function attachGlobalSideChannelLogs(source: SourceAnalyticsPayload, configRoot: string): void {
  const { decisions, events } = readPruningLog(configRoot);
  source.pruningDecisions = decisions;
  source.pruningEvents = events;
  source.toolResultPruningEvents = readToolResultPruningLog(configRoot);
  const warmBash = readWarmBashLog(configRoot);
  source.warmBashRewrites = warmBash.rewrites;
  source.warmBashSummaries = warmBash.summaries;
}

function readPruningLog(configRoot: string): { decisions: PruningSourceDecision[]; events: PruningSourceEvent[] } {
  const pruningPath = path.join(configRoot, 'data', 'pruning.jsonl');
  let raw: string;
  try {
    raw = readFileSync(pruningPath, 'utf8');
  } catch {
    return { decisions: [], events: [] };
  }
  const lines = raw.trim().split('\n').filter((line) => line.trim().length > 0);
  const decisions: PruningSourceDecision[] = [];
  const events: PruningSourceEvent[] = [];
  const EVENT_TYPES = new Set(['skill_read', 'skill_miss', 'shadow_miss_candidate', 'tool_recovered']);
  for (const line of lines) {
    try {
      const parsed = parseJsonOrThrow<any>(line, pruningPath);
      // Decision-shaped line: has mode + included/excluded (no `event` field).
      if (
        typeof parsed.timestamp === 'string' &&
        typeof parsed.sessionId === 'string' &&
        typeof parsed.mode === 'string' &&
        Array.isArray(parsed.included) &&
        Array.isArray(parsed.excluded)
      ) {
        decisions.push({
          timestamp: parsed.timestamp,
          sessionId: parsed.sessionId,
          sessionPath: typeof parsed.sessionPath === 'string' ? parsed.sessionPath : parsed.sessionId,
          mode: parsed.mode,
          query: typeof parsed.query === 'string' ? parsed.query : '',
          llmModel: typeof parsed.llmModel === 'string' ? parsed.llmModel : '',
          llmThinkingLevel: typeof parsed.llmThinkingLevel === 'string' ? parsed.llmThinkingLevel : '',
          llmLatencyMs: typeof parsed.llmLatencyMs === 'number' ? parsed.llmLatencyMs : 0,
          included: parsed.included.filter((s: unknown) => typeof s === 'string'),
          excluded: parsed.excluded.filter((s: unknown) => typeof s === 'string'),
          skillBlockTokens: typeof parsed.skillBlockTokens === 'number' ? parsed.skillBlockTokens : 0,
          originalBlockTokens: typeof parsed.originalBlockTokens === 'number' ? parsed.originalBlockTokens : 0,
          toolIncluded: Array.isArray(parsed.toolIncluded) ? parsed.toolIncluded.filter((s: unknown) => typeof s === 'string') : [],
          toolExcluded: Array.isArray(parsed.toolExcluded) ? parsed.toolExcluded.filter((s: unknown) => typeof s === 'string') : [],
          toolBlockTokens: typeof parsed.toolBlockTokens === 'number' ? parsed.toolBlockTokens : 0,
          originalToolBlockTokens: typeof parsed.originalToolBlockTokens === 'number' ? parsed.originalToolBlockTokens : 0,
        });
        continue;
      }
      // Event-shaped line: over-pruning quality signals (skill_miss / shadow_miss_candidate /
      // tool_recovered) plus the skill_read baseline. Carries `event` + sessionId + timestamp.
      if (
        typeof parsed.event === 'string' &&
        EVENT_TYPES.has(parsed.event) &&
        typeof parsed.sessionId === 'string' &&
        typeof parsed.timestamp === 'string'
      ) {
        events.push({
          event: parsed.event,
          skillName: typeof parsed.skillName === 'string' ? parsed.skillName : undefined,
          toolName: typeof parsed.toolName === 'string' ? parsed.toolName : undefined,
          sessionId: parsed.sessionId,
          timestamp: parsed.timestamp,
        });
      }
    } catch {
      // Skip malformed lines
    }
  }
  return { decisions, events };
}

export async function readSourceAnalyticsPayload(filePath: string): Promise<SourceAnalyticsPayload> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read source analytics payload at ${filePath}: ${(error as Error).message}`);
  }

  // parseJsonOrThrow raises a contextual Error naming the payload + path on
  // malformed JSON, so we let it propagate directly (no double-wrapping).
  const parsed = parseJsonOrThrow<unknown>(raw, `source analytics payload at ${filePath}`);

  return coerceSourceAnalyticsPayload(parsed);
}

async function querySourceAnalyticsPayloadFromStorageDir(storageDir: string): Promise<SourceAnalyticsPayload> {
  const queryModuleUrl = pathToFileURL(path.resolve(SCRIPT_DIR, '../../extension/src/host/run-analytics/query.ts')).href;
  const typesModuleUrl = pathToFileURL(path.resolve(SCRIPT_DIR, '../../extension/src/host/run-analytics/types.ts')).href;
  const [{ queryRunAnalyticsStore }, { RUN_ANALYTICS_SCHEMA_VERSION: sourceSchemaVersion }] = await Promise.all([
    import(queryModuleUrl),
    import(typesModuleUrl),
  ]);

  const result = await queryRunAnalyticsStore(storageDir);
  return {
    schemaVersion: sourceSchemaVersion,
    exportedAt: new Date().toISOString(),
    workspaceKey: path.basename(storageDir),
    completedRuns: result.completedRuns,
    openRuns: result.openRuns,
    outcomes: result.outcomes,
    agentReviews: readAgentReviewsLog(storageDir),
    pruningDecisions: [],
    pruningEvents: [],
    toolResultPruningEvents: [],
  };
}

/**
 * Aggregate every run store found under an outcomes root into a single
 * payload. Each `<hash>` subdirectory is one workspace's store (the hash is
 * derived from the VS Code workspace folder path, which may be an ancestor of
 * this package). Merging across stores — and deduplicating by runId later in
 * `prepareSourceAnalytics` — lets the dashboard report across all workspaces,
 * including migrated data recorded under old repo paths. Returns the merged
 * payload and the number of stores that contributed.
 */
async function queryAllRunAnalyticsStores(
  outcomesRootDir: string,
): Promise<{ source: SourceAnalyticsPayload; storeCount: number }> {
  const candidates = await listStorageDirCandidates(outcomesRootDir);
  const completedRuns: RunSnapshot[] = [];
  const openRuns: RunSnapshot[] = [];
  const outcomes: OutcomeHistoryLogEntry[] = [];
  const agentReviews: AgentReviewSourceEvent[] = [];

  for (const { storageDir } of candidates) {
    const result = await querySourceAnalyticsPayloadFromStorageDir(storageDir);
    completedRuns.push(...result.completedRuns);
    openRuns.push(...result.openRuns);
    outcomes.push(...result.outcomes);
    agentReviews.push(...result.agentReviews);
  }

  const source: SourceAnalyticsPayload = {
    schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    workspaceKey: 'all',
    completedRuns,
    openRuns,
    outcomes,
    agentReviews,
    pruningDecisions: [],
    pruningEvents: [],
    toolResultPruningEvents: [],
  };

  return { source, storeCount: candidates.length };
}

export async function loadSourceAnalytics(selection: SourceSelection = {}): Promise<LoadedSourceAnalytics> {
  const configRoot = CONFIG_ROOT;
  if (selection.exportPath) {
    const source = await readSourceAnalyticsPayload(selection.exportPath);
    attachGlobalSideChannelLogs(source, configRoot);
    return { source, sourceKind: 'export', sourcePath: selection.exportPath };
  }

  if (selection.storageDir) {
    const source = await querySourceAnalyticsPayloadFromStorageDir(selection.storageDir);
    attachGlobalSideChannelLogs(source, configRoot);
    return { source, sourceKind: 'storage-dir', sourcePath: selection.storageDir };
  }

  // Default: aggregate every run store under the outcomes root (all
  // workspaces, including migrated data recorded under old repo paths). Falls
  // back to the bundled fixture only when no local run stores exist, so the
  // dashboard still renders in a fresh checkout.
  const outcomesRoot = selection.outcomesRoot ?? DEFAULT_OUTCOMES_ROOT;
  const { source, storeCount } = await queryAllRunAnalyticsStores(outcomesRoot);
  if (storeCount > 0) {
    attachGlobalSideChannelLogs(source, configRoot);
    return { source, sourceKind: 'all-stores', sourcePath: outcomesRoot };
  }

  const fixtureSource = await readSourceAnalyticsPayload(DEFAULT_FIXTURE_PATH);
  attachGlobalSideChannelLogs(fixtureSource, configRoot);
  return { source: fixtureSource, sourceKind: 'fixture', sourcePath: DEFAULT_FIXTURE_PATH };
}

