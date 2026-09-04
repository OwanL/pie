import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import {
  boundedTimerSlice,
  DeferredTriggerRegistry,
  MAX_TIMER_SLICE_MS,
} from '../../../src/host/deferred-triggers/registry';
import { appendTriggerOp, DeferredTriggerStore, replayTriggers } from '../../../src/host/deferred-triggers/store';
import type { ArchState } from '../../../src/host/core/arch-state';
import type { Event } from '../../../src/host/core/events';

/**
 * deferred-triggers registry: fire conditions, self-exclusion, OR semantics,
 * watcher-closed skip, and idempotent fire. The sidecar is pointed at a tmpdir
 * via `PI_CODING_AGENT_SESSION_DIR`; the tool's `register` op is simulated by
 * appending directly to the sidecar (the registry only reads + fires).
 */

const WATCHER = '/repo/watcher.jsonl';
const OTHER = '/repo/other.jsonl';

let dir: string;
let savedSessionDirEnv: string | undefined;
let openTabs: string[];
let dispatched: Event[];
let registries: DeferredTriggerRegistry[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-deferred-triggers-registry-test-'));
  savedSessionDirEnv = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(dir, 'sessions');
  openTabs = [WATCHER];
  dispatched = [];
  registries = [];
});

afterEach(() => {
  for (const r of registries) r.dispose();
  registries = [];
  if (savedSessionDirEnv === undefined) {
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
  } else {
    process.env.PI_CODING_AGENT_SESSION_DIR = savedSessionDirEnv;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeArchState(): ArchState {
  return { sessions: { openTabPaths: openTabs } } as unknown as ArchState;
}

function newRegistry(): DeferredTriggerRegistry {
  const registry = new DeferredTriggerRegistry({
    getArchState: fakeArchState,
    dispatchArch: (event) => dispatched.push(event),
    // No-op watcher: avoids `fs.watch` (libuv crashes on Windows under rapid
    // create/dispose in tests). `start()` still calls `reload()` once.
    startWatcher: () => () => {},
  });
  registry.start();
  registries.push(registry);
  return registry;
}

function register(id: string, sessionPath: string, triggers: unknown[], note = '', at?: string): void {
  appendTriggerOp({
    id,
    op: 'register',
    sessionPath,
    triggers: triggers as never,
    note,
    at: at ?? new Date().toISOString(),
  });
}

function sentTexts(): string[] {
  return dispatched
    .filter((e) => e.kind === 'Command')
    .map((e) => (e as { cmd?: { text?: string } }).cmd?.text ?? '');
}

function sentCommands(): { kind: string; corrId?: string; customType?: string; customDetails?: unknown; text?: string }[] {
  return dispatched
    .filter((e) => e.kind === 'Command')
    .map((e) => (e as { cmd?: { kind: string; corrId?: string; customType?: string; customDetails?: unknown; text?: string } }).cmd ?? { kind: 'unknown' });
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('session_finished (any): fires when another session finishes, delivers wake-up to watcher', () => {
  register('t1', WATCHER, [{ kind: 'session_finished' }], 'mark done + close');
  const r = newRegistry();
  r.onSessionFinished(OTHER);
  assert.equal(dispatched.length, 1);
  const text = sentTexts()[0];
  assert.match(text, /\[deferred trigger fired: session finished \(any open session\)\]/);
  assert.match(text, /Task note:\nmark done \+ close/);
});

test('synthetic wake-up Send is tagged for timer/session-finished differentiation', () => {
  register('t1', WATCHER, [{ kind: 'session_finished' }], 'note');
  const r = newRegistry();
  r.onSessionFinished(OTHER);
  const cmd = sentCommands()[0];
  assert.equal(cmd.kind, 'Send');
  assert.equal(cmd.customType, 'deferred-trigger');
  assert.deepEqual(cmd.customDetails, { reason: 'session finished (any open session)' });
});

test('session_finished: does NOT self-wake when the watcher itself finishes', () => {
  register('t1', WATCHER, [{ kind: 'session_finished' }], 'note');
  const r = newRegistry();
  r.onSessionFinished(WATCHER); // watcher's own turn ending
  assert.equal(dispatched.length, 0);
});

test('session_finished (specific): fires only for the matching path', () => {
  register('t1', WATCHER, [{ kind: 'session_finished', sessionPath: OTHER }], 'note');
  const r = newRegistry();
  r.onSessionFinished('/repo/unrelated.jsonl');
  assert.equal(dispatched.length, 0);
  r.onSessionFinished(OTHER);
  assert.equal(dispatched.length, 1);
});

test('user_input: the real user prompt consumes the trigger without a synthetic Send', () => {
  register('t1', WATCHER, [{ kind: 'user_input' }], 'note');
  const r = newRegistry();
  r.onUserInput('/repo/unrelated.jsonl', 'real-send');
  assert.equal(dispatched.length, 0);
  r.onUserInput(WATCHER, 'real-send');
  assert.equal(dispatched.length, 0, 'the router already dispatched the sole real-user Send');
  const claimed = replayTriggers(new DeferredTriggerStore().readOps()).get('t1');
  assert.equal(claimed?.deliveryState, 'claimed');
  assert.equal(claimed?.recoveryState, 'acknowledgement-ambiguous', 'the real prompt was already dispatched');
  r.onSendResult('real-send', true);
  assert.equal(replayTriggers(new DeferredTriggerStore().readOps()).size, 0);
  const sidecar = fs.readFileSync(path.join(dir, 'deferred-triggers', 'triggers.jsonl'), 'utf8');
  assert.match(sidecar, /"op":"claim"/);
  assert.match(sidecar, /"op":"fire"/);
});

test('timer: delays beyond Node setTimeout range are scheduled in bounded slices', () => {
  assert.equal(boundedTimerSlice(MAX_TIMER_SLICE_MS + 60_000), MAX_TIMER_SLICE_MS);
  assert.equal(boundedTimerSlice(60_000), 60_000);
});

test('timer: an already-elapsed timer fires on start via setImmediate', async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  register('t1', WATCHER, [{ kind: 'timer', ms: 1000 }], 'note', past);
  newRegistry();
  await flushMicrotasks();
  assert.equal(dispatched.length, 1);
  assert.match(sentTexts()[0], /timer elapsed after 1000ms/);
});

test('OR semantics: once one spec fires, the whole trigger is consumed', async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  register('t1', WATCHER, [{ kind: 'session_finished' }, { kind: 'timer', ms: 1000 }], 'note', past);
  const r = newRegistry();
  await flushMicrotasks(); // timer fires first
  assert.equal(dispatched.length, 1);
  r.onSessionFinished(OTHER); // trigger already consumed
  assert.equal(dispatched.length, 1);
});

test('watcher tab closed: delivery is explicit and retryable, not consumed', () => {
  register('t1', WATCHER, [{ kind: 'session_finished' }], 'note');
  openTabs = []; // watcher no longer open
  const r = newRegistry();
  r.onSessionFinished(OTHER);
  assert.equal(dispatched.length, 0);
  const active = r.getActiveTriggers();
  assert.equal(active.length, 1);
  assert.equal(active[0]?.deliveryState, 'retryable');
  assert.match(active[0]?.deliveryDetail ?? '', /tab is closed/);
  const sidecar = fs.readFileSync(path.join(dir, 'deferred-triggers', 'triggers.jsonl'), 'utf8');
  assert.match(sidecar, /"op":"failed"/);
  assert.doesNotMatch(sidecar, /"op":"fire"/);
});

test('opening a watcher retries a retained one-shot timer wake', async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  register('t1', WATCHER, [{ kind: 'timer', ms: 1000 }], 'note', past);
  openTabs = [];
  const r = newRegistry();
  await flushMicrotasks();
  assert.equal(r.getActiveTriggers()[0]?.deliveryState, 'retryable');

  openTabs = [WATCHER];
  r.onSessionOpened(WATCHER);
  assert.equal(dispatched.length, 1);
  const corrId = sentCommands()[0]?.corrId ?? '';
  r.onSendResult(corrId, true);
  assert.equal(r.getActiveTriggers().length, 0);
});

test('fire is idempotent: a second fire for the same id does not double-deliver', () => {
  register('t1', WATCHER, [{ kind: 'session_finished' }], 'note');
  const r = newRegistry();
  r.onSessionFinished(OTHER);
  r.fire('t1', 'again'); // already consumed
  assert.equal(dispatched.length, 1);
});

test('two registry/store instances racing the same stale trigger dispatch at most once', () => {
  register('t1', WATCHER, [{ kind: 'session_finished' }], 'note');
  const file = path.join(dir, 'deferred-triggers', 'triggers.jsonl');
  const first = new DeferredTriggerRegistry({
    getArchState: fakeArchState,
    dispatchArch: (event) => dispatched.push(event),
    startWatcher: () => () => {},
    store: new DeferredTriggerStore(file),
    instanceId: 'host-a',
  });
  const second = new DeferredTriggerRegistry({
    getArchState: fakeArchState,
    dispatchArch: (event) => dispatched.push(event),
    startWatcher: () => () => {},
    store: new DeferredTriggerStore(file),
    instanceId: 'host-b',
  });
  first.start();
  second.start();
  registries.push(first, second);

  // Both registries loaded the trigger before either tried delivery.
  first.fire('t1', 'race');
  second.fire('t1', 'race');

  assert.equal(dispatched.length, 1);
  assert.equal(replayTriggers(new DeferredTriggerStore(file).readOps()).get('t1')?.deliveryState, 'claimed');
  first.onSendResult(sentCommands()[0]?.corrId ?? '', true);
  assert.equal(replayTriggers(new DeferredTriggerStore(file).readOps()).size, 0);
});

test('startup automatically retries a safely recovered synthetic wake for an open watcher', async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  register('t1', WATCHER, [{ kind: 'timer', ms: 1000 }], 'note', past);
  const file = path.join(dir, 'deferred-triggers', 'triggers.jsonl');
  const crashedStore = new DeferredTriggerStore(file);
  assert.ok(crashedStore.tryClaim('t1', WATCHER, 'crashed-host', 51_000, 'timer elapsed'));

  const registry = new DeferredTriggerRegistry({
    getArchState: fakeArchState,
    dispatchArch: (event) => dispatched.push(event),
    startWatcher: () => () => {},
    store: new DeferredTriggerStore(file),
    instanceId: 'recovery-host',
    ownerPid: 51_001,
    checkOwnerLiveness: () => 'dead',
  });
  registry.start();
  registries.push(registry);

  assert.equal(registry.getActiveTriggers()[0]?.recoveryState, 'dead-owner-recovered');
  await flushMicrotasks();
  assert.equal(dispatched.length, 1);
  assert.match(sentTexts()[0] ?? '', /timer elapsed/);
});

test('two registries racing dead-owner recovery produce one retryable state and at most one new dispatch', async () => {
  register('t1', WATCHER, [{ kind: 'session_finished' }], 'note');
  const file = path.join(dir, 'deferred-triggers', 'triggers.jsonl');
  const crashedStore = new DeferredTriggerStore(file);
  assert.ok(crashedStore.tryClaim('t1', WATCHER, 'crashed-host', 51_001, 'session finished'));

  let secondStarted = false;
  const second = new DeferredTriggerRegistry({
    getArchState: fakeArchState,
    dispatchArch: (event) => dispatched.push(event),
    startWatcher: () => () => {},
    store: new DeferredTriggerStore(file),
    instanceId: 'recovery-host-b',
    ownerPid: 51_003,
    checkOwnerLiveness: () => 'dead',
  });
  const first = new DeferredTriggerRegistry({
    getArchState: fakeArchState,
    dispatchArch: (event) => dispatched.push(event),
    startWatcher: () => () => {},
    store: new DeferredTriggerStore(file),
    instanceId: 'recovery-host-a',
    ownerPid: 51_002,
    checkOwnerLiveness: () => {
      if (!secondStarted) {
        secondStarted = true;
        second.start();
      }
      return 'dead';
    },
  });
  first.start();
  registries.push(first, second);

  for (const registry of [first, second]) {
    const active = registry.getActiveTriggers()[0];
    assert.equal(active?.deliveryState, 'retryable');
    assert.equal(active?.recoveryState, 'dead-owner-recovered');
  }

  // Both hosts schedule the same safe automatic retry. The fixed claim
  // artifact still selects exactly one new live owner.
  await flushMicrotasks();
  assert.equal(dispatched.length, 1);
  const active = replayTriggers(new DeferredTriggerStore(file).readOps()).get('t1');
  assert.equal(active?.deliveryState, 'claimed');
  assert.equal(active?.recoveryState, 'acknowledgement-ambiguous');

  first.onSendResult(sentCommands()[0]?.corrId ?? '', true);
  second.onSendResult(sentCommands()[0]?.corrId ?? '', true);
  assert.equal(replayTriggers(new DeferredTriggerStore(file).readOps()).size, 0);
});

test('a rejected synthetic Send remains retryable without an automatic refire loop', async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  register('t1', WATCHER, [{ kind: 'timer', ms: 1000 }], 'note', past);
  const registry = newRegistry();
  await flushMicrotasks();
  const corrId = sentCommands()[0]?.corrId ?? '';

  registry.onSendResult(corrId, false, 'backend rejected wake');

  const active = registry.getActiveTriggers();
  assert.equal(active.length, 1);
  assert.equal(active[0]?.deliveryState, 'retryable');
  assert.equal(active[0]?.deliveryDetail, 'backend rejected wake');
  await flushMicrotasks();
  assert.equal(dispatched.length, 1, 'retry waits for an explicit reopen instead of spinning');
});

test('a definite dispatch failure releases the claim and remains retryable', () => {
  register('t1', WATCHER, [{ kind: 'session_finished' }], 'note');
  const registry = new DeferredTriggerRegistry({
    getArchState: fakeArchState,
    dispatchArch: () => { throw new Error('closed delivery surface'); },
    startWatcher: () => () => {},
    instanceId: 'failing-host',
  });
  registry.start();
  registries.push(registry);

  registry.fire('t1', 'delivery test');

  const active = registry.getActiveTriggers();
  assert.equal(active.length, 1);
  assert.equal(active[0]?.deliveryState, 'retryable');
  assert.match(active[0]?.deliveryDetail ?? '', /dispatch failed/);
});

test('timer: multiple timer specs arm the earliest deadline (OR semantics)', async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  register('t1', WATCHER, [{ kind: 'timer', ms: 5000 }, { kind: 'timer', ms: 2000 }], 'note', past);
  newRegistry();
  await flushMicrotasks();
  assert.equal(dispatched.length, 1);
  assert.match(sentTexts()[0], /timer elapsed after 2000ms/);
});


// ── cancel() + getActiveTriggers() (webview status-strip cancel affordance) ──
// Registers are appended BEFORE the registry reads the sidecar (start() is
// idempotent — a second call does not reload), matching the existing test
// pattern. The no-op watcher means reload only runs once at start().

test('getActiveTriggers: returns the registered active set (empty when none)', () => {
  const r0 = newRegistry();
  assert.equal(r0.getActiveTriggers().length, 0);

  register('t1', WATCHER, [{ kind: 'session_finished' }], 'note-a');
  register('t2', OTHER, [{ kind: 'timer', ms: 5000 }], 'note-b');
  const r = newRegistry(); // start() reads both registers
  const active = r.getActiveTriggers();
  assert.equal(active.length, 2);
  assert.ok(active.some((t) => t.id === 't1' && t.sessionPath === WATCHER && t.note === 'note-a'));
  assert.ok(active.some((t) => t.id === 't2' && t.sessionPath === OTHER));
});

test('cancel(targetId): removes only that trigger in-memory + persists a cancel op + renders', () => {
  let renders = 0;
  register('t1', WATCHER, [{ kind: 'session_finished' }], 'keep');
  register('t2', WATCHER, [{ kind: 'timer', ms: 5000 }], 'cancel me');
  const r = new DeferredTriggerRegistry({
    getArchState: fakeArchState,
    dispatchArch: (event) => dispatched.push(event),
    scheduleRender: () => { renders++; },
    startWatcher: () => () => {},
  });
  r.start();
  registries.push(r);
  assert.equal(r.getActiveTriggers().length, 2);

  const rendersBefore = renders;
  r.cancel(WATCHER, 't2');

  const active = r.getActiveTriggers();
  assert.equal(active.length, 1);
  assert.equal(active[0]?.id, 't1');
  assert.ok(renders > rendersBefore, 'cancel scheduled a render');
  // A cancel op was persisted (a restart will not re-arm t2).
  const sidecar = fs.readFileSync(path.join(dir, 'deferred-triggers', 'triggers.jsonl'), 'utf8');
  assert.match(sidecar, /"op":"cancel","sessionPath":"\/repo\/watcher\.jsonl","targetId":"t2"/);
  // No wake-up is dispatched on cancel (only fire delivers a wake-up).
  assert.equal(dispatched.length, 0);
});

test('cancel(sessionPath) with no targetId: removes ALL triggers for that session only', () => {
  register('t1', WATCHER, [{ kind: 'session_finished' }], 'a');
  register('t2', WATCHER, [{ kind: 'timer', ms: 5000 }], 'b');
  register('t3', OTHER, [{ kind: 'session_finished' }], 'c');
  const r = newRegistry();
  assert.equal(r.getActiveTriggers().length, 3);

  r.cancel(WATCHER); // cancel all for WATCHER, leave OTHER untouched

  const active = r.getActiveTriggers();
  assert.equal(active.length, 1);
  assert.equal(active[0]?.id, 't3');
  assert.equal(active[0]?.sessionPath, OTHER);
});

test('cancel of an unknown targetId still persists the op + renders (matches tool semantics)', () => {
  let renders = 0;
  register('t1', WATCHER, [{ kind: 'session_finished' }], 'a');
  const r = new DeferredTriggerRegistry({
    getArchState: fakeArchState,
    dispatchArch: (event) => dispatched.push(event),
    scheduleRender: () => { renders++; },
    startWatcher: () => () => {},
  });
  r.start();
  registries.push(r);

  const rendersBefore = renders;
  r.cancel(WATCHER, 'does-not-exist');
  // The unknown id is not removed (still 1 active), but a cancel op is still
  // persisted and a render is requested — matching the tool's cancel semantics.
  assert.equal(r.getActiveTriggers().length, 1);
  assert.ok(renders > rendersBefore);
});
