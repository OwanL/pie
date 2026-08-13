import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleDelegatedFilePathClick,
  handleDelegatedFilePathContextMenu,
  handleDelegatedFilePathKeyDown,
} from '../../../../src/webview/panel/transcript/file-path-interactions';
import {
  shouldOpenSubagentContextMenu,
  shouldOpenUserMessageEditor,
} from '../../../../src/webview/panel/transcript/interactions';

function closestTarget(matchesInteractiveDescendant: boolean): EventTarget {
  return {
    closest: () => (matchesInteractiveDescendant ? {} : null),
  } as unknown as EventTarget;
}

test('shouldOpenUserMessageEditor allows ordinary bubble clicks', () => {
  assert.equal(shouldOpenUserMessageEditor(closestTarget(false)), true);
});

test('shouldOpenUserMessageEditor suppresses edits for interactive descendants', () => {
  assert.equal(shouldOpenUserMessageEditor(closestTarget(true)), false);
});

test('shouldOpenUserMessageEditor follows parentElement for text-node-like targets', () => {
  const parent = {
    closest: () => ({}),
  };
  const textNodeLike = {
    parentElement: parent,
  };

  assert.equal(shouldOpenUserMessageEditor(textNodeLike as unknown as EventTarget), false);
});

test('shouldOpenUserMessageEditor defaults to editable when target cannot use closest', () => {
  assert.equal(shouldOpenUserMessageEditor({} as EventTarget), true);
});

test('shouldOpenSubagentContextMenu allows clicks on subagent chrome', () => {
  assert.equal(shouldOpenSubagentContextMenu(closestTarget(false)), true);
});

test('shouldOpenSubagentContextMenu suppresses nested message descendants', () => {
  assert.equal(shouldOpenSubagentContextMenu(closestTarget(true)), false);
});

function pathTarget(reference: string): EventTarget {
  return {
    closest: () => ({ getAttribute: () => reference }),
  } as unknown as EventTarget;
}

function delegatedEvent(target: EventTarget, key?: string, repeat = false) {
  const calls: string[] = [];
  return {
    event: {
      target,
      key: key ?? '',
      repeat,
      preventDefault: () => calls.push('preventDefault'),
      stopPropagation: () => calls.push('stopPropagation'),
    },
    calls,
  };
}

test('delegated file-path click resolves a relative path against the session cwd', () => {
  const { event, calls } = delegatedEvent(pathTarget('reveal/docs/foo.md'));
  const opened: string[] = [];

  assert.equal(handleDelegatedFilePathClick(event, 'D:\\Projects\\pie', (path) => opened.push(path)), true);
  assert.deepEqual(opened, ['D:\\Projects\\pie\\reveal\\docs\\foo.md']);
  assert.deepEqual(calls, ['preventDefault', 'stopPropagation']);
});

test('delegated inline-code keyboard activation opens the resolved path', () => {
  const { event, calls } = delegatedEvent(pathTarget('./README.md'), ' ');
  const opened: string[] = [];

  assert.equal(handleDelegatedFilePathKeyDown(event, '/workspace/pie', (path) => opened.push(path)), true);
  assert.deepEqual(opened, ['/workspace/pie/README.md']);
  assert.deepEqual(calls, ['preventDefault', 'stopPropagation']);
});

test('selected file-path clicks suppress native anchor navigation without opening', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { getSelection: () => ({ isCollapsed: false, toString: () => 'selected path text' }) },
  });

  try {
    const { event, calls } = delegatedEvent(pathTarget('reveal/docs/foo.md'));
    const opened: string[] = [];

    assert.equal(handleDelegatedFilePathClick(event, '/workspace/pie', (path) => opened.push(path)), true);
    assert.deepEqual(opened, []);
    assert.deepEqual(calls, ['preventDefault', 'stopPropagation']);
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'window', descriptor);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
});

test('repeated file-path keydown activation is consumed without reopening', () => {
  const { event, calls } = delegatedEvent(pathTarget('./README.md'), 'Enter', true);
  const opened: string[] = [];

  assert.equal(handleDelegatedFilePathKeyDown(event, '/workspace/pie', (path) => opened.push(path)), true);
  assert.deepEqual(opened, []);
  assert.deepEqual(calls, ['preventDefault', 'stopPropagation']);
});

test('delegated right-click opens a file-path context menu instead of the message menu', () => {
  const { event, calls } = delegatedEvent(pathTarget('reveal/docs/foo.md'));
  const menus: Array<{ type: string; rawData: string }> = [];

  assert.equal(handleDelegatedFilePathContextMenu(
    event,
    '/workspace/pie',
    (type, rawData) => menus.push({ type, rawData }),
  ), true);
  assert.deepEqual(menus, [{ type: 'filePath', rawData: '/workspace/pie/reveal/docs/foo.md' }]);
  assert.deepEqual(calls, ['preventDefault', 'stopPropagation']);
});

test('delegated path handlers leave ordinary targets alone', () => {
  const { event, calls } = delegatedEvent({ closest: () => null } as unknown as EventTarget);
  assert.equal(handleDelegatedFilePathClick(event, '/workspace/pie', () => {}), false);
  assert.equal(handleDelegatedFilePathContextMenu(event, '/workspace/pie', () => {}), false);
  assert.deepEqual(calls, []);
});
