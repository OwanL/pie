import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import {
  computePreTaskComplexityProfile,
  PRE_TASK_PROMPT_LENGTH_MINIMUM_COVERAGE,
} from '../scripts/pre-task-complexity.ts';
import { loadFixture } from './helpers.ts';

test('pre-task complexity ignores post-treatment workload telemetry', async () => {
  const prepared = prepareSourceAnalytics(await loadFixture());
  const runs = prepared.runs.slice(0, 2);
  assert.equal(runs.length, 2);

  for (const run of runs) {
    run.initialUserMessageChars = 100;
    run.filesystemPathRefCount = 0;
    run.imageInputCount = 0;
    run.contextFileCount = 1;
  }
  Object.assign(runs[0]!, {
    lineMutationTotal: 0,
    lineAdditions: 0,
    touchedFileCount: 0,
    toolCallCount: 0,
    busyDurationMs: 1,
    verificationTotalCount: 0,
    inputTokens: 1,
  });
  Object.assign(runs[1]!, {
    lineMutationTotal: 100_000,
    lineAdditions: 100_000,
    touchedFileCount: 500,
    toolCallCount: 1_000,
    busyDurationMs: 10_000_000,
    verificationTotalCount: 100,
    inputTokens: 1_000_000,
  });

  const profile = computePreTaskComplexityProfile(runs);
  assert.deepEqual(profile.activeSignals, []);
  assert.equal(profile.scores.get(runs[0]!.runId), 0.5);
  assert.equal(profile.scores.get(runs[1]!.runId), 0.5);
  assert.equal(profile.hasVariance, false);
});

test('pre-task complexity activates prompt size only with broad cohort coverage', async () => {
  const prepared = prepareSourceAnalytics(await loadFixture());
  const template = prepared.runs[0]!;
  const runs = Array.from({ length: 10 }, (_, index) => ({
    ...template,
    runId: `coverage-${index}`,
    initialUserMessageChars: index < 8 ? 20 + index * 20 : null,
    filesystemPathRefCount: 0,
    imageInputCount: 0,
    contextFileCount: 0,
  }));

  const profile = computePreTaskComplexityProfile(runs);
  assert.equal(profile.initialUserMessageCoverage, PRE_TASK_PROMPT_LENGTH_MINIMUM_COVERAGE);
  assert.deepEqual(profile.activeSignals, ['initialUserMessageChars']);
  assert.equal(profile.hasVariance, true);
  assert.equal(profile.scores.get('coverage-8'), 0.5, 'missing values on an active signal are neutral');
  assert.equal(profile.scores.get('coverage-9'), 0.5, 'missing values on an active signal are neutral');
  assert.ok(profile.scores.get('coverage-0')! < profile.scores.get('coverage-7')!);
});

test('pre-task complexity uses attachments and context but never stores content', async () => {
  const prepared = prepareSourceAnalytics(await loadFixture());
  const template = prepared.runs[0]!;
  const low = {
    ...template,
    runId: 'low',
    initialUserMessageChars: null,
    filesystemPathRefCount: 0,
    imageInputCount: 0,
    contextFileCount: 0,
  };
  const high = {
    ...template,
    runId: 'high',
    initialUserMessageChars: null,
    filesystemPathRefCount: 2,
    imageInputCount: 1,
    contextFileCount: 4,
  };

  const profile = computePreTaskComplexityProfile([low, high]);
  assert.deepEqual(profile.activeSignals, ['attachmentCount', 'contextFileCount']);
  assert.equal(profile.bands.get('low'), 'low');
  assert.equal(profile.bands.get('high'), 'high');
});
