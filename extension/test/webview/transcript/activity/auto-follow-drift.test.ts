/**
 * Auto-follow drift / spurious-disengage harness for `useTranscriptScroll`.
 *
 * The sibling `perf/auto-follow-reflow.test.ts` proves exact pinning tracks the
 * cached target without repeated reflows, but it deliberately stubs
 * `scrollTop` so writes do not dispatch scroll events. That leaves the
 * ownership path (`onScroll` → `resolveAutoFollowState`) unexercised. A false
 * disengage leaves the view stuck mid-transcript; a missed real disengage
 * fights the reader by pulling them back to the bottom.
 *
 * This harness closes that gap: `scrollTop` writes mark a dirty flag, and a
 * coalesced `scroll` event is dispatched ONCE PER FRAME, AFTER the rAF batch —
 * faithful to the browser's rendering order (rAF → layout → scroll events).
 * scrollTop is clamped on write AND on scrollHeight change (as a real browser
 * does), so shrink-clamp disengage behavior is realistic.
 *
 * Determinism: rAF is faked and flushed synchronously one frame at a time.
 * scrollHeight/clientHeight are own-property getters (observable, free).
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { useRef } from 'preact/hooks';
import { act } from 'preact/test-utils';

import { EMPTY_TRANSCRIPT_WINDOW, type ChatMessage } from '../../../../src/shared/protocol';
import {
  TRANSCRIPT_SCROLLBAR_INTERACTION_END_EVENT,
  TRANSCRIPT_SCROLLBAR_INTERACTION_START_EVENT,
} from '../../../../src/webview/panel/transcript/transcript-scrollbar-events';
import { useTranscriptScroll } from '../../../../src/webview/panel/transcript/use-transcript-scroll';

type ScrollResult = ReturnType<typeof useTranscriptScroll>;

const noop = () => {};
const TRANSCRIPT_WINDOW = { ...EMPTY_TRANSCRIPT_WINDOW, hasUserMessages: true };

// ── Controlled rAF (deterministic frame driving) ──────────────────────────────

let rafMap = new Map<number, () => void>();
let rafCounter = 0;
let origRaf: unknown;
let origCaf: unknown;

function installFakeRaf(): void {
  origRaf = globalThis.requestAnimationFrame;
  origCaf = globalThis.cancelAnimationFrame;
  rafMap = new Map();
  rafCounter = 0;
  globalThis.requestAnimationFrame = ((cb: (t: number) => void) => {
    const id = ++rafCounter;
    rafMap.set(id, () => cb(0));
    return id;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    rafMap.delete(id);
  }) as typeof globalThis.cancelAnimationFrame;
}

function restoreRaf(): void {
  globalThis.requestAnimationFrame = origRaf as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = origCaf as typeof globalThis.cancelAnimationFrame;
}

// ── Probe + metric/spy scroll element ─────────────────────────────────────────

const capture: { r: ScrollResult | null } = { r: null };

function Probe({
  totalSize,
  busy,
  transcript,
  hasNewer = false,
  hasOlder = false,
  pagingSuspended = false,
  onLoadOlder = noop,
  onJumpToLatest = noop,
  sessionKey = '/s',
}: {
  totalSize: number;
  busy: boolean;
  transcript?: readonly ChatMessage[];
  hasNewer?: boolean;
  hasOlder?: boolean;
  pagingSuspended?: boolean;
  onLoadOlder?: () => void;
  onJumpToLatest?: () => void;
  sessionKey?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const r = useTranscriptScroll({
    scrollRef,
    sessionKey,
    transcriptWindow: { ...TRANSCRIPT_WINDOW, hasNewer, hasOlder },
    transcript: transcript ?? STABLE_TRANSCRIPT,
    transcriptLength: 1,
    busy,
    onLoadOlder,
    onLoadNewer: noop,
    onJumpToLatest,
    pagingSuspended,
    totalSize,
  });
  capture.r = r;
  return h('div', { id: 'scroll-host', ref: scrollRef });
}

const STABLE_TRANSCRIPT: readonly ChatMessage[] = [];

let scrollHeightValue = 1000;
let clientHeightValue = 200;
let scrollTopValue = 0;
let scrollDirty = false;
let scrollDispatchCount = 0;

function maxScrollTop(): number {
  return Math.max(0, scrollHeightValue - clientHeightValue);
}

function clampScrollTop(v: number): number {
  return Math.max(0, Math.min(v, maxScrollTop()));
}

let el: HTMLElement;

function spyMetrics(element: HTMLElement): void {
  scrollHeightValue = 1000;
  clientHeightValue = 200;
  scrollTopValue = 0;
  scrollDirty = false;
  scrollDispatchCount = 0;
  Object.defineProperty(element, 'scrollHeight', {
    get() { return scrollHeightValue; },
    configurable: true,
  });
  Object.defineProperty(element, 'clientHeight', {
    get() { return clientHeightValue; },
    configurable: true,
  });
  // Own-property scrollTop: writes mark dirty (coalesced scroll event flushed
  // once per frame after rAF) and CLAMP to the valid range (browser behavior).
  Object.defineProperty(element, 'scrollTop', {
    get() { return scrollTopValue; },
    set(v: number) {
      scrollTopValue = clampScrollTop(v);
      scrollDirty = true;
    },
    configurable: true,
  });
}

let container: HTMLElement;
let tick = 0;

beforeEach(() => {
  installFakeRaf();
  container = document.createElement('div');
  document.body.appendChild(container);
  capture.r = null;
  tick = 0;
});

afterEach(() => {
  act(() => { render(null, container); });
  container.remove();
  restoreRaf();
});

function rerender(busy: boolean, flush: number, transcript?: readonly ChatMessage[]): void {
  tick += 1;
  act(() => {
    render(h(Probe, { totalSize: tick, busy, transcript }), container);
    if (flush > 0) flushFrames(flush);
  });
}

function mountProbe(busy: boolean): void {
  tick = 1;
  act(() => { render(h(Probe, { totalSize: tick, busy }), container); });
  el = container.querySelector('#scroll-host') as HTMLElement;
  spyMetrics(el);
}

/** Run `n` animation frames. Each frame executes every rAF callback queued at
 *  the start of the frame (a tick re-queues for the next frame), THEN dispatches
 *  one coalesced `scroll` event if any scrollTop write marked dirty — matching
 *  the browser's rAF → layout → scroll-event ordering. */
function flushFrames(n: number): void {
  for (let i = 0; i < n; i++) {
    const batch = Array.from(rafMap.values());
    rafMap.clear();
    for (const fn of batch) fn();
    if (scrollDirty) {
      scrollDirty = false;
      scrollDispatchCount++;
      el.dispatchEvent(new Event('scroll'));
    }
  }
}

/** Set scrollHeight and re-clamp scrollTop (browser clamps scrollTop to the
 *  new max when content shrinks). */
function setScrollHeight(h: number): void {
  scrollHeightValue = h;
  // Re-clamp: if scrollTop now exceeds the new max, the browser clamps it down.
  const clamped = clampScrollTop(scrollTopValue);
  if (clamped !== scrollTopValue) {
    scrollTopValue = clamped;
    scrollDirty = true; // a clamp fires a scroll event
  }
}

function settle(): void {
  rerender(true, 14);
  scrollDispatchCount = 0;
}

const bottom = () => scrollHeightValue - clientHeightValue;

// ── Tests ─────────────────────────────────────────────────────────────────────

test('steady streaming growth: auto-follow stays engaged and tracks the bottom', () => {
  mountProbe(true);
  settle();
  assert.equal(capture.r!.autoFollowRef.current, true, 'auto-follow engaged after settle');
  assert.equal(scrollTopValue, bottom(), 'sanity: pinned to the bottom');

  // Simulate several streaming snapshots: content grows at the bottom each
  // snapshot, transcript identity changes, totalSize grows. Auto-follow should
  // pin the viewport to the new bottom every time and autoFollow must NEVER
  // flip false (no user scroll-up).
  for (let i = 0; i < 20; i++) {
    scrollHeightValue += 40; // ~40px of new content per snapshot
    rerender(true, 6, []);   // fresh transcript identity + flush reset frames
    assert.equal(capture.r!.autoFollowRef.current, true, `autoFollow must stay true across snapshot ${i} (no user input)`);
    assert.equal(scrollTopValue, bottom(), `snapshot ${i}: follow should stay exactly pinned`);
  }
});

test('manual scroll-up disables follow even while the agent is busy', () => {
  mountProbe(true);
  settle();

  scrollTopValue -= 100;
  el.dispatchEvent(new Event('scroll'));
  assert.equal(capture.r!.autoFollowRef.current, false, 'manual upward movement disengages follow');

  // Busy state must not create follow work after ownership transfers to the
  // user. Only the bounded session-reset scheduler may have had a callback.
  act(() => flushFrames(1));
  assert.equal(rafMap.size, 0, 'no follow frame remains queued while scrolled up');
});

test('large burst growth stays exactly pinned and keeps follow engaged', () => {
  mountProbe(true);
  settle();
  assert.equal(scrollTopValue, bottom());

  // A single big burst (e.g. two sections opening): 600px in one snapshot.
  scrollHeightValue += 600;
  rerender(true, 6, []);
  assert.equal(capture.r!.autoFollowRef.current, true, 'autoFollow must stay true after a large burst');
  assert.equal(scrollTopValue, bottom(), 'large growth should stay exactly pinned');
});

test('content shrink while pinned: clamp must NOT disengage auto-follow', () => {
  mountProbe(true);
  settle();
  assert.equal(scrollTopValue, bottom());

  // Content above the viewport shrinks (tool card collapses / pruning): the
  // browser clamps scrollTop down to the new bottom. This must NOT trip the
  // `nextScrollTop < previousScrollTop - 1` disengage — isNearBottom (clamped
  // to the bottom) should keep follow engaged.
  setScrollHeight(scrollHeightValue - 120);
  rerender(true, 4, []);
  assert.equal(capture.r!.autoFollowRef.current, true, 'a shrink-clamp must not disengage auto-follow');
  assert.equal(scrollTopValue, bottom(), 'should be re-pinned to the new bottom');
});

test('manual scroll-up preserves the reading position while new content grows', () => {
  mountProbe(true);
  settle();

  // Stay inside the 24px visual near-bottom zone to prove even a small,
  // deliberate upward scroll transfers ownership to the user.
  scrollTopValue -= 8;
  el.dispatchEvent(new Event('scroll'));
  const readingPosition = scrollTopValue;
  assert.equal(capture.r!.autoFollowRef.current, false, 'manual upward movement disengages follow');

  // Streaming and expandable tool sections may continue growing after the
  // reader takes control. Neither the content signal nor queued frames may
  // pull the viewport back to the live edge.
  scrollHeightValue += 400;
  rerender(true, 8, []);
  assert.equal(capture.r!.autoFollowRef.current, false, 'content growth must not re-engage follow');
  assert.equal(scrollTopValue, readingPosition, 'the user-controlled reading position must be preserved');
});

test('animated close (gradual multi-frame shrink): auto-follow must NOT disengage', () => {
  // Models the 300ms grid-template-rows close animation on a tool-call body.
  // Two parallel bash calls complete and their cards animate closed over ~18
  // frames, each frame shrinking the content ~17px (≈300px total). The bottom
  // moves UP every frame. This is the user's reported scenario.
  mountProbe(true);
  settle();
  assert.equal(scrollTopValue, bottom(), 'sanity: pinned to the bottom');

  // Simulate the 300ms animated close: shrink scrollHeight frame-by-frame.
  // Each frame: content shrinks (clamp re-pins scrollTop), totalSize bumps
  // (target refresh), one rAF flush (loop tick + coalesced scroll event).
  for (let f = 0; f < 18; f++) {
    setScrollHeight(scrollHeightValue - 17);
    rerender(true, 1, []); // totalSize bump + 1 frame
    if (!capture.r!.autoFollowRef.current) {
      assert.fail(`autoFollow disengaged at animation frame ${f} (scrollTop=${scrollTopValue}, bottom=${bottom()})`);
    }
  }
  assert.equal(capture.r!.autoFollowRef.current, true, 'autoFollow must survive the animated close');
  assert.ok(Math.abs(scrollTopValue - bottom()) <= 24, `should be at bottom=${bottom()} after close, got ${scrollTopValue}`);
});

test('post-turn late measurement (busy false): auto-follow still catches up', () => {
  mountProbe(true);
  settle();
  // Agent turn ends (busy -> false) but a late image/table load grows a row.
  rerender(false, 2);
  assert.equal(capture.r!.autoFollowRef.current, true, 'autoFollow should remain true after turn ends (pinned)');

  scrollHeightValue += 80; // late row re-measurement
  rerender(false, 10, []);
  assert.equal(capture.r!.autoFollowRef.current, true, 'late growth while idle must not disengage');
  assert.ok(Math.abs(scrollTopValue - bottom()) <= 24, `late growth should be caught: scrollTop=${scrollTopValue} bottom=${bottom()}`);
});

test('REGRESSION: two parallel tool calls growing then animated-collapsing must not stop auto-follow', () => {
  // Repro of the reported scenario: two quick parallel bash tool calls run
  // (cards grow at the bottom), then complete and animated-close (collapse).
  // After the animated close, autoscroll had stopped (view stuck mid-transcript).
  mountProbe(true);
  settle();
  assert.equal(scrollTopValue, bottom(), 'sanity: pinned');

  // Tool cards appear + run: content grows at the bottom (two cards, ~300px).
  scrollHeightValue += 300;
  rerender(true, 8, []);
  assert.equal(capture.r!.autoFollowRef.current, true, 'autoFollow during tool growth');
  assert.ok(Math.abs(scrollTopValue - bottom()) <= 24, `growth: scrollTop=${scrollTopValue} bottom=${bottom()}`);

  // Animated close: the two cards collapse gradually over ~12 frames (CSS
  // transition). scrollHeight recedes each frame; the browser clamps scrollTop
  // down to the new bottom. autoFollow must NOT disengage (no user input).
  for (let i = 0; i < 12; i++) {
    setScrollHeight(scrollHeightValue - 25);
    rerender(true, 1, []);
  }
  assert.equal(capture.r!.autoFollowRef.current, true, `autoFollow must stay true after animated close (got false — STUCK)`);
  assert.ok(Math.abs(scrollTopValue - bottom()) <= 24, `after close: scrollTop=${scrollTopValue} should be at bottom=${bottom()}`);

  // And it must KEEP following new content that arrives afterwards.
  scrollHeightValue += 60;
  rerender(true, 8, []);
  assert.equal(capture.r!.autoFollowRef.current, true, 'autoFollow must re-follow new content after a collapse');
  assert.ok(Math.abs(scrollTopValue - bottom()) <= 24, `post-collapse follow: scrollTop=${scrollTopValue} bottom=${bottom()}`);
});

test('REGRESSION: sudden tool-card collapse (unmount) while pinned must not stop auto-follow', () => {
  mountProbe(true);
  settle();
  scrollHeightValue += 300;
  rerender(true, 8, []);
  // Sudden collapse (e.g. card unmounted without transition): one big shrink.
  setScrollHeight(scrollHeightValue - 300);
  rerender(true, 8, []);
  assert.equal(capture.r!.autoFollowRef.current, true, 'sudden collapse must not disengage auto-follow');
  assert.ok(Math.abs(scrollTopValue - bottom()) <= 24, `sudden collapse: scrollTop=${scrollTopValue} bottom=${bottom()}`);
});

test('sending a prompt while scrolled up re-engages follow and jumps to the bottom', () => {
  mountProbe(false);
  settle();

  scrollTopValue -= 240;
  el.dispatchEvent(new Event('scroll'));
  assert.equal(capture.r!.autoFollowRef.current, false, 'sanity: reading earlier content');

  const optimisticPrompt: ChatMessage = {
    id: 'local:new-send',
    role: 'user',
    createdAt: new Date().toISOString(),
    markdown: 'continue',
    status: 'completed',
  };
  scrollHeightValue += 120;
  rerender(true, 2, [optimisticPrompt]);

  assert.equal(capture.r!.autoFollowRef.current, true, 'a deliberate send should resume live follow');
  assert.equal(scrollTopValue, bottom(), 'a deliberate send should snap to the new bottom');
});

test('sending from a partial window requests the latest page', () => {
  mountProbe(false);
  settle();

  let jumpRequests = 0;
  const optimisticPrompt: ChatMessage = {
    id: 'local:partial-window-send',
    role: 'user',
    createdAt: new Date().toISOString(),
    markdown: 'continue from here',
    status: 'completed',
  };
  tick += 1;
  act(() => {
    render(h(Probe, {
      totalSize: tick,
      busy: true,
      transcript: [optimisticPrompt],
      hasNewer: true,
      onJumpToLatest: () => { jumpRequests += 1; },
    }), container);
  });

  assert.equal(jumpRequests, 1, 'send should load the real latest window before snapping');
  assert.equal(capture.r!.autoFollowRef.current, true, 'send should re-engage follow while the latest page loads');
});

test('starting an inline edit clears an already-in-flight pagination loading latch', () => {
  let olderRequests = 0;
  tick = 1;
  act(() => {
    render(h(Probe, {
      totalSize: tick,
      busy: false,
      hasOlder: true,
      onLoadOlder: () => { olderRequests += 1; },
    }), container);
  });
  el = container.querySelector('#scroll-host') as HTMLElement;
  spyMetrics(el);

  act(() => capture.r!.requestOlderPage());
  assert.equal(olderRequests, 1);
  assert.equal(capture.r!.isLoadingOlder, true);

  tick += 1;
  act(() => {
    render(h(Probe, {
      totalSize: tick,
      busy: false,
      hasOlder: true,
      pagingSuspended: true,
      onLoadOlder: () => { olderRequests += 1; },
    }), container);
  });

  assert.equal(capture.r!.isLoadingOlder, false);

  act(() => capture.r!.requestOlderPage());
  act(() => { el.dispatchEvent(new Event('scroll')); });
  assert.equal(olderRequests, 1, 'paging stays gated for the whole edit, not only at edit start');
  assert.equal(capture.r!.isLoadingOlder, false);
});

test('isAtBottom remains true when followed content grows', () => {
  mountProbe(true);
  settle();
  assert.equal(capture.r!.isAtBottom, true, 'sanity: settled at bottom');

  scrollHeightValue += 400;
  rerender(true, 0, []);
  assert.equal(scrollTopValue, bottom(), 'follow should pin to growth in the same commit');
  assert.equal(capture.r!.isAtBottom, true, 'the Bottom control must not flash while exact follow is active');
});

test('detached geometry growth reveals the Bottom control without requiring a scroll event', () => {
  mountProbe(false);
  settle();
  assert.equal(capture.r!.isAtBottom, true, 'sanity: settled at the current bottom');

  act(() => capture.r!.setAutoFollow(false));
  const readingPosition = scrollTopValue;
  scrollHeightValue += 400;
  rerender(false, 0);

  assert.equal(scrollTopValue, readingPosition, 'detached geometry must preserve the reading position');
  assert.equal(capture.r!.autoFollowRef.current, false, 'geometry alone must not reacquire follow ownership');
  assert.equal(capture.r!.isAtBottom, false, 'the Bottom control must reflect the new measured range immediately');
});

test('targeted navigation cannot reacquire auto-follow when an estimated target clamps to bottom', () => {
  mountProbe(false);
  settle();

  act(() => {
    capture.r!.setAutoFollow(false);
    capture.r!.navigationActiveRef.current = true;
  });
  scrollTopValue = bottom();
  capture.r!.programmaticScrollTargetRef.current = scrollTopValue;
  el.dispatchEvent(new Event('scroll'));
  assert.equal(capture.r!.autoFollowRef.current, false, 'navigation suppression survives a temporary exact-bottom clamp');

  const clampedPosition = scrollTopValue;
  scrollHeightValue += 400;
  rerender(false, 0);
  assert.equal(scrollTopValue, clampedPosition, 'geometry growth must not turn a message jump into a bottom jump');
  assert.equal(capture.r!.autoFollowRef.current, false);
});

test('manual scrolling in either direction is exposed so the anchor can yield', () => {
  mountProbe(false);
  settle();

  scrollTopValue -= 240;
  el.dispatchEvent(new Event('scroll'));
  scrollTopValue += 40;
  el.dispatchEvent(new Event('scroll'));

  assert.equal(capture.r!.autoFollowRef.current, false, 'still away from bottom');
  assert.equal(capture.r!.manualScrollActiveRef.current, true, 'manual interaction ownership should be active');
});

test('pointerless downward thumb movement reacquires manual ownership after the prior latch settles', () => {
  mountProbe(false);
  settle();

  let idleReset: TimerHandler | undefined;
  const originalSetTimeout = window.setTimeout;
  window.setTimeout = ((callback: TimerHandler) => {
    idleReset = callback;
    return 1;
  }) as typeof window.setTimeout;
  try {
    scrollTopValue -= 240;
    el.dispatchEvent(new Event('scroll'));
    assert.equal(capture.r!.autoFollowRef.current, false);
    assert.equal(capture.r!.manualScrollActiveRef.current, true);

    const settleUpwardMove = idleReset;
    if (typeof settleUpwardMove === 'function') settleUpwardMove();
    assert.equal(capture.r!.manualScrollActiveRef.current, false);

    idleReset = undefined;
    scrollTopValue += 40;
    el.dispatchEvent(new Event('scroll'));
    assert.equal(capture.r!.manualScrollActiveRef.current, true, 'detached downward movement must own scroll without pointerdown');
    assert.equal(typeof idleReset, 'function');
  } finally {
    window.setTimeout = originalSetTimeout;
  }
});

test('programmatic anchor movement does not acquire manual scroll ownership', () => {
  mountProbe(false);
  settle();

  capture.r!.autoFollowRef.current = false;
  scrollTopValue -= 40;
  capture.r!.programmaticScrollTargetRef.current = scrollTopValue;
  el.dispatchEvent(new Event('scroll'));

  assert.equal(capture.r!.programmaticScrollTargetRef.current, null, 'the expected browser event is consumed');
  assert.equal(capture.r!.manualScrollActiveRef.current, false, 'app-owned anchor movement must not start the manual latch');
});

test('coalesced pointerless thumb movement overrides the expected programmatic position', () => {
  mountProbe(false);
  settle();

  capture.r!.autoFollowRef.current = false;
  const expectedAnchorTop = scrollTopValue - 40;
  capture.r!.programmaticScrollTargetRef.current = expectedAnchorTop;
  scrollTopValue = expectedAnchorTop - 24;
  el.dispatchEvent(new Event('scroll'));

  assert.equal(capture.r!.programmaticScrollTargetRef.current, null);
  assert.equal(capture.r!.manualScrollActiveRef.current, true, 'a mismatched coalesced position belongs to the user');
});

test('session switch clears reactive manual ownership and pending programmatic target', () => {
  mountProbe(false);
  settle();

  scrollTopValue -= 80;
  el.dispatchEvent(new Event('scroll'));
  capture.r!.programmaticScrollTargetRef.current = scrollTopValue + 10;
  assert.equal(capture.r!.manualScrollActiveRef.current, true);

  tick += 1;
  act(() => {
    render(h(Probe, { totalSize: tick, busy: false, sessionKey: '/next' }), container);
  });

  assert.equal(capture.r!.manualScrollActiveRef.current, false);
  assert.equal(capture.r!.programmaticScrollTargetRef.current, null);
});

test('touchcancel releases manual ownership through the idle settle path', () => {
  mountProbe(false);
  settle();

  let idleReset: TimerHandler | undefined;
  const originalSetTimeout = window.setTimeout;
  window.setTimeout = ((callback: TimerHandler) => {
    idleReset = callback;
    return 1;
  }) as typeof window.setTimeout;
  try {
    el.dispatchEvent(new Event('touchstart'));
    assert.equal(capture.r!.manualScrollActiveRef.current, true);
    el.dispatchEvent(new Event('touchcancel'));
    assert.equal(typeof idleReset, 'function');
    const settleTouch = idleReset;
    if (typeof settleTouch === 'function') settleTouch();
    assert.equal(capture.r!.manualScrollActiveRef.current, false);
  } finally {
    window.setTimeout = originalSetTimeout;
  }
});

test('anchor yield survives a pause during a scrollbar or middle-button drag', () => {
  mountProbe(false);
  settle();

  let idleReset: TimerHandler | undefined;
  const originalSetTimeout = window.setTimeout;
  window.setTimeout = ((callback: TimerHandler) => {
    idleReset = callback;
    return 1;
  }) as typeof window.setTimeout;
  try {
    scrollTopValue -= 240;
    el.dispatchEvent(new Event('scroll'));
    el.dispatchEvent(new MouseEvent('pointerdown', { button: 0 }));
    // The pointerdown cancels the pre-existing upward-scroll fallback timer.
    // Reset the test capture because this lightweight timer mock does not
    // emulate clearTimeout removing the previously captured callback.
    idleReset = undefined;
    scrollTopValue += 40;
    el.dispatchEvent(new Event('scroll'));

    assert.equal(capture.r!.manualScrollActiveRef.current, true, 'an active pointer gesture must keep the anchor yielded');
    assert.equal(idleReset, undefined, 'active pointer gestures must not arm the idle reset');

    window.dispatchEvent(new MouseEvent('pointerup', { button: 0 }));
    assert.equal(typeof idleReset, 'function', 'release arms the idle reset');
    const runIdleReset = idleReset as TimerHandler | undefined;
    if (typeof runIdleReset === 'function') runIdleReset();
    assert.equal(capture.r!.manualScrollActiveRef.current, false, 'anchoring resumes after the idle reset');
  } finally {
    window.setTimeout = originalSetTimeout;
  }
});

test('custom thumb keeps anchor ownership yielded until its explicit release', () => {
  mountProbe(false);
  settle();

  let idleReset: TimerHandler | undefined;
  const originalSetTimeout = window.setTimeout;
  window.setTimeout = ((callback: TimerHandler) => {
    idleReset = callback;
    return 1;
  }) as typeof window.setTimeout;
  try {
    el.dispatchEvent(new Event(TRANSCRIPT_SCROLLBAR_INTERACTION_START_EVENT));
    scrollTopValue -= 120;
    el.dispatchEvent(new Event('scroll'));

    assert.equal(capture.r!.manualScrollActiveRef.current, true);
    assert.equal(idleReset, undefined, 'a paused custom drag must not arm the idle reset');

    el.dispatchEvent(new Event(TRANSCRIPT_SCROLLBAR_INTERACTION_END_EVENT));
    assert.equal(typeof idleReset, 'function', 'explicit thumb release starts the settle window');
    const runIdleReset = idleReset as TimerHandler | undefined;
    if (typeof runIdleReset === 'function') runIdleReset();
    assert.equal(capture.r!.manualScrollActiveRef.current, false);
  } finally {
    window.setTimeout = originalSetTimeout;
  }
});
