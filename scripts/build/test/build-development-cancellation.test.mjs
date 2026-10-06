import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDevelopment } from '../build-development.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t, build) {
  const controller = new AbortController();
  const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('PIE_BUILD_')));
  t.after(() => {
    controller.abort();
    for (const key of Object.keys(process.env)) if (key.startsWith('PIE_BUILD_')) delete process.env[key];
    Object.assign(process.env, previous);
  });
  let disposed = 0;
  const run = () => buildDevelopment(['--watch', '--renderer-only'], {
    loadBuild: async () => build,
    readMarker: async () => 'fixture-renderer\n',
    createCancellation: () => ({ signal: controller.signal, dispose: () => { disposed += 1; } }),
  });
  return { controller, run, disposed: () => disposed };
}

test('development cancellation during async watcher acquisition closes the acquired watcher before settling', { timeout: 2000 }, async t => {
  const entered = deferred();
  const acquired = deferred();
  const closing = deferred();
  const closed = deferred();
  let closeCalls = 0;
  let settled = false;
  const f = fixture(t, async options => {
    if (!options.build.watch) return;
    entered.resolve();
    return acquired.promise;
  });
  const running = f.run().then(() => { settled = true; });
  await entered.promise;
  f.controller.abort();
  acquired.resolve({ close: async () => { closeCalls += 1; closing.resolve(); await closed.promise; } });
  await closing.promise;
  assert.equal(settled, false, 'completion waits for watcher teardown');
  assert.equal(f.disposed(), 0);
  closed.resolve();
  await running;
  assert.equal(closeCalls, 1);
  assert.equal(f.disposed(), 1);
});

test('development cancellation during initial renderer build does not start a watcher', { timeout: 2000 }, async t => {
  const entered = deferred();
  const built = deferred();
  let calls = 0;
  const f = fixture(t, async () => { calls += 1; entered.resolve(); await built.promise; });
  const running = f.run();
  await entered.promise;
  f.controller.abort();
  built.resolve();
  await running;
  assert.equal(calls, 1);
  assert.equal(f.disposed(), 1);
});

test('development watch cancellation after acquisition reports unconfirmed close failure and disposes signals', { timeout: 2000 }, async t => {
  let closeCalls = 0;
  const f = fixture(t, async options => {
    if (!options.build.watch) return;
    // A later turn ensures the watcher is acquired and the abort listener installed.
    setImmediate(() => f.controller.abort());
    return { close: async () => { closeCalls += 1; throw new Error('fixture close failed'); } };
  });
  await assert.rejects(f.run(), error => error.teardownUnconfirmed === true);
  assert.equal(closeCalls, 1);
  assert.equal(f.disposed(), 1);
});
