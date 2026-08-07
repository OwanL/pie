/**
 * Auto-follow target-refresh harness for exact bottom pinning.
 *
 * `useRefreshFollowTarget` keeps a cached *bottom* target
 * (`scrollHeight - clientHeight`) fresh, and `useAutoFollow` applies it in the
 * same layout commit. The pinning effect never reads `scrollHeight` or
 * `clientHeight`; the target is re-read exactly once per content-height change, keyed
 * on the virtualizer's `totalSize` — which changes for EVERY height-relevant
 * mutation (streaming markdown, tool-body output, reasoning/preview
 * expand-collapse, late image/table loads, drag-resizes), because each measured
 * row's ResizeObserver → `measureElement` → `totalSize`.
 *
 * This replaced a data-model content signature + 250ms fallback cadence. That
 * signature only observed streaming-message prose, so every OTHER growth source
 * (tool output, reasoning, previews, late loads) was seen at most once per 250ms
 * — up to ~250px of persistent drift during regular agent work. `totalSize`
 * sees all of them immediately, so the follow stays pinned.
 *
 * happy-dom has no layout engine — `scrollHeight`/`clientHeight` are always 0
 * and reading them is free — so the *forced-reflow* cost can't be measured
 * here (that needs a real browser). What this harness DOES prove, faithfully:
 *   (1) auto-follow tracks growth (correctness) — a `totalSize` change re-reads
 *       `scrollHeight` exactly once and pins `scrollTop` to the new bottom in
 *       the same commit, for ANY growth source (totalSize is source-agnostic);
 *   (2) settled stable content leaves ZERO follow callbacks queued and reads
 *       `scrollHeight` zero times (no idle main-thread churn or reflow);
 *   (3) every `totalSize` change re-pins IMMEDIATELY — there is no timed
 *       fallback cadence anymore (no `Date.now` dependency), so a late image /
 *       table load is caught the same frame its row re-measures, not 250ms
 *       later.
 *
 * Determinism: `requestAnimationFrame` is faked and flushed synchronously one
 * frame at a time. `scrollHeight`/`clientHeight`/`scrollTop` are own-property
 * getters on the scroll element (so reads/writes are observable and no real
 * scroll events fire to perturb `autoFollow`). `totalSize` is driven as a pure
 * change-trigger tick (its value is irrelevant — only that it changes), decoupled
 * from the spied `scrollHeight`.
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { useRef } from 'preact/hooks';
import { act } from 'preact/test-utils';

import { EMPTY_TRANSCRIPT_WINDOW } from '../../src/shared/protocol';
import { useTranscriptScroll } from '../../src/webview/panel/transcript/use-transcript-scroll';

type ScrollResult = ReturnType<typeof useTranscriptScroll>;

const noop = () => {};
const TRANSCRIPT_WINDOW = { ...EMPTY_TRANSCRIPT_WINDOW, hasUserMessages: true };
// Stable empty array: the reflow harness drives growth via `totalSize` (the
// broad measurement signal), so the transcript identity is held constant to
// isolate totalSize-driven read counts. A fresh array per snapshot is what
// makes the transcript-keyed refresh timely in the real webview; here it must
// NOT change so the assertions stay attributable to `totalSize`.
const STABLE_TRANSCRIPT: readonly never[] = [];

// ── Controlled rAF (deterministic frame driving) ──────────────────────────────

let rafMap = new Map<number, () => void>();
let rafCounter = 0;
let origRaf: unknown;
let origCaf: unknown;
let origResizeObserver: typeof ResizeObserver;
let resizeCallbacks = new Set<() => void>();

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

function installFakeResizeObserver(): void {
  origResizeObserver = globalThis.ResizeObserver;
  resizeCallbacks = new Set();
  globalThis.ResizeObserver = class FakeResizeObserver {
    private readonly notify: () => void;

    constructor(callback: ResizeObserverCallback) {
      this.notify = () => callback([], this as unknown as ResizeObserver);
      resizeCallbacks.add(this.notify);
    }

    observe(): void {}
    unobserve(): void {}
    disconnect(): void { resizeCallbacks.delete(this.notify); }
  } as unknown as typeof ResizeObserver;
}

function restoreResizeObserver(): void {
  globalThis.ResizeObserver = origResizeObserver;
}

function notifyResizeObservers(): void {
  for (const callback of Array.from(resizeCallbacks)) callback();
}

/** Run `n` animation frames. Each frame executes every rAF callback queued at
 *  the start of the frame (a tick re-queues for the next frame). */
function flushFrames(n: number): void {
  for (let i = 0; i < n; i++) {
    const batch = Array.from(rafMap.values());
    rafMap.clear();
    for (const fn of batch) fn();
  }
}

// ── Probe + metric spies ──────────────────────────────────────────────────────

const capture: { r: ScrollResult | null } = { r: null };

function Probe({ totalSize, busy, transcript = STABLE_TRANSCRIPT }: { totalSize: number; busy: boolean; transcript?: readonly never[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const r = useTranscriptScroll({
    scrollRef,
    sessionKey: '/s',
    transcriptWindow: TRANSCRIPT_WINDOW,
    transcript,
    transcriptLength: 1,
    busy,
    onLoadOlder: noop,
    onLoadNewer: noop,
    onJumpToLatest: noop,
    totalSize,
  });
  capture.r = r;
  return h('div', { id: 'scroll-host', ref: scrollRef });
}

let scrollHeightValue = 1000;
let scrollHeightReads = 0;
const clientHeightValue = 200;
let scrollTopValue = 0;

function spyMetrics(el: HTMLElement): void {
  scrollHeightReads = 0;
  scrollHeightValue = 1000;
  scrollTopValue = 0;
  Object.defineProperty(el, 'scrollHeight', {
    get() { scrollHeightReads++; return scrollHeightValue; },
    configurable: true,
  });
  Object.defineProperty(el, 'clientHeight', {
    get() { return clientHeightValue; },
    configurable: true,
  });
  // Own-property scrollTop so writes don't dispatch a real scroll event (which
  // would perturb autoFollow via the scroll listener). Clamp like a browser:
  // `scrollTop = scrollHeight` resolves to `scrollHeight - clientHeight`.
  Object.defineProperty(el, 'scrollTop', {
    get() { return scrollTopValue; },
    set(v: number) { scrollTopValue = Math.max(0, Math.min(v, bottom())); },
    configurable: true,
  });
}

const bottom = () => scrollHeightValue - clientHeightValue;

let container: HTMLElement;
let el: HTMLElement;
let tick = 0;

beforeEach(() => {
  installFakeRaf();
  installFakeResizeObserver();
  container = document.createElement('div');
  document.body.appendChild(container);
  capture.r = null;
  tick = 0;
});

afterEach(() => {
  act(() => { render(null, container); });
  container.remove();
  restoreResizeObserver();
  restoreRaf();
});

/** Re-render the Probe with a fresh `totalSize` tick so the target-refresh
 *  layout effect re-runs (it keys on totalSize). `flush` rAF frames after. */
function rerender(busy: boolean, flush: number): void {
  tick += 1;
  act(() => {
    render(h(Probe, { totalSize: tick, busy }), container);
  });
  // Target refresh may update the wake revision in a layout effect; let that
  // commit restart the follow effect before advancing the fake scheduler.
  if (flush > 0) act(() => flushFrames(flush));
}

function mountProbe(busy: boolean): void {
  tick = 1;
  act(() => { render(h(Probe, { totalSize: tick, busy }), container); });
  el = container.querySelector('#scroll-host') as HTMLElement;
  spyMetrics(el);
}

/** Let the mount-time positioning window settle (clear `isInitialPositioning`)
 *  and pin `scrollTop` to the cached bottom, then reset the read counter so
 *  subsequent reads are attributable to the behavior under test.
 *
 *  The rerender here is load-bearing: `mountProbe` spies metrics AFTER the
 *  initial render, so the mount-time layout effect seeded the target with
 *  happy-dom's un-spied 0. Bumping `totalSize` forces the layout effect to
 *  re-run under the spy, seeding the real bottom before the pin. */
function settle(): void {
  rerender(true, 12);
  // The positioning-state update flushes effects at the end of the render
  // act, after rerender's frame batch. Drain the follow effect it restarts so
  // the harness observes the genuinely settled scheduler state.
  act(() => flushFrames(12));
  scrollHeightReads = 0;
}

test('auto-follow tracks totalSize growth and reads scrollHeight only once per change', () => {
  mountProbe(true);
  settle();
  assert.equal(capture.r!.autoFollowRef.current, true, 'auto-follow must be engaged after settle');
  assert.equal(scrollHeightReads, 0, 'sanity: reads reset after settle');
  assert.equal(scrollTopValue, bottom(), 'sanity: pinned to the bottom');
  assert.equal(rafMap.size, 0, 'settled follow must leave no animation frame queued');

  const scrollTopBefore = scrollTopValue;

  // Grow content: totalSize changes (the source-agnostic signal for ANY row
  // growth — streaming markdown, tool-body output, reasoning, previews, late
  // loads) + scrollHeight grows. The totalSize-keyed layout effects re-read
  // scrollHeight exactly once and pin to the new bottom before paint.
  scrollHeightValue = 1500;
  rerender(true, 1);
  assert.equal(scrollHeightReads, 1, 'a totalSize change should trigger exactly one scrollHeight read');
  assert.ok(scrollTopValue > scrollTopBefore, `scrollTop should advance toward the grown bottom (got ${scrollTopValue})`);

  // Stable frames: totalSize unchanged → the layout effects don't re-run, so
  // there are no new scrollHeight reads or follow callbacks.
  const readsBeforeStable = scrollHeightReads;
  act(() => flushFrames(40));
  assert.equal(scrollHeightReads, readsBeforeStable, 'stable-content frames must not re-read scrollHeight (no forced reflow)');
  assert.equal(scrollTopValue, bottom(), 'scrollTop should remain pinned to the cached bottom');
});

test('a pinned transcript stays exactly at the bottom across ordinary tool-section growth', () => {
  mountProbe(true);
  settle();
  assert.equal(scrollTopValue, bottom(), 'sanity: pinned before the section expands');

  // A single bash/tool section typically adds less than the old 480px snap
  // threshold. Auto-follow must still preserve the bottom invariant in the
  // layout that observes the growth; easing behind creates a temporary gap
  // that repeated streaming/expand updates can turn into a stuck transcript.
  scrollHeightValue += 320;
  rerender(true, 0);

  assert.equal(scrollTopValue, bottom(), 'pinned follow must remain at the exact bottom without waiting for animation frames');
  assert.equal(rafMap.size, 0, 'exact pinning should not leave catch-up work queued');
});

test('settled idle follow leaves the rAF queue empty even while busy', () => {
  mountProbe(true);
  settle();
  assert.equal(capture.r!.autoFollowRef.current, true, 'auto-follow engaged');
  assert.equal(scrollTopValue, bottom(), 'sanity: pinned to the bottom');
  const readsBefore = scrollHeightReads;
  assert.equal(rafMap.size, 0, 'no follow frame remains queued once the target is reached');

  // busy + auto-follow + stable content is fully quiescent. Flushing the fake
  // scheduler cannot manufacture work because no callback remains queued.
  act(() => flushFrames(10));
  assert.equal(scrollHeightReads, readsBefore, 'quiescent follow must not read scrollHeight');
  assert.equal(rafMap.size, 0, 'quiescent follow must keep the scheduler empty');
});

test('every totalSize change re-pins immediately — no timed fallback cadence', () => {
  mountProbe(true);
  settle();
  // Simulate a late image / table load: scrollHeight grows, and because the
  // row re-measures, totalSize grows too. There is no longer a 250ms fallback
  // cadence — the totalSize-keyed layout effect re-reads on the change render,
  // so the view re-pins the same frame, not 250ms later.
  scrollHeightValue = 1800;
  const readsBefore = scrollHeightReads;
  const scrollTopBefore = scrollTopValue;

  rerender(true, 1);
  assert.equal(scrollHeightReads, readsBefore + 1, 'a totalSize change re-reads scrollHeight immediately (no wall-clock wait)');
  assert.ok(scrollTopValue > scrollTopBefore, 'scrollTop should advance toward the new bottom immediately');

  // No clock is advanced between changes; the read is purely change-driven.
  act(() => flushFrames(40));
  assert.equal(scrollTopValue, bottom(), 'scrollTop should re-pin to the late-loaded height');
});

test('a fresh transcript snapshot re-reads the bottom at commit time — no measurement-lag drift', () => {
  // The host posts a fresh JSON-deserialized transcript array on every ~150ms
  // streaming snapshot. That identity change is the timely signal the follow
  // target refresh keys on (in addition to the lagged totalSize): it re-reads
  // scrollHeight at commit — the moment the DOM grew — instead of waiting up to
  // a frame for the virtualizer's deferred re-measurement. Without it follow
  // targeted a ~16ms-stale bottom on every snapshot, trailing the latest
  // content during regular agent work.
  mountProbe(true);
  settle();
  assert.equal(capture.r!.autoFollowRef.current, true, 'auto-follow engaged');
  assert.equal(scrollTopValue, bottom(), 'sanity: pinned to the bottom');
  assert.equal(rafMap.size, 0, 'sanity: follow is quiescent before the transcript signal');

  // Growth arrives as a new transcript array reference with totalSize HELD
  // stable, so only the transcript-keyed refresh can fire (isolating it from
  // the totalSize path).
  scrollHeightValue = 1500;
  const readsBefore = scrollHeightReads;
  const scrollTopBefore = scrollTopValue;
  const freshTranscript: readonly never[] = [];
  act(() => {
    render(h(Probe, { totalSize: tick, busy: true, transcript: freshTranscript }), container);
  });
  act(() => flushFrames(1));
  assert.ok(scrollHeightReads > readsBefore, 'a fresh transcript identity must re-read scrollHeight at commit time');
  assert.ok(scrollTopValue > scrollTopBefore, 'scrollTop should advance toward the grown bottom the same frame');
});

test('container resize re-pins quiescent follow without catch-up frames', () => {
  mountProbe(true);
  settle();
  assert.equal(scrollTopValue, bottom(), 'sanity: pinned to the bottom');
  assert.equal(rafMap.size, 0, 'sanity: follow is quiescent before resize');

  // A viewport resize changes the true bottom without changing transcript or
  // virtualizer totalSize. The container observer must refresh the target and
  // trigger a commit-time re-pin.
  scrollHeightValue += 120;
  const readsBefore = scrollHeightReads;
  const scrollTopBefore = scrollTopValue;
  act(() => notifyResizeObservers());
  assert.equal(scrollHeightReads, readsBefore + 1, 'resize should refresh the cached bottom once');
  assert.ok(scrollTopValue > scrollTopBefore, 'resize-triggered follow should advance to the new bottom');
  assert.equal(scrollTopValue, bottom(), 'resize-triggered follow should pin to the new bottom immediately');
  assert.equal(rafMap.size, 0, 'resize pinning should not schedule catch-up frames');
});
