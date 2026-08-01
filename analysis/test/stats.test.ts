import assert from 'node:assert/strict';
import test from 'node:test';

import {
  logGamma,
  meanConfidenceInterval95,
  regularizedIncompleteBeta,
  studentTQuantile,
  welchDifference95,
} from '../scripts/stats.ts';

// Known two-sided 95% Student-t critical values (upper 0.975 quantile).
const T_CRITICAL_975: Array<[number, number]> = [
  [1, 12.7062],
  [2, 4.3027],
  [3, 3.1824],
  [5, 2.5706],
  [10, 2.2281],
  [30, 2.0423],
  [120, 1.9793],
  [100000, 1.96], // approaches the normal critical value
];

test('studentTQuantile matches published 95% critical values across degrees of freedom', () => {
  for (const [df, expected] of T_CRITICAL_975) {
    const actual = studentTQuantile(0.975, df);
    assert.ok(
      Math.abs(actual - expected) < 0.01,
      `t(0.975, df=${df}): expected ${expected}, got ${actual}`,
    );
  }
});

test('studentTQuantile is symmetric about 0.5 and reflects the lower tail', () => {
  assert.ok(Math.abs(studentTQuantile(0.975, 10) + studentTQuantile(0.025, 10)) < 1e-9);
  assert.ok(Math.abs(studentTQuantile(0.025, 10) + 2.2281) < 0.01);
  assert.equal(studentTQuantile(0.5, 8), 0);
});

test('studentTQuantile rejects invalid probabilities and degrees of freedom', () => {
  assert.ok(Number.isNaN(studentTQuantile(0, 10)));
  assert.ok(Number.isNaN(studentTQuantile(1, 10)));
  assert.ok(Number.isNaN(studentTQuantile(0.975, 0)));
  assert.ok(Number.isNaN(studentTQuantile(0.975, -1)));
});

test('regularizedIncompleteBeta and logGamma match known analytic values', () => {
  // I_x(0.5, 0.5) = (2/π)·arcsin(√x), so I_{0.5}(0.5,0.5) = 0.5.
  assert.ok(Math.abs(regularizedIncompleteBeta(0.5, 0.5, 0.5) - 0.5) < 1e-9);
  assert.equal(regularizedIncompleteBeta(0, 2, 3), 0);
  assert.equal(regularizedIncompleteBeta(1, 2, 3), 1);
  // Γ(0.5) = √π, log = 0.572365.
  assert.ok(Math.abs(logGamma(0.5) - 0.572365) < 1e-6);
  // Γ(5) = 24, log = 3.178054.
  assert.ok(Math.abs(logGamma(5) - 3.178054) < 1e-6);
});

test('meanConfidenceInterval95 returns a null interval for n < 2 and a point interval for constant samples', () => {
  assert.equal(meanConfidenceInterval95([]).ci95, null);
  assert.equal(meanConfidenceInterval95([]).mean, null);
  const single = meanConfidenceInterval95([42]);
  assert.equal(single.n, 1);
  assert.equal(single.mean, 42);
  assert.equal(single.ci95, null);
  const constant = meanConfidenceInterval95([50, 50, 50]);
  assert.equal(constant.mean, 50);
  assert.deepEqual(constant.ci95, { lower: 50, upper: 50, level: 0.95 });
});

test('meanConfidenceInterval95 widens for small n and brackets the mean', () => {
  const { n, mean, ci95 } = meanConfidenceInterval95([80, 90, 100]);
  assert.equal(n, 3);
  assert.equal(mean, 90);
  assert.ok(ci95 !== null);
  assert.ok(ci95.lower < mean && ci95.upper > mean);
  // sd=10, se=10/√3≈5.77, t(0.975,2)=4.3027 → 90 ± 24.83.
  assert.ok(Math.abs(ci95.lower - 65.17) < 0.1);
  assert.ok(Math.abs(ci95.upper - 114.83) < 0.1);
});

test('welchDifference95 returns a null interval when either group has n < 2', () => {
  const result = welchDifference95([90, 90, 90], [70]);
  assert.equal(result.ci95, null);
  assert.equal(result.meanDifference, 20);
  assert.equal(result.degreesOfFreedom, null);
  const empty = welchDifference95([], []);
  assert.equal(empty.meanDifference, null);
  assert.equal(empty.ci95, null);
});

test('welchDifference95 centers the interval on comparison − reference and yields a point interval for constant groups', () => {
  const point = welchDifference95([90, 90, 90], [70, 70, 70]);
  assert.equal(point.meanDifference, 20);
  assert.deepEqual(point.ci95, { lower: 20, upper: 20, level: 0.95 });
  const spread = welchDifference95([100, 80, 90], [70, 70, 70]);
  assert.ok(spread.ci95 !== null);
  assert.equal(spread.meanDifference, 20);
  assert.ok(spread.ci95.lower < 20 && spread.ci95.upper > 20);
  assert.ok(spread.degreesOfFreedom !== null && spread.degreesOfFreedom > 0);
});
