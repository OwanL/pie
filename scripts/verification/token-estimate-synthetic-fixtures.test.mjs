import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateToolDefinitionsTokens } from '../../lib/request-token-estimate.ts';
import { holdoutSchema, measurementError, candidateHoldoutFixtures, nested70Tool, probeSmallTool, frozenProviderMeasurements, frozenFixtureCoreLengths } from './token-estimate-synthetic-fixtures.mjs';

test('probe threshold uses inclusive absolute OR relative tolerance', () => {
  assert.equal(measurementError(116, 100).pass, true);
  assert.equal(measurementError(1100, 1000).pass, true);
  assert.equal(measurementError(117, 100).pass, false);
  assert.equal(measurementError(0, null).pass, null);
  assert.equal(measurementError(16, 0).pass, true);
  assert.equal(measurementError(17, 0).pass, false);
  assert.equal(measurementError(80, 100).absolute, 20);
});
test('frozen mixed holdout retains required and closed nested objects', () => {
  assert.deepEqual(holdoutSchema.required, ['jobs']);
  const job = holdoutSchema.properties.jobs.items;
  assert.deepEqual(job.required, ['operation', 'target']);
  assert.deepEqual(job.properties.operation.enum, ['insert', 'delete', 'replace']);
  assert.equal(job.properties.target.additionalProperties, false);
});
test('candidate holdout generators reproduce the recorded frozen fixture shapes', () => {
  assert.equal(JSON.stringify(candidateHoldoutFixtures['wide-deep150'][0].parameters).length, frozenFixtureCoreLengths.wideDeep150);
  assert.equal(JSON.stringify(candidateHoldoutFixtures['enum-heavy50'][0].parameters).length, frozenFixtureCoreLengths.enumHeavy50);
  assert.equal(JSON.stringify(candidateHoldoutFixtures.deep12[0].parameters).length, frozenFixtureCoreLengths.deep12);
  assert.equal(JSON.stringify(nested70Tool).length, frozenFixtureCoreLengths.nested70);
});
test('frozen measured nested70+deep holdout keeps the unindented estimator within 16 tokens or 10%', () => {
  // Recorded usage on one gpt-6-astra/openai-codex route: provider-specific
  // measured evidence, not exact ground-truth constants across models. The
  // errors below are frozen outcomes of the unindented rendering with
  // supported annotations and the once-per-request 12-token tools-block
  // overhead; they assert tolerance compliance, not fitted agreement.
  for (const label of ['wide-deep150', 'multitool18', 'enum-heavy50', 'deep12']) {
    const estimate = estimateToolDefinitionsTokens(candidateHoldoutFixtures[label], { ...frozenProviderMeasurements.route });
    const error = measurementError(estimate, frozenProviderMeasurements[label]);
    assert.equal(error.pass, true, `${label}: ${JSON.stringify(error)}`);
  }
  const nestedDelta = estimateToolDefinitionsTokens([probeSmallTool, nested70Tool], { ...frozenProviderMeasurements.route })
    - estimateToolDefinitionsTokens([probeSmallTool], { ...frozenProviderMeasurements.route });
  const nestedError = measurementError(nestedDelta, frozenProviderMeasurements.nested70);
  assert.equal(nestedError.pass, true, `nested70: ${JSON.stringify(nestedError)}`);
  // Frozen unindented rendering errors (do not fit; tolerance-only check) —
  // recomputed for rendering with array-item comment rendering plus the 12-token
  // tools-block overhead on these single-tool totals; nested70 is a removal-pair
  // delta where the overhead cancels.
  assert.deepEqual(
    ['wide-deep150', 'multitool18', 'enum-heavy50', 'deep12', 'nested70'].map((label) => measurementError(
      label === 'nested70'
        ? estimateToolDefinitionsTokens([probeSmallTool, nested70Tool], { ...frozenProviderMeasurements.route }) - estimateToolDefinitionsTokens([probeSmallTool], { ...frozenProviderMeasurements.route })
        : estimateToolDefinitionsTokens(candidateHoldoutFixtures[label], { ...frozenProviderMeasurements.route }),
      frozenProviderMeasurements[label],
    ).absolute),
    [453, 19, 3, 15, 140],
  );
});
