import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkerRuntimeHost } from '../../../src/backend/worker-runtime-host';

function makeHost(): {
  host: WorkerRuntimeHost;
  sent: Array<{ kind: string; domain?: string; payload?: unknown }>;
} {
  const sent: Array<{ kind: string; domain?: string; payload?: unknown }> = [];
  const server = {
    sendFrame: (frame: any) => { sent.push(frame); return true; },
    sendDetailFrame: () => true,
  } as never;
  const host = new WorkerRuntimeHost({
    server,
    owner: { coordinatorGeneration: 1, workerId: 'host-worker', workerGeneration: 1 },
    patchIdentity: { relativePath: 'dist/core/session-manager.js', patchVersion: 1, sha256: 'a'.repeat(64) },
  } as never);
  return { host, sent };
}

test('host applies monotonic sync domains and rejects stale catalog revisions', () => {
  const { host } = makeHost();
  host.applySync('catalog', 1, { models: [{ id: 'configured-c', name: 'Configured C', provider: 'phase-0', reasoning: false }] });
  host.applySync('settings', 1, { values: { defaultModel: 'configured-c' } });
  host.applySync('runtimePrefs', 1, { values: { autonomousMode: true } });
  assert.throws(() => host.applySync('catalog', 1, { models: [] }), /Stale worker sync revision/);
  assert.throws(() => host.applySync('catalog', 0, { models: [] }), /Stale worker sync revision/);
  host.applySync('catalog', 2, { models: [{ id: 'configured-d' }] });
});

test('host consumes the synced catalog as fallback for models.list', () => {
  const { host, sent } = makeHost();
  // No runtime context: the synced configured catalog is the availability fallback.
  host.applySync('catalog', 1, { models: [{ id: 'configured-fallback', name: 'Fallback', provider: 'phase-0', reasoning: false }] });
  const probe = host as unknown as { availableModels(): unknown };
  assert.deepEqual(probe.availableModels(), [{ id: 'configured-fallback', name: 'Fallback', provider: 'phase-0', reasoning: false }]);
  // The coordinator remains the authority: a later authoritative catalog
  // snapshot replaces the fallback, and reports never do.
  host.applySync('catalog', 2, { models: [] });
  assert.deepEqual(probe.availableModels(), []);
  assert.equal(sent.filter((frame) => frame.kind === 'runtime.report').length, 0);
});
