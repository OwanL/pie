import test from 'node:test';
import assert from 'node:assert/strict';

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
