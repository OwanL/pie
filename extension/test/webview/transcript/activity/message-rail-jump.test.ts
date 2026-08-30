import assert from 'node:assert/strict';
import test from 'node:test';

import { createMessageRailJumpController } from '../../../../src/webview/panel/transcript/message-rail-jump';

function harness() {
  let scrollTop = 0;
  let scrollHeight = 1_000;
  let rowStart = 600;
  let now = 0;
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const navigationActiveRef = { current: false };
  const programmaticScrollTargetRef = { current: null as number | null };
  const followWrites: boolean[] = [];
  const element = {
    clientHeight: 100,
    get scrollHeight() { return scrollHeight; },
    get scrollTop() { return scrollTop; },
    set scrollTop(value: number) { scrollTop = Math.max(0, Math.min(value, scrollHeight - 100)); },
    style: { scrollBehavior: '' },
  } as unknown as HTMLDivElement;
  const controller = createMessageRailJumpController({
    element,
    getRowStart: () => rowStart,
    navigationActiveRef,
    programmaticScrollTargetRef,
    setAutoFollow: (value) => followWrites.push(value),
    requestFrame: (callback) => {
      const id = ++frameId;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => { frames.delete(id); },
    now: () => now,
  });
  const flushFrame = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(now);
  };
  return {
    controller,
    navigationActiveRef,
    programmaticScrollTargetRef,
    followWrites,
    get scrollTop() { return scrollTop; },
    set rowStart(value: number) { rowStart = value; },
    set scrollHeight(value: number) { scrollHeight = value; },
    set now(value: number) { now = value; },
    flushFrame,
  };
}

test('message rail jump follows measured target movement, then yields permanently to manual input', () => {
  const probe = harness();
  probe.controller.jumpTo(4);
  assert.equal(probe.scrollTop, 600, 'jump owns an immediate estimated alignment');
  assert.equal(probe.navigationActiveRef.current, true);
  assert.deepEqual(probe.followWrites, [false]);

  probe.rowStart = 750;
  probe.now = 16;
  probe.flushFrame();
  assert.equal(probe.scrollTop, 750, 'measurement drift is corrected during the bounded settle');

  probe.navigationActiveRef.current = false; // wheel/thumb/keyboard intent
  probe.rowStart = 820;
  probe.now = 32;
  probe.flushFrame();
  assert.equal(probe.scrollTop, 750, 'a manual cancellation cannot be overwritten by a later settle frame');
});

test('message rail jump releases ownership after stable measured geometry', () => {
  const probe = harness();
  probe.controller.jumpTo(3);
  probe.now = 1_500;
  probe.flushFrame();
  probe.now = 1_516;
  probe.flushFrame();

  assert.equal(probe.navigationActiveRef.current, false);
  assert.equal(probe.programmaticScrollTargetRef.current, 600);
});

test('message rail jump aligns the last reachable target to the native maximum', () => {
  const probe = harness();
  probe.rowStart = 1_400;
  probe.scrollHeight = 1_000;
  probe.controller.jumpTo(9);

  assert.equal(probe.scrollTop, 900);
  assert.equal(probe.navigationActiveRef.current, true, 'temporary bottom clamping does not complete navigation early');
});
