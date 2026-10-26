import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import type { ChatMessage } from '../../../lib/protocol/index.js';
import type { TranscriptRow } from '../../transcript/virtual-list-rows';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });

let useLiveMessageArrivals: typeof import('../../transcript/live-message-motion').useLiveMessageArrivals;
test.before(async () => {
  ({ useLiveMessageArrivals } = await import('../../transcript/live-message-motion'));
});

const message = (id: string, role: ChatMessage['role'] = 'assistant'): ChatMessage => ({
  id, role, createdAt: '2026-01-01T00:00:00Z', markdown: id, status: 'completed',
});
const row = (id: string, role: ChatMessage['role'] = 'assistant'): TranscriptRow => ({
  kind: 'message', key: `message:${id}`, message: message(id, role),
});
const placeholder = (id = 'assistant-placeholder:prompt'): TranscriptRow => ({
  kind: 'message', key: `message:${id}`, message: message(id),
});

function mount() {
  const root = document.getElementById('root')!;
  let arrivals!: ReturnType<typeof useLiveMessageArrivals>;
  function Probe({ rows, session = 'session-a', busy = false, hasNewer = false }: {
    rows: readonly TranscriptRow[]; session?: string | null; busy?: boolean; hasNewer?: boolean;
  }) {
    arrivals = useLiveMessageArrivals(rows, session, busy, hasNewer);
    return null;
  }
  const draw = (rows: readonly TranscriptRow[], options: { session?: string | null; busy?: boolean; hasNewer?: boolean } = {}) => {
    act(() => { render(h(Probe, { rows, ...options }), root); });
    return arrivals;
  };
  const dispose = () => act(() => { render(null, root); });
  return { draw, dispose };
}

test('initial history is baseline, not a live arrival', () => {
  const view = mount();
  try {
    const arrivals = view.draw([row('old-user', 'user'), row('old-assistant')], { busy: true });
    assert.equal(arrivals.entrances.size, 0);
  } finally { view.dispose(); }
});

test('a new assistant tail after the prior tail receives an entrance', () => {
  const view = mount();
  try {
    view.draw([row('user', 'user')], { busy: true });
    const arrivals = view.draw([row('user', 'user'), row('reply')], { busy: true });
    assert.deepEqual([...arrivals.entrances.keys()], ['message:reply']);
    assert.equal(arrivals.entrances.get('message:reply')?.from, 0);
    assert.equal(arrivals.entrances.get('message:reply')?.claimed, false);
  } finally { view.dispose(); }
});

test('a claimed entrance survives subsequent row snapshots unchanged', () => {
  const view = mount();
  try {
    view.draw([row('user', 'user')], { busy: true });
    const entrance = view.draw([row('user', 'user'), row('reply')], { busy: true }).entrances.get('message:reply')!;
    entrance.claimed = true;
    const next = view.draw([row('user', 'user'), row('reply'), row('newer-snapshot')], { busy: true });
    assert.equal(next.entrances.get('message:reply'), entrance);
    assert.equal(next.entrances.get('message:reply')?.claimed, true);
  } finally { view.dispose(); }
});

test('prepended history and newer-page snapshots do not animate arrivals', () => {
  const view = mount();
  try {
    view.draw([row('existing')], { busy: true });
    const prepended = view.draw([row('older'), row('existing')], { busy: true });
    assert.equal(prepended.entrances.size, 0);
    const paging = view.draw([row('older'), row('existing'), row('page-assistant')], { busy: true, hasNewer: true });
    assert.equal(paging.entrances.size, 0);
  } finally { view.dispose(); }
});

test('switching sessions establishes a fresh baseline', () => {
  const view = mount();
  try {
    view.draw([row('old-session')], { busy: true, session: 'session-a' });
    const arrivals = view.draw([row('new-session')], { busy: true, session: 'session-b' });
    assert.equal(arrivals.entrances.size, 0);
  } finally { view.dispose(); }
});

test('an assistant arriving on the first terminal snapshot still animates', () => {
  const view = mount();
  try {
    view.draw([row('user', 'user')], { busy: true });
    const arrivals = view.draw([row('user', 'user'), row('reply')], { busy: false });
    assert.deepEqual([...arrivals.entrances.keys()], ['message:reply']);
  } finally { view.dispose(); }
});

test('placeholder height registered by its rendered node is used as the arrival baseline', () => {
  const view = mount();
  try {
    const pending = placeholder();
    const arrivals = view.draw([row('user', 'user'), pending], { busy: true });
    const node = document.createElement('div');
    node.getBoundingClientRect = () => ({ height: 47 } as DOMRect);
    arrivals.placeholders.set(pending.key, node);
    const next = view.draw([row('user', 'user'), row('reply')], { busy: true });
    assert.equal(next.entrances.get('message:reply')?.from, 47);
  } finally { view.dispose(); }
});
