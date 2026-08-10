import test from 'node:test';
import assert from 'node:assert/strict';

import {
  StateDeliveryController,
  type StateDeliveryBuildContext,
  type StateDeliveryClock,
  type StateDeliveryControllerOptions,
  type StateDeliveryPostContext,
  type StateDeliveryProtocolDefect,
  type StateDeliveryRecovery,
  type StateDeliveryTelemetry,
} from '../../../src/host/sidebar/state-delivery-controller';

class FakeClock implements StateDeliveryClock {
  private time = 0;
  private nextId = 1;
  private timers = new Map<number, { dueAt: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { dueAt: this.time + delayMs, callback });
    return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  advance(ms: number): void {
    this.time += ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= this.time)
        .sort(([, a], [, b]) => a.dueAt - b.dueAt);
      if (due.length === 0) return;
      for (const [id, timer] of due) {
        if (this.timers.delete(id)) timer.callback();
      }
    }
  }
  pendingCount(): number { return this.timers.size; }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

type Harness = {
  clock: FakeClock;
  controller: StateDeliveryController<string>;
  builds: StateDeliveryBuildContext[];
  posts: StateDeliveryPostContext[];
  recoveries: StateDeliveryRecovery[];
  telemetry: StateDeliveryTelemetry[];
  defects: StateDeliveryProtocolDefect[];
  accepted: StateDeliveryPostContext[];
  commits: number[];
  blocked: { count: number };
  setEligible(value: boolean): void;
};

function harness(
  post: (context: StateDeliveryPostContext) => boolean | Promise<boolean>,
  overrides: Partial<Omit<StateDeliveryControllerOptions<string>, 'clock' | 'buildSnapshot' | 'isEligible' | 'post' | 'onRecovery' | 'onProtocolDefect'>> = {},
  onRecoveryHook?: (recovery: StateDeliveryRecovery, controller: StateDeliveryController<string>) => void,
): Harness {
  const clock = new FakeClock();
  const builds: StateDeliveryBuildContext[] = [];
  const posts: StateDeliveryPostContext[] = [];
  const recoveries: StateDeliveryRecovery[] = [];
  const telemetry: StateDeliveryTelemetry[] = [];
  const defects: StateDeliveryProtocolDefect[] = [];
  const accepted: StateDeliveryPostContext[] = [];
  const commits: number[] = [];
  const blocked = { count: 0 };
  let eligible = true;
  const controller = new StateDeliveryController<string>({
    clock,
    buildSnapshot: (context) => {
      builds.push(context);
      return { payload: `state-${context.desiredGeneration}`, expectedTranscriptIdentity: `identity-${context.revision}` };
    },
    isEligible: () => eligible,
    post: (_snapshot, context) => { posts.push(context); return post(context); },
    onRecovery: (recovery) => {
      recoveries.push(recovery);
      onRecoveryHook?.(recovery, controller);
    },
    onProtocolDefect: (defect) => defects.push(defect),
    onTelemetry: (event) => telemetry.push(event),
    onAccepted: (context) => accepted.push(context),
    onCommitAdvanced: (revision) => commits.push(revision),
    onDeliveryBlocked: () => { blocked.count += 1; },
    settlementTimeoutMs: 10,
    commitTimeoutMs: 100,
    retryDelayMs: 5,
    maxRetryAttempts: 2,
    acceptedLedgerCapacity: 8,
    ...overrides,
  });
  return {
    clock, controller, builds, posts, recoveries, telemetry, defects, accepted, commits, blocked,
    setEligible: (value) => { eligible = value; },
  };
}

function transcriptCommit(revision: number, viewGeneration: number, identity = `identity-${revision}`) {
  return { revision, viewGeneration, identity, mountGeneration: 1, evidence: 'displayed' as const };
}

test('one unsettled or uncommitted post coalesces many host changes to the latest snapshot', async () => {
  const first = deferred<boolean>();
  const second = deferred<boolean>();
  let calls = 0;
  const h = harness(() => (++calls === 1 ? first.promise : second.promise));

  h.controller.markDirty();
  h.controller.markDirty();
  h.controller.markDirty();
  assert.deepEqual(h.builds.map((build) => build.desiredGeneration), [1]);

  first.resolve(true);
  await settle();
  assert.deepEqual(h.builds.map((build) => build.desiredGeneration), [1]);
  assert.equal(h.controller.getDebugState().dirty, true);
  assert.deepEqual(h.controller.getDebugState().acceptedRevisions, [1]);

  h.controller.transcriptCommitted(transcriptCommit(1, h.controller.getDebugState().viewGeneration));
  assert.deepEqual(h.builds.map((build) => build.desiredGeneration), [1, 3]);

  second.resolve(true);
  await settle();
  assert.equal(h.controller.getDebugState().dirty, false);
  assert.deepEqual(h.controller.getDebugState().acceptedRevisions, [2]);
});

test('priority state retires an accepted streaming snapshot and posts without waiting for commit', async () => {
  const h = harness(() => true);
  h.controller.markDirty();
  await settle();
  assert.deepEqual(h.controller.getDebugState().acceptedRevisions, [1]);

  h.controller.markPriorityDirty();
  await settle();

  assert.equal(h.posts.length, 2);
  assert.deepEqual(h.builds.map((build) => build.desiredGeneration), [1, 2]);
  assert.deepEqual(h.controller.getDebugState().acceptedRevisions, [2]);

  const generation = h.controller.getDebugState().viewGeneration;
  h.controller.transcriptCommitted(transcriptCommit(1, generation));
  assert.equal(h.defects.length, 0, 'retired selection predecessor evidence is stale, not defective');
  assert.ok(h.telemetry.some((event) => event.kind === 'commit-stale'));
});

test('priority state coalesces behind an unsettled post then supersedes it after acceptance', async () => {
  const first = deferred<boolean>();
  const h = harness(() => h.posts.length === 1 ? first.promise : true);
  h.controller.markDirty();
  h.controller.markPriorityDirty();
  h.controller.markPriorityDirty();
  assert.equal(h.posts.length, 1);

  first.resolve(true);
  await settle();

  assert.equal(h.posts.length, 2);
  assert.deepEqual(h.builds.map((build) => build.desiredGeneration), [1, 3]);
  assert.deepEqual(h.controller.getDebugState().acceptedRevisions, [2]);
});

test('priority state retries without the normal delay when the older unsettled post fails', async () => {
  const first = deferred<boolean>();
  const h = harness(() => h.posts.length === 1 ? first.promise : true, { retryDelayMs: 50 });
  h.controller.markDirty();
  h.controller.markPriorityDirty();

  first.resolve(false);
  await settle();
  assert.equal(h.posts.length, 1);

  h.clock.advance(0);
  await settle();
  assert.equal(h.posts.length, 2, 'priority retry uses a zero-delay task instead of the normal retry budget');
});

test('renderer block retires a stale acceptance only when newer host state is coalesced', async () => {
  const h = harness(() => true);
  h.controller.markDirty();
  await settle();
  const generation = h.controller.getDebugState().viewGeneration;

  h.controller.transcriptCommitBlocked({
    revision: 1,
    viewGeneration: generation,
    reason: 'leaf_mismatch',
  });
  assert.deepEqual(h.builds.map((build) => build.desiredGeneration), [1]);
  assert.deepEqual(h.controller.getDebugState().acceptedRevisions, [1]);

  h.controller.markDirty();
  h.controller.transcriptCommitBlocked({
    revision: 1,
    viewGeneration: generation,
    reason: 'leaf_mismatch',
  });
  await settle();

  assert.deepEqual(h.builds.map((build) => build.desiredGeneration), [1, 2]);
  assert.deepEqual(h.controller.getDebugState().acceptedRevisions, [2]);
  assert.ok(h.telemetry.some((event) => event.kind === 'commit-blocked'));
  assert.equal(h.recoveries.length, 0);
});

test('renderer block with no newer host state retains bounded commit-timeout recovery', async () => {
  const h = harness(() => true, { commitTimeoutMs: 100 });
  h.controller.markDirty();
  await settle();
  const generation = h.controller.getDebugState().viewGeneration;

  h.controller.transcriptCommitBlocked({
    revision: 1,
    viewGeneration: generation,
    reason: 'structure_mismatch',
  });
  h.clock.advance(99);
  assert.equal(h.recoveries.length, 0);
  h.clock.advance(1);

  assert.equal(h.recoveries[0]?.reason, 'commit-timeout');
  assert.equal(h.recoveries[0]?.revision, 1);
});

test('renderer block racing post settlement is replayed against the accepted revision', async () => {
  const pending = deferred<boolean>();
  const h = harness(() => pending.promise);
  h.controller.markDirty();
  h.controller.markDirty();
  const generation = h.controller.getDebugState().viewGeneration;

  h.controller.transcriptCommitBlocked({
    revision: 1,
    viewGeneration: generation,
    reason: 'leaf_missing',
  });
  pending.resolve(true);
  await settle();

  assert.deepEqual(h.builds.map((build) => build.desiredGeneration), [1, 2]);
  assert.equal(h.posts.length, 2);
});

test('false, reject, never-settling timeout, and late true retry autonomously without raw error telemetry', async () => {
  const hung = deferred<boolean>();
  let call = 0;
  const h = harness(() => {
    call += 1;
    if (call === 1) return false;
    if (call === 2) return Promise.reject(new Error('SECRET raw body'));
    if (call === 3) return hung.promise;
    return true;
  }, { maxRetryAttempts: 3 });

  h.controller.markDirty();
  await settle();
  h.clock.advance(5); await settle();
  h.clock.advance(5); await settle();
  h.clock.advance(10);
  hung.resolve(true);
  await settle();
  h.clock.advance(5); await settle();

  assert.equal(call, 4);
  assert.equal(h.controller.getDebugState().dirty, false);
  assert.ok(h.telemetry.some((event) => event.kind === 'post-false'));
  assert.ok(h.telemetry.some((event) => event.kind === 'post-rejected'));
  assert.ok(h.telemetry.some((event) => event.kind === 'post-timeout'));
  assert.ok(h.telemetry.some((event) => event.kind === 'post-late-settlement'));
  assert.equal(JSON.stringify(h.telemetry).includes('SECRET'), false);
});

test('evidence arriving after post-settlement timeout is stale telemetry, not a protocol defect', async () => {
  const hung = deferred<boolean>();
  const h = harness(() => hung.promise);
  h.controller.markDirty();
  const generation = h.controller.getDebugState().viewGeneration;
  h.clock.advance(10);

  h.controller.stateReceived({ revision: 1, viewGeneration: generation, snapshotBytes: 10 });
  h.controller.appCommitted({ revision: 1, viewGeneration: generation, surface: 'app' });
  h.controller.transcriptCommitted(transcriptCommit(1, generation));
  h.controller.paintObserved({ ...transcriptCommit(1, generation), latencyMs: 1 });

  assert.equal(h.defects.length, 0);
  assert.equal(h.telemetry.filter((event) => event.kind === 'evidence-stale').length, 3);
  assert.ok(h.telemetry.some((event) => event.kind === 'commit-stale' && event.detail === 'retired-after-timeout'));
  hung.resolve(true);
  await settle();
  assert.ok(h.telemetry.some((event) => event.kind === 'post-late-settlement'));
});

test('new host changes cannot bypass a scheduled retry or spend its budget without a post', async () => {
  let calls = 0;
  const h = harness(() => {
    calls += 1;
    return calls > 1;
  });
  h.controller.markDirty();
  await settle();
  h.controller.markDirty();
  h.controller.markDirty();
  assert.equal(calls, 1, 'dirty updates remain coalesced behind the retry timer');
  assert.equal(h.controller.getDebugState().retryAttempts, 0);

  h.clock.advance(5);
  await settle();
  assert.equal(calls, 2);
  assert.equal(h.controller.getDebugState().retryAttempts, 0, 'acceptance resets the one actual retry');
});

test('readiness probes use the same post slot and can adopt one lazy accepted snapshot', async () => {
  const active = deferred<boolean>();
  let call = 0;
  const h = harness(() => (++call === 1 ? active.promise : true));
  h.controller.markDirty();

  assert.equal(await h.controller.probe(), false, 'probe cannot bypass an unsettled normal post');
  assert.equal(h.posts.length, 1);
  active.resolve(true);
  await settle();
  h.controller.transcriptCommitted(transcriptCommit(1, h.controller.getDebugState().viewGeneration));

  h.setEligible(false);
  h.controller.markDirty();
  const probeResult = h.controller.probe();
  await settle();
  assert.equal(await probeResult, true);
  assert.equal(h.posts.at(-1)?.readinessProbe, true);
  assert.equal(h.accepted.at(-1)?.readinessProbe, true);
});

test('timeout and replacement-view invalidation isolate late true/false/reject settlements', async () => {
  const old = deferred<boolean>();
  const h = harness(() => h.posts.length === 1 ? old.promise : true);
  h.controller.markDirty();
  const oldGeneration = h.posts[0].viewGeneration;
  h.controller.invalidateView();
  await settle();

  assert.equal(h.posts.length, 2);
  assert.ok(h.posts[1].viewGeneration > oldGeneration);
  old.reject(new Error('old renderer detail'));
  await settle();
  assert.deepEqual(h.controller.getDebugState().acceptedRevisions, [2]);
  assert.ok(h.telemetry.some((event) => event.kind === 'post-late-settlement'));
});

test('disposal invalidates a pending post and prevents every late callback mutation', async () => {
  const pending = deferred<boolean>();
  const h = harness(() => pending.promise);
  h.controller.markDirty();
  h.controller.dispose();
  pending.resolve(true);
  await settle();
  h.clock.advance(1_000);
  assert.equal(h.controller.getDebugState().disposed, true);
  assert.deepEqual(h.controller.getDebugState().acceptedRevisions, []);
  assert.equal(h.clock.pendingCount(), 0);
});

test('transcript commits advance a monotonic high-water and old delayed evidence is telemetry-only', async () => {
  const h = harness(() => true);
  h.controller.markDirty(); await settle();
  const generation = h.controller.getDebugState().viewGeneration;
  h.controller.markDirty();
  h.controller.transcriptCommitted(transcriptCommit(1, generation));
  await settle();

  h.controller.transcriptCommitted(transcriptCommit(2, generation));
  assert.equal(h.controller.getDebugState().lastTranscriptCommittedRevision, 2);
  assert.deepEqual(h.controller.getDebugState().acceptedRevisions, []);
  h.controller.transcriptCommitted(transcriptCommit(1, generation, 'wrong-old'));

  assert.equal(h.defects.length, 0);
  assert.deepEqual(h.commits, [1, 2]);
  assert.ok(h.telemetry.some((event) => event.kind === 'commit-stale'));
});

test('future, unaccepted, identity-mismatch, and future-generation evidence are defects', async () => {
  const h = harness(() => true);
  h.controller.markDirty(); await settle();
  const generation = h.controller.getDebugState().viewGeneration;

  h.controller.transcriptCommitted(transcriptCommit(2, generation));
  h.controller.transcriptCommitted(transcriptCommit(1, generation, 'wrong'));
  h.controller.stateReceived({ revision: 1, viewGeneration: generation + 1, snapshotBytes: 10 });

  assert.deepEqual(h.defects.map((defect) => defect.reason), [
    'future-or-unaccepted-commit',
    'commit-identity-mismatch',
    'future-view-generation',
  ]);
});

test('old-generation state/app/transcript/paint/render-failure evidence is telemetry-only', async () => {
  const h = harness(() => true);
  h.controller.markDirty(); await settle();
  const oldGeneration = h.controller.getDebugState().viewGeneration;
  h.controller.invalidateView(); await settle();

  h.controller.stateReceived({ revision: 999, viewGeneration: oldGeneration, snapshotBytes: 1 });
  h.controller.appCommitted({ revision: 999, viewGeneration: oldGeneration, surface: 'app' });
  h.controller.transcriptCommitted(transcriptCommit(999, oldGeneration, 'bad'));
  h.controller.paintObserved({ ...transcriptCommit(999, oldGeneration, 'bad'), latencyMs: 1 });
  h.controller.renderFailure({ viewGeneration: oldGeneration, revision: 999, surface: 'transcript', classification: 'component_error' });

  assert.equal(h.defects.length, 0);
  assert.equal(h.recoveries.length, 0);
  assert.equal(h.telemetry.filter((event) => event.kind === 'evidence-stale').length, 5);
});

test('commit evidence arriving before post settlement is deferred until acceptance', async () => {
  const post = deferred<boolean>();
  const h = harness(() => post.promise);
  h.controller.markDirty();
  const generation = h.controller.getDebugState().viewGeneration;
  h.controller.transcriptCommitted(transcriptCommit(1, generation));
  assert.equal(h.controller.getDebugState().lastTranscriptCommittedRevision, 0);
  assert.equal(h.defects.length, 0);

  post.resolve(true);
  await settle();
  assert.equal(h.controller.getDebugState().lastTranscriptCommittedRevision, 1);
  assert.deepEqual(h.controller.getDebugState().acceptedRevisions, []);
});

test('host updates cannot reset the accepted revision commit deadline', async () => {
  const h = harness(() => true, { commitTimeoutMs: 100 });
  h.controller.markDirty(); await settle();
  h.clock.advance(50);
  h.controller.markDirty(); await settle();
  assert.equal(h.posts.length, 1, 'the accepted revision applies backpressure until transcript commit');
  h.clock.advance(49);
  assert.equal(h.recoveries.length, 0);
  h.clock.advance(1);

  assert.equal(h.recoveries[0].reason, 'commit-timeout');
  assert.equal(h.recoveries[0].revision, 1);
  assert.equal(h.builds.at(-1)?.desiredGeneration, 3, 'timeout retires the old acceptance and resnapshots latest host state');
  const generation = h.controller.getDebugState().viewGeneration;
  h.controller.stateReceived({ revision: 1, viewGeneration: generation, snapshotBytes: 10 });
  h.controller.appCommitted({ revision: 1, viewGeneration: generation, surface: 'app' });
  h.controller.transcriptCommitted(transcriptCommit(1, generation));
  h.controller.paintObserved({ ...transcriptCommit(1, generation), latencyMs: 1 });
  h.controller.renderFailure({ viewGeneration: generation, revision: 1, surface: 'transcript', classification: 'component_error' });
  assert.equal(h.defects.length, 0, 'late evidence for a timed-out accepted revision is stale, not defective');
  assert.equal(h.recoveries.filter((r) => r.reason === 'render-failure').length, 0, 'late render-failure for a retired revision is not a recovery trigger');
  assert.ok(h.telemetry.some((event) => event.kind === 'evidence-stale' && event.detail === 'paint-observed'), 'late paint-observed for a retired revision is stale telemetry');
  assert.ok(h.telemetry.some((event) => event.kind === 'evidence-stale' && event.detail === 'render-failure'), 'late render-failure for a retired revision is stale telemetry');
});

test('commit gating bounds accepted delivery and coalesces newer host state', async () => {
  const h = harness(() => true, { acceptedLedgerCapacity: 2 });
  h.controller.markDirty(); await settle();
  h.controller.markDirty();
  h.controller.markDirty();

  assert.deepEqual(h.controller.getDebugState().acceptedRevisions, [1]);
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.recoveries, []);

  h.controller.transcriptCommitted(transcriptCommit(1, h.controller.getDebugState().viewGeneration));
  await settle();
  assert.equal(h.posts.length, 2);
  assert.equal(h.builds[1]?.desiredGeneration, 3);
  assert.deepEqual(h.controller.getDebugState().acceptedRevisions, [2]);
});

test('hidden views pause retry and commit clocks, then resume retained dirty intent', async () => {
  const h = harness(() => false, { commitTimeoutMs: 100 });
  h.controller.markDirty(); await settle();
  h.controller.setVisible(false);
  h.clock.advance(1_000); await settle();
  assert.equal(h.posts.length, 1);
  assert.equal(h.recoveries.length, 0);

  h.controller.setVisible(true);
  await settle();
  assert.equal(h.posts.length, 2);

  const committed = harness(() => true, { commitTimeoutMs: 100 });
  committed.controller.markDirty(); await settle();
  committed.clock.advance(40);
  committed.controller.setVisible(false);
  committed.clock.advance(1_000);
  committed.controller.setVisible(true);
  committed.clock.advance(59);
  assert.equal(committed.recoveries.length, 0);
  committed.clock.advance(1);
  assert.equal(committed.recoveries[0].reason, 'commit-timeout');
});

test('ineligible dirty delivery reports blocked state and resumes on eligibility notification', async () => {
  const h = harness(() => true);
  h.setEligible(false);
  h.controller.markDirty();
  assert.equal(h.builds.length, 0);
  assert.ok(h.blocked.count > 0);

  h.setEligible(true);
  h.controller.notifyEligibilityChanged();
  await settle();
  assert.equal(h.builds.length, 1);
  assert.equal(h.controller.getDebugState().dirty, false);
});

test('typed current render failure requests immediate classified recovery without an error body', async () => {
  const h = harness(() => true);
  h.controller.markDirty(); await settle();
  const generation = h.controller.getDebugState().viewGeneration;
  h.controller.renderFailure({
    viewGeneration: generation,
    revision: 1,
    surface: 'transcript',
    classification: 'component_error',
  });
  assert.equal(h.recoveries.at(-1)?.reason, 'render-failure');
  assert.deepEqual(h.recoveries.at(-1)?.renderFailure, {
    surface: 'transcript',
    classification: 'component_error',
  });
});

test('probe cannot bypass an accepted-but-uncommitted revision', async () => {
  const h = harness(() => true);
  h.controller.markDirty(); await settle();
  assert.deepEqual(h.controller.getDebugState().acceptedRevisions, [1]);
  h.controller.markDirty();
  const postsBefore = h.posts.length;
  assert.equal(await h.controller.probe(), false, 'probe cannot bypass the accepted-but-uncommitted revision');
  assert.equal(h.posts.length, postsBefore, 'no probe post is started while an acceptance is uncommitted');
  assert.deepEqual(h.controller.getDebugState().acceptedRevisions, [1], 'the accepted revision is retained');
  h.controller.flush();
  assert.equal(h.posts.length, postsBefore, 'flush also stays gated behind the uncommitted acceptance');
});

test('a synchronous commit-timeout recovery that invalidates the view still classifies late evidence as stale', async () => {
  const h = harness(
    () => true,
    { commitTimeoutMs: 100 },
    (recovery, controller) => {
      if (recovery.reason === 'commit-timeout') controller.invalidateView();
    },
  );
  h.controller.markDirty(); await settle();
  assert.deepEqual(h.controller.getDebugState().acceptedRevisions, [1]);
  h.clock.advance(100);
  assert.equal(h.recoveries[0].reason, 'commit-timeout');
  assert.equal(h.recoveries[0].revision, 1);
  await settle();
  assert.equal(
    h.recoveries.filter((r) => r.reason === 'commit-timeout').length,
    1,
    'no duplicate commit-timeout recovery from the synchronous invalidateView',
  );
  assert.deepEqual(h.controller.getDebugState().acceptedRevisions, [2], 'the invalidated view resnapshotted and posted a fresh acceptance');
  const generation = h.controller.getDebugState().viewGeneration;
  assert.ok(generation > 1, 'the synchronous recovery invalidated the view');
  h.controller.stateReceived({ revision: 1, viewGeneration: generation, snapshotBytes: 10 });
  h.controller.appCommitted({ revision: 1, viewGeneration: generation, surface: 'app' });
  h.controller.transcriptCommitted(transcriptCommit(1, generation));
  assert.equal(h.defects.length, 0, 'late evidence for the timed-out revision is stale, not defective');
  assert.ok(h.telemetry.some((event) => event.kind === 'evidence-stale'));
  assert.ok(h.telemetry.some((event) => event.kind === 'commit-stale'));
});
