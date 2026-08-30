import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { TranscriptScrollbar } from '../../../../src/webview/panel/transcript/transcript-scrollbar';
import {
  TRANSCRIPT_SCROLLBAR_INTERACTION_END_EVENT,
  TRANSCRIPT_SCROLLBAR_INTERACTION_START_EVENT,
} from '../../../../src/webview/panel/transcript/transcript-scrollbar-events';
import {
  createTranscriptScrollbarDragSnapshot,
  deriveTranscriptScrollbarGeometry,
  resolveTranscriptScrollbarDrag,
} from '../../../../src/webview/panel/transcript/transcript-scrollbar-model';

test('geometry preserves proportional position with a minimum usable thumb', () => {
  const proportional = deriveTranscriptScrollbarGeometry({
    scrollTop: 400,
    scrollHeight: 1_000,
    clientHeight: 200,
    trackSize: 200,
  });
  assert.deepEqual(proportional, {
    hasOverflow: true,
    maxScroll: 800,
    thumbSize: 40,
    maxThumbOffset: 160,
    thumbOffset: 80,
  });

  const longTranscript = deriveTranscriptScrollbarGeometry({
    scrollTop: 0,
    scrollHeight: 100_000,
    clientHeight: 200,
    trackSize: 200,
  });
  assert.equal(longTranscript.thumbSize, 24);
  assert.equal(longTranscript.maxThumbOffset, 176);
});

test('drag mapping remains frozen when live transcript height changes', () => {
  const original = deriveTranscriptScrollbarGeometry({
    scrollTop: 1_900,
    scrollHeight: 10_000,
    clientHeight: 500,
    trackSize: 500,
  });
  const snapshot = createTranscriptScrollbarDragSnapshot(original, 200);

  // Streaming doubles the live content range after pointerdown. The snapshot
  // deliberately remains the authority until release.
  const changed = deriveTranscriptScrollbarGeometry({
    scrollTop: 1_900,
    scrollHeight: 20_000,
    clientHeight: 500,
    trackSize: 500,
  });
  assert.notEqual(changed.maxScroll, snapshot.maxScroll);
  assert.notEqual(changed.thumbSize, snapshot.thumbSize);

  const resolved = resolveTranscriptScrollbarDrag(snapshot, 260);
  assert.equal(resolved.thumbOffset, original.thumbOffset + 60);
  assert.equal(
    resolved.scrollTop,
    (resolved.thumbOffset / snapshot.maxThumbOffset) * snapshot.maxScroll,
  );
});

test('drag mapping clamps at both ends of the captured track', () => {
  const geometry = deriveTranscriptScrollbarGeometry({
    scrollTop: 400,
    scrollHeight: 1_000,
    clientHeight: 200,
    trackSize: 200,
  });
  const snapshot = createTranscriptScrollbarDragSnapshot(geometry, 100);

  assert.deepEqual(resolveTranscriptScrollbarDrag(snapshot, -1_000), {
    thumbOffset: 0,
    scrollTop: 0,
  });
  assert.deepEqual(resolveTranscriptScrollbarDrag(snapshot, 1_000), {
    thumbOffset: 160,
    scrollTop: 800,
  });
});

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => render(null, container));
  container.remove();
});

function pointerEvent(type: string, clientY: number, pointerId = 7): Event {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientY });
  Object.defineProperty(event, 'pointerId', { configurable: true, value: pointerId });
  return event;
}

test('component keeps the pill under the pointer and reconciles only on release', () => {
  const scrollRef: { current: HTMLDivElement | null } = { current: null };
  let scrollHeight = 1_000;
  let scrollTop = 400;
  const renderScrollbar = (totalSize: number) => {
    act(() => {
      render(h('div', {},
        h('div', { ref: scrollRef }),
        h(TranscriptScrollbar, { scrollRef, totalSize }),
      ), container);
    });
  };

  renderScrollbar(1_000);
  const scrollElement = scrollRef.current!;
  const track = container.querySelector('.transcript-scrollbar') as HTMLDivElement;
  const thumb = container.querySelector('.transcript-scrollbar-thumb') as HTMLDivElement;
  Object.defineProperties(scrollElement, {
    clientHeight: { configurable: true, get: () => 200 },
    scrollHeight: { configurable: true, get: () => scrollHeight },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = Math.max(0, Math.min(value, scrollHeight - 200)); },
    },
  });
  track.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, right: 10, bottom: 200, left: 0,
    width: 10, height: 200, toJSON: () => ({}),
  });
  track.setPointerCapture = () => undefined;
  track.hasPointerCapture = () => false;

  const interactionEvents: string[] = [];
  scrollElement.addEventListener(TRANSCRIPT_SCROLLBAR_INTERACTION_START_EVENT, () => interactionEvents.push('start'));
  scrollElement.addEventListener(TRANSCRIPT_SCROLLBAR_INTERACTION_END_EVENT, () => interactionEvents.push('end'));

  renderScrollbar(1_001);
  assert.equal(track.hidden, false, 'initial hidden chrome must resolve from the scroll viewport height');
  assert.equal(thumb.style.height, '40px');
  assert.equal(thumb.style.transform, 'translateY(80px)');

  thumb.dispatchEvent(pointerEvent('pointerdown', 90));
  scrollHeight = 2_000;
  renderScrollbar(2_000);
  assert.equal(thumb.style.height, '40px', 'live range growth must not resize an active thumb');

  window.dispatchEvent(pointerEvent('pointermove', 110));
  assert.equal(thumb.style.transform, 'translateY(100px)', 'the pill follows the 20px pointer delta exactly');
  assert.equal(scrollTop, 500, 'content uses the frozen pointer-to-scroll mapping');

  window.dispatchEvent(pointerEvent('pointerup', 110));
  assert.equal(thumb.style.height, '24px', 'release reconciles to current geometry');
  assert.match(thumb.style.transform, /^translateY\(48\.8/);
  assert.deepEqual(interactionEvents, ['start', 'end']);
});
