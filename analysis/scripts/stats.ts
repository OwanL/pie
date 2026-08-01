/**
 * Small, dependency-free statistical helpers for the analytics actionability
 * bundles (outcome correlations + evidence reliability).
 *
 * These compute *observational* mean intervals and differences for a bounded
 * quality score. They are intentionally not a causal-inference toolkit: the
 * t-interval for a group mean and the Welch interval for a mean difference are
 * the standard, statistically appropriate choices for small samples, and they
 * make no claim about why groups differ.
 *
 * Pure TypeScript (no Node- or browser-only APIs) so it is portable to every
 * consumer of the shared contracts.
 */

// ─── log Gamma (Lanczos approximation) ──────────────────────────────────────

const LANCZOS_G = 7;
const LANCZOS_C = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

export function logGamma(x: number): number {
  if (x < 0.5) {
    // Reflection formula: Γ(x)Γ(1-x) = π / sin(πx).
    return Math.log(Math.abs(Math.PI / Math.sin(Math.PI * x))) - logGamma(1 - x);
  }
  const shifted = x - 1;
  let a = LANCZOS_C[0]!;
  for (let i = 1; i < LANCZOS_G + 2; i += 1) {
    a += LANCZOS_C[i]! / (shifted + i);
  }
  const t = shifted + LANCZOS_G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(a);
}

// ─── regularized incomplete beta I_x(a, b) ──────────────────────────────────

/** Lentz continued fraction for the incomplete beta (Numerical Recipes `betacf`). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const fpmin = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < fpmin) d = fpmin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-14) break;
  }
  return h;
}

/**
 * Regularized incomplete beta function I_x(a, b). Strictly increasing in x on
 * (0, 1), which the inverse relies on. Returns 0 for x <= 0 and 1 for x >= 1.
 */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = logGamma(a + b) - logGamma(a) - logGamma(b);
  const front = Math.exp(lbeta + a * Math.log(x) + b * Math.log(1 - x));
  // Use the symmetry I_x(a,b) = 1 - I_{1-x}(b,a) to keep the fraction well-behaved.
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaContinuedFraction(x, a, b)) / a;
  }
  return 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/**
 * Inverse of the regularized incomplete beta: returns x such that
 * I_x(a, b) = p. Bisection is robust (the function is monotonic) and bounded,
 * avoiding Newton divergence on pathological shapes.
 */
export function inverseRegularizedIncompleteBeta(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 100; i += 1) {
    const mid = (lo + hi) / 2;
    const value = regularizedIncompleteBeta(mid, a, b);
    if (Math.abs(value - p) < 1e-14) return mid;
    if (value < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ─── Student-t quantile ─────────────────────────────────────────────────────

/**
 * Quantile (inverse CDF) of the Student-t distribution for probability `p` in
 * (0, 1) and degrees of freedom `df` > 0. Derived from the regularized
 * incomplete beta: CDF(t) = 1 - 0.5·I_x(df/2, 1/2) for t >= 0, where
 * x = df / (df + t²). Inverting gives t = ±sqrt(df·(1/x - 1)).
 */
export function studentTQuantile(p: number, df: number): number {
  if (!(p > 0 && p < 1) || !(df > 0)) return Number.NaN;
  if (p === 0.5) return 0;
  const tailProbability = 2 * Math.min(p, 1 - p);
  const x = inverseRegularizedIncompleteBeta(tailProbability, df / 2, 0.5);
  if (x <= 0 || x >= 1) {
    // Degenerate: the requested tail is essentially at the limit of the support.
    return p > 0.5 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  }
  const magnitude = Math.sqrt(df * (1 / x - 1));
  return p < 0.5 ? -magnitude : magnitude;
}

// ─── mean interval + Welch difference ────────────────────────────────────────

export interface MeanInterval {
  /** Sample size. */
  n: number;
  mean: number | null;
  /** Two-sided 95% Student-t confidence interval for the mean. Null when n < 2. */
  ci95: { lower: number; upper: number; level: 0.95 } | null;
}

function sampleMean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleVariance(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
}

/**
 * Two-sided 95% Student-t confidence interval for the mean of a sample. The
 * t-interval (not the normal/z interval) is the statistically appropriate
 * choice for the small samples typical of reviewed-session cohorts: it widens
 * honestly as n shrinks. Returns a null interval when n < 2 (a single
 * observation carries no degrees of freedom for a mean interval).
 */
export function meanConfidenceInterval95(values: number[]): MeanInterval {
  const n = values.length;
  const mean = sampleMean(values);
  if (n < 2 || mean === null) {
    return { n, mean, ci95: null };
  }
  const variance = sampleVariance(values, mean);
  if (variance === 0) {
    return { n, mean, ci95: { lower: mean, upper: mean, level: 0.95 } };
  }
  const standardError = Math.sqrt(variance / n);
  const t = studentTQuantile(0.975, n - 1);
  return {
    n,
    mean,
    ci95: { lower: mean - t * standardError, upper: mean + t * standardError, level: 0.95 },
  };
}

export interface WelchDifference {
  /** comparison mean − reference mean. */
  meanDifference: number | null;
  /** Two-sided 95% Welch (unequal-variance) t confidence interval for the
   *  difference. Null when either group has fewer than 2 observations. */
  ci95: { lower: number; upper: number; level: 0.95 } | null;
  /** Satterthwaite approximate degrees of freedom. */
  degreesOfFreedom: number | null;
  referenceN: number;
  comparisonN: number;
}

/**
 * 95% Welch confidence interval for the difference of two independent group
 * means (comparison − reference). Welch's interval does not assume equal
 * variances, which is the statistically appropriate default when group
 * dispersions are unknown and possibly unequal. Returns a null interval when
 * either group has fewer than 2 observations.
 */
export function welchDifference95(comparison: number[], reference: number[]): WelchDifference {
  const n1 = comparison.length;
  const n2 = reference.length;
  const mean1 = sampleMean(comparison);
  const mean2 = sampleMean(reference);
  if (n1 < 2 || n2 < 2 || mean1 === null || mean2 === null) {
    return {
      meanDifference: mean1 !== null && mean2 !== null ? mean1 - mean2 : null,
      ci95: null,
      degreesOfFreedom: null,
      referenceN: n2,
      comparisonN: n1,
    };
  }
  const var1 = sampleVariance(comparison, mean1);
  const var2 = sampleVariance(reference, mean2);
  const se1 = var1 / n1;
  const se2 = var2 / n2;
  const standardError = Math.sqrt(se1 + se2);
  const difference = mean1 - mean2;
  if (standardError === 0) {
    return {
      meanDifference: difference,
      ci95: { lower: difference, upper: difference, level: 0.95 },
      degreesOfFreedom: Number.POSITIVE_INFINITY,
      referenceN: n2,
      comparisonN: n1,
    };
  }
  const degreesOfFreedom = (se1 + se2) ** 2 / ((se1 ** 2) / (n1 - 1) + (se2 ** 2) / (n2 - 1));
  const t = studentTQuantile(0.975, degreesOfFreedom);
  return {
    meanDifference: difference,
    ci95: { lower: difference - t * standardError, upper: difference + t * standardError, level: 0.95 },
    degreesOfFreedom,
    referenceN: n2,
    comparisonN: n1,
  };
}
