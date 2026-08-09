import assert from 'node:assert/strict';
import test from 'node:test';
import { getSharedWarmBashState, installWarmBashProcessCleanup } from '../src/shared-state.js';

test('independent extension instances share one process owner and install cleanup listeners once', () => {
  const before = {
    sigint: process.listenerCount('SIGINT'),
    sigterm: process.listenerCount('SIGTERM'),
    exit: process.listenerCount('exit'),
  };

  installWarmBashProcessCleanup();
  const first = getSharedWarmBashState();
  installWarmBashProcessCleanup();
  const second = getSharedWarmBashState();

  assert.equal(first.pool, second.pool);
  assert.equal(first.metrics, second.metrics);
  assert.equal(second.processCleanupInstalled, true);
  assert.equal(process.listenerCount('SIGINT') - before.sigint, 1);
  assert.equal(process.listenerCount('SIGTERM') - before.sigterm, 1);
  assert.equal(process.listenerCount('exit') - before.exit, 1);
});
