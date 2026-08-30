import assert from 'node:assert/strict';
import test from 'node:test';

import type { ArchState } from '../../../src/host/core/reducer';
import {
  didOpenTabsRegistryInputsChange,
  OpenTabsRegistryPublisher,
  selectOpenTabsRegistry,
  type OpenTabsRegistryEntry,
  type OpenTabsRegistryPublisherScheduler,
} from '../../../src/host/session-service/open-tabs-registry';

const tick = async (): Promise<void> => await new Promise((resolve) => setImmediate(resolve));

class FakeScheduler implements OpenTabsRegistryPublisherScheduler {
  private nextId = 1;
  readonly timers = new Map<number, () => void>();

  setTimeout(callback: () => void, _delayMs: number): ReturnType<typeof setTimeout> {
    const id = this.nextId++;
    this.timers.set(id, callback);
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(timer: ReturnType<typeof setTimeout>): void {
    this.timers.delete(timer as unknown as number);
  }

  fireNext(): void {
    const entry = this.timers.entries().next().value as [number, () => void] | undefined;
    assert.ok(entry);
    this.timers.delete(entry[0]);
    entry[1]();
  }
}

function registryEntry(path: string, pinned: boolean, isRunning: boolean): OpenTabsRegistryEntry {
  return {
    path,
    name: path,
    cwd: '.',
    modifiedAt: new Date(0).toISOString(),
    messageCount: 0,
    pinned,
    isRunning,
  };
}

test('registry projection derives open, pinned, and running state from host authority', () => {
  const state = {
    sessions: {
      sessions: [
        registryEntry('/sessions/a.jsonl', false, false),
        registryEntry('/sessions/b.jsonl', false, false),
      ],
      openTabPaths: ['/sessions/a.jsonl', '__pending__:create-1', '/sessions/b.jsonl'],
      pinnedTabPaths: ['/sessions/a.jsonl'],
      runningSessionPaths: ['/sessions/b.jsonl'],
    },
  } as unknown as ArchState;

  assert.deepEqual(selectOpenTabsRegistry(state), [
    registryEntry('/sessions/a.jsonl', true, false),
    registryEntry('/sessions/b.jsonl', false, true),
  ]);

  assert.equal(didOpenTabsRegistryInputsChange(state.sessions, state.sessions), false);
  assert.equal(didOpenTabsRegistryInputsChange(state.sessions, {
    ...state.sessions,
    runningSessionPaths: ['/sessions/a.jsonl'],
  }), true, 'BusyChanged identity advances the live registry immediately');
});

test('registry publisher coalesces in-flight changes to the latest snapshot', async () => {
  const sent: Array<{ revision: number; tabs: OpenTabsRegistryEntry[] }> = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const publisher = new OpenTabsRegistryPublisher({
    request: async (snapshot) => {
      sent.push(snapshot);
      if (sent.length === 1) await firstGate;
    },
  });

  publisher.publish([registryEntry('/sessions/a.jsonl', true, false)]);
  publisher.publish([registryEntry('/sessions/a.jsonl', true, true)]);
  assert.equal(sent.length, 1, 'only one request is active while an older snapshot is in flight');

  releaseFirst();
  await tick();
  assert.deepEqual(sent.map(({ revision, tabs }) => [revision, tabs[0]?.isRunning]), [
    [1, false],
    [2, true],
  ]);

  publisher.publish([registryEntry('/sessions/a.jsonl', true, true)]);
  await tick();
  assert.equal(sent.length, 2, 'an ordinary persistence checkpoint does not rebroadcast unchanged authority');
  publisher.dispose();
});

test('registry publisher retries a lost response idempotently with the same revision', async () => {
  const scheduler = new FakeScheduler();
  const revisions: number[] = [];
  let fail = true;
  const publisher = new OpenTabsRegistryPublisher({
    scheduler,
    retryDelaysMs: [1],
    request: async ({ revision }) => {
      revisions.push(revision);
      if (fail) {
        fail = false;
        throw new Error('transport closed');
      }
    },
  });

  publisher.publish([registryEntry('/sessions/a.jsonl', false, false)]);
  await tick();
  assert.deepEqual(revisions, [1]);
  assert.equal(scheduler.timers.size, 1);
  scheduler.fireNext();
  await tick();
  assert.deepEqual(revisions, [1, 1]);
  assert.equal(scheduler.timers.size, 0);
  publisher.dispose();
});

test('registry publisher force after backend restart resends immediately at the stable revision', async () => {
  const scheduler = new FakeScheduler();
  const revisions: number[] = [];
  let fail = true;
  const publisher = new OpenTabsRegistryPublisher({
    scheduler,
    retryDelaysMs: [1],
    request: async ({ revision }) => {
      revisions.push(revision);
      if (fail) throw new Error('old backend stopped');
    },
  });

  const tabs = [registryEntry('/sessions/a.jsonl', true, false)];
  publisher.publish(tabs);
  await tick();
  assert.equal(scheduler.timers.size, 1);

  fail = false;
  publisher.publish(tabs, { force: true });
  await tick();
  assert.deepEqual(revisions, [1, 1]);
  assert.equal(scheduler.timers.size, 0, 'restart bypasses the obsolete backend retry delay');
  publisher.dispose();
});

test('registry publisher dispose cancels retry state and rejects later publications', async () => {
  const scheduler = new FakeScheduler();
  let requests = 0;
  const publisher = new OpenTabsRegistryPublisher({
    scheduler,
    retryDelaysMs: [1],
    request: async () => {
      requests += 1;
      throw new Error('transport closed');
    },
  });

  publisher.publish([registryEntry('/sessions/a.jsonl', false, false)]);
  await tick();
  assert.equal(scheduler.timers.size, 1);
  publisher.dispose();
  assert.equal(scheduler.timers.size, 0);
  assert.equal(publisher.publish([registryEntry('/sessions/b.jsonl', false, false)]), undefined);
  await tick();
  assert.equal(requests, 1);
});
