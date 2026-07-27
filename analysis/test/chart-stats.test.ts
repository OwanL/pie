import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mean, meanDifferenceInterval, meanInterval, wilsonInterval } from '../site/chart-stats.ts';

describe('chart statistics helpers', () => {
  it('computes bounded t confidence intervals for bounded means', () => {
    const estimate = meanInterval([3, 4, 5, 5], { min: 1, max: 5 });

    assert.equal(estimate?.n, 4);
    assert.equal(estimate?.mean, 4.25);
    assert.equal(estimate?.ciEstimated, true);
    assert.ok((estimate?.lower ?? 0) >= 1);
    assert.ok((estimate?.upper ?? 0) <= 5);
    assert.ok((estimate?.lower ?? 0) < (estimate?.mean ?? 0));
    assert.ok((estimate?.upper ?? 0) > (estimate?.mean ?? 0));
  });

  it('marks single-observation means as not estimated', () => {
    const estimate = meanInterval([5], { min: 1, max: 5 });

    assert.equal(estimate?.mean, 5);
    assert.equal(estimate?.lower, 5);
    assert.equal(estimate?.upper, 5);
    assert.equal(estimate?.ciEstimated, false);
  });

  it('uses Wilson intervals for proportions without returning impossible bounds', () => {
    const estimate = wilsonInterval(0, 3);

    assert.equal(estimate?.rate, 0);
    assert.equal(estimate?.lower, 0);
    assert.ok((estimate?.upper ?? 0) > 0);
    assert.ok((estimate?.upper ?? 0) < 1);
  });

  it('computes bounded Welch intervals for mean differences', () => {
    const estimate = meanDifferenceInterval([4, 5, 5], [2, 3, 3], { min: -4, max: 4 });

    assert.equal(estimate?.nA, 3);
    assert.equal(estimate?.nB, 3);
    assert.ok((estimate?.difference ?? 0) > 0);
    assert.equal(estimate?.ciEstimated, true);
    assert.ok((estimate?.lower ?? -5) >= -4);
    assert.ok((estimate?.upper ?? 5) <= 4);
  });

  it('returns null for empty samples and invalid totals', () => {
    assert.equal(mean([]), null);
    assert.equal(meanInterval([], { min: 1, max: 5 }), null);
    assert.equal(wilsonInterval(1, 0), null);
    assert.equal(meanDifferenceInterval([], [1, 2], { min: -5, max: 5 }), null);
  });

  it('handles low-sample and zero-variance difference edge cases', () => {
    const lowSample = meanDifferenceInterval([10], [2, 4, 6], { min: -5, max: 5 });
    assert.equal(lowSample?.ciEstimated, false);
    assert.equal(lowSample?.difference, 5);
    assert.equal(lowSample?.lower, 5);
    assert.equal(lowSample?.upper, 5);

    const zeroVariance = meanDifferenceInterval([3, 3, 3], [1, 1, 1], { min: -5, max: 5 });
    assert.equal(zeroVariance?.ciEstimated, true);
    assert.equal(zeroVariance?.difference, 2);
    assert.equal(zeroVariance?.lower, 2);
    assert.equal(zeroVariance?.upper, 2);
    assert.match(zeroVariance?.ciLabel ?? '', /^95% CI /);
  });

  it('exercises t-critical lookup ranges via mean interval sample sizes', () => {
    const sampleSizes = [2, 31, 41, 61, 121, 122];
    for (const size of sampleSizes) {
      const values = Array.from({ length: size }, (_, index) => (index % 9) + 1);
      const estimate = meanInterval(values, { min: 0, max: 10 });
      assert.equal(estimate?.ciEstimated, true);
      assert.match(estimate?.ciLabel ?? '', /^95% CI /);
    }

    const allSuccesses = wilsonInterval(3, 3);
    assert.equal(allSuccesses?.rate, 1);
    assert.equal(allSuccesses?.upper, 1);
  });
});
