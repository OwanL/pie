import test from 'node:test';
import assert from 'node:assert/strict';

import { h, type VNode } from 'preact';
import renderToString from 'preact-render-to-string';

import { QueuedDwellBanner } from '../src/webview/panel/composer/queued-dwell-banner.tsx';
import type { QueuedDwellEntry, WebviewToHostMessage } from '../src/shared/protocol';

const SESSION = '/workspace/session.jsonl';

function firedEntry(localId: string, enqueuedAt: number): QueuedDwellEntry {
  return { localId, enqueuedAt, watchdogFired: true, abandoned: false };
}

type ButtonNode = VNode & { type: 'button' };

function isButton(node: unknown): node is ButtonNode {
  const v = node as VNode;
  return typeof v?.type === 'string' && v.type === 'button' && typeof v.props === 'object' && v.props !== null;
}

function findButtons(vnode: VNode): Array<{ text: string; onClick: () => void }> {
  const result: Array<{ text: string; onClick: () => void }> = [];
  function walk(node: unknown) {
    if (node == null || typeof node !== 'object') return;
    if (isButton(node)) {
      const props = node.props as { children?: unknown; onClick?: () => void };
      result.push({ text: String(props.children ?? ''), onClick: props.onClick ?? (() => undefined) });
    }
    const children = (node as VNode).props?.children;
    if (Array.isArray(children)) {
      children.forEach(walk);
    } else if (children != null) {
      walk(children);
    }
  }
  walk(vnode);
  return result;
}

function renderBanner(props: Parameters<typeof QueuedDwellBanner>[0]): VNode {
  return (QueuedDwellBanner(props) ?? h('span', null)) as VNode;
}

test('QueuedDwellBanner renders warning and action buttons when watchdogFired', () => {
  const vnode = renderBanner({
    queuedDwell: [firedEntry('local:q1', 0)],
    sessionPath: SESSION,
    onInterrupt: () => undefined,
    onClearQueue: () => undefined,
    postMessage: () => undefined,
    now: 600_000,
  });

  const html = renderToString(vnode);
  assert.match(html, /Queued message has been waiting/);
  assert.match(html, /10m 0s/);
  assert.match(html, /Stop current turn/);
  assert.match(html, /Keep waiting/);
  assert.match(html, /Remove queued/);
});

test('QueuedDwellBanner calls onInterrupt and onClearQueue', () => {
  let interruptCalled = false;
  let clearCalled = false;

  const vnode = renderBanner({
    queuedDwell: [firedEntry('local:q1', 0)],
    sessionPath: SESSION,
    onInterrupt: () => { interruptCalled = true; },
    onClearQueue: () => { clearCalled = true; },
    postMessage: () => undefined,
    now: 600_000,
  });

  const buttons = findButtons(vnode);
  const stop = buttons.find((b) => b.text === 'Stop current turn');
  const remove = buttons.find((b) => b.text === 'Remove queued');
  assert.ok(stop);
  assert.ok(remove);
  stop!.onClick();
  remove!.onClick();
  assert.equal(interruptCalled, true);
  assert.equal(clearCalled, true);
});

test('QueuedDwellBanner posts rearmQueuedDwellWatchdog on Keep waiting', () => {
  const messages: WebviewToHostMessage[] = [];

  const vnode = renderBanner({
    queuedDwell: [firedEntry('local:q1', 0)],
    sessionPath: SESSION,
    onInterrupt: () => undefined,
    onClearQueue: () => undefined,
    postMessage: (msg) => { messages.push(msg); },
    now: 600_000,
  });

  const buttons = findButtons(vnode);
  const keepWaiting = buttons.find((b) => b.text === 'Keep waiting');
  assert.ok(keepWaiting, 'Keep waiting button found');
  keepWaiting!.onClick();

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], {
    type: 'rearmQueuedDwellWatchdog',
    sessionPath: SESSION,
    localId: 'local:q1',
  });
});

test('QueuedDwellBanner returns null when no watchdogFired entry', () => {
  const vnode = QueuedDwellBanner({
    queuedDwell: [{ localId: 'local:q1', enqueuedAt: 0, watchdogFired: false, abandoned: false }],
    sessionPath: SESSION,
    onInterrupt: () => undefined,
    onClearQueue: () => undefined,
    postMessage: () => undefined,
    now: 600_000,
  });
  assert.equal(vnode, null);
});

test('QueuedDwellBanner returns null when sessionPath is null', () => {
  const vnode = QueuedDwellBanner({
    queuedDwell: [firedEntry('local:q1', 0)],
    sessionPath: null,
    onInterrupt: () => undefined,
    onClearQueue: () => undefined,
    postMessage: () => undefined,
    now: 600_000,
  });
  assert.equal(vnode, null);
});
