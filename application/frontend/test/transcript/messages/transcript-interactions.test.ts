import test from 'node:test';
import assert from 'node:assert/strict';

import {
  filePathPreviewRequestFromTarget,
  handleDelegatedFilePathClick,
  handleDelegatedFilePathContextMenu,
  handleDelegatedFilePathKeyDown,
} from '../../../transcript/file-path-interactions';
import {
  shouldOpenSubagentContextMenu,
  shouldOpenUserMessageEditor,
} from '../../../transcript/interactions';

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

function withWindowSelection<T>(selection: {
  isCollapsed: boolean;
  anchorNode: Node | null;
  focusNode: Node | null;
} | null, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { getSelection: () => selection },
  });

  try {
    return run();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'window', descriptor);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
}

function messageTarget(selectedNodes: Node[], overlapsSelection?: () => boolean): EventTarget {
  const message: {
    contains: (node: Node | null) => boolean;
    ownerDocument?: Document;
  } = { contains: (node) => node !== null && selectedNodes.includes(node) };
  message.ownerDocument = {
    getSelection: () => {
      const selection = window.getSelection?.();
      if (!selection) return null;
      return {
        ...selection,
        rangeCount: 1,
        getRangeAt: () => ({
          intersectsNode: () => overlapsSelection?.() ?? (
            message.contains(selection.anchorNode) || message.contains(selection.focusNode)
          ),
        }),
      };
    },
  } as Document;
  return {
    closest: (selector: string) => selector === '[data-message-id]' ? message : null,
  } as unknown as EventTarget;
}

test('shouldOpenUserMessageEditor keeps a selected message from opening on the following click', () => {
  const selectedText = {} as Node;
  const target = messageTarget([selectedText]);

  withWindowSelection({ isCollapsed: false, anchorNode: selectedText, focusNode: selectedText }, () => {
    assert.equal(shouldOpenUserMessageEditor(target), false);
  });
});

test('shouldOpenUserMessageEditor ignores a selection outside the clicked message', () => {
  const otherMessageText = {} as Node;
  const target = messageTarget([]);

  withWindowSelection({ isCollapsed: false, anchorNode: otherMessageText, focusNode: otherMessageText }, () => {
    assert.equal(shouldOpenUserMessageEditor(target), true);
  });
});

test('shouldOpenUserMessageEditor suppresses edits when a cross-message selection spans the message', () => {
  const target = messageTarget([], () => true);

  withWindowSelection({
    isCollapsed: false,
    anchorNode: {} as Node,
    focusNode: {} as Node,
  }, () => {
    assert.equal(shouldOpenUserMessageEditor(target), false);
  });
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

test('delegated file open retains the original bare reference and captured session cwd', () => {
  const { event } = delegatedEvent(pathTarget('README.md'));
  const requests: Array<{ path: string; reference?: string; workingDirectory?: string }> = [];

  assert.equal(handleDelegatedFilePathClick(
    event,
    '/workspace/session-a',
    (path, reference, workingDirectory) => requests.push({ path, reference, workingDirectory }),
  ), true);
  assert.deepEqual(requests, [{
    path: '/workspace/session-a/README.md',
    reference: 'README.md',
    workingDirectory: '/workspace/session-a',
  }]);
});

test('image previews reuse file-path resolution and conservatively reject SVG', () => {
  assert.deepEqual(filePathPreviewRequestFromTarget(pathTarget('assets/photo.PNG'), '/workspace'), {
    path: '/workspace/assets/photo.PNG',
    reference: 'assets/photo.PNG',
    workingDirectory: '/workspace',
  });
  assert.deepEqual(filePathPreviewRequestFromTarget(pathTarget('/tmp/agent-artifact.webp'), null), {
    path: '/tmp/agent-artifact.webp',
    reference: '/tmp/agent-artifact.webp',
  });
  assert.equal(filePathPreviewRequestFromTarget(pathTarget('/workspace/diagram.svg'), '/workspace'), null);
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
  const menus: Array<{ type: string; rawData: string; reference?: string; workingDirectory?: string }> = [];

  assert.equal(handleDelegatedFilePathContextMenu(
    event,
    '/workspace/pie',
    (type, rawData, _event, _message, filePath) => menus.push({ type, rawData, ...filePath }),
  ), true);
  assert.deepEqual(menus, [{
    type: 'filePath',
    rawData: '/workspace/pie/reveal/docs/foo.md',
    reference: 'reveal/docs/foo.md',
    workingDirectory: '/workspace/pie',
  }]);
  assert.deepEqual(calls, ['preventDefault', 'stopPropagation']);
});

test('delegated path handlers leave ordinary targets alone', () => {
  const { event, calls } = delegatedEvent({ closest: () => null } as unknown as EventTarget);
  assert.equal(handleDelegatedFilePathClick(event, '/workspace/pie', () => {}), false);
  assert.equal(handleDelegatedFilePathContextMenu(event, '/workspace/pie', () => {}), false);
  assert.deepEqual(calls, []);
});
