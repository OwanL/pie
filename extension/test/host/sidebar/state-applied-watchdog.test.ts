import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVISIONAL_COMMIT_RESNAPSHOT_MAX_RETRIES,
  StateAppliedWatchdog,
  STATE_APPLIED_RELOAD_LIMIT,
  STATE_APPLIED_RELOAD_WINDOW_MS,
  type StateAppliedWatchdogDeps,
} from '../../../src/host/sidebar/state-applied-watchdog';
import type { StateDeliveryRecovery } from '../../../src/host/sidebar/state-delivery-controller';

function recovery(reason: StateDeliveryRecovery['reason'], revision = 1): StateDeliveryRecovery {
  return { reason, revision, viewGeneration: 2, desiredGeneration: 3 };
}

function harness() {
  const reloads: StateDeliveryRecovery[] = [];
  let now = 1_000;
  const deps: StateAppliedWatchdogDeps = {
    getHostInstanceId: () => 'host-test',
    getRunningSessionCount: () => 1,
    onForceReload: async (value) => { reloads.push(value); },
    now: () => now,
  };
  return {
    watchdog: new StateAppliedWatchdog(deps),
    reloads,
    setNow: (value: number) => { now = value; },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test('repurposed watchdog owns no lack-of-commit timer and escalates after provisional resnapshots', async () => {
  const h = harness();
  for (let i = 0; i < PROVISIONAL_COMMIT_RESNAPSHOT_MAX_RETRIES; i++) {
    assert.equal(h.watchdog.handleRecovery(recovery('commit-timeout', i + 1)), false);
  }
  assert.equal(h.reloads.length, 0);
  assert.equal(h.watchdog.handleRecovery(recovery('commit-timeout', 5)), true);
  await settle();
  assert.equal(h.reloads.length, 1);
  assert.equal(h.reloads[0].reason, 'commit-timeout');
});

test('valid commit progress resets the resnapshot episode', () => {
  const h = harness();
  h.watchdog.handleRecovery(recovery('commit-timeout'));
  h.watchdog.handleRecovery(recovery('commit-timeout'));
  h.watchdog.recordCommitAdvanced();
  assert.equal(h.watchdog.handleRecovery(recovery('commit-timeout')), false);
  assert.equal(h.reloads.length, 0);
});

test('typed render failure skips resnapshot and requests immediate bounded reload', async () => {
  const h = harness();
  const renderRecovery: StateDeliveryRecovery = {
    ...recovery('render-failure', 7),
    renderFailure: { surface: 'transcript', classification: 'component_error' },
  };
  assert.equal(h.watchdog.handleRecovery(renderRecovery), true);
  await settle();
  assert.deepEqual(h.reloads, [renderRecovery]);
});

test('ledger overflow and retry exhaustion also request immediate reload', async () => {
  const h = harness();
  assert.equal(h.watchdog.handleRecovery(recovery('ledger-overflow')), true);
  await settle();
  assert.equal(h.watchdog.handleRecovery(recovery('retry-exhausted')), true);
  await settle();
  assert.deepEqual(h.reloads.map((value) => value.reason), ['ledger-overflow', 'retry-exhausted']);
});

test('reload storm opens a circuit until real commit progress occurs', async () => {
  const h = harness();
  h.setNow(10_000);
  for (let i = 0; i < STATE_APPLIED_RELOAD_LIMIT; i++) {
    assert.equal(h.watchdog.handleRecovery(recovery('render-failure', i + 1)), true);
    await settle();
  }
  assert.equal(h.watchdog.handleRecovery(recovery('render-failure', 99)), false);
  assert.equal(h.watchdog.getLastDecision(), 'throttled');
  assert.equal(h.reloads.length, STATE_APPLIED_RELOAD_LIMIT);

  h.setNow(10_000 + STATE_APPLIED_RELOAD_WINDOW_MS + 1);
  assert.equal(h.watchdog.handleRecovery(recovery('render-failure', 100)), false);
  assert.equal(h.watchdog.getLastDecision(), 'circuit-open');
  assert.equal(h.reloads.length, STATE_APPLIED_RELOAD_LIMIT);

  h.watchdog.recordCommitAdvanced();
  assert.equal(h.watchdog.handleRecovery(recovery('render-failure', 101)), true);
  await settle();
  assert.equal(h.reloads.length, STATE_APPLIED_RELOAD_LIMIT + 1);
});

test('direct throttle helper retains the rolling-window semantics', () => {
  const h = harness();
  const t0 = 5_000;
  assert.equal(h.watchdog.shouldThrottleStateAppliedReload(t0), false);
  assert.equal(h.watchdog.shouldThrottleStateAppliedReload(t0 + 1), false);
  assert.equal(h.watchdog.shouldThrottleStateAppliedReload(t0 + 2), true);
  assert.equal(h.watchdog.shouldThrottleStateAppliedReload(t0 + STATE_APPLIED_RELOAD_WINDOW_MS + 1), false);
});
