import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRIVATE_SESSION_CLEANUP_TIMEOUT_MS,
  PrivateSessionCleanup,
} from '../../../src/host/session-service/private-session-cleanup';

const tick = async (): Promise<void> => await new Promise((resolve) => setImmediate(resolve));

test('private cleanup is deferred and does not block startup callers', async () => {
  let release!: () => void;
  const request = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  const cleanup = new PrivateSessionCleanup({
    requestForget: async (_sessionPath, _timeoutMs, onTransportSettled) => {
      requests += 1;
      await request;
      onTransportSettled();
    },
    forgetLocalAnalytics: async () => undefined,
    clearPrivacyMarker: () => undefined,
    persistMarkers: async () => undefined,
    isBackendReady: () => true,
    getBackendGeneration: () => 1,
  });

  const returned = cleanup.schedule(['/private.jsonl'], []);
  assert.equal(returned, undefined);
  await tick();
  assert.equal(requests, 1);

  release();
  await tick();
  cleanup.dispose();
});

test('cleanup passes the bounded request timeout and retains marker on failure', async () => {
  const timeouts: number[] = [];
  const persisted: string[][] = [];
  let cleared = 0;
  const cleanup = new PrivateSessionCleanup({
    requestForget: async (_sessionPath, timeoutMs, onTransportSettled) => {
      timeouts.push(timeoutMs);
      onTransportSettled();
      throw new Error('backend unavailable');
    },
    forgetLocalAnalytics: async () => undefined,
    clearPrivacyMarker: () => { cleared += 1; },
    persistMarkers: async (paths) => { persisted.push([...paths]); },
    isBackendReady: () => true,
    getBackendGeneration: () => 1,
  });

  cleanup.schedule(['/private.jsonl'], []);
  await tick();

  assert.deepEqual(timeouts, [PRIVATE_SESSION_CLEANUP_TIMEOUT_MS]);
  assert.equal(cleared, 0);
  assert.deepEqual(persisted, []);
  cleanup.dispose();
});

test('local analytics cleanup is a prerequisite for backend deletion and marker removal', async () => {
  const order: string[] = [];
  let cleared = 0;
  let persisted = 0;
  const cleanup = new PrivateSessionCleanup({
    forgetLocalAnalytics: async () => {
      order.push('local');
      throw new Error('storage.forgetSession failed');
    },
    requestForget: async () => {
      order.push('backend');
    },
    clearPrivacyMarker: () => { cleared += 1; },
    persistMarkers: async () => { persisted += 1; },
    isBackendReady: () => true,
    getBackendGeneration: () => 1,
  });

  cleanup.schedule(['/private.jsonl'], []);
  await tick();

  assert.deepEqual(order, ['local']);
  assert.equal(cleared, 0, 'a local scrub failure cannot clear the durable marker');
  assert.equal(persisted, 0);
  cleanup.dispose();
});

test('marker persistence rebases onto a newer marker set while cleanup awaits', async () => {
  let releasePersistence!: () => void;
  let persistenceStarted!: () => void;
  const persistenceReady = new Promise<void>((resolve) => { persistenceStarted = resolve; });
  const persistenceGate = new Promise<void>((resolve) => { releasePersistence = resolve; });
  const persisted: string[][] = [];
  let first = true;
  const cleanup = new PrivateSessionCleanup({
    requestForget: async (_sessionPath, _timeoutMs, onTransportSettled) => {
      onTransportSettled();
    },
    forgetLocalAnalytics: async () => undefined,
    clearPrivacyMarker: () => undefined,
    persistMarkers: async (paths) => {
      persisted.push([...paths]);
      if (first) {
        first = false;
        persistenceStarted();
        await persistenceGate;
      }
    },
    isBackendReady: () => true,
    getBackendGeneration: () => 1,
    isSessionOpen: (sessionPath) => sessionPath === '/new.jsonl',
  });

  cleanup.schedule(['/old.jsonl'], []);
  await persistenceReady;
  cleanup.schedule(['/old.jsonl', '/new.jsonl'], ['/new.jsonl']);
  releasePersistence();
  await tick();
  await tick();

  assert.deepEqual(persisted.at(-1), ['/new.jsonl'], 'a newer marker is not dropped by the older removal write');
  cleanup.dispose();
});

test('successful cleanup clears its marker once and does not repeat deletion on resync', async () => {
  let requests = 0;
  const persisted: string[][] = [];
  let cleared = 0;
  const cleanup = new PrivateSessionCleanup({
    requestForget: async (_sessionPath, _timeoutMs, onTransportSettled) => {
      requests += 1;
      onTransportSettled();
    },
    forgetLocalAnalytics: async () => undefined,
    clearPrivacyMarker: () => { cleared += 1; },
    persistMarkers: async (paths) => { persisted.push([...paths]); },
    isBackendReady: () => true,
    getBackendGeneration: () => 1,
  });

  cleanup.schedule(['/private.jsonl', '/restored.jsonl'], ['/restored.jsonl']);
  await tick();
  cleanup.schedule(['/private.jsonl', '/restored.jsonl'], ['/restored.jsonl']);
  await tick();

  assert.equal(requests, 1);
  assert.equal(cleared, 1);
  assert.deepEqual(persisted.at(-1), ['/restored.jsonl']);
  cleanup.dispose();
});

test('local scrub failures release slots so later candidates are attempted', async () => {
  const paths = ['/one.jsonl', '/two.jsonl', '/three.jsonl', '/four.jsonl', '/five.jsonl'];
  const localScrubs: string[] = [];
  const requests: string[] = [];
  let cleared = 0;
  const cleanup = new PrivateSessionCleanup({
    forgetLocalAnalytics: async (sessionPath) => {
      localScrubs.push(sessionPath);
      if (localScrubs.length <= 4) throw new Error('local scrub failed');
    },
    requestForget: async (sessionPath, _timeoutMs, onTransportSettled) => {
      requests.push(sessionPath);
      onTransportSettled();
      throw new Error('backend unavailable');
    },
    clearPrivacyMarker: () => { cleared += 1; },
    persistMarkers: async () => undefined,
    isBackendReady: () => true,
    getBackendGeneration: () => 1,
  });

  cleanup.schedule(paths, []);
  await tick();
  await tick();
  await tick();

  assert.deepEqual(localScrubs, paths, 'the fifth local scrub is not starved behind the first four failures');
  assert.deepEqual(requests, ['/five.jsonl']);
  assert.equal(cleared, 0, 'all failed candidates retain their privacy markers');
  cleanup.dispose();
});

test('an admitted timed-out request keeps its physical cleanup slot', async () => {
  const paths = ['/one.jsonl', '/two.jsonl', '/three.jsonl', '/four.jsonl', '/five.jsonl'];
  let requests = 0;
  let cleared = 0;
  const cleanup = new PrivateSessionCleanup({
    forgetLocalAnalytics: async () => undefined,
    requestForget: async () => {
      requests += 1;
      throw new Error('request timed out');
    },
    clearPrivacyMarker: () => { cleared += 1; },
    persistMarkers: async () => undefined,
    isBackendReady: () => true,
    getBackendGeneration: () => 1,
  });

  cleanup.schedule(paths, []);
  await tick();
  await tick();

  assert.equal(requests, 4, 'a timed-out physical request cannot be replaced before transport settlement');
  assert.equal(cleared, 0, 'timed-out requests retain their privacy markers');
  cleanup.dispose();
});

test('dispose while local scrub is pending does not send a forget request', async () => {
  let localScrubStarted!: () => void;
  let releaseLocalScrub!: () => void;
  const localScrubReady = new Promise<void>((resolve) => { localScrubStarted = resolve; });
  const localScrubGate = new Promise<void>((resolve) => { releaseLocalScrub = resolve; });
  let requests = 0;
  let cleared = 0;
  const cleanup = new PrivateSessionCleanup({
    forgetLocalAnalytics: async () => {
      localScrubStarted();
      await localScrubGate;
    },
    requestForget: async () => {
      requests += 1;
    },
    clearPrivacyMarker: () => { cleared += 1; },
    persistMarkers: async () => undefined,
    isBackendReady: () => true,
    getBackendGeneration: () => 1,
  });

  cleanup.schedule(['/private.jsonl'], []);
  await localScrubReady;
  cleanup.dispose();
  releaseLocalScrub();
  await tick();
  await tick();

  assert.equal(requests, 0);
  assert.equal(cleared, 0, 'disposing during the local scrub retains the retry marker');
});

test('backend replacement while local scrub is pending skips the stale request and retries', async () => {
  let generation = 1;
  let localScrubStarted!: () => void;
  let releaseLocalScrub!: () => void;
  const localScrubReady = new Promise<void>((resolve) => { localScrubStarted = resolve; });
  const localScrubGate = new Promise<void>((resolve) => { releaseLocalScrub = resolve; });
  const requestGenerations: number[] = [];
  let localScrubs = 0;
  let cleared = 0;
  const cleanup = new PrivateSessionCleanup({
    forgetLocalAnalytics: async () => {
      localScrubs += 1;
      if (localScrubs === 1) {
        localScrubStarted();
        await localScrubGate;
      }
    },
    requestForget: async (_sessionPath, _timeoutMs, onTransportSettled) => {
      requestGenerations.push(generation);
      onTransportSettled();
      throw new Error('replacement backend unavailable');
    },
    clearPrivacyMarker: () => { cleared += 1; },
    persistMarkers: async () => undefined,
    isBackendReady: () => true,
    getBackendGeneration: () => generation,
  });

  cleanup.schedule(['/private.jsonl'], []);
  await localScrubReady;
  generation = 2;
  cleanup.schedule(['/private.jsonl'], []);
  releaseLocalScrub();
  await tick();
  await tick();
  await tick();

  assert.deepEqual(requestGenerations, [2], 'the stale generation never receives a destructive request');
  assert.equal(localScrubs, 2, 'the replacement retries the preserved marker');
  assert.equal(cleared, 0, 'the failed replacement retains the privacy marker');
  cleanup.dispose();
});

test('a restart waits for the old cleanup request before retrying the same path', async () => {
  let generation = 1;
  let rejectOld!: (error: Error) => void;
  const calls: number[] = [];
  const cleanup = new PrivateSessionCleanup({
    requestForget: async (_sessionPath, _timeoutMs, onTransportSettled) => {
      calls.push(generation);
      try {
        if (calls.length === 1) {
          await new Promise<void>((_resolve, reject) => { rejectOld = reject; });
        }
      } finally {
        onTransportSettled();
      }
    },
    forgetLocalAnalytics: async () => undefined,
    clearPrivacyMarker: () => undefined,
    persistMarkers: async () => undefined,
    isBackendReady: () => true,
    getBackendGeneration: () => generation,
  });

  cleanup.schedule(['/private.jsonl'], []);
  await tick();
  generation = 2;
  cleanup.schedule(['/private.jsonl'], []);
  await tick();
  assert.deepEqual(calls, [1], 'the old request is still the only physical request while it is in flight');

  rejectOld(new Error('old backend stopped'));
  await tick();
  await tick();
  assert.deepEqual(calls, [1, 2]);
  cleanup.dispose();
});
