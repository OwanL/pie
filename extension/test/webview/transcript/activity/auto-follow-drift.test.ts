/**
 * Auto-follow drift / spurious-disengage harness for `useTranscriptScroll`.
 *
 * The sibling `perf/auto-follow-reflow.test.ts` proves the loop tracks the
 * cached target without per-frame reflows — but it deliberately stubs
 * `scrollTop` so writes do NOT dispatch scroll events. That leaves the
 * DISENGAGE path (`onScroll` → `resolveAutoFollowState` → autoFollow=false →
 * loop stops easing) completely unexercised. "Autoscroll drifts from the
 * bottom and gets stuck in the middle" is exactly that path firing spuriously:
 * once autoFollow flips false without a real user scroll-up, the loop stops
 * easing and the view is left mid-transcript while content keeps growing.
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
  onJumpToLatest = noop,
}: {
  totalSize: number;
  busy: boolean;
  transcript?: readonly ChatMessage[];
  hasNewer?: boolean;
  onJumpToLatest?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const r = useTranscriptScroll({
    scrollRef,
    sessionKey: '/s',
    transcriptWindow: { ...TRANSCRIPT_WINDOW, hasNewer },
    transcript: transcript ?? STABLE_TRANSCRIPT,
    transcriptLength: 1,
    busy,
    onLoadOlder: noop,
    onLoadNewer: noop,
    onJumpToLatest,
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
  // snapshot, transcript identity changes, totalSize grows. The loop should
  // ease the viewport to the new bottom every time and autoFollow must NEVER
  // flip false (no user scroll-up).
  for (let i = 0; i < 20; i++) {
    scrollHeightValue += 40; // ~40px of new content per snapshot
    rerender(true, 6, []);   // fresh transcript identity + flush easing frames
    assert.equal(capture.r!.autoFollowRef.current, true, `autoFollow must stay true across snapshot ${i} (no user input)`);
    assert.ok(
      Math.abs(scrollTopValue - bottom()) <= 24,
      `snapshot ${i}: scrollTop=${scrollTopValue} should track bottom=${bottom()} (within near-bottom threshold)`,
    );
  }
});

test('manual scroll-up stops the follow rAF even while the agent is busy', () => {
  mountProbe(true);
  settle();

  scrollTopValue -= 100;
  el.dispatchEvent(new Event('scroll'));
  assert.equal(capture.r!.autoFollowRef.current, false, 'manual upward movement disengages follow');

  // Flush the one callback scheduled by the restarted effect. It must not
  // enqueue another merely because busy=true; that no-op 60fps loop made
  // manual scrolling compete for main-thread time during active turns.
  act(() => flushFrames(1));
  assert.equal(rafMap.size, 0, 'no follow frame remains queued while scrolled up');
});

test('large burst growth (>snap threshold): auto-follow snaps and stays engaged', () => {
  mountProbe(true);
  settle();
  assert.equal(scrollTopValue, bottom());

  // A single big burst (e.g. two sections opening): 600px in one snapshot.
  scrollHeightValue += 600;
  rerender(true, 6, []);
  assert.equal(capture.r!.autoFollowRef.current, true, 'autoFollow must stay true after a large burst');
  assert.ok(Math.abs(scrollTopValue - bottom()) <= 24, `scrollTop=${scrollTopValue} should be at bottom=${bottom()} after burst`);
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

test('content shrink while trailing (mid-ease): must not spuriously disengage', () => {
  mountProbe(true);
  settle();
  // Create a trailing gap: grow the bottom a lot in one step so the loop is
  // mid-ease (not yet at the bottom) when the shrink lands.
  scrollHeightValue += 400;
  rerender(true, 1, []); // one frame: loop has eased only partway -> trailing
  const trailing = scrollTopValue;
  assert.ok(trailing < bottom(), 'sanity: should be trailing the bottom');

  // Now shrink content slightly while trailing. Whatever happens, autoFollow
  // must not flip false without a user scroll-up.
  setScrollHeight(scrollHeightValue - 30);
  rerender(true, 8, []);
  assert.equal(capture.r!.autoFollowRef.current, true, 'shrink while trailing must not disengage auto-follow');
  assert.ok(Math.abs(scrollTopValue - bottom()) <= 24, `should recover to bottom=${bottom()}, got ${scrollTopValue}`);
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

test('isAtBottom reflects real distance while auto-follow is catching up', () => {
  mountProbe(true);
  settle();
  assert.equal(capture.r!.isAtBottom, true, 'sanity: settled at bottom');

  scrollHeightValue += 400;
  rerender(true, 1, []);
  assert.ok(scrollTopValue < bottom() - 24, 'sanity: first ease frame is still away from bottom');
  assert.equal(capture.r!.isAtBottom, false, 'jump control must remain visible while catching up');

  act(() => flushFrames(8));
  assert.equal(scrollTopValue, bottom(), 'follow should converge');
  assert.equal(capture.r!.isAtBottom, true, 'bottom state should become true after convergence');
});

test('downward manual scrolling is exposed so the anchor can yield', () => {
  mountProbe(false);
  settle();

  scrollTopValue -= 240;
  el.dispatchEvent(new Event('scroll'));
  scrollTopValue += 40;
  el.dispatchEvent(new Event('scroll'));

  assert.equal(capture.r!.autoFollowRef.current, false, 'still away from bottom');
  assert.equal(capture.r!.isScrollingTowardBottomRef.current, true, 'downward interaction signal should be active');
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
    scrollTopValue += 40;
    el.dispatchEvent(new Event('scroll'));

    assert.equal(capture.r!.isScrollingTowardBottomRef.current, true, 'an active pointer gesture must keep the anchor yielded');
    assert.equal(idleReset, undefined, 'active pointer gestures must not arm the idle reset');

    window.dispatchEvent(new MouseEvent('pointerup', { button: 0 }));
    assert.equal(typeof idleReset, 'function', 'release arms the idle reset');
    const runIdleReset = idleReset as TimerHandler | undefined;
    if (typeof runIdleReset === 'function') runIdleReset();
    assert.equal(capture.r!.isScrollingTowardBottomRef.current, false, 'anchoring resumes after the idle reset');
  } finally {
    window.setTimeout = originalSetTimeout;
  }
});
