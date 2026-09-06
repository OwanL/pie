// Regression tests for the memoized MessageRail marker model.
//
// The rail is memoized against parent-owned props with `totalSize` as the
// refresh signal for measurement-driven marker movement (see MessageRail
// props doc). These tests pin that contract: markers render from the
// virtualizer's measurement cache, move when `totalSize` changes, and stay
// stable across identical re-renders.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { MessageRail } from '../../../src/webview/panel/transcript/message-rail';
import type { TranscriptRow } from '../../../src/webview/panel/transcript/virtual-list-rows';
import type { Virtualizer } from '@tanstack/virtual-core';

let container: HTMLElement;

class StubResizeObserver {
  static last: StubResizeObserver | null = null;
  callback: (entries: unknown) => void;
  element: { clientHeight: number } | null = null;
  constructor(callback: (entries: unknown) => void) {
    this.callback = callback;
    StubResizeObserver.last = this;
  }
  observe(element: { clientHeight: number }): void {
    this.element = element;
    this.callback([]);
  }
  unobserve(): void {}
  disconnect(): void {}
}

type GlobalWithRO = Record<string, unknown>;
(globalThis as GlobalWithRO).ResizeObserver = StubResizeObserver;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
  };
});

function userMessage(id: string, markdown: string) {
  return { id, role: 'user' as const, createdAt: '2026-09-06T00:00:00Z', markdown, status: 'completed' as const };
}

function assistantMessage(id: string) {
  return { id, role: 'assistant' as const, createdAt: '2026-09-06T00:00:10Z', markdown: 'reply', status: 'completed' as const };
}

function buildRows(): TranscriptRow[] {
  return [
    { kind: 'message', key: 'u1', message: userMessage('u1', 'First prompt with a reasonably long preview text') },
    { kind: 'message', key: 'a1', message: assistantMessage('a1') },
    { kind: 'message', key: 'u2', message: userMessage('u2', 'Second prompt') },
    { kind: 'message', key: 'a2', message: assistantMessage('a2') },
  ] as TranscriptRow[];
}

function stubVirtualizer(starts: number[]): Virtualizer<HTMLDivElement, HTMLDivElement> {
  return {
    measurementsCache: starts.map((start) => ({ start, end: start + 100 })),
  } as unknown as Virtualizer<HTMLDivElement, HTMLDivElement>;
}

function railProps(overrides?: Record<string, unknown>) {
  const scrollRef = { current: { clientHeight: 800 } as unknown as HTMLDivElement };
  return {
    rows: buildRows(),
    virtualizer: stubVirtualizer([0, 300, 600, 900]),
    scrollRef,
    setAutoFollow: () => {},
    navigationActiveRef: { current: false },
    programmaticScrollTargetRef: { current: null },
    markerSize: 20,
    totalSize: 1000,
    onJumpToRow: () => {},
    hidden: false,
    ...overrides,
  } as Parameters<typeof MessageRail>[0];
}

test('renders one marker per spaced user message with preview titles', () => {
  act(() => { render(h(MessageRail, railProps()), container); });
  const markers = [...container.querySelectorAll<HTMLDivElement>('.transcript-message-rail-marker')];
  assert.equal(markers.length, 2, 'assistant rows produce no markers');
  assert.match(markers[0]!.getAttribute('aria-label') ?? '', /First prompt/);
  assert.match(markers[1]!.getAttribute('aria-label') ?? '', /Second prompt/);
  // `top` is derived from measurement start / totalSize × rail height,
  // clamped to at least half the marker hit height.
  assert.equal(markers[0]!.style.top, '10px');
  assert.equal(markers[1]!.style.top, '480px');
});

test('markers move when totalSize changes (measurement-driven refresh)', () => {
  const props = railProps();
  act(() => { render(h(MessageRail, props), container); });
  const before = [...container.querySelectorAll<HTMLDivElement>('.transcript-message-rail-marker')].map((m) => m.style.top);

  act(() => { render(h(MessageRail, railProps({ totalSize: 2000 })), container); });
  const after = [...container.querySelectorAll<HTMLDivElement>('.transcript-message-rail-marker')].map((m) => m.style.top);

  assert.notDeepEqual(before, after, 'marker positions follow the new totalSize');
  const markers = [...container.querySelectorAll<HTMLDivElement>('.transcript-message-rail-marker')];
  assert.equal(markers[1]!.style.top, '240px', '600 / 2000 × 800');
});

test('identical re-render keeps marker DOM stable', () => {
  act(() => { render(h(MessageRail, railProps()), container); });
  const markers = [...container.querySelectorAll<HTMLDivElement>('.transcript-message-rail-marker')];
  const tops = markers.map((m) => m.style.top);

  act(() => { render(h(MessageRail, railProps()), container); });
  const rerendered = [...container.querySelectorAll<HTMLDivElement>('.transcript-message-rail-marker')];
  assert.deepEqual(rerendered.map((m) => m.style.top), tops);
  assert.equal(rerendered.length, markers.length);
});

test('viewport resize refreshes marker positions via the ResizeObserver', () => {
  const scrollElement = { clientHeight: 800 } as unknown as HTMLDivElement;
  act(() => { render(h(MessageRail, railProps({ scrollRef: { current: scrollElement } })), container); });
  assert.ok(StubResizeObserver.last, 'rail observes the scroll element');
  assert.equal(StubResizeObserver.last!.element, scrollElement);

  (scrollElement as unknown as { clientHeight: number }).clientHeight = 400;
  act(() => { StubResizeObserver.last!.callback([]); });
  const markers = [...container.querySelectorAll<HTMLDivElement>('.transcript-message-rail-marker')];
  assert.equal(markers[1]!.style.top, '240px', '600 / 1000 × 400');
});