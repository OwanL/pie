import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { clearCollapsibleCache, useCollapsibleOpen } from '../../../../src/webview/panel/transcript/use-collapsible-open';

let container: HTMLElement;

beforeEach(() => {
  clearCollapsibleCache();
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
  };
});

interface CapturedState {
  open: boolean;
  setOpen: ReturnType<typeof useCollapsibleOpen>[1];
}

/**
 * Mount a fresh instance of a component that uses useCollapsibleOpen. Each call
 * unmounts first so useState re-initialises from the module-level cache — that
 * is what lets us observe whether persisted open state survives a remount and
 * whether clearCollapsibleCache resets it.
 */
function mountCollapsible(storageKey: string, defaultOpen: boolean): CapturedState {
  const captured: CapturedState = { open: false, setOpen: () => {} };
  const Harness = () => {
    const [open, setOpen] = useCollapsibleOpen(storageKey, defaultOpen);
    captured.open = open;
    captured.setOpen = setOpen;
    return null;
  };
  act(() => {
    render(null, container);
    render(h(Harness, {}), container);
  });
  return captured;
}

test('clearCollapsibleCache resets persisted open state so a fresh render starts collapsed', () => {
  // 1) Fresh mount with defaultOpen=false starts collapsed (empty cache).
  const first = mountCollapsible('cache-clear-key', false);
  assert.equal(first.open, false, 'starts collapsed by default');

  // 2) Open it — the hook persists open=true into the module-level cache.
  act(() => first.setOpen(true));
  assert.equal(first.open, true, 'opens on setOpen(true)');

  // 3) A fresh mount reads the persisted state and stays open. This proves the
  //    module cache (not defaultOpen) is the source of truth across remounts,
  //    so the reset assertion below is not vacuously true.
  const persisted = mountCollapsible('cache-clear-key', false);
  assert.equal(persisted.open, true, 'persisted open state survives a remount');

  // 4) Clear the cache and remount fresh — back to the default (collapsed). If
  //    clearCollapsibleCache were a no-op, this would read the stale persisted
  //    true and fail.
  clearCollapsibleCache();
  const afterClear = mountCollapsible('cache-clear-key', false);
  assert.equal(afterClear.open, false, 'clearCollapsibleCache resets to the default');
});
