import assert from 'node:assert/strict';
import test from 'node:test';
import { OrphanCleanupRegistry } from '../src/cleanup.js';

function record(id: string) {
  return {
    attemptId: id,
    phase: 'waiting_provider' as const,
    detachedAt: Date.now(),
    billableWindowsStopped: true,
  };
}

test('orphan cleanup retries after a never-settling attempt instead of wedging the registry', async () => {
  const registry = new OrphanCleanupRegistry({
    retryIntervalsMs: [1, 1],
    attemptTimeoutMs: 10,
  });
  let calls = 0;
  registry.register(record('retry-hung'), async () => {
    calls++;
    if (calls === 1) await new Promise<void>(() => {});
  });

  const deadline = Date.now() + 1_000;
  let diagnostics = registry.getDiagnostics();
  while ((calls < 2 || diagnostics.pending > 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    diagnostics = registry.getDiagnostics();
  }
  assert.equal(calls, 2);
  assert.equal(diagnostics.completed, 1);
  assert.equal(diagnostics.pending, 0);
});

test('drain is bounded even when remote abort never settles', async () => {
  const registry = new OrphanCleanupRegistry({
    retryIntervalsMs: [10_000],
    attemptTimeoutMs: 15,
  });
  registry.register(record('drain-hung'), async () => new Promise<void>(() => {}));

  const started = Date.now();
  const records = await registry.drain();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 500, `drain blocked for ${elapsed}ms`);
  assert.equal(records[0].abortAttempts, 1);
  assert.match(records[0].lastError ?? '', /cleanup attempt exceeded/);
});
