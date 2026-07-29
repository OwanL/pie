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
});
