import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ComputerBackend } from '../src/backend.mjs';
import { estimateSequenceDuration, runTimedSequence } from '../src/sequence.mjs';

test('fake-clock sequence scheduling preserves source order at equal nondecreasing offsets', async () => {
  let now = 100; const sleeps: number[] = []; const order: string[] = [];
  const clock = { now: () => now, async sleep(ms: number) { sleeps.push(ms); now += ms; } };
  const trace = await runTimedSequence({ version: 1, actions: [
    { atMs: 0, action: { kind: 'key_down', key: 'W' } },
    { atMs: 0, action: { kind: 'key_down', key: 'D' } },
    { atMs: 25, action: { kind: 'key_up', key: 'W' } },
    { atMs: 25, action: { kind: 'key_up', key: 'D' } },
  ] }, async (action: any) => { order.push(`${action.kind}:${action.key}`); }, { clock });
  assert.deepEqual(order, ['key_down:W', 'key_down:D', 'key_up:W', 'key_up:D']);
  assert.deepEqual(sleeps, [25]); assert.deepEqual(trace.map((entry: any) => entry.startedAtMs), [0, 0, 25, 25]);
});

test('sequence duration accounts for serial waits, moves, and drags at equal schedule offsets', () => {
  assert.equal(estimateSequenceDuration({ version: 1, actions: [
    { atMs: 0, action: { kind: 'wait', durationMs: 100 } },
    { atMs: 0, action: { kind: 'move', target: { x: 1, y: 1 }, durationMs: 200 } },
    { atMs: 50, action: { kind: 'drag', from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, durationMs: 300 } },
  ] }), 600);
});

test('sequence cancellation is monotonic-clock driven and stops before later actions', async () => {
  const controller = new AbortController(); let now = 0; const order: string[] = [];
  const clock = { now: () => now, async sleep(ms: number) { now += ms; controller.abort(); } };
  await assert.rejects(() => runTimedSequence({ version: 1, actions: [
    { atMs: 0, action: { kind: 'text', text: 'a' } },
    { atMs: 10, action: { kind: 'text', text: 'b' } },
  ] }, async (action: any) => { order.push(action.text); }, { clock, signal: controller.signal }), (error: any) => error.code === 'CANCELLED');
  assert.deepEqual(order, ['a']);
});

function heldBackend(throwKey?: number) {
  const releasedKeys: number[] = []; const pressedKeys: number[] = [];
  const nut = {
    Key: { W: 1, D: 2, A: 3 }, Button: { LEFT: 1, MIDDLE: 2, RIGHT: 3 },
    keyboard: {
      config: {}, async pressKey(key: number) { pressedKeys.push(key); if (key === throwKey) throw new Error('injected key failure'); },
      async releaseKey(key: number) { releasedKeys.push(key); }, async type() {},
    },
    mouse: { config: {}, async pressButton() {}, async releaseButton() {}, async setPosition() {}, async getPosition() { return { x: 0, y: 0 }; } },
    screen: { async width() { return 100; }, async height() { return 100; } }, async getWindows() { return []; }, async getActiveWindow() { return { windowHandle: 99 }; },
  };
  const backend: any = new ComputerBackend({ driver: { async shutdown() {} }, nut });
  return { backend, releasedKeys, pressedKeys };
}
function seed(backend: any, artifactDir: string) {
  const target = { id: 'desktop:s', kind: 'desktop', revision: 1, desktopForegroundWindowId: 99, refs: new Map() };
  backend.sessions.set('s', { id: 's', artifactDir, targets: new Map([[target.id, target]]), activeTargetId: target.id, heldKeys: new Set(), heldButtons: new Set(), potentialKeys: new Set(), potentialButtons: new Set() });
}

test('act holds cumulatively; sequence releases only newly held input unless preserveHeld, and saves artifacts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-sequence-'));
  try {
    const fixture = heldBackend(); seed(fixture.backend, dir);
    assert.deepEqual((await fixture.backend.act({ sessionId: 's', revision: 1, input: { kind: 'key_down', key: 'W' } })).held.keys, ['W']);
    const released = await fixture.backend.runSequence({ sessionId: 's', revision: 1, sequence: { version: 1, actions: [{ atMs: 0, action: { kind: 'key_down', key: 'D' } }] }, preserveHeld: false });
    assert.deepEqual(released.held.keys, ['W']); assert.ok(fixture.releasedKeys.includes(2));
    assert.equal(JSON.parse(await readFile(released.sequencePath, 'utf8')).version, 1);
    assert.equal(JSON.parse(await readFile(released.tracePath, 'utf8')).actions[0].status, 'ok');
    const preserved = await fixture.backend.runSequence({ sessionId: 's', revision: 1, sequence: { version: 1, actions: [{ atMs: 0, action: { kind: 'key_down', key: 'D' } }] }, preserveHeld: true });
    assert.deepEqual(new Set(preserved.held.keys), new Set(['W', 'D']));
    await fixture.backend.act({ sessionId: 's', revision: 1, input: { kind: 'key_up', key: 'W' } });
    assert.deepEqual((await fixture.backend.act({ sessionId: 's', revision: 1, input: { kind: 'key_up', key: 'W' } })).held.keys, ['D'], 'key_up on an already-up key is idempotent');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('loaded sequences require a revision for target-relative coordinates in the sidecar', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-loaded-revision-'));
  try {
    const fixture = heldBackend(); seed(fixture.backend, dir); const sequencePath = path.join(dir, 'sequence.json');
    await writeFile(sequencePath, JSON.stringify({ version: 1, actions: [{ atMs: 0, action: { kind: 'move', target: { x: 1, y: 1 } } }] }));
    await assert.rejects(() => fixture.backend.runSequence({ sessionId: 's', sequencePath }), (error: any) => error.code === 'INVALID_ARGUMENTS');
    await assert.rejects(() => fixture.backend.runSequence({ sessionId: 's', sequence: { version: 1, actions: [{ atMs: 1, action: { kind: 'wait', durationMs: 600000 } }] } }), (error: any) => error.code === 'MALFORMED_SEQUENCE');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an action error releases cumulative and potential held keys', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-cleanup-'));
  try {
    const fixture = heldBackend(3); seed(fixture.backend, dir);
    await fixture.backend.act({ sessionId: 's', revision: 1, input: { kind: 'key_down', key: 'W' } });
    await assert.rejects(() => fixture.backend.act({ sessionId: 's', revision: 1, input: { kind: 'key_down', key: 'A' } }), /injected/);
    assert.deepEqual(fixture.backend.held(fixture.backend.sessions.get('s')), { keys: [], buttons: [] });
    assert.ok(fixture.releasedKeys.includes(1), 'cumulative W released'); assert.ok(fixture.releasedKeys.includes(3), 'potential A released');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
