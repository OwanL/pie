/**
 * Run-analytics coercion rollups (pie extension).
 *
 * This is a thin duplicate of the equivalent coercion logic in
 * `analysis/scripts/source.ts` (pie-analysis standalone CLI) to avoid
 * cross-package import complexity. Keep constants and logic synchronized.
 */

import type { VerificationCommandKind, ToolFailureKind, ToolResultIssueKind } from '../../shared/tool-call-analysis';
import type {
  FileExtensionRollup,
  FileMutationRollup,
  ToolFailureSample,
  ToolResultIssueSample,
  ToolUsageRollup,
  TreatmentChangeKind,
  VerificationRollup,
} from './types';
import { coerceStringArray, isObjectRecord, toNonNegativeInteger } from './coercion-utils';

/** Coerce an unknown value into a `Record<string, number>` of non-negative integers. */
function coerceNonNegativeIntegerRecord(value: unknown): Record<string, number> {
  if (!isObjectRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, count]) => typeof count === 'number' && Number.isFinite(count) && count >= 0)
      .map(([name, count]) => [name, Math.trunc(count as number)]),
  );
}

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

const TOOL_RESULT_ISSUE_KINDS: ToolResultIssueKind[] = ['verification_failure', 'probe_no_match', 'verification_pending'];

/**
 * Legacy failure-kind names (pre-split) that are now classified as non-success
 * results rather than tool failures, mapped to their new `ToolResultIssueKind`.
 * Used to remap historical run-analytics data on read so old dashboards stay
 * consistent with the execution-only failure semantics.
 */
const LEGACY_RESULT_ISSUE_KIND_MAP: Record<string, ToolResultIssueKind> = {
  verification_project_failure: 'verification_failure',
  probe_no_match: 'probe_no_match',
  verification_pending: 'verification_pending',
};

const TREATMENT_CHANGE_KINDS: TreatmentChangeKind[] = [
  'model',
  'thinking',
  'prompt',
  'toolSelection',
  'skills',
  'experimentAssignment',
  'extensions',
];

export function coerceTreatmentChangeKinds(value: unknown): TreatmentChangeKind[] {
  const kinds = new Set<TreatmentChangeKind>();
  for (const item of coerceStringArray(value)) {
    if (TREATMENT_CHANGE_KINDS.includes(item as TreatmentChangeKind)) {
      kinds.add(item as TreatmentChangeKind);
    }
  }
  return [...kinds];
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
    verification_pending: 0,
  };
}

/**
 * Split a raw by-kind failure record into execution failures and non-success
 * results. Handles both new-format data (execution kinds only) and legacy data
 * (which also embedded `verification_project_failure` / `probe_no_match`). Legacy
 * result-issue kinds are remapped to their new `ToolResultIssueKind`.
 */
interface SplitFailureKinds {
  execution: Record<ToolFailureKind, number>;
  resultIssue: Record<ToolResultIssueKind, number>;
  executionTotal: number;
  verificationTotal: number;
  probeTotal: number;
  pendingTotal: number;
}

function splitRawFailureKindRecord(value: unknown): SplitFailureKinds {
  const execution = createEmptyToolFailureKindRecord();
  const resultIssue = createEmptyToolResultIssueKindRecord();
  let executionTotal = 0;
  let verificationTotal = 0;
  let probeTotal = 0;
  let pendingTotal = 0;
  if (!isObjectRecord(value)) {
    return { execution, resultIssue, executionTotal, verificationTotal, probeTotal, pendingTotal };
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
      } else if (mapped === 'probe_no_match') {
        probeTotal += count;
      } else {
        pendingTotal += count;
      }
    }
  }
  return { execution, resultIssue, executionTotal, verificationTotal, probeTotal, pendingTotal };
}

export function createEmptyToolUsageRollup(): ToolUsageRollup {
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
    timedCallCountsByName: {},
    subagentCallCount: 0,
    subagentTaskCount: 0,
    subagentAgentNames: [],
    subagentInputTokens: 0,
    subagentOutputTokens: 0,
    subagentCacheReadTokens: 0,
    subagentCacheWriteTokens: 0,
  };
}

export function createEmptyFileMutationRollup(): FileMutationRollup {
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

export function createEmptyFileExtensionRollup(): FileExtensionRollup {
  return {
    readCountsByExtension: {},
    writeCountsByExtension: {},
    editCountsByExtension: {},
  };
}

export function createEmptyVerificationRollup(): VerificationRollup {
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

function coerceToolResultIssueKindRecord(value: unknown): Record<ToolResultIssueKind, number> {
  const result = createEmptyToolResultIssueKindRecord();
  if (!isObjectRecord(value)) {
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
  if (!isObjectRecord(value)) {
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
  if (!isObjectRecord(value)) {
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

export function coerceToolUsageRollup(value: unknown): ToolUsageRollup {
  if (!isObjectRecord(value)) {
    return createEmptyToolUsageRollup();
  }

  const coerceNameCountRecord = (v: unknown): Record<string, number> =>
    isObjectRecord(v)
      ? Object.fromEntries(
        Object.entries(v)
          .filter(([, count]) => typeof count === 'number' && Number.isFinite(count) && count >= 0)
          .map(([name, count]) => [name, Math.trunc(count as number)]),
      )
      : {};
  const countsByName = coerceNameCountRecord(value.countsByName);
  const failureCountsByName = coerceNameCountRecord(value.failureCountsByName);

  // Split aggregate by-kind (handles legacy embedded result-issue kinds).
  const failureByKindSplit = splitRawFailureKindRecord(value.failureCountsByKind);

  // Split per-tool by-name-and-kind; collect derived result-issue-by-name for legacy data.
  const failureCountsByNameAndKind: Record<string, Record<ToolFailureKind, number>> = {};
  const derivedResultIssueByNameAndKind: Record<string, Record<ToolResultIssueKind, number>> = {};
  if (isObjectRecord(value.failureCountsByNameAndKind)) {
    for (const [toolName, counts] of Object.entries(value.failureCountsByNameAndKind)) {
      const split = splitRawFailureKindRecord(counts);
      if (Object.values(split.execution).some((c) => c > 0)) {
        failureCountsByNameAndKind[toolName] = split.execution;
      }
      if (split.verificationTotal > 0 || split.probeTotal > 0 || split.pendingTotal > 0) {
        derivedResultIssueByNameAndKind[toolName] = split.resultIssue;
      }
    }
  }

  // result-issue rollups: prefer explicit new-format fields, else derive from the legacy split.
  const hasResultIssueField = typeof value.resultIssueCount === 'number' || isObjectRecord(value.resultIssueCountsByKind);
  const resultIssueCountsByKind = isObjectRecord(value.resultIssueCountsByKind)
    ? coerceToolResultIssueKindRecord(value.resultIssueCountsByKind)
    : failureByKindSplit.resultIssue;
  const resultIssueCountsByNameAndKind = isObjectRecord(value.resultIssueCountsByNameAndKind)
    ? Object.fromEntries(
      Object.entries(value.resultIssueCountsByNameAndKind)
        .map(([toolName, counts]) => [toolName, coerceToolResultIssueKindRecord(counts)]),
    )
    : derivedResultIssueByNameAndKind;
  const resultIssueCountsByName = coerceNameCountRecord(value.resultIssueCountsByName);

  // Counts: new-format data carries execution-only failureCount + resultIssueCount;
  // legacy data carries a total failureCount with result issues embedded, so recompute.
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
    resultIssueCount = verificationProjectFailureCount + probeFailureCount + failureByKindSplit.pendingTotal;
    executionFailureCount = toNonNegativeInteger(value.executionFailureCount)
      || failureByKindSplit.executionTotal;
    // Attribute the legacy total minus classified result-issues to execution
    // failures. Falls back to the full legacy total for ancient data that
    // predates by-kind classification (no execution kinds to split out).
    failureCount = executionFailureCount > 0
      ? executionFailureCount
      : Math.max(0, toNonNegativeInteger(value.failureCount) - resultIssueCount);
  }

  // Samples: split legacy samples (which may carry result-issue kinds) into result-issue samples.
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
    ...(typeof value.criticalPathDurationMs === 'number'
      && Number.isFinite(value.criticalPathDurationMs)
      && value.criticalPathDurationMs >= 0
      ? { criticalPathDurationMs: Math.trunc(value.criticalPathDurationMs) }
      : {}),
    timedCallCount: toNonNegativeInteger(value.timedCallCount),
    durationMsByName: coerceNonNegativeIntegerRecord(value.durationMsByName),
    timedCallCountsByName: coerceNonNegativeIntegerRecord(value.timedCallCountsByName),
    subagentCallCount: toNonNegativeInteger(value.subagentCallCount),
    subagentTaskCount: toNonNegativeInteger(value.subagentTaskCount),
    subagentAgentNames: coerceStringArray(value.subagentAgentNames),
    subagentInputTokens: toNonNegativeInteger(value.subagentInputTokens),
    subagentOutputTokens: toNonNegativeInteger(value.subagentOutputTokens),
    subagentCacheReadTokens: toNonNegativeInteger(value.subagentCacheReadTokens),
    subagentCacheWriteTokens: toNonNegativeInteger(value.subagentCacheWriteTokens),
  };
}

export function coerceFileMutationRollup(value: unknown): FileMutationRollup {
  if (!isObjectRecord(value)) {
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
    editCountsByFile: coerceExtensionCountRecord(value.editCountsByFile),
    readCountsByFile: coerceExtensionCountRecord(value.readCountsByFile),
  };
}

function coerceExtensionCountRecord(value: unknown): Record<string, number> {
  if (!isObjectRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, count]) => typeof count === 'number' && Number.isFinite(count) && count >= 0)
      .map(([ext, count]) => [ext, Math.trunc(count as number)]),
  );
}

export function coerceFileExtensionRollup(value: unknown): FileExtensionRollup {
  if (!isObjectRecord(value)) {
    return createEmptyFileExtensionRollup();
  }

  return {
    readCountsByExtension: coerceExtensionCountRecord(value.readCountsByExtension),
    writeCountsByExtension: coerceExtensionCountRecord(value.writeCountsByExtension),
    editCountsByExtension: coerceExtensionCountRecord(value.editCountsByExtension),
  };
}

export function coerceVerificationRollup(value: unknown): VerificationRollup {
  if (!isObjectRecord(value)) {
    return createEmptyVerificationRollup();
  }

  const countsByKind = createEmptyVerificationRollup().countsByKind;
  if (isObjectRecord(value.countsByKind)) {
    for (const kind of VERIFICATION_COMMAND_KINDS) {
      countsByKind[kind] = toNonNegativeInteger(value.countsByKind[kind], 0);
    }
  }

  return {
    totalCount: toNonNegativeInteger(value.totalCount),
    failureCount: toNonNegativeInteger(value.failureCount),
    countsByKind,
  };
}
