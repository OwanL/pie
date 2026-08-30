import assert from 'node:assert/strict';
import test from 'node:test';

import { RollingAggregateRate } from '../../../src/host/rolling-aggregate-rate';

const BASE = 1_700_000_000_000;

test('rolling aggregate sums run totals over elapsed wall time and decays after 30 seconds', () => {
  const rate = new RollingAggregateRate();
  assert.equal(rate.observe(BASE, []), 0);
  assert.equal(rate.observe(BASE + 1_000, [
    { runId: 'a', reportedOutputTokens: 100 },
    { runId: 'b', reportedOutputTokens: 50 },
  ]), 150);
  assert.equal(rate.observe(BASE + 10_000, []), 15, 'recent completed output remains visible while idle');
  assert.equal(rate.observe(BASE + 31_000, []), 0, 'the trailing window expires after 30 seconds');
});

test('output already present on the first observation becomes a baseline rather than an invented burst', () => {
  const rate = new RollingAggregateRate();
  assert.equal(rate.observe(BASE, [{ runId: 'restored', reportedOutputTokens: 100 }]), 0);
  assert.equal(rate.observe(BASE + 200, [{ runId: 'restored', reportedOutputTokens: 100 }]), 0);
});

test('rolling aggregate captures a run first seen after it already completed', () => {
  const rate = new RollingAggregateRate();
  rate.observe(BASE, []);
  assert.equal(rate.observe(BASE + 1_000, [{ runId: 'fast', reportedOutputTokens: 80 }]), 80);
});

test('settled usage and transient live estimates compose across concurrent settlement', () => {
  const rate = new RollingAggregateRate();
  rate.observe(BASE, []);
  assert.equal(rate.observe(BASE + 1_000, [{
    runId: 'run', reportedOutputTokens: 0, liveOutputTokens: 100,
  }]), 100);
  assert.equal(rate.observe(BASE + 2_000, [{
    runId: 'run', reportedOutputTokens: 100, liveOutputTokens: 80,
  }]), 90, 'settled output and a different still-live stream are both retained');
  assert.equal(rate.observe(BASE + 3_000, [{
    runId: 'run', reportedOutputTokens: 100, liveOutputTokens: 120,
  }]), 73, 'continued live output advances above the combined high-water mark');
  assert.equal(rate.observe(BASE + 4_000, [{
    runId: 'run', reportedOutputTokens: 220,
  }]), 55, 'terminal usage replaces the live estimate without double-counting');
  assert.equal(
    rate.observe(BASE + 5_000, [{ runId: 'run', reportedOutputTokens: 220, terminal: true }]),
    44,
    'the settlement correction is idempotent for an already-reconciled total',
  );
});

// ── Terminal settlement reconciliation (one-time signed correction) ──

test('settlement corrects a run whose terminal usage is below the live estimate', () => {
  // The live tokenizer estimate overshot (e.g. visible text over-counts hidden
  // reasoning boundaries). Open observations never retract transient drops, but
  // the first terminal observation reconciles the run down to its authoritative
  // total with a single negative correction.
  const rate = new RollingAggregateRate();
  rate.observe(BASE, []);
  assert.equal(rate.observe(BASE + 1_000, [{
    runId: 'run', reportedOutputTokens: 0, liveOutputTokens: 100,
  }]), 100);
  assert.equal(
    rate.observe(BASE + 2_000, [{ runId: 'run', reportedOutputTokens: 60, terminal: true }]),
    30,
    'the displayed rate reflects the authoritative 60 tokens, not the overshoot',
  );
  assert.equal(
    rate.observe(BASE + 3_000, [{ runId: 'run', reportedOutputTokens: 60, terminal: true }]),
    20,
    'repeating the settled observation is idempotent (no further correction)',
  );
  assert.equal(
    rate.observe(BASE + 4_000, [{ runId: 'run', reportedOutputTokens: 60, liveOutputTokens: 40 }]),
    25,
    'post-settlement growth is measured against the corrected total',
  );
});

test('settlement corrects a run whose terminal usage exceeds the estimates', () => {
  const rate = new RollingAggregateRate();
  rate.observe(BASE, []);
  assert.equal(rate.observe(BASE + 1_000, [{
    runId: 'run', reportedOutputTokens: 0, liveOutputTokens: 40,
  }]), 40);
  assert.equal(
    rate.observe(BASE + 2_000, [{ runId: 'run', reportedOutputTokens: 100, terminal: true }]),
    50,
    'the missing provider output is added once at settlement',
  );
});

 test('a live drop never retracts before terminal authority, and retracts exactly once at settlement', () => {
  const rate = new RollingAggregateRate();
  rate.observe(BASE, []);
  assert.equal(rate.observe(BASE + 1_000, [{
    runId: 'run', reportedOutputTokens: 0, liveOutputTokens: 100,
  }]), 100);
  assert.equal(
    rate.observe(BASE + 2_000, [{ runId: 'run', reportedOutputTokens: 0, liveOutputTokens: 60 }]),
    50,
    'a transient live drop does not retract (open observation)',
  );
  assert.equal(
    rate.observe(BASE + 3_000, [{ runId: 'run', reportedOutputTokens: 60, terminal: true }]),
    20,
    'terminal authority applies the one-time negative correction',
  );
  assert.equal(
    rate.observe(BASE + 4_000, [{ runId: 'run', reportedOutputTokens: 60, terminal: true }]),
    15,
    'the correction never repeats',
  );
});

test('a short burst captured only by its terminal estimate contributes to the rolling rate', () => {
  // A burst that completes between sampler ticks never appears in
  // liveOutputTokens; its conservative visible-output estimate rides the
  // terminal observation so the 30s wall-clock throughput still counts it.
  const rate = new RollingAggregateRate();
  rate.observe(BASE, []);
  assert.equal(rate.observe(BASE + 1_000, [{
    runId: 'burst', reportedOutputTokens: 0, terminalOutputTokensEstimate: 50, terminal: true,
  }]), 50);
  assert.equal(
    rate.observe(BASE + 2_000, [{
      runId: 'burst', reportedOutputTokens: 0, terminalOutputTokensEstimate: 50, terminal: true,
    }]),
    25,
    're-observing the settled estimate adds nothing (idempotent)',
  );
});

test('settlement correction never renders a negative displayed rate', () => {
  const rate = new RollingAggregateRate();
  rate.observe(BASE, []);
  assert.equal(rate.observe(BASE + 1_000, [{
    runId: 'run', reportedOutputTokens: 0, liveOutputTokens: 500,
  }]), 500);
  const corrected = rate.observe(BASE + 2_000, [{
    runId: 'run', reportedOutputTokens: 5, terminal: true,
  }]);
  assert.ok(corrected >= 0, `corrected rate must never be negative, got ${corrected}`);
  assert.equal(corrected, 2.5, 'the rate clamps at the corrected total (5 tokens / 2s)');
});

test('a mixed run settles conservatively: reported totals win over older unreported estimates', () => {
  // Exact reconciliation is impossible when a run mixes usage-bearing and
  // unreported turns: only the NEWEST terminal turn carries an estimate, so the
  // settlement reconciles to reported + that estimate and never invents output
  // for older unreported turns (bounded conservative fallback).
  const rate = new RollingAggregateRate();
  rate.observe(BASE, []);
  // Turn A finished without usage; its estimate is counted while open.
  assert.equal(rate.observe(BASE + 1_000, [{
    runId: 'run', reportedOutputTokens: 0, terminalOutputTokensEstimate: 100,
  }]), 100);
  // Turn B streams on top of A's uncovered estimate.
  assert.equal(rate.observe(BASE + 2_000, [{
    runId: 'run', reportedOutputTokens: 0, liveOutputTokens: 50, terminalOutputTokensEstimate: 100,
  }]), 75);
  // B settles WITH usage: the authoritative total replaces both estimates.
  assert.equal(
    rate.observe(BASE + 3_000, [{ runId: 'run', reportedOutputTokens: 60, terminal: true }]),
    20,
    'the mixed run settles to the authoritative reported total',
  );
});
