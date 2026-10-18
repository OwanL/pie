import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendAnalyticsActivation } from '../backend-analytics-activation.js';
import { assertAnalyticsBackendContext, sameAnalyticsBackendContext } from '../backend-analytics-context.js';
import type { AnalyticsWriterStorePort } from '../session-lifecycle-writer-store.js';

const context = { mode: 'canonical-only' as const, generationId: 'capture-generation', buildId: 'capture-build', workspaceId: 'workspace', hostInstanceId: 'host-boot' };

test('canonical context requires the complete namespace and exact ready echo', () => {
  assertAnalyticsBackendContext(context);
  assert.equal(sameAnalyticsBackendContext(context, { ...context }), true);
  for (const field of Object.keys(context)) {
    const partial = { ...context } as Record<string, unknown>;
    delete partial[field];
    assert.throws(() => assertAnalyticsBackendContext(partial));
    assert.equal(sameAnalyticsBackendContext(context, partial), false);
    assert.equal(sameAnalyticsBackendContext(context, { ...context, [field]: 'other' }), false);
  }
  assert.equal(sameAnalyticsBackendContext(undefined, undefined), true);
  assert.equal(sameAnalyticsBackendContext(context, undefined), false);
  assert.throws(() => assertAnalyticsBackendContext({ ...context, trialSha256: 'not-evidence' }));
});

test('canonical-only backend retains durable admission independently of capture identity', () => {
  let acquired = 0;
  let released = 0;
  let checked = 0;
  const store = {
    getAnalyticsWriterAdmissionState: () => ({ fenceEpoch: 7 }),
    assertAnalyticsWriterAdmitted: (identity: Parameters<AnalyticsWriterStorePort['assertAnalyticsWriterAdmitted']>[0], epoch: number) => {
      checked += 1;
      assert.equal(identity.generationId, context.hostInstanceId);
      assert.equal(identity.buildId, 'loaded-build');
      assert.equal(identity.workspaceId, context.workspaceId);
      assert.equal(epoch, 7);
    },
    acquireAnalyticsWriterLease: () => { acquired += 1; return {}; },
    releaseAnalyticsWriterLease: () => { released += 1; },
    listAnalyticsWriterLeases: () => [],
    close: () => {},
  } as unknown as AnalyticsWriterStorePort;
  const authority = new BackendAnalyticsActivation({
    agentDir: () => process.cwd(), buildId: 'loaded-build', hostPid: () => 123,
    openWriterStore: () => store,
  }, { context });
  authority.validate();
  authority.openWriterAdmission();
  assert.equal(authority.context, context);
  assert.equal(authority.descriptor, undefined);
  assert.equal(authority.captureDescriptor, context);
  const release = authority.admission!.acquire();
  assert.equal(acquired, 1);
  assert.equal(checked, 1);
  assert.equal(released, 0);
  release();
  release();
  assert.equal(released, 1);
  authority.close();
  assert.equal(authority.admission, undefined);
});
