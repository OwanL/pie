import type { PreparedRunRow, PreTaskComplexitySignal, TaskComplexityBand } from './contracts.ts';
export type { PreTaskComplexitySignal } from './contracts.ts';
import { percentileRanks } from './complexity-scoring.ts';

/**
 * Privacy-safe, pre-treatment signals available before the model begins work.
 * Post-treatment activity (tokens, tools, duration, mutations, verification) is intentionally absent.
 */
export interface PreTaskComplexitySignals {
  initialUserMessageChars: number | null;
  attachmentCount: number;
  contextFileCount: number;
}

export interface PreTaskComplexityTask extends PreTaskComplexitySignals {
  taskId: string;
}

export interface PreTaskComplexityProfile {
  scores: Map<string, number>;
  bands: Map<string, TaskComplexityBand>;
  activeSignals: PreTaskComplexitySignal[];
  initialUserMessageCoverage: number;
  hasVariance: boolean;
}

/** Avoid introducing a prompt-length covariate only for a small, newer slice of runs. */
export const PRE_TASK_PROMPT_LENGTH_MINIMUM_COVERAGE = 0.8;

/**
 * Select the earliest pre-treatment snapshot for each task group. Prepared timestamps are ISO-8601,
 * so lexical ordering is chronological; equal timestamps retain first-encountered export order.
 */
export function selectPreTaskComplexityRepresentativeRuns(runs: PreparedRunRow[]): PreparedRunRow[] {
  const representativeByTaskGroup = new Map<string, PreparedRunRow>();
  for (const run of runs) {
    const taskGroupId = run.taskGroupId || run.runId;
    const current = representativeByTaskGroup.get(taskGroupId);
    if (current === undefined || run.startedAt.localeCompare(current.startedAt) < 0) {
      representativeByTaskGroup.set(taskGroupId, run);
    }
  }
  return [...representativeByTaskGroup.values()];
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function hasVariance(values: number[]): boolean {
  if (values.length < 2) return false;
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return Number.isFinite(min) && Number.isFinite(max) && max - min > 1e-9;
}

export function extractPreTaskSignals(run: PreparedRunRow): PreTaskComplexitySignals {
  return {
    initialUserMessageChars: isFiniteNonNegative(run.initialUserMessageChars)
      ? run.initialUserMessageChars
      : null,
    attachmentCount: Math.max(0, run.filesystemPathRefCount) + Math.max(0, run.imageInputCount),
    contextFileCount: Math.max(0, run.contextFileCount),
  };
}

export function preTaskComplexityBand(score: number): TaskComplexityBand {
  if (score < 1 / 3) return 'low';
  if (score > 2 / 3) return 'high';
  return 'medium';
}

/**
 * Build a cohort-relative ex-ante complexity score in [0,1]. Each active signal contributes one
 * tied-midrank percentile. Callers comparing task groups must pass one representative run per group
 * so retries cannot alter the percentile population. A newly captured signal is activated only with
 * broad cohort coverage; missing values on an active signal receive the neutral percentile 0.5.
 */
export function computeGenericPreTaskComplexityProfile(tasks: PreTaskComplexityTask[]): PreTaskComplexityProfile {
  if (tasks.length === 0) {
    return {
      scores: new Map(),
      bands: new Map(),
      activeSignals: [],
      initialUserMessageCoverage: 0,
      hasVariance: false,
    };
  }

  const signals = tasks;
  const promptValues = signals.map((signal) => signal.initialUserMessageChars);
  const knownPromptValues = promptValues.filter((value): value is number => value !== null);
  const initialUserMessageCoverage = knownPromptValues.length / tasks.length;
  const attachmentValues = signals.map((signal) => signal.attachmentCount);
  const contextFileValues = signals.map((signal) => signal.contextFileCount);

  const activeSignals: PreTaskComplexitySignal[] = [];
  const ranksBySignal = new Map<PreTaskComplexitySignal, number[]>();

  if (
    initialUserMessageCoverage >= PRE_TASK_PROMPT_LENGTH_MINIMUM_COVERAGE
    && hasVariance(knownPromptValues)
  ) {
    const knownRanks = percentileRanks(knownPromptValues);
    let knownIndex = 0;
    ranksBySignal.set('initialUserMessageChars', promptValues.map((value) => {
      if (value === null) return 0.5;
      const rank = knownRanks[knownIndex] ?? 0.5;
      knownIndex += 1;
      return rank;
    }));
    activeSignals.push('initialUserMessageChars');
  }

  if (hasVariance(attachmentValues)) {
    ranksBySignal.set('attachmentCount', percentileRanks(attachmentValues));
    activeSignals.push('attachmentCount');
  }

  if (hasVariance(contextFileValues)) {
    ranksBySignal.set('contextFileCount', percentileRanks(contextFileValues));
    activeSignals.push('contextFileCount');
  }

  const scores = new Map<string, number>();
  const bands = new Map<string, TaskComplexityBand>();
  for (let index = 0; index < tasks.length; index += 1) {
    const score = activeSignals.length === 0
      ? 0.5
      : activeSignals.reduce((sum, signal) => sum + (ranksBySignal.get(signal)?.[index] ?? 0.5), 0)
        / activeSignals.length;
    scores.set(tasks[index]!.taskId, score);
    bands.set(tasks[index]!.taskId, preTaskComplexityBand(score));
  }

  return {
    scores,
    bands,
    activeSignals,
    initialUserMessageCoverage,
    hasVariance: hasVariance([...scores.values()]),
  };
}

export function computePreTaskComplexityProfile(runs: PreparedRunRow[]): PreTaskComplexityProfile {
  return computeGenericPreTaskComplexityProfile(runs.map((run) => ({
    taskId: run.runId,
    ...extractPreTaskSignals(run),
  })));
}

export function computePreTaskComplexityScores(runs: PreparedRunRow[]): Map<string, number> {
  return computePreTaskComplexityProfile(runs).scores;
}
