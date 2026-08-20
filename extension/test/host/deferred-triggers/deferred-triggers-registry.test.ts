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
import { appendTriggerOp } from '../../../src/host/deferred-triggers/store';
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

function sentCommands(): { kind: string; customType?: string; customDetails?: unknown; text?: string }[] {
  return dispatched
    .filter((e) => e.kind === 'Command')
    .map((e) => (e as { cmd?: { kind: string; customType?: string; customDetails?: unknown; text?: string } }).cmd ?? { kind: 'unknown' });
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

test('wake-up Send is tagged with customType=deferred-trigger + reason for webview differentiation', () => {
  register('t1', WATCHER, [{ kind: 'user_input' }], 'note');
  const r = newRegistry();
  r.onUserInput(WATCHER);
  const cmd = sentCommands()[0];
  assert.equal(cmd.kind, 'Send');
  assert.equal(cmd.customType, 'deferred-trigger');
  assert.deepEqual(cmd.customDetails, { reason: 'user input received in this session' });
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

test('user_input: fires when the user sends in the watcher session', () => {
  register('t1', WATCHER, [{ kind: 'user_input' }], 'note');
  const r = newRegistry();
  r.onUserInput('/repo/unrelated.jsonl');
  assert.equal(dispatched.length, 0);
  r.onUserInput(WATCHER);
  assert.equal(dispatched.length, 1);
  assert.match(sentTexts()[0], /user input received in this session/);
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

test('watcher tab closed: fire persists the op but skips delivery', () => {
  register('t1', WATCHER, [{ kind: 'session_finished' }], 'note');
  openTabs = []; // watcher no longer open
  const r = newRegistry();
  r.onSessionFinished(OTHER);
  assert.equal(dispatched.length, 0);
  // The fire op was still persisted (a restart won't re-arm it).
  const sidecar = fs.readFileSync(path.join(dir, 'deferred-triggers', 'triggers.jsonl'), 'utf8');
  assert.match(sidecar, /"op":"fire"/);
});

test('fire is idempotent: a second fire for the same id does not double-deliver', () => {
  register('t1', WATCHER, [{ kind: 'session_finished' }], 'note');
  const r = newRegistry();
  r.onSessionFinished(OTHER);
  r.fire('t1', 'again'); // already consumed
  assert.equal(dispatched.length, 1);
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
