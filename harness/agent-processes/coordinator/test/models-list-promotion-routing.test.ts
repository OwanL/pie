import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { BackendServer } from '../server.js';
import { createSyntheticSourceTestSdkRuntime } from '../../test/fixtures/sdk-runtime-selection.js';

function fixture(state: 'promoting' | 'hot' | 'retiring') {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const server = new BackendServer({
    sdkPath: '/sdk', cwd: '/repo', workerEntryPath: '/worker.js',
    sourceArtifactDescriptor: createSyntheticSourceTestSdkRuntime(resolve('/sdk')).descriptor,
  });
  const port = server as any;
  const catalogPaths: string[] = [];
  const workerRequests: unknown[] = [];
  port.sessionModelCatalog = async (sessionPath: string) => {
    catalogPaths.push(sessionPath);
    return { ok: true, models: [{ id: 'session-owned' }] };
  };
  port.workerRuntimeRouter = {
    getRoute: () => ({ state, promotion: pending, retirement: pending }),
    hasHotOwner: () => state === 'hot',
    routeExisting: async (request: unknown) => { workerRequests.push(request); return ['worker-owned']; },
  };
  return { port, catalogPaths, workerRequests, release, setState: (value: typeof state) => { state = value; } };
}

const request = { id: 'models', method: 'models.list', params: { sessionPath: '/repo/session.jsonl' } };

test('models.list answers through the session catalog while promotion is held', async () => {
  const f = fixture('promoting');
  let settled = false;
  const result = f.port.handleRequest(request).then((value: unknown) => { settled = true; return value; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(settled, true, 'models.list must not join held runtime promotion');
    assert.deepEqual(await result, [{ id: 'session-owned' }]);
    assert.deepEqual(f.catalogPaths, [request.params.sessionPath]);
    assert.deepEqual(f.workerRequests, []);
  } finally {
    f.setState('hot');
    f.release();
    await result;
  }
});

test('hot models.list retains worker authority', async () => {
  const f = fixture('hot');
  assert.deepEqual(await f.port.handleRequest(request), ['worker-owned']);
  assert.deepEqual(f.workerRequests, [request]);
  assert.deepEqual(f.catalogPaths, []);
});

test('models.list still waits for retirement and reselects authority', async () => {
  const f = fixture('retiring');
  let settled = false;
  const result = f.port.handleRequest(request).then((value: unknown) => { settled = true; return value; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(settled, false);
  f.setState('hot');
  f.release();
  assert.deepEqual(await result, ['worker-owned']);
  assert.deepEqual(f.catalogPaths, []);
});
